/**
 * Guide Runtime SDK — Core Engine
 * Framework-agnostic. The install-snippet agent (packages/agent) and the
 * Angular/Vue wrappers sit on top of this and only handle: (1) calling init()
 * at startup, (2) calling onRouteChange() on navigation, (3) identify() after
 * login. Rendering is injected — this file owns state, not DOM painting.
 */

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

export type GuideType = 'tooltip' | 'modal' | 'banner' | 'tour' | 'checklist' | 'survey' | 'beacon';

export interface StepAction {
  label: string;
  action: 'next' | 'back' | 'dismiss' | 'complete' | 'custom';
  customHandler?: string; // name of a registered custom handler, resolved by the renderer
}

export interface Step {
  id: string;
  order: number;
  type: GuideType;
  targetSelector?: string; // e.g. '[data-guide-id="invite-button"]'
  content: string; // sanitized HTML
  position?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  actions: StepAction[];
}

export interface RouteMatch {
  type: 'exact' | 'pattern';
  value: string; // exact path or a wildcard/regex-ish pattern like '/dashboard/*'
}

export interface Guide {
  id: string;
  versionId: string;
  name: string;
  type: GuideType;
  steps: Step[];
  routeMatch: RouteMatch;
  /** Set when force-rendered from a signed preview link (renderer shows a badge). */
  preview?: boolean;
}

export type GuideRuntimeStatus = 'idle' | 'matching' | 'showing' | 'completed' | 'dismissed' | 'error';

export interface GuideRuntimeState {
  guide: Guide;
  status: GuideRuntimeStatus;
  currentStepIndex: number;
  /** How this run started, recorded on its events: automatic, the help center, or a shared link. */
  source?: 'help' | 'link';
}

/** A guide listed in the help center (on-demand, searchable). */
export interface HelpItem extends Guide {
  help: {
    title: string;
    description: string;
    keywords: string[];
    /** Where to send the visitor before starting (a path on the same site). */
    startPath: string;
  };
}

/**
 * Where the help list and its "Go to another page?" confirmation appear: a
 * corner, or the center of the screen. The floating button sits in the
 * chosen corner (bottom right for 'center').
 */
export type HelpPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'center';

export interface HelpButtonSettings {
  label: string;
  color: string;
  /** Default bottom-right. */
  position?: HelpPosition;
}

/** Help-center UI, injected like the renderer (see help-widget.ts for the default). */
export interface HelpUi {
  /** New list / settings. showButton=false hides the floating button (the panel still opens via openHelp()). */
  update(state: { items: HelpItem[]; button: HelpButtonSettings; showButton: boolean }): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /**
   * Asks the visitor whether to leave for `item`'s start page (a page load,
   * which can drop unsaved work). Calls `go` only if they agree. A UI without
   * this method gets no confirmation: the engine navigates straight away.
   */
  confirmNavigation?(item: HelpItem, go: () => void): void;
}

/** The end user (Pendo calls them visitors). Only `id` is sent to the server. */
export interface Visitor {
  id: string;
  [key: string]: unknown;
}

/** The end user's company/customer, used for account targeting. */
export interface Account {
  id: string;
  [key: string]: unknown;
}

export interface IdentityOptions {
  /** The signed-in end user. Omit for anonymous visitors (a random id is kept per browser). */
  visitor?: Visitor;
  account?: Account | null;
  /**
   * A JWT your BACKEND signed with the app's signing secret, carrying
   * { visitor: { id }, account?: { id } }. Required when the app has
   * "Require signed identity" switched on; its ids take precedence.
   */
  jwt?: string;
}

export interface SdkInitOptions extends IdentityOptions {
  /** Where the Guide Engine API lives, e.g. https://guides.example.com */
  apiBaseUrl: string;
  /** The app's PUBLIC key from the Studio (ge_pk_…). Safe to ship in pages. */
  appKey: string;
  /**
   * Show the floating help button (default true). Set false to use your own
   * button and call openHelp() / toggleHelp() from it.
   */
  helpButton?: boolean;
}

