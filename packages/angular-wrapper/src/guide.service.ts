import { Injectable, OnDestroy } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import { GuideEngine, IdentityOptions, createDomRenderer, createHelpWidget, SdkInitOptions } from '@guide-engine/core';

@Injectable({ providedIn: 'root' })
export class GuideService implements OnDestroy {
  private engine = new GuideEngine();
  private routerSub?: Subscription;

  constructor(private router: Router) {}

  /**
   * Call once, typically from provideAppInitializer / APP_INITIALIZER or the
   * root component's ngOnInit. Options: { apiBaseUrl, appKey, visitor?,
   * account?, jwt? } — appKey is the app's public key from the Studio.
   * (Apps that can't add an npm dependency can use the install snippet instead.)
   */
  async init(options: SdkInitOptions): Promise<void> {
    const renderer = createDomRenderer({
      advanceStep: (id) => this.engine.advanceStep(id),
      previousStep: (id) => this.engine.previousStep(id),
      dismissGuide: (id) => this.engine.dismissGuide(id),
    });

    // Help center: floating button (unless options.helpButton === false) + openHelp().
    // Opens and searches are reported for the Studio's help-center analytics.
    const help = createHelpWidget({
      onSelect: (item) => this.engine.launchHelpGuide(item.id),
      onOpen: () => this.engine.trackHelpOpened(),
      onSearch: (query, results) => this.engine.trackHelpSearched(query, results),
    });
    await this.engine.init(options, renderer, help);

    this.routerSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        this.engine.onRouteChange(e.urlAfterRedirects);
      });
  }

  /** Open the help center — wire your own help button to this. */
  openHelp(): void {
    this.engine.openHelp();
  }

  closeHelp(): void {
    this.engine.closeHelp();
  }

  toggleHelp(): void {
    this.engine.toggleHelp();
  }

  /** Switch to a different end user (e.g. after login). */
  identify(identity: IdentityOptions): Promise<void> {
    return this.engine.identify(identity);
  }

  ngOnDestroy(): void {
    this.routerSub?.unsubscribe();
  }
}
