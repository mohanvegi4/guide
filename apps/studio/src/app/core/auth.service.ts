import { HttpClient, HttpContext, HttpContextToken, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { User, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { firstValueFrom } from 'rxjs';
import { AppRole, Me, MyOrg, OrgRole, SupportContext } from './models';

const STORAGE_KEY = 'guide-studio-token';
/** Support mode survives a reload within the tab (sessionStorage), never across tabs. */
const SUPPORT_KEY = 'guide-studio-support-org';

/** Marks a request whose Authorization header is set explicitly (see auth.interceptor). */
export const EXPLICIT_AUTH = new HttpContextToken<boolean>(() => false);

/** What the backend says about how to sign in (GET /auth/config). */
export interface AuthUiConfig {
  oidc: { issuer: string; clientId: string; scope: string } | null;
  tokenPaste: boolean;
}

/**
 * Studio sign-in. Two ways in, both ending in a bearer token the backend
 * verifies on every request:
 *  - SSO: OpenID Connect Authorization Code + PKCE (oidc-client-ts) against
 *    the provider named by GET /auth/config; the access token is sent to the API.
 *  - Paste a token: local development, or when no SSO is configured.
 *
 * Who you are and which organizations/apps you can manage always come from
 * GET /v1/me — the Studio never decodes tokens itself, and what it shows
 * can't disagree with what the backend enforces.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private userManager: UserManager | null = null;

  readonly token = signal<string | null>(null);
  /** The signed-in user and their orgs/apps (with roles). */
  readonly me = signal<Me | null>(null);
  readonly config = signal<AuthUiConfig>({ oidc: null, tokenPaste: true });
  readonly usingSso = signal(false);
  /**
   * Support mode (platform admins only): the customer organization being
   * viewed read-only under its support-access window. While set, the
   * interceptor sends X-Support-Org and the org appears in me().orgs as a
   * member/viewer so the ordinary pages and guards work unchanged.
   */
  readonly supportOrg = signal<{ id: string; name: string; until: string } | null>(null);

  /** Runs before routing (provideAppInitializer): restores an existing session. */
  async init(): Promise<void> {
    try {
      this.config.set(await firstValueFrom(this.http.get<AuthUiConfig>('/api/auth/config')));
    } catch {
      // Backend unreachable: keep the defaults; login will surface the error.
    }

    const oidc = this.config().oidc;
    if (oidc) {
      this.userManager = new UserManager({
        authority: oidc.issuer,
        client_id: oidc.clientId,
        scope: oidc.scope,
        response_type: 'code', // + PKCE (oidc-client-ts default for the code flow)
        redirect_uri: `${location.origin}/auth/callback`,
        post_logout_redirect_uri: `${location.origin}/login`,
        // Session-scoped: closing the tab ends the Studio session.
        userStore: new WebStorageStateStore({ store: sessionStorage }),
        automaticSilentRenew: true, // uses the refresh token when the provider issues one
        loadUserInfo: false,
      });
      // Renewed tokens replace the old one; an expired session falls back to login.
      this.userManager.events.addUserLoaded((user) => this.token.set(user.access_token));
      this.userManager.events.addAccessTokenExpired(() => this.clearLocal());

      const user = await this.userManager.getUser().catch(() => null);
      if (user && !user.expired && !(await this.adopt(user.access_token, 'sso'))) return;
    }

    const stored = readStored();
    if (stored && (await this.adopt(stored, 'paste'))) clearStored();
  }

  org(orgId: string | null | undefined): MyOrg | undefined {
    return this.me()?.orgs.find((o) => o.id === orgId);
  }

  orgRole(orgId: string | null | undefined): OrgRole | undefined {
    return this.org(orgId)?.role;
  }

  appRole(appId: string | null | undefined): AppRole | undefined {
    for (const o of this.me()?.orgs ?? []) {
      const app = o.apps.find((a) => a.id === appId);
      if (app) return app.role;
    }
    return undefined;
  }

  /** Where to land after sign-in: your first app's guides, else onboarding. */
  homePath(): string {
    const orgs = this.me()?.orgs ?? [];
    const withApp = orgs.find((o) => o.apps.length > 0);
    if (withApp) return `/o/${withApp.id}/apps/${withApp.apps[0].id}/guides`;
    if (orgs[0]) return `/o/${orgs[0].id}/apps`;
    return '/welcome';
  }

  /** Re-reads /v1/me (after creating an org, accepting an invitation, role changes). */
  async refresh(): Promise<void> {
    const token = this.token();
    if (!token) return;
    try {
      const me = await firstValueFrom(this.http.get<Me>('/api/v1/me'));
      this.me.set(me);
      // Re-enter support mode after a reload, if the window is still open.
      const remembered = this.supportOrg()?.id ?? readSupport();
      if (remembered && me.user.platformAdmin) await this.enterSupport(remembered);
      else this.exitSupport();
    } catch {
      // the interceptor handles 401s
    }
  }

  /**
   * Enters support mode for `orgId`: asks the backend what may be seen (404
   * unless the organization has granted access) and adds the org to me().
   * Resolves to an error message, or null on success.
   */
  async enterSupport(orgId: string): Promise<string | null> {
    this.supportOrg.set({ id: orgId, name: '', until: '' });
    let context: SupportContext;
    try {
      context = await firstValueFrom(this.http.get<SupportContext>('/api/v1/support-context'));
    } catch {
      this.exitSupport();
      return 'This organization has not granted support access, or the window has closed.';
    }
    this.supportOrg.set({ id: context.id, name: context.name, until: context.supportAccessUntil });
    writeSupport(context.id);
    this.me.update((me) =>
      me
        ? {
            ...me,
            orgs: [
              ...me.orgs.filter((o) => o.id !== context.id),
              {
                id: context.id,
                name: context.name,
                role: context.role,
                suspendedAt: null,
                apps: context.apps,
                supportAccessUntil: context.supportAccessUntil,
              },
            ],
          }
        : me,
    );
    return null;
  }

  /** Leaves support mode: the organization disappears from me() again. */
  exitSupport(): void {
    const current = this.supportOrg();
    this.supportOrg.set(null);
    writeSupport(null);
    if (current)
      this.me.update((me) => (me ? { ...me, orgs: me.orgs.filter((o) => o.id !== current.id) } : me));
  }

  /** Paste-a-token sign-in. Resolves to an error message, or null on success. */
  loginWithToken(rawToken: string): Promise<string | null> {
    return this.adopt(rawToken.trim().replace(/^Bearer\s+/i, ''), 'paste');
  }

  /** Redirects to the identity provider; comes back via /auth/callback. */
  async signInWithSso(returnUrl = '/'): Promise<void> {
    if (!this.userManager) throw new Error('SSO is not configured');
    await this.userManager.signinRedirect({ url_state: returnUrl });
  }

  /** Finishes the SSO redirect. Resolves to an error message (or null) and where to go next. */
  async completeSsoSignIn(): Promise<{ error: string | null; returnUrl: string }> {
    if (!this.userManager) return { error: 'SSO is not configured.', returnUrl: '/login' };
    let user: User;
    try {
      user = await this.userManager.signinRedirectCallback();
    } catch {
      return { error: 'Sign-in did not complete. Please try again.', returnUrl: '/login' };
    }
    const error = await this.adopt(user.access_token, 'sso');
    if (error) await this.userManager.removeUser();
    const target =
      user.url_state && user.url_state.startsWith('/') && !user.url_state.startsWith('//')
        ? user.url_state
        : '';
    return { error, returnUrl: target && target !== '/' ? target : this.homePath() };
  }

  /** Local sign-out (e.g. after a 401). Doesn't end the provider session. */
  logout(): void {
    this.exitSupport();
    this.clearLocal();
    void this.userManager?.removeUser();
  }

  /** The Sign out button: local sign-out, plus the provider's session when using SSO. */
  async signOut(): Promise<void> {
    const sso = this.usingSso() && this.userManager;
    this.logout();
    if (sso) {
      await this.userManager!.signoutRedirect().catch(() => undefined); // provider may not support it
    }
  }

  /** Asks the backend who this token belongs to, and adopts it only if the backend accepts it. */
  private async adopt(token: string, source: 'sso' | 'paste'): Promise<string | null> {
    if (!token) return 'Paste a token first.';
    let me: Me;
    try {
      me = await firstValueFrom(
        this.http.get<Me>('/api/v1/me', {
          headers: { Authorization: `Bearer ${token}` },
          context: new HttpContext().set(EXPLICIT_AUTH, true),
        }),
      );
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 401) {
        return source === 'paste'
          ? 'The backend rejected that token (invalid or expired) — mint a new one.'
          : 'The backend rejected your sign-in token. Check the SSO configuration (issuer, audience).';
      }
      return 'Cannot reach the backend. Is it running on :3000?';
    }
    this.token.set(token);
    this.me.set(me);
    this.usingSso.set(source === 'sso');
    // A platform admin reloading the tab mid-support: pick the organization up again.
    const remembered = readSupport();
    if (remembered && me.user.platformAdmin) await this.enterSupport(remembered);
    else writeSupport(null);
    if (source === 'paste') {
      try {
        sessionStorage.setItem(STORAGE_KEY, token);
      } catch {
        // storage unavailable (private mode) — token lives for this page load only
      }
    }
    return null;
  }

  private clearLocal(): void {
    this.token.set(null);
    this.me.set(null);
    this.usingSso.set(false);
    clearStored();
  }
}

function readStored(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function clearStored(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function readSupport(): string | null {
  try {
    return sessionStorage.getItem(SUPPORT_KEY);
  } catch {
    return null;
  }
}

function writeSupport(orgId: string | null): void {
  try {
    if (orgId) sessionStorage.setItem(SUPPORT_KEY, orgId);
    else sessionStorage.removeItem(SUPPORT_KEY);
  } catch {
    // storage unavailable: support mode just won't survive a reload
  }
}