export interface GuideEventPayload {
  guideId: string;
  guideVersionId: string;
  stepId?: string;
  sessionId: string;
  eventType:
    | 'guide_shown'
    | 'guide_step_viewed'
    | 'guide_step_completed'
    | 'guide_dismissed'
    | 'guide_completed'
    | 'guide_error'
    | 'survey_response';
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

// Renderer is injected — the core engine never touches the DOM directly.
export interface GuideRenderer {
  renderStep(guide: Guide, step: Step, targetEl: Element | null): void;
  clear(guideId: string): void;
}

// ------------------------------------------------------------
// Transport
// ------------------------------------------------------------

/** What every agent request carries to identify the end user. */
interface WireIdentity {
  visitor?: { id: string };
  account?: { id: string } | null;
  jwt?: string;
}

/** crypto.randomUUID needs a secure context; plain-http intranet apps don't have one. */
function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const ANON_KEY = 'guideEngine.anonymousId';
let memoryAnonId: string | null = null;

/** A stable per-browser id for visitors the host app doesn't identify. */
export function anonymousVisitorId(): string {
  try {
    let id = localStorage.getItem(ANON_KEY);
    if (!id) {
      id = `anon-${uuid()}`;
      localStorage.setItem(ANON_KEY, id);
    }
    return id;
  } catch {
    // storage blocked (privacy mode): stable for this page load only
    memoryAnonId ??= `anon-${uuid()}`;
    return memoryAnonId;
  }
}

function toWireIdentity(options: IdentityOptions): WireIdentity {
  const wire: WireIdentity = {};
  if (options.jwt) wire.jwt = options.jwt;
  const visitorId = options.visitor?.id
    ? String(options.visitor.id)
    : options.jwt
      ? undefined
      : anonymousVisitorId();
  if (visitorId) wire.visitor = { id: visitorId };
  if (options.account?.id) wire.account = { id: String(options.account.id) };
  return wire;
}

/**
 * Talks to the public agent API for one app key. Bodies are JSON sent as
 * text/plain: a CORS "simple" request, so the browser skips the preflight
 * round trip, and keepalive requests (sent while the page unloads) work in
 * every browser.
 * @internal exported for unit tests
 */
export class AgentClient {
  constructor(
    private apiBaseUrl: string,
    private appKey: string,
    private identity: () => WireIdentity,
  ) {}

