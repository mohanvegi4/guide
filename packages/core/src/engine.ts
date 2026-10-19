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

class EventQueue {
  private queue: GuideEventPayload[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushIntervalMs = 5000;
  private readonly maxBatchSize = 20;

  constructor(private apiBaseUrl: string) {}

  push(event: GuideEventPayload): void {
    this.queue.push(event);
    if (this.queue.length >= this.maxBatchSize) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.queue.length);
    try {
      await fetch(`${this.apiBaseUrl}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

function matchesRoute(routeMatch: RouteMatch, currentPath: string): boolean {
  if (routeMatch.type === 'exact') {
    return routeMatch.value === currentPath;
  }
  // pattern: turn '/dashboard/*' into a simple prefix/wildcard check
  const escaped = routeMatch.value
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(currentPath);
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

  /** Call once at app startup. */
  async init(options: SdkInitOptions, renderer: GuideRenderer): Promise<void> {
    this.options = options;
    this.eventQueue = new EventQueue(options.apiBaseUrl);
    this.renderer = renderer;

    const flagsOk = await this.checkKillSwitches();
    if (!flagsOk) return; // engine disabled globally or for this tenant — do nothing further

    await this.evaluateGuidesForRoute(window.location.pathname);
  }

  /** Call on every SPA route change (Angular Router NavigationEnd / Vue Router afterEach). */
  async onRouteChange(newPath: string): Promise<void> {
    if (!this.globalEnabled || !this.tenantEnabled) return;
    await this.evaluateGuidesForRoute(newPath);
  }

  private async checkKillSwitches(): Promise<boolean> {
    if (!this.options) return false;
    try {
      const res = await fetch(
        `${this.options.apiBaseUrl}/system/flag?tenantId=${encodeURIComponent(this.options.tenantId)}`
      );
      const data = await res.json();
      this.globalEnabled = data.globalEnabled !== false;
      this.tenantEnabled = data.tenantEnabled !== false;
    } catch {
      // Network failure: fail closed on the side of "don't show guides" rather
      // than risk showing something when we can't confirm it's safe to.
      this.globalEnabled = false;
      this.tenantEnabled = false;
    }
    return this.globalEnabled && this.tenantEnabled;
  }

  private async evaluateGuidesForRoute(path: string): Promise<void> {
    if (!this.options) return;

    let guides: Guide[] = [];
    try {
      const res = await fetch(
        `${this.options.apiBaseUrl}/guides/active?tenantId=${encodeURIComponent(
          this.options.tenantId
        )}&route=${encodeURIComponent(path)}`
      );
      guides = await res.json();
    } catch {
      return; // silent failure — never block the host app
    }

    const matched = guides.filter((g) => matchesRoute(g.routeMatch, path));

    for (const guide of matched) {
      if (this.activeGuides.has(guide.id)) continue; // already showing/tracked
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

    state.status = 'showing';
    this.renderer?.renderStep(state.guide, step, targetEl);
    this.emitEvent(state, step.id, state.currentStepIndex === 0 ? 'guide_shown' : 'guide_step_viewed');

    if (targetEl) {
      this.observeTarget(state.guide.id, targetEl);
    }
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

  private observeTarget(guideId: string, el: Element): void {
    this.targetObservers.get(guideId)?.disconnect();
    const observer = new MutationObserver(() => {
      // Re-render position on relevant DOM mutations. Actual repositioning
      // logic lives in the renderer; this just triggers a re-render call.
      const state = this.activeGuides.get(guideId);
      if (state && state.status === 'showing') {
        const step = state.guide.steps[state.currentStepIndex];
        this.renderer?.renderStep(state.guide, step, el);
      }
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
    this.teardownGuide(guideId);
  }

  private completeGuide(state: GuideRuntimeState): void {
    state.status = 'completed';
    this.emitEvent(state, undefined, 'guide_completed');
    this.teardownGuide(state.guide.id);
  }

  private teardownGuide(guideId: string): void {
    this.renderer?.clear(guideId);
    this.targetObservers.get(guideId)?.disconnect();
    this.targetObservers.delete(guideId);
    this.activeGuides.delete(guideId);
  }

  private emitEvent(
    state: GuideRuntimeState,
    stepId: string | undefined,
    eventType: GuideEventPayload['eventType'],
    metadata?: Record<string, unknown>
  ): void {
    if (!this.options || !this.eventQueue) return;
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
