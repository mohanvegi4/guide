import type { App, InjectionKey } from 'vue';
import { inject } from 'vue';
import type { Router } from 'vue-router';
import { GuideEngine, createDomRenderer, createHelpWidget, SdkInitOptions } from '@guide-engine/core';

export interface GuidePluginOptions extends SdkInitOptions {
  router: Router;
}

const ENGINE_INJECTION_KEY: InjectionKey<GuideEngine> = Symbol('guide-engine');

export const GuidePlugin = {
  install(app: App, options: GuidePluginOptions) {
    const engine = new GuideEngine();
    const renderer = createDomRenderer({
      advanceStep: (id) => engine.advanceStep(id),
      dismissGuide: (id) => engine.dismissGuide(id),
    });

    // Fire-and-forget init; the engine fails closed/silently per its own
    // design, so we don't need to await this before the app mounts.
    // Help center: floating button (unless options.helpButton === false);
    // useGuideEngine().openHelp() from your own button.
    const help = createHelpWidget({ onSelect: (item) => engine.launchHelpGuide(item.id) });
    engine.init(options, renderer, help);

    options.router.afterEach((to) => {
      engine.onRouteChange(to.fullPath);
    });

    app.provide(ENGINE_INJECTION_KEY, engine);
    app.config.globalProperties.$guideEngine = engine;
  },
};

/** Call from within a component's setup() to get the shared engine instance. */
export function useGuideEngine(): GuideEngine {
  const engine = inject(ENGINE_INJECTION_KEY);
  if (!engine) {
    throw new Error('useGuideEngine() called before GuidePlugin was installed via app.use(GuidePlugin, ...)');
  }
  return engine;
}