  post(path: string, body: Record<string, unknown> = {}, keepalive = false): Promise<Response> {
    return fetch(`${this.apiBaseUrl.replace(/\/$/, '')}/v1/agent/${encodeURIComponent(this.appKey)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ ...this.identity(), ...body }),
      credentials: 'omit', // the key + identity are the credentials; never send the host site's cookies
      keepalive,
    });
  }
}

// ------------------------------------------------------------
// Event bus (fire-and-forget, batched)
// ------------------------------------------------------------

const URGENT_EVENTS = new Set<GuideEventPayload['eventType']>(['guide_dismissed', 'guide_completed']);

/** @internal exported for unit tests */
export class EventQueue {
  private queue: GuideEventPayload[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushIntervalMs = 5000;
  private readonly maxBatchSize = 20;

  constructor(private client: AgentClient) {
    // Last chance to deliver queued events before the page goes away
    // (keepalive lets the request outlive the page).
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => void this.flush());
    }
  }

  push(event: GuideEventPayload): void {
    this.queue.push(event);
    // Dismiss/complete are sent right away rather than batched: the backend
    // records them per visitor, and that must land before the visitor's next
    // page load or the guide would show again.
    if (this.queue.length >= this.maxBatchSize || URGENT_EVENTS.has(event.eventType)) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  /** @internal visible for tests; normally driven by size/timer */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.queue.length);
    try {
      await this.client.post('/events', { events: batch }, true);
    } catch {
      // Fire-and-forget: never block or throw into host app. Drop the batch
      // rather than retrying indefinitely and building unbounded memory.
    }
  }
}

// ------------------------------------------------------------
// Route matching (simple wildcard support; swap for real regex if needed)
// ------------------------------------------------------------

/** @internal exported for unit tests */
export function matchesRoute(routeMatch: RouteMatch, currentPath: string): boolean {
  if (routeMatch.type === 'exact') {
    return routeMatch.value === currentPath;
  }
  // pattern: turn '/dashboard/*' into a simple prefix/wildcard check
  const escaped = routeMatch.value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(currentPath);
}

function finishedKey(guide: Guide): string {
  return `${guide.id}:${guide.versionId}`;
}

/**
 * Query parameter that starts a help-center guide on page load:
 * ?guideEngine=<guide id> (a shareable link), or ?guideEngine=help:<id> when
 * the help center sent the visitor here. Like Pendo's guide permalinks.
 */
export const LAUNCH_PARAM = 'guideEngine';

function readLaunchParam(): { guideId: string; source: 'help' | 'link' } | null {
  try {
    const raw = new URLSearchParams(window.location.search).get(LAUNCH_PARAM);
    if (!raw) return null;
    return raw.startsWith('help:')
      ? { guideId: raw.slice(5), source: 'help' }
      : { guideId: raw, source: 'link' };
  } catch {
    return null;
  }
}

/** Removes the launch parameter so a reload or a copied URL doesn't start the guide again. */
function stripLaunchParam(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(LAUNCH_PARAM)) return;
    url.searchParams.delete(LAUNCH_PARAM);
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  } catch {
    // never break the page
  }
}

function readPreviewToken(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('guidePreview');
  } catch {
    return null;
  }
}

/** Route matching is on the path only — query strings and hashes vary freely. */
function stripQueryAndHash(path: string): string {
  return path.split(/[?#]/)[0] || '/';
}

// ------------------------------------------------------------
// Core Engine
// ------------------------------------------------------------

export class GuideEngine {
  private options: SdkInitOptions | null = null;
  private identity: WireIdentity = {};
  private client: AgentClient | null = null;
  private eventQueue: EventQueue | null = null;
  private sessionId: string = uuid();
  private activeGuides = new Map<string, GuideRuntimeState>();
  /** Set once the server says the engine is off (kill switch / app disabled) or init failed. */
  private disabled = false;
  private renderer: GuideRenderer | null = null;
  private targetObservers = new Map<string, MutationObserver>();
  /** True when this page load is showing a signed preview (see startPreview). */
  private previewMode = false;
  /**
   * Guide versions the visitor dismissed/completed during this session. The
   * backend also records these, but this covers the gap before that write
   * lands so a finished guide can't flash back on the next navigation. Keyed
   * by version so a newer version may still show.
   */
  private finished = new Set<string>();
  private helpUi: HelpUi | null = null;
  private helpItems: HelpItem[] = [];
  private helpLoaded = false;
  /**
   * How a help guide on another page is reached: a normal page load (like
   * Pendo). Overridable for tests.
   * @internal
   */
  navigate: (url: string) => void = (url) => window.location.assign(url);

  /**
   * Call once at startup. Never rejects: any failure leaves the engine
   * disabled (fail closed) rather than throwing into the host app.
   */
  async init(options: SdkInitOptions, renderer: GuideRenderer, helpUi?: HelpUi): Promise<void> {
    try {
      this.options = options;
      this.renderer = renderer;
      this.helpUi = helpUi ?? null;
      this.identity = toWireIdentity(options);
      this.client = new AgentClient(options.apiBaseUrl, options.appKey, () => this.identity);
      this.eventQueue = new EventQueue(this.client);

      // Preview links (?guidePreview=<signed token>) bypass the per-guide
      // enabled flag and publish state, never the kill switches (checked
      // server-side). An invalid/expired token falls back to normal mode.
      const previewToken = readPreviewToken();
      if (previewToken && (await this.startPreview(previewToken))) return;

      // Arrived via a help-center / shared guide link: start that guide first,
      // so automatic evaluation doesn't start it a second time.
      const launch = readLaunchParam();
      if (launch) {
        await this.loadHelp();
        const item = this.helpItems.find((g) => g.id === launch.guideId);
        if (item) this.startOnDemand(item, launch.source);
        stripLaunchParam();
      }

      await this.evaluateGuidesForRoute(stripQueryAndHash(window.location.pathname));
      if (!this.disabled && !this.helpLoaded) await this.loadHelp();
    } catch {
      this.disabled = true;
    }
  }

  // ------------------------------------------------------------
  // Help center
  // ------------------------------------------------------------

  /** Opens the help center (for a product's own help button). */
  openHelp(): void {
    if (this.disabled || this.previewMode) return;
    this.helpUi?.open();
  }

  closeHelp(): void {
    this.helpUi?.close();
  }

  toggleHelp(): void {
    if (this.helpUi?.isOpen()) this.closeHelp();
    else this.openHelp();
  }

  /**
   * Starts a help-center guide for the visitor. On the guide's own page it
   * starts immediately (even if they finished it before: help is on demand).
   * Elsewhere, the visitor is asked first (the help UI's confirmation modal),
   * then sent to the guide's start page with a launch parameter; the guide
   * starts when that page loads.
   */
  launchHelpGuide(guideId: string): void {
    const item = this.helpItems.find((g) => g.id === guideId);
    if (!item || this.disabled) return;
    const here = stripQueryAndHash(window.location.pathname);
    if (matchesRoute(item.routeMatch, here)) {
      this.helpUi?.close();
      this.startOnDemand(item, 'help');
      return;
    }
    let target: string;
    try {
      const url = new URL(item.help.startPath, window.location.origin);
      if (url.origin !== window.location.origin) return; // help links never leave the site
      url.searchParams.set(LAUNCH_PARAM, `help:${item.id}`);
      target = url.pathname + url.search + url.hash;
    } catch {
      return; // malformed start page: do nothing rather than break the page
    }
    const go = () => this.navigate(target);
    if (this.helpUi?.confirmNavigation) {
      this.helpUi.confirmNavigation(item, go);
    } else {
      this.helpUi?.close();
      go();
    }
  }

  /** (Re)starts a guide on request, regardless of whether the visitor already finished it. */
  private startOnDemand(guide: Guide, source: 'help' | 'link'): void {
    if (this.activeGuides.has(guide.id)) this.teardownGuide(guide.id);
    this.finished.delete(finishedKey(guide));
    this.startGuide(guide, source);
  }

  /** Fetches this visitor's help-center guides and settings, and updates the help UI. */
  private async loadHelp(): Promise<void> {
    if (!this.client) return;
    this.helpLoaded = true;
    let items: HelpItem[] = [];
    let button: HelpButtonSettings = { label: 'Help', color: '#4f46e5' };
    try {
      const res = await this.client.post('/help');
      if (res.ok) {
        const data = (await res.json()) as {
          enabled?: unknown;
          guides?: unknown;
          button?: HelpButtonSettings;
        } | null;
        if (data?.enabled === true && Array.isArray(data.guides)) {
          items = (data.guides as HelpItem[]).filter((g) => g?.help && typeof g.help.title === 'string');
          if (data.button) button = data.button;
        }
      }
    } catch {
      // fail closed: no help center
    }
    this.helpItems = items;
    this.helpUi?.update({
      items,
      button,
      showButton: this.options?.helpButton !== false && items.length > 0,
    });
  }

  /** Call on every SPA route change. The install-snippet agent does this automatically. */
  async onRouteChange(newPath: string): Promise<void> {
    if (this.disabled || this.previewMode || !this.client) return;
    try {
      await this.evaluateGuidesForRoute(stripQueryAndHash(newPath));
    } catch {
      // never throw into the host app's router hooks
    }
  }

  /**
   * Switch to a different end user (e.g. after login). Clears what the
   * previous user was shown and re-evaluates the current page.
   */
  async identify(identity: IdentityOptions): Promise<void> {
    if (!this.options || !this.client) return;
    try {
      await this.eventQueue?.flush(); // the old user's events go out under the old identity
      this.options = { ...this.options, ...identity };
      this.identity = toWireIdentity(this.options);
      for (const id of [...this.activeGuides.keys()]) this.teardownGuide(id);
      this.finished.clear();
      if (!this.disabled && !this.previewMode) {
        await this.evaluateGuidesForRoute(stripQueryAndHash(window.location.pathname));
        if (!this.disabled) await this.loadHelp(); // the new user's help list (account targeting)
      }
    } catch {
      // fail silent
    }
  }

  /**
   * Asks the backend to verify a preview token and return the version it
   * names. The signature can only be checked server-side (the secret never
   * reaches the browser), so "valid" here means "the backend accepted it".
   */
  private async startPreview(token: string): Promise<boolean> {
    try {
      const res = await this.client!.post('/preview', { token });
      if (!res.ok) return false;
      const guide = (await res.json()) as Guide;
      if (!guide || typeof guide.id !== 'string' || !Array.isArray(guide.steps)) return false;

      this.previewMode = true;
      // Force-render: no route matching, no enabled/publish checks.
      this.startGuide({ ...guide, preview: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One request returns the kill-switch state and this visitor's candidate
   * guides. Fail closed: an explicit enabled:false disables the agent for the
   * rest of the page's life; any other failure (network, non-2xx, malformed
   * body) shows nothing for this navigation.
   */
  private async evaluateGuidesForRoute(path: string): Promise<void> {
    if (!this.client) return;

    let guides: Guide[];
    try {
      const res = await this.client.post('/guides');
      if (!res.ok) return;
      const data = (await res.json()) as { enabled?: unknown; guides?: unknown } | null;
      if (data?.enabled === false) {
        this.disabled = true;
        return;
      }
      if (data?.enabled !== true || !Array.isArray(data.guides)) return;
      guides = data.guides as Guide[];
    } catch {
      return; // silent failure — never block the host app
    }

    const matched = guides.filter((g) => g?.routeMatch && matchesRoute(g.routeMatch, path));

    for (const guide of matched) {
      if (this.activeGuides.has(guide.id)) continue; // already showing/tracked
      if (this.finished.has(finishedKey(guide))) continue; // visitor already dismissed/completed it
      this.startGuide(guide);
    }
  }

  private startGuide(guide: Guide, source?: 'help' | 'link'): void {
    const state: GuideRuntimeState = {
      guide,
      status: 'matching',
      currentStepIndex: 0,
      source,
    };
    this.activeGuides.set(guide.id, state);
    this.showCurrentStep(state);
  }

  private showCurrentStep(state: GuideRuntimeState): void {
    const step = state.guide.steps[state.currentStepIndex];
    if (!step) {
      this.completeGuide(state);
      return;
    }

    const targetEl = step.targetSelector ? document.querySelector(step.targetSelector) : null;

    if (step.targetSelector && !targetEl) {
      // Target not yet in the DOM (common in SPAs) — watch for it to appear.
      this.watchForTarget(state, step);
      return;
    }

    // A new step replaces whatever the previous step was tracking. Without
    // this, a targeted step's observer outlived it and re-rendered the NEXT
    // step (e.g. a centered modal) next to the old step's element on the
    // first unrelated DOM change.
    this.stopObserving(state.guide.id);

    state.status = 'showing';
    this.renderer?.renderStep(state.guide, step, targetEl);
    this.emitEvent(state, step.id, state.currentStepIndex === 0 ? 'guide_shown' : 'guide_step_viewed');

    if (targetEl) {
      this.observeTarget(state.guide.id, step);
    }
  }

  private stopObserving(guideId: string): void {
    this.targetObservers.get(guideId)?.disconnect();
    this.targetObservers.delete(guideId);
  }

  private watchForTarget(state: GuideRuntimeState, step: Step, attempt = 0): void {
    const maxAttempts = 10;
    if (attempt >= maxAttempts) {
      state.status = 'error';
      this.emitEvent(state, step.id, 'guide_error', { reason: 'target_not_found' });
      this.activeGuides.delete(state.guide.id);
      return;
    }
    setTimeout(
      () => {
        const el = document.querySelector(step.targetSelector!);
        if (el) {
          this.showCurrentStep(state);
        } else {
          this.watchForTarget(state, step, attempt + 1);
        }
      },
      300 * (attempt + 1),
    ); // backoff
  }

  private observeTarget(guideId: string, step: Step): void {
    this.stopObserving(guideId);
    let frameScheduled = false;
    const observer = new MutationObserver((mutations) => {
      // Ignore mutations caused by our own guide hosts: the renderer writes
      // host.style on every render, which is itself an attribute mutation
      // under <body> and would otherwise re-trigger this observer forever.
      const external = mutations.some(
        (m) => !(m.target instanceof Element && m.target.closest('[data-guide-host]')),
      );
      if (!external || frameScheduled) return;

      // Coalesce bursts of host-app mutations into one re-render per frame.
      frameScheduled = true;
      requestAnimationFrame(() => {
        frameScheduled = false;
        // Re-render position on relevant DOM mutations. Actual repositioning
        // logic lives in the renderer; this just triggers a re-render call.
        const state = this.activeGuides.get(guideId);
        // Only for the step this observer was created for, and against the
        // target as it is NOW — SPAs often re-mount elements, so a captured
        // element reference can go stale. If it's gone, keep the last position.
        if (!state || state.status !== 'showing' || state.guide.steps[state.currentStepIndex] !== step)
          return;
        const target = document.querySelector(step.targetSelector!);
        if (target) this.renderer?.renderStep(state.guide, step, target);
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    this.targetObservers.set(guideId, observer);
  }

  /** Called by the renderer when the user clicks "Next". */
  advanceStep(guideId: string): void {
    const state = this.activeGuides.get(guideId);
    if (!state) return;

    const step = state.guide.steps[state.currentStepIndex];
    this.emitEvent(state, step.id, 'guide_step_completed');

    state.currentStepIndex += 1;
    this.showCurrentStep(state);
  }

  /** Called by the renderer when the user dismisses the guide. */
  dismissGuide(guideId: string): void {
    const state = this.activeGuides.get(guideId);
    if (!state) return;

    state.status = 'dismissed';
    const step = state.guide.steps[state.currentStepIndex];
    this.emitEvent(state, step?.id, 'guide_dismissed');
    this.finished.add(finishedKey(state.guide));
    this.teardownGuide(guideId);
  }

  private completeGuide(state: GuideRuntimeState): void {
    state.status = 'completed';
    this.emitEvent(state, undefined, 'guide_completed');
    this.finished.add(finishedKey(state.guide));
    this.teardownGuide(state.guide.id);
  }

  private teardownGuide(guideId: string): void {
    this.renderer?.clear(guideId);
    this.stopObserving(guideId);
    this.activeGuides.delete(guideId);
  }

  private emitEvent(
    state: GuideRuntimeState,
    stepId: string | undefined,
    eventType: GuideEventPayload['eventType'],
    metadata?: Record<string, unknown>,
  ): void {
    if (!this.options || !this.eventQueue) return;
    // Authors clicking through a preview must not pollute real analytics.
    if (this.previewMode) return;
    // Runs started from the help center / a link are tagged on every event.
    const tagged = state.source ? { ...metadata, source: state.source } : metadata;
    this.eventQueue.push({
      guideId: state.guide.id,
      guideVersionId: state.guide.versionId,
      stepId,
      sessionId: this.sessionId,
      eventType,
      occurredAt: new Date().toISOString(),
      metadata: tagged,
    });
  }
}
