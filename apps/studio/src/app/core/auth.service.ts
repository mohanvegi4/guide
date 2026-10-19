import { HttpClient, HttpContext, HttpContextToken, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { User, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { firstValueFrom } from 'rxjs';
import { GUIDE_ADMIN, PLATFORM_ADMIN } from './models';

const STORAGE_KEY = 'guide-studio-token';

/** Marks a request whose Authorization header is set explicitly (see auth.interceptor). */
export const EXPLICIT_AUTH = new HttpContextToken<boolean>(() => false);

/** The caller's identity as VERIFIED by the backend (GET /auth/me). */
export interface Identity {
  tenantId: string;
  userId: string;
  roles: string[];
}

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
 * Identity and roles always come from GET /auth/me — the Studio never
 * decodes tokens itself, so it doesn't need to know a provider's claim names,
 * and what it shows can't disagree with what the backend enforces.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private userManager: UserManager | null = null;

  readonly token = signal<string | null>(null);
  readonly info = signal<Identity | null>(null);
  readonly config = signal<AuthUiConfig>({ oidc: null, tokenPaste: true });
  readonly usingSso = signal(false);

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

  hasRole(role: string): boolean {
    return this.info()?.roles.includes(role) ?? false;
  }

  /** Where to land after sign-in: tenant guides if allowed, else global guides. */
  homePath(): string {
    return this.hasRole(GUIDE_ADMIN) || !this.hasRole(PLATFORM_ADMIN) ? '/guides' : '/global';
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
    const target = user.url_state && user.url_state.startsWith('/') && !user.url_state.startsWith('//') ? user.url_state : '';
    return { error, returnUrl: target && target !== '/' ? target : this.homePath() };
  }

  /** Local sign-out (e.g. after a 401). Doesn't end the provider session. */
  logout(): void {
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

  /**
   * Asks the backend who this token belongs to, and adopts it only if the
   * backend accepts it and it carries an authoring role.
   */
  private async adopt(token: string, source: 'sso' | 'paste'): Promise<string | null> {
    if (!token) return 'Paste a token first.';
    let me: Identity;
    try {
      me = await firstValueFrom(
        this.http.get<Identity>('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
          context: new HttpContext().set(EXPLICIT_AUTH, true),
        })
      );
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 401) {
        return source === 'paste'
          ? 'The backend rejected that token (invalid or expired) — mint a new one.'
          : 'The backend rejected your sign-in token. Check the SSO configuration (issuer, audience, claims).';
      }
      return 'Cannot reach the backend. Is it running on :3000?';
    }
    if (!me.roles.includes(GUIDE_ADMIN) && !me.roles.includes(PLATFORM_ADMIN)) {
      return 'Your account has neither the guide_admin nor the platform_admin role, so it cannot author guides.';
    }

    this.token.set(token);
    this.info.set(me);
    this.usingSso.set(source === 'sso');
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
    this.info.set(null);
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
