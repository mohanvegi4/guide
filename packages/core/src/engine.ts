/**
 * Guide Runtime SDK — Core Engine
 * Framework-agnostic. Angular/Vue wrappers sit on top of this and only
 * handle: (1) calling init() at app startup, (2) calling onRouteChange()
 * on navigation, (3) rendering — this file owns state, not DOM painting.
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
  content: string;         // sanitized HTML
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
  tenantId: string | null;
  isGlobal: boolean;
  name: string;
  type: GuideType;
  steps: Step[];
  routeMatch: RouteMatch;
  /** Set when force-rendered from a signed preview link (renderer shows a badge). */
  preview?: boolean;
}

export type GuideRuntimeStatus =
  | 'idle'
  | 'matching'
  | 'showing'
  | 'completed'
  | 'dismissed'
  | 'error';

export interface GuideRuntimeState {
  guide: Guide;
  status: GuideRuntimeStatus;
  currentStepIndex: number;
}

export interface SdkInitOptions {
  tenantId: string;
  userId: string;
  apiBaseUrl: string;
  /**
   * Returns the end user's bearer token for the guide-engine backend. The
   * backend derives tenant and user from this token only — tenantId/userId
   * above are informational for the host app and are never trusted
   * server-side. Called per request so the host app can refresh tokens.
   */
  getAuthToken: () => string | Promise<string>;
  traits?: Record<string, unknown>;
  locale?: string;
}

export interface GuideEventPayload {
  tenantId: string;
  guideId: string;
  guideVersionId: string;
  stepId?: string;
  userId: string;
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
// Event bus (fire-and-forget, batched)
// ------------------------------------------------------------

const URGENT_EVENTS = new Set<GuideEventPayload['eventType']>(['guide_dismissed', 'guide_completed']);

/** @internal exported for unit tests */
export class EventQueue {
  private queue: GuideEventPayload[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushIntervalMs = 5000;
  private readonly maxBatchSize = 20;

  constructor(
    private apiBaseUrl: string,
    private getAuthToken: () => string | Promise<string>
  ) {
    // Last chance to deliver queued events before the page goes away
    // (keepalive lets the request outlive the page).
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => void this.flush());
    }
  }

