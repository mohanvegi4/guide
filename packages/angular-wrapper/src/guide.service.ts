import { Injectable, OnDestroy } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import { GuideEngine, createDomRenderer, SdkInitOptions } from '@guide-engine/core';

@Injectable({ providedIn: 'root' })
export class GuideService implements OnDestroy {
  private engine = new GuideEngine();
  private routerSub?: Subscription;

  constructor(private router: Router) {}

  /** Call once, typically from an APP_INITIALIZER or root component ngOnInit. */
  async init(options: SdkInitOptions): Promise<void> {
    const renderer = createDomRenderer({
      advanceStep: (id) => this.engine.advanceStep(id),
      dismissGuide: (id) => this.engine.dismissGuide(id),
    });

    await this.engine.init(options, renderer);

    this.routerSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        this.engine.onRouteChange(e.urlAfterRedirects);
      });
  }

  ngOnDestroy(): void {
    this.routerSub?.unsubscribe();
  }
}
