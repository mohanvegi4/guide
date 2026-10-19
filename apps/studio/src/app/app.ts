import { DatePipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { AuthService } from './core/auth.service';
import { isOrgAdmin } from './core/models';

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
  protected readonly orgAdmin = computed(() => isOrgAdmin(this.org()?.role));
  protected readonly appRole = computed(() => this.auth.appRole(this.appId()));

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