  push(event: GuideEventPayload): void {
    this.queue.push(event);
    // Dismiss/complete are sent right away rather than batched: the backend
    // records them per user, and that must land before the user's next page
    // load or the guide would show again.
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
      const token = await this.getAuthToken();
      await fetch(`${this.apiBaseUrl}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ events: batch }),
        keepalive: true, // survive page unload
      });
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
  const escaped = routeMatch.value
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(currentPath);
}

function finishedKey(guide: Guide): string {
  return `${guide.id}:${guide.versionId}`;
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
  private eventQueue: EventQueue | null = null;
  private sessionId: string = crypto.randomUUID();
  private activeGuides = new Map<string, GuideRuntimeState>();
  private globalEnabled = true;
  private tenantEnabled = true;
  private renderer: GuideRenderer | null = null;
  private targetObservers = new Map<string, MutationObserver>();
  /** True when this page load is showing a signed preview (see startPreview). */
  private previewMode = false;
  /**
   * Guide versions the user dismissed/completed during this session. The
   * backend also records these (user_guide_state), but this covers the gap
   * before that write lands so a finished guide can't flash back on the next
   * navigation. Keyed by version so a newer version may still show.
   */
  private finished = new Set<string>();

  /**
   * Call once at app startup. Never rejects: any failure leaves the engine
   * disabled (fail closed) rather than throwing into the host app.
   */
  async init(options: SdkInitOptions, renderer: GuideRenderer): Promise<void> {
    try {
      this.options = options;
      this.eventQueue = new EventQueue(options.apiBaseUrl, options.getAuthToken);
      this.renderer = renderer;

      const flagsOk = await this.checkKillSwitches();
      if (!flagsOk) return; // engine disabled globally or for this tenant — do nothing further

      // Preview links (?guidePreview=<signed token>) still respect the kill
      // switches above; they only bypass the per-guide enabled flag and
      // publish state. An invalid/expired token falls back to normal mode.
      const previewToken = readPreviewToken();
      if (previewToken && (await this.startPreview(previewToken))) return;

      await this.evaluateGuidesForRoute(window.location.pathname);
    } catch {
      this.globalEnabled = false;
      this.tenantEnabled = false;
    }
  }

  /** Call on every SPA route change (Angular Router NavigationEnd / Vue Router afterEach). */
  async onRouteChange(newPath: string): Promise<void> {
    if (!this.globalEnabled || !this.tenantEnabled) return;
    if (this.previewMode) return; // a preview session shows only the previewed guide
    try {
      await this.evaluateGuidesForRoute(stripQueryAndHash(newPath));
    } catch {
      // never throw into the host app's router hooks
    }
  }

  /** GET against the backend with the end user's bearer token. */
  private async apiGet(path: string): Promise<Response> {
    const token = await this.options!.getAuthToken();
    return fetch(`${this.options!.apiBaseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  /**
   * Asks the backend to verify a preview token and return the version it
   * names. The signature can only be checked server-side (the secret never
   * reaches the browser), so "valid" here means "the backend accepted it".
   */
  private async startPreview(token: string): Promise<boolean> {
    try {
      const auth = await this.options!.getAuthToken();
      const res = await fetch(`${this.options!.apiBaseUrl}/preview/guide`, {
        headers: { Authorization: `Bearer ${auth}`, 'X-Guide-Preview': token },
      });
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

  private async checkKillSwitches(): Promise<boolean> {
    if (!this.options) return false;
    // Fail closed: anything other than an explicit, successful "true" from
    // the backend disables the engine. Previously a 401/500 body ({error})
    // was read as "enabled" because only `=== false` was treated as off.
    this.globalEnabled = false;
    this.tenantEnabled = false;
    try {
      const res = await this.apiGet('/system/flag');
      if (!res.ok) return false;
      const data = await res.json();
      this.globalEnabled = data?.globalEnabled === true;
      this.tenantEnabled = data?.tenantEnabled === true;
    } catch {
      // Network failure: fail closed on the side of "don't show guides" rather
      // than risk showing something when we can't confirm it's safe to.
    }
    return this.globalEnabled && this.tenantEnabled;
  }

  private async evaluateGuidesForRoute(path: string): Promise<void> {
    if (!this.options) return;

    let guides: Guide[] = [];
    try {
      const res = await this.apiGet('/guides/active');
      if (!res.ok) return;
      const data: unknown = await res.json();
      if (!Array.isArray(data)) return; // unexpected shape — show nothing
      guides = data as Guide[];
    } catch {
      return; // silent failure — never block the host app
    }

    const matched = guides.filter((g) => g?.routeMatch && matchesRoute(g.routeMatch, path));

    for (const guide of matched) {
      if (this.activeGuides.has(guide.id)) continue; // already showing/tracked
      if (this.finished.has(finishedKey(guide))) continue; // user already dismissed/completed it
      this.startGuide(guide);
    }
  }

  private startGuide(guide: Guide): void {
    const state: GuideRuntimeState = {
      guide,
      status: 'matching',
      currentStepIndex: 0,
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

    const targetEl = step.targetSelector
      ? document.querySelector(step.targetSelector)
      : null;

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
    setTimeout(() => {
      const el = document.querySelector(step.targetSelector!);
      if (el) {
        this.showCurrentStep(state);
      } else {
        this.watchForTarget(state, step, attempt + 1);
      }
    }, 300 * (attempt + 1)); // backoff
  }

  private observeTarget(guideId: string, step: Step): void {
    this.stopObserving(guideId);
    let frameScheduled = false;
    const observer = new MutationObserver((mutations) => {
      // Ignore mutations caused by our own guide hosts: the renderer writes
      // host.style on every render, which is itself an attribute mutation
      // under <body> and would otherwise re-trigger this observer forever.
      const external = mutations.some(
        (m) => !(m.target instanceof Element && m.target.closest('[data-guide-host]'))
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
        if (!state || state.status !== 'showing' || state.guide.steps[state.currentStepIndex] !== step) return;
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
    metadata?: Record<string, unknown>
  ): void {
    if (!this.options || !this.eventQueue) return;
    // Authors clicking through a preview must not pollute real analytics.
    if (this.previewMode) return;
    this.eventQueue.push({
      tenantId: this.options.tenantId,
      guideId: state.guide.id,
      guideVersionId: state.guide.versionId,
      stepId,
      userId: this.options.userId,
      sessionId: this.sessionId,
      eventType,
      occurredAt: new Date().toISOString(),
      metadata,
    });
  }
}
