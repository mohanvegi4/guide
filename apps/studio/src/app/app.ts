import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { AuthService } from './core/auth.service';
import { isOrgManager } from './core/models';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, DatePipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** Current /o/:orgId/apps/:appId from the URL (the shell sits outside the routed components). */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  protected readonly orgId = computed(() => this.url().match(/^\/o\/([^/?#]+)/)?.[1] ?? null);
  protected readonly appId = computed(() => this.url().match(/^\/o\/[^/]+\/apps\/([^/?#]+)/)?.[1] ?? null);
  protected readonly org = computed(() => this.auth.org(this.orgId()));
  protected readonly orgAdmin = computed(() => isOrgManager(this.org()?.role));
  /** Only owners start new organizations (someone with none yet gets the Welcome page anyway). */
  protected readonly canCreateOrg = computed(() => {
    const orgs = this.auth.me()?.orgs ?? [];
    return orgs.length === 0 || orgs.some((o) => o.role === 'owner');
  });

  /** The app last visited per organization, so org-level pages keep that app's tabs. */
  private readonly lastApp = signal<Record<string, string>>({});
  /**
   * The app the tabs and switcher refer to: the one in the URL, else the one
   * last visited in this organization, else the organization's first app.
   * Org-level pages (Apps, Members) have no app in their URL; without this
   * the Guides and Pages tabs vanished there.
   */
  protected readonly currentAppId = computed(() => {
    const org = this.org();
    if (!org) return null;
    const has = (id: string | null | undefined) => !!id && org.apps.some((a) => a.id === id);
    const fromUrl = this.appId();
    if (has(fromUrl)) return fromUrl;
    const remembered = this.lastApp()[org.id];
    return has(remembered) ? remembered : (org.apps[0]?.id ?? null);
  });
  protected readonly appRole = computed(() => this.auth.appRole(this.currentAppId()));

  constructor() {
    effect(() => {
      const orgId = this.orgId();
      const appId = this.appId();
      if (orgId && appId) this.lastApp.update((m) => (m[orgId] === appId ? m : { ...m, [orgId]: appId }));
    });
  }

  switchOrg(orgId: string): void {
    const org = this.auth.org(orgId);
    const first = org?.apps[0];
    void this.router.navigate(first ? ['/o', orgId, 'apps', first.id, 'guides'] : ['/o', orgId, 'apps']);
  }

  switchApp(appId: string): void {
    // Stay on the same kind of screen (guide editors and settings fall back to the list).
    const section = /^\/o\/[^/]+\/apps\/[^/]+\/pages/.test(this.url()) ? 'pages' : 'guides';
    void this.router.navigate(['/o', this.orgId(), 'apps', appId, section]);
  }

  /** Leaves support mode and returns to the administration page. */
  exitSupport(): void {
    this.auth.exitSupport();
    void this.router.navigate(['/operator']);
  }

  async logout(): Promise<void> {
    await this.auth.signOut(); // SSO: may redirect to the provider's logout page
    void this.router.navigate(['/login']);
  }
}
