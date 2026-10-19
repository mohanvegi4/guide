import { GuideEngine, IdentityOptions, createDomRenderer, createHelpWidget } from '@guide-engine/core';

/**
 * The install-snippet agent. A host page adds the snippet to its <head>:
 *
 *   (function(w,d,k){ … w.guideEngine = stub that queues calls; loads
 *     https://<api>/agent/v1/<k>/guides.js … })(window, document, 'ge_pk_…');
 *   guideEngine.initialize({ visitor: { id: 'u-1' }, account: { id: 'acme' } });
 *
 * This script then: works out its app key and API origin from its own URL,
 * replaces the stub with the real API, replays the queued calls, and follows
 * client-side navigation by itself — no framework integration needed. It also
 * adds the help center: a floating button (unless initialize({ helpButton:
 * false })) and guideEngine.openHelp() / closeHelp() / toggleHelp() for a
 * product's own help button.
 *
 * Fail silent: nothing here may throw into the host page.
 */

export interface AgentApi {
  readonly version: string;
  initialize(options?: InitializeOptions): void;
  identify(options: IdentityOptions): void;
  /** Open the help center (e.g. from your own help button). */
  openHelp(): void;
  closeHelp(): void;
  toggleHelp(): void;
}

export interface InitializeOptions extends IdentityOptions {
  /** Override where the API lives (defaults to the origin this script came from). */
  apiBaseUrl?: string;
  /** Override the app key (defaults to the key in this script's URL). */
  appKey?: string;
  /** Show the floating help button (default true). */
  helpButton?: boolean;
}

interface Stub {
  _q?: unknown[][];
  version?: string;
  [method: string]: unknown;
}

declare global {
  interface Window {
    guideEngine?: Stub | AgentApi;
  }
}

export const AGENT_VERSION = '1';
const SCRIPT_SRC = /\/agent\/v1\/(ge_pk_[0-9a-f]{32})\/guides\.js(?:[?#].*)?$/;

/** Finds this script's <script> tag and reads the app key + API origin from its src. */
export function locateInstall(doc: Document): { apiBaseUrl: string; appKey: string } | null {
  const candidates: Array<Element | null> = [doc.currentScript, ...Array.from(doc.querySelectorAll('script[src]'))];
  for (const el of candidates) {
    const src = (el as HTMLScriptElement | null)?.src;
    const match = src?.match(SCRIPT_SRC);
    if (src && match) return { apiBaseUrl: new URL(src).origin, appKey: match[1] };
  }
  return null;
}

/**
 * Calls onChange(path) whenever the URL path changes: history.pushState /
 * replaceState (what SPA routers use), back/forward, and hash changes.
 */
export function watchNavigation(onChange: (path: string) => void, win: Window = window): void {
  let last = win.location.pathname;
  const check = () => {
    const path = win.location.pathname;
    if (path === last) return;
    last = path;
    try {
      onChange(path);
    } catch {
      // never break the host's navigation
    }
  };
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = win.history[method];
    win.history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      queueMicrotask(check);
      return result;
    };
  }
  win.addEventListener('popstate', check);
  win.addEventListener('hashchange', check);
}

export function startAgent(win: Window = window): void {
  const existing = win.guideEngine as Stub | undefined;
  if (existing?.version) return; // already loaded (snippet included twice)

  const install = locateInstall(win.document);
  const queue = Array.isArray(existing?._q) ? existing._q : [];
  const engine = new GuideEngine();
  const renderer = createDomRenderer({
    advanceStep: (id) => engine.advanceStep(id),
    dismissGuide: (id) => engine.dismissGuide(id),
  });
  const help = createHelpWidget({ onSelect: (item) => engine.launchHelpGuide(item.id) });
  let started = false;
  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      // fail silent
    }
  };

  const api: AgentApi = {
    version: AGENT_VERSION,
    initialize(options = {}) {
      try {
        if (started) return api.identify(options); // a second initialize just switches user
        const apiBaseUrl = options.apiBaseUrl ?? install?.apiBaseUrl;
        const appKey = options.appKey ?? install?.appKey;
        if (!apiBaseUrl || !appKey) {
          console.warn('[guideEngine] could not find the app key — is the install snippet unmodified?');
          return;
        }
        started = true;
        void engine.init({ ...options, apiBaseUrl, appKey }, renderer, help);
        watchNavigation((path) => void engine.onRouteChange(path), win);
      } catch {
        // fail silent
      }
    },
    identify(options) {
      try {
        if (!started) return api.initialize(options);
        void engine.identify(options);
      } catch {
        // fail silent
      }
    },
    openHelp: () => safely(() => engine.openHelp()),
    closeHelp: () => safely(() => engine.closeHelp()),
    toggleHelp: () => safely(() => engine.toggleHelp()),
  };
  win.guideEngine = api;

  // Replay what the page queued before this script arrived; initialize first
  // so an early identify() doesn't run against an engine that isn't set up.
  const calls = [...queue.filter(([m]) => m === 'initialize'), ...queue.filter(([m]) => m !== 'initialize')];
  for (const [method, ...args] of calls) {
    const fn = (api as unknown as Record<string, unknown>)[String(method)];
    if (typeof fn === 'function') (fn as (...a: unknown[]) => void).apply(api, args);
  }
}

startAgent();
