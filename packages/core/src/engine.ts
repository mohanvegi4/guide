/**
 * Guide Runtime SDK — Core Engine
 * Framework-agnostic. The install-snippet agent (packages/agent) and the
 * Angular/Vue wrappers sit on top of this and only handle: (1) calling init()
 * at startup, (2) calling onRouteChange() on navigation, (3) identify() after
 * login. Rendering is injected — this file owns state, not DOM painting.
 */

import { GuideTheme, readTheme, sameTheme } from './theme';

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

export interface StepAction {
  label: string;
  action: 'next' | 'back' | 'dismiss' | 'complete' | 'custom';
  customHandler?: string; // name of a registered custom handler, resolved by the renderer
}

export interface Step {
  id: string;
  order: number;
  targetSelector?: string; // e.g. '[data-guide-id="invite-button"]'
  content: string; // sanitized HTML
  position?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  actions: StepAction[];
}

export interface RouteMatch {
  type: 'exact' | 'pattern';
  value: string; // exact path or a wildcard/regex-ish pattern like '/dashboard/*'
}

/**
 * How the host app's router addresses pages (an app setting the server sends
 * with every /guides and /help response):
 *   'path'  /settings/team     routes are matched on location.pathname
 *   'hash'  /#/settings/team   routes are matched on the path inside location.hash
 */
export type RouteMode = 'path' | 'hash';

export interface Guide {
  id: string;
  versionId: string;
  name: string;
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
  /**
   * New list / settings. showButton=false hides the floating button (the
   * panel still opens via openHelp()). routeMode says how to read the
   * current page and how to show start pages ("/team" vs "/#/team").
   */
  update(state: {
    items: HelpItem[];
    button: HelpButtonSettings;
    showButton: boolean;
    routeMode?: RouteMode;
    /** The app's look; null until the backend has sent one. */
    theme?: GuideTheme | null;
  }): void;
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

/**
 * The end user (Pendo calls them visitors). Only `id` and `tags` are sent to
 * the server; other keys are ignored. Initialized without an `id`, the visitor
 * is anonymous (a random id is kept per browser) but can still carry tags,
 * e.g. ["anonymous"]. In identify(), a visitor without an `id` key keeps the
 * current id (a tags update); pass `id: undefined` to become anonymous.
 */
export interface Visitor {
  id?: string;
  /**
   * What this visitor may do in your application, as short strings you
   * choose (e.g. "POINT_OF_SALE", "CUSTOMERS:edit"). A guide limited to
   * visitor tags shows only to visitors carrying at least one of them.
   * Letters, digits and _ . : / - only, up to 100 characters each and 1000
   * tags; anything else is dropped. With signed identity, put them in the
   * token's visitor claim instead (tags sent beside a token are ignored).
   */
  tags?: string[];
  [key: string]: unknown;
}

/** The end user's company/customer, used for account targeting. */
export interface Account {
  id: string;
  [key: string]: unknown;
}

export interface IdentityOptions {
  /** The signed-in end user. Omit it, or its id, for anonymous visitors (a random id is kept per browser). */
  visitor?: Visitor;
  account?: Account | null;
  /**
   * A JWT your BACKEND signed with the app's signing secret, carrying
   * { visitor: { id, tags? }, account?: { id } }. Required when the app has
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
  /** The agent build in use; attached to error reports (the snippet agent fills it in). */
  agentVersion?: string;
}

export interface GuideEventPayload {
  /** Absent on help-center events (help_opened / help_searched), which are about the panel, not a guide. */
  guideId?: string;
  guideVersionId?: string;
  stepId?: string;
  sessionId: string;
  eventType:
    | 'guide_shown'
    | 'guide_step_viewed'
    | 'guide_step_completed'
    | 'guide_dismissed'
    | 'guide_completed'
    | 'guide_error'
    | 'survey_response'
    | 'help_opened'
    | 'help_searched';
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

/** The longest search query recorded on a help_searched event (the server caps it too). */
export const HELP_QUERY_MAX = 200;

// Renderer is injected — the core engine never touches the DOM directly.
export interface GuideRenderer {
  renderStep(guide: Guide, step: Step, targetEl: Element | null): void;
  clear(guideId: string): void;
  /** The app's look (see theme.ts). Optional: a custom renderer may style itself. */
  setTheme?(theme: GuideTheme): void;
}

// ------------------------------------------------------------
// Transport
// ------------------------------------------------------------

/** What every agent request carries to identify the end user. */
interface WireIdentity {
  visitor?: { id: string; tags?: string[] };
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

/**
 * Mirrors the backend's rule (auth/visitor.ts), which ignores malformed tags
 * too; dropping them here keeps them off the wire.
 */
const VISITOR_TAG = /^[A-Za-z0-9_.:/-]{1,100}$/;
const MAX_VISITOR_TAGS = 1000;

/** Well-formed, de-duplicated tags; anything else dropped. */
function cleanVisitorTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const kept = tags.filter((t): t is string => typeof t === 'string' && VISITOR_TAG.test(t));
  return [...new Set(kept)].slice(0, MAX_VISITOR_TAGS);
}

function toWireIdentity(options: IdentityOptions): WireIdentity {
  const wire: WireIdentity = {};
  if (options.jwt) wire.jwt = options.jwt;
  const visitorId = options.visitor?.id
    ? String(options.visitor.id)
    : options.jwt
      ? undefined
      : anonymousVisitorId();
  if (visitorId) {
    wire.visitor = { id: visitorId };
    // A signed token carries its own tags; the server ignores any sent beside it.
    const tags = options.jwt ? [] : cleanVisitorTags(options.visitor?.tags);
    if (tags.length > 0) wire.visitor.tags = tags;
  }
  if (options.account?.id) wire.account = { id: String(options.account.id) };
  return wire;
}

/** Endpoints that target guides by visitor tags; every other one is sent without them. */
const TAGGED_PATHS = new Set(['/guides', '/help']);
/** Endpoints that never read the visitor's identity, so none is sent. */
const ANONYMOUS_PATHS = new Set(['/errors', '/preview']);
/**
 * Browsers refuse a keepalive request once the keepalive bodies in flight add
 * up to more than 64 KiB. A larger body is sent as an ordinary request: it
 * still arrives unless the page is closing.
 */
const KEEPALIVE_BODY_LIMIT = 60 * 1024;

const utf8 = typeof TextEncoder === 'undefined' ? null : new TextEncoder();
/** UTF-8 size of a request body (an over-estimate where TextEncoder is missing). */
function byteLength(text: string): number {
  return utf8 ? utf8.encode(text).length : text.length * 3;
}

/** The identity a request to `path` needs: tags only where they're matched, nothing where it's unused. */
function identityFor(path: string, identity: WireIdentity): WireIdentity | Record<string, never> {
  if (ANONYMOUS_PATHS.has(path)) return {};
  if (TAGGED_PATHS.has(path) || !identity.visitor?.tags) return identity;
  return { ...identity, visitor: { id: identity.visitor.id } };
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
    const json = JSON.stringify({ ...identityFor(path, this.identity()), ...body });
    return fetch(`${this.apiBaseUrl.replace(/\/$/, '')}/v1/agent/${encodeURIComponent(this.appKey)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: json,
      credentials: 'omit', // the key + identity are the credentials; never send the host site's cookies
      // The limit is in bytes; a JS string length counts UTF-16 units, up to 3 bytes each.
      keepalive: keepalive && byteLength(json) <= KEEPALIVE_BODY_LIMIT,
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
      // A keepalive request is refused outright when other keepalive requests
      // already use the browser's 64 KiB budget; while the page is still open
      // an ordinary request gets through. One retry, then fire-and-forget:
      // never block or throw into the host app, and never build unbounded memory.
      try {
        await this.client.post('/events', { events: batch });
      } catch {
        // dropped
      }
    }
  }
}

// ------------------------------------------------------------
// Error reporting
// ------------------------------------------------------------

/**
 * The engine fails silent towards the host page, which also means nobody
 * hears about a bug unless it's reported somewhere. reportError (below)
 * sends a sampled, capped trickle of them to POST /v1/agent/:key/errors.
 * @internal exported for unit tests
 */
export const ERROR_SAMPLE_RATE = 0.1;
/** @internal exported for unit tests */
export const MAX_ERROR_REPORTS_PER_PAGE = 5;

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
 * Query parameter that starts a guide on page load: ?guideEngine=<guide id>
 * (a shareable link, like Pendo's guide permalinks). ?guideEngine=help:<id>
 * is the help center's hand-off when session storage is unavailable.
 */
export const LAUNCH_PARAM = 'guideEngine';

/**
 * How the help center hands "start guide X" to the page it sends the visitor
 * to: an entry in this tab's session storage, not the URL, so nothing shows
 * in the address bar and a host router that rewrites the URL on boot can't
 * put it back. Scoped to the app key; expires so a hand-off whose page never
 * loaded doesn't fire minutes later.
 */
export const LAUNCH_STORAGE_KEY = 'guideEngine.launch';
const LAUNCH_TTL_MS = 60_000;

/** Records a help hand-off. False when storage is unavailable: the caller falls back to the URL. */
function storeHelpLaunch(appKey: string, guideId: string): boolean {
  try {
    window.sessionStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify({ appKey, guideId, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

/** This app's pending help hand-off, if one is fresh. Expired or malformed entries are cleared. */
function readHelpLaunch(appKey: string): string | null {
  try {
    const raw = window.sessionStorage.getItem(LAUNCH_STORAGE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as { appKey?: unknown; guideId?: unknown; at?: unknown };
    const fresh = typeof entry.at === 'number' && Date.now() - entry.at < LAUNCH_TTL_MS;
    if (!fresh || typeof entry.guideId !== 'string') {
      clearHelpLaunch();
      return null;
    }
    // Another app on the same site (another key) keeps its own hand-off.
    return entry.appKey === appKey ? entry.guideId : null;
  } catch {
    return null;
  }
}

function clearHelpLaunch(): void {
  try {
    window.sessionStorage.removeItem(LAUNCH_STORAGE_KEY);
  } catch {
    // never break the page
  }
}

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

/** Automatic display order on a page: walkthroughs first, then single-step guides. */
function autoShowRank(guide: Guide): number {
  return (guide.steps?.length ?? 0) > 1 ? 0 : 1;
}

/** Route matching is on the path only — query strings and hashes vary freely. */
function stripQueryAndHash(path: string): string {
  return path.split(/[?#]/)[0] || '/';
}

/**
 * The page the visitor is on, as routes are written for this app: the URL
 * path, or for hash routers the path inside the fragment ("#/team?x=1" is
 * "/team"; no fragment is the root).
 */
export function currentRoutePath(mode: RouteMode, loc: Location = window.location): string {
  if (mode === 'hash') return loc.hash.slice(1).split('?')[0] || '/';
  return stripQueryAndHash(loc.pathname);
}

/** How a start page is shown to visitors: "/team", or "/#/team" for hash routers. */
export function displayRoutePath(mode: RouteMode, path: string): string {
  return mode === 'hash' ? `/#${path}` : path;
}

// ------------------------------------------------------------
// Core Engine
// ------------------------------------------------------------

export class GuideEngine {
  private options: SdkInitOptions | null = null;
  private identity: WireIdentity = {};
  /**
   * Bumped whenever identify() switches the identity. A response requested
   * under an earlier identity is dropped when it arrives, so guides chosen for
   * the previous visitor (or their old tags) never start for the new one.
   */
  private identityGeneration = 0;
  /** Counts identify() calls, so the latest of overlapping calls is the one applied. */
  private identifyCalls = 0;
  /** What overlapping identify() calls asked for so far; a later partial call builds on it. */
  private requestedOptions: SdkInitOptions | null = null;
  /**
   * A shared-guide link or help-center hand-off this page was opened with,
   * started once the help list arrives. `handOff`: it came from session
   * storage, so it only starts on the guide's own page (the hand-off may have
   * landed on a redirect, such as a sign-in page).
   */
  private pendingLaunch: { guideId: string; source: 'help' | 'link'; handOff?: boolean } | null = null;
  /** identify(null): nobody is signed in, so nothing is fetched or shown until the next identify(). */
  private signedOut = false;
  private client: AgentClient | null = null;
  private eventQueue: EventQueue | null = null;
  private sessionId: string = uuid();
  private activeGuides = new Map<string, GuideRuntimeState>();
  /**
   * Guides that match the current page but are waiting their turn: only one
   * guide shows at a time (see evaluateGuidesForRoute / showNextQueued).
   */
  private queued: Guide[] = [];
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
  /** Error reports sent during this page load (see reportError). */
  private errorReports = 0;
  private helpButton: HelpButtonSettings = { label: 'Help', color: '#4f46e5' };
  /**
   * Where routes live in the URL. The server sends it with every /guides and
   * /help response; until the first one arrives the engine assumes paths.
   */
  private routeMode: RouteMode = 'path';
  /** The app's look, from the latest /guides, /help or /preview answer. */
  private theme: GuideTheme | null = null;
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

      // Arrived via a shared guide link or a help-center hand-off: start that
      // guide first, so automatic evaluation doesn't start it a second time.
      const handedOff = readHelpLaunch(options.appKey);
      const launch =
        readLaunchParam() ?? (handedOff ? { guideId: handedOff, source: 'help' as const, handOff: true } : null);
      if (launch) {
        this.pendingLaunch = launch;
        stripLaunchParam();
        // Started by the first help list fetched for the current identity: this
        // one, or identify()'s if the visitor changes before this answer lands.
        await this.loadHelp();
      }

      await this.evaluateGuidesForRoute();
      if (!this.disabled && !this.helpLoaded) await this.loadHelp();
    } catch (err) {
      this.disabled = true;
      this.reportError(err, 'init');
    }
  }

  /**
   * Tells the backend about an exception the engine swallowed, so operators
   * learn about broken pages. Fail silent also applies here: a failed report
   * is dropped. Sampled client-side (ERROR_SAMPLE_RATE) and capped per page
   * load, so a page that throws in a loop can't flood the API; the backend
   * caps per app on top of that.
   */
  reportError(err: unknown, context: string): void {
    try {
      if (!this.client || this.errorReports >= MAX_ERROR_REPORTS_PER_PAGE) return;
      if (Math.random() >= ERROR_SAMPLE_RATE) return;
      this.errorReports += 1;
      const error = err instanceof Error ? err : null;
      const message = `${context}: ${error ? error.message : String(err)}`.slice(0, 500);
      const report: Record<string, unknown> = { message };
      if (error?.stack) report.stack = error.stack.slice(0, 4000);
      if (this.options?.agentVersion) report.agentVersion = this.options.agentVersion;
      try {
        report.url = window.location.href.slice(0, 2000);
      } catch {
        // no location (non-browser host): the report still carries the message
      }
      // keepalive: the error may have happened while the page is going away.
      this.client.post('/errors', report, true).catch(() => undefined);
    } catch {
      // reporting must never become a second error
    }
  }

  /** The page the visitor is on, as routes are written for this app (see RouteMode). */
  currentPath(): string {
    return currentRoutePath(this.routeMode);
  }

  /** Whether `path` is where a help guide runs: its route, or its start page. */
  private isGuidePage(item: HelpItem, path: string): boolean {
    return matchesRoute(item.routeMatch, path) || this.isCurrentPage(item.help.startPath);
  }

  /** Whether a help start page (a same-site path, maybe with a query) is the page the visitor is on. */
  private isCurrentPage(startPath: string): boolean {
    try {
      const target = new URL(startPath, window.location.origin);
      // Start pages are written as routes in both modes (/reports/2026); a
      // hash-mode one written with its fragment (/#/reports/2026) works too.
      const path = this.routeMode === 'hash' && target.hash ? target.hash.slice(1) : target.pathname;
      return stripQueryAndHash(path) === this.currentPath();
    } catch {
      return false;
    }
  }

  /** Takes the app's look from an API answer, and re-styles the cards and help center if it changed. */
  private useTheme(data: { theme?: unknown } | null): void {
    const theme = readTheme(data);
    if (!theme || sameTheme(theme, this.theme)) return;
    this.theme = theme;
    try {
      this.renderer?.setTheme?.(theme);
    } catch (err) {
      this.reportError(err, 'render');
    }
    if (this.helpLoaded) this.pushHelpState();
  }

  /** Reads the app's route mode from a /guides or /help response; anything unknown means paths. */
  private applyRouteMode(data: { routeMode?: unknown } | null): void {
    const mode: RouteMode = data?.routeMode === 'hash' ? 'hash' : 'path';
    if (mode === this.routeMode) return;
    this.routeMode = mode;
    // The help list shows "Opens on …" per mode, so it needs to know too.
    if (this.helpLoaded) this.pushHelpState();
  }

  // ------------------------------------------------------------
  // Help center
  // ------------------------------------------------------------

  /** Opens the help center (for a product's own help button). */
  openHelp(): void {
    if (this.disabled || this.previewMode || this.signedOut) return;
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
   * then sent to the guide's start page, with the guide handed over in session
   * storage; it starts when that page loads (or, for a hash router, when the
   * route changes).
   */
  launchHelpGuide(guideId: string): void {
    const item = this.helpItems.find((g) => g.id === guideId);
    if (!item || this.disabled) return;
    // Start here when the guide's route matches, and also when its start page
    // IS this page (same path, query aside): asking "go to another page?" for
    // the page the visitor is on, then reloading it, helps nobody.
    if (this.isGuidePage(item, this.currentPath())) {
      this.helpUi?.close();
      this.startOnDemand(item, 'help');
      return;
    }
    const target = this.startPageUrl(item, false);
    if (target === null) return; // malformed or off-site start page: do nothing rather than break the page
    const go = () => {
      // The URL parameter is only the fallback, for a browser without session storage.
      const url = storeHelpLaunch(this.options?.appKey ?? '', item.id) ? target : this.startPageUrl(item, true);
      if (url !== null) this.navigate(url);
    };
    if (this.helpUi?.confirmNavigation) {
      this.helpUi.confirmNavigation(item, go);
    } else {
      this.helpUi?.close();
      go();
    }
  }

  /**
   * Where a help guide's start page is, as a same-site URL; null when it is
   * malformed or (for path routing) on another site. With `withParam`, it
   * carries ?guideEngine=help:<id>, read wherever the document loads.
   */
  private startPageUrl(item: HelpItem, withParam: boolean): string | null {
    try {
      if (this.routeMode === 'hash') {
        // A hash router keeps the document where it is; the start page goes
        // in the fragment, and the launch parameter in the REAL query string
        // (before the hash), where readLaunchParam() looks on any page.
        const url = new URL(window.location.pathname + window.location.search, window.location.origin);
        if (withParam) url.searchParams.set(LAUNCH_PARAM, `help:${item.id}`);
        url.hash = item.help.startPath;
        return url.pathname + url.search + url.hash;
      }
      const url = new URL(item.help.startPath, window.location.origin);
      if (url.origin !== window.location.origin) return null; // help links never leave the site
      if (withParam) url.searchParams.set(LAUNCH_PARAM, `help:${item.id}`);
      return url.pathname + url.search + url.hash;
    } catch {
      return null;
    }
  }

  /**
   * (Re)starts a guide on request, regardless of whether the visitor already
   * finished it. An explicit launch takes the screen: whatever was showing
   * automatically goes back to the front of the queue (not finished, so it
   * returns once the requested guide completes or on the next navigation).
   */
  private startOnDemand(guide: Guide, source: 'help' | 'link'): void {
    for (const [id, state] of [...this.activeGuides]) {
      this.teardownGuide(id);
      if (id !== guide.id && !state.source) this.queued.unshift(state.guide);
    }
    this.finished.delete(finishedKey(guide));
    this.startGuide(guide, source);
  }

  /** Fetches this visitor's help-center guides and settings, and updates the help UI. */
  private async loadHelp(): Promise<void> {
    if (!this.client || this.signedOut) return;
    this.helpLoaded = true;
    let items: HelpItem[] = [];
    let button: HelpButtonSettings = { label: 'Help', color: '#4f46e5' };
    const generation = this.identityGeneration;
    try {
      const res = await this.client.post('/help');
      if (res.ok) {
        const data = (await res.json()) as {
          enabled?: unknown;
          routeMode?: unknown;
          theme?: unknown;
          guides?: unknown;
          button?: HelpButtonSettings;
        } | null;
        if (generation !== this.identityGeneration) return; // the list of a previous identity
        if (data?.enabled === true && Array.isArray(data.guides)) {
          items = (data.guides as HelpItem[]).filter((g) => g?.help && typeof g.help.title === 'string');
          if (data.button) button = data.button;
          this.applyRouteMode(data);
          this.useTheme(data);
        }
      }
    } catch {
      // fail closed: no help center
    }
    this.helpItems = items;
    this.helpButton = button;
    const launch = this.pendingLaunch;
    this.pendingLaunch = null;
    if (launch) {
      const item = items.find((g) => g.id === launch.guideId);
      if (item && launch.handOff) {
        if (this.isGuidePage(item, this.currentPath())) {
          clearHelpLaunch();
          this.startOnDemand(item, 'help');
        }
      } else if (item) {
        this.startOnDemand(item, launch.source);
      }
    }
    this.pushHelpState();
  }

  private pushHelpState(): void {
    try {
      this.helpUi?.update({
        items: this.helpItems,
        button: this.helpButton,
        showButton: this.options?.helpButton !== false && this.helpItems.length > 0,
        routeMode: this.routeMode,
        theme: this.theme,
      });
    } catch (err) {
      this.reportError(err, 'help');
    }
  }

  /** The help panel opened (the floating button, or openHelp()). Called by the help UI. */
  trackHelpOpened(): void {
    this.emitHelpEvent('help_opened');
  }

  /** The visitor searched the help center: what for, and how many topics matched. Called by the help UI. */
  trackHelpSearched(query: string, results: number): void {
    this.emitHelpEvent('help_searched', { query: query.slice(0, HELP_QUERY_MAX), results });
  }

  /**
   * Call on every SPA route change. The install-snippet agent does this
   * automatically. `newPath` is the route as the app's router sees it ("/team"
   * for both path and hash routers); omit it to read the current location.
   */
  async onRouteChange(newPath?: string): Promise<void> {
    if (this.disabled || this.previewMode || !this.client) return;
    try {
      this.takeRouteHandOff(newPath === undefined ? this.currentPath() : stripQueryAndHash(newPath));
      await this.evaluateGuidesForRoute(newPath === undefined ? undefined : stripQueryAndHash(newPath));
    } catch (err) {
      // never throw into the host app's router hooks
      this.reportError(err, 'route');
    }
  }

  /**
   * A help hand-off whose navigation didn't reload the document (a hash
   * router only changes the fragment) is picked up on the route change that
   * brings the visitor to the guide's page. Started first, like at page load,
   * so automatic evaluation doesn't start it a second time; left alone on any
   * other page, where it simply expires.
   */
  private takeRouteHandOff(path: string): void {
    const guideId = this.options ? readHelpLaunch(this.options.appKey) : null;
    if (!guideId) return;
    const item = this.helpItems.find((g) => g.id === guideId);
    if (!item) return;
    if (!this.isGuidePage(item, path)) return;
    clearHelpLaunch();
    this.startOnDemand(item, 'help');
  }

  /**
   * Tell the engine who the visitor is now.
   *  - A different person (another visitor id, or a signed token, whose ids
   *    the engine can't read) clears what the previous one was shown and
   *    re-evaluates the page.
   *    So does another account: events and account-limited guides belong to it.
   *  - The same person in the same account with new tags keeps the guide on
   *    screen and only refreshes which guides apply and the help list.
   *  - null: nobody is signed in any more (a logout). The previous visitor's
   *    events are sent, their guides and help list removed, and nothing is
   *    fetched or shown until the next identify().
   * A `visitor` without an `id` key keeps the current id, so
   * identify({ visitor: { tags } }) updates the tags of the same person; pass
   * `id: undefined` to become anonymous. When calls overlap, the latest one
   * wins, built on what the earlier ones asked for.
   */
  async identify(identity: IdentityOptions | null): Promise<void> {
    if (!this.options || !this.client) return;
    const call = ++this.identifyCalls;
    if (identity === null) {
      this.requestedOptions = null;
      try {
        await this.eventQueue?.flush(); // the old identity's events go out under the old identity
        if (call !== this.identifyCalls) return;
        this.signedOut = true;
        this.identityGeneration++;
        for (const id of [...this.activeGuides.keys()]) this.teardownGuide(id);
        this.queued = [];
        this.finished.clear();
        this.pendingLaunch = null;
        this.helpItems = [];
        this.helpUi?.close();
        this.pushHelpState();
      } catch (err) {
        this.reportError(err, 'identify');
      }
      return;
    }
    const base = this.requestedOptions ?? this.options;
    const options = { ...base, ...identity };
    if (identity.visitor && !('id' in identity.visitor) && base.visitor?.id) {
      options.visitor = { ...identity.visitor, id: base.visitor.id };
    }
    this.requestedOptions = options;
    try {
      const next = toWireIdentity(options);
      const samePerson =
        !this.signedOut &&
        !next.jwt &&
        !this.identity.jwt &&
        next.visitor?.id === this.identity.visitor?.id &&
        next.account?.id === this.identity.account?.id;
      // The old identity's events go out under the old identity.
      if (!samePerson) await this.eventQueue?.flush();
      if (call !== this.identifyCalls) return; // a later identify() took over meanwhile
      this.requestedOptions = null;
      this.signedOut = false;
      this.options = options;
      this.identity = next;
      this.identityGeneration++; // anything still in flight was asked for the old identity
      if (!samePerson) {
        for (const id of [...this.activeGuides.keys()]) this.teardownGuide(id);
        this.finished.clear();
      }
      this.queued = [];
      if (!this.disabled && !this.previewMode) {
        await this.evaluateGuidesForRoute();
        if (!this.disabled) await this.loadHelp(); // the help list is account- and tag-targeted too
      }
    } catch (err) {
      // fail silent
      this.reportError(err, 'identify');
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
      const guide = (await res.json()) as Guide & { theme?: unknown };
      if (!guide || typeof guide.id !== 'string' || !Array.isArray(guide.steps)) return false;
      this.useTheme(guide);

      this.previewMode = true;
      // Force-render: no route matching, no enabled/publish checks.
      this.startGuide({ ...guide, preview: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One request returns the kill-switch state, the app's route mode and this
   * visitor's candidate guides. Fail closed: an explicit enabled:false
   * disables the agent for the rest of the page's life; any other failure
   * (network, non-2xx, malformed body) shows nothing for this navigation.
   *
   * `path` is the route to match; omitted, the current location is read
   * AFTER the response, because that's when the route mode is known.
   */
  private async evaluateGuidesForRoute(path?: string): Promise<void> {
    if (!this.client || this.signedOut) return;
    const generation = this.identityGeneration;

    let guides: Guide[];
    try {
      const res = await this.client.post('/guides');
      if (!res.ok) return;
      const data = (await res.json()) as {
        enabled?: unknown;
        routeMode?: unknown;
        theme?: unknown;
        guides?: unknown;
      } | null;
      if (generation !== this.identityGeneration) return; // chosen for a previous identity
      if (data?.enabled === false) {
        this.disabled = true;
        return;
      }
      if (data?.enabled !== true || !Array.isArray(data.guides)) return;
      guides = data.guides as Guide[];
      this.applyRouteMode(data);
      this.useTheme(data);
    } catch (err) {
      // Silent failure — never block the host app. Reported because a
      // non-JSON 200 (a CDN or proxy error page) is a deployment problem
      // operators want to hear about; a plain network failure is noise, but
      // its report fails to send anyway.
      this.reportError(err, 'guides');
      return;
    }

    const here = path ?? this.currentPath();
    // One guide at a time, like Pendo's throttling: two cards and two
    // spotlights on one page just compete for attention. Everything that
    // matches goes into a queue, walkthroughs (tours, multi-step guides)
    // ahead of single-step tips and otherwise in the server's order, and the
    // first one shows now; showNextQueued says when the others get a turn.
    // A guide still showing from the previous page (a tour that spans pages)
    // keeps the screen until it's done.
    this.queued = guides
      .filter((g) => g?.routeMatch && matchesRoute(g.routeMatch, here))
      .filter((g) => !this.activeGuides.has(g.id) && !this.finished.has(finishedKey(g)))
      .sort((a, b) => autoShowRank(a) - autoShowRank(b));
    this.showNextQueued();
  }

  /**
   * Shows the next waiting guide if nothing is on screen. Reached when the
   * current guide completes or fails (target never appeared, renderer threw),
   * never when the visitor dismisses it: "Maybe later" means no more pop-ups
   * on this page view, so dismissGuide empties the queue instead. The queued
   * guides come back on the next navigation.
   */
  private showNextQueued(): void {
    while (this.activeGuides.size === 0) {
      const next = this.queued.shift();
      if (!next) return;
      if (this.finished.has(finishedKey(next))) continue; // finished on demand meanwhile
      this.startGuide(next);
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

  /**
   * Shows the step at currentStepIndex. The first step records guide_shown
   * and every later one guide_step_viewed — unless `revisit` (the visitor
   * went back), when it's always guide_step_viewed: the guide didn't start
   * again, a step was just seen again.
   */
  private showCurrentStep(state: GuideRuntimeState, revisit = false): void {
    const step = state.guide.steps[state.currentStepIndex];
    if (!step) {
      this.completeGuide(state);
      return;
    }

    const targetEl = step.targetSelector ? document.querySelector(step.targetSelector) : null;

    if (step.targetSelector && !targetEl && state.currentStepIndex === 0 && !revisit) {
      // A first step whose anchor isn't in the DOM yet: the page may still be
      // rendering (common in SPAs), or the feature may not be there for this
      // visitor at all. Wait quietly for a while, then give up without
      // showing anything.
      this.watchForTarget(state, step, revisit);
      return;
    }

    // A new step replaces whatever the previous step was tracking. Without
    // this, a targeted step's observer outlived it and re-rendered the NEXT
    // step (e.g. a centered modal) next to the old step's element on the
    // first unrelated DOM change.
    this.stopObserving(state.guide.id);

    state.status = 'showing';
    try {
      // A later step whose anchor isn't on the page yet (it appears after the
      // visitor does something: the item scanner once a customer is picked,
      // a dialog once a button is clicked) shows its card centered right away,
      // so "Next" visibly did something and the buttons still work, and moves
      // onto the element when it appears (see waitForLateTarget).
      this.renderer?.renderStep(state.guide, step, targetEl);
    } catch (err) {
      // A renderer failure (bad content, a host page that breaks the DOM
      // APIs) leaves nothing half-drawn: the guide is taken down for this
      // page load and the failure reported. Not marked finished — a reload
      // may well work.
      state.status = 'error';
      this.teardownGuide(state.guide.id);
      this.reportError(err, 'render');
      this.showNextQueued();
      return;
    }
    this.emitEvent(
      state,
      step.id,
      state.currentStepIndex === 0 && !revisit ? 'guide_shown' : 'guide_step_viewed',
    );

    if (targetEl) {
      this.observeTarget(state.guide.id, step);
    } else if (step.targetSelector) {
      this.waitForLateTarget(state, step);
    }
  }

  /**
   * Keeps watching the page for a later step's anchor and, once it exists,
   * re-renders the card anchored to it (no new analytics event: the visitor
   * already saw the step). Stops when the step changes or the guide ends,
   * which is also what bounds it: the visitor can always finish or dismiss
   * from the centered card.
   */
  private waitForLateTarget(state: GuideRuntimeState, step: Step): void {
    let frameScheduled = false;
    const observer = new MutationObserver(() => {
      if (frameScheduled) return;
      frameScheduled = true;
      requestAnimationFrame(() => {
        frameScheduled = false;
        if (
          this.activeGuides.get(state.guide.id) !== state ||
          state.guide.steps[state.currentStepIndex] !== step
        )
          return;
        const el = document.querySelector(step.targetSelector!);
        if (!el) return;
        try {
          this.renderer?.renderStep(state.guide, step, el);
        } catch (err) {
          this.reportError(err, 'render');
          return;
        }
        // From here on, track the element like any targeted step.
        this.observeTarget(state.guide.id, step);
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    this.targetObservers.set(state.guide.id, observer);
  }

  private stopObserving(guideId: string): void {
    this.targetObservers.get(guideId)?.disconnect();
    this.targetObservers.delete(guideId);
  }

  private watchForTarget(state: GuideRuntimeState, step: Step, revisit: boolean, attempt = 0): void {
    const maxAttempts = 10;
    // A guide torn down while it waited (identify(), a help launch) must not
    // come back, nor remove a newer run of the same guide.
    if (this.activeGuides.get(state.guide.id) !== state) return;
    if (attempt >= maxAttempts) {
      state.status = 'error';
      this.emitEvent(state, step.id, 'guide_error', { reason: 'target_not_found' });
      this.activeGuides.delete(state.guide.id);
      this.showNextQueued();
      return;
    }
    setTimeout(
      () => {
        if (this.activeGuides.get(state.guide.id) !== state) return;
        const el = document.querySelector(step.targetSelector!);
        if (el) {
          this.showCurrentStep(state, revisit);
        } else {
          this.watchForTarget(state, step, revisit, attempt + 1);
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
        try {
          if (target) this.renderer?.renderStep(state.guide, step, target);
        } catch (err) {
          // Keep the last good render rather than throwing in a rAF callback.
          this.reportError(err, 'render');
        }
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    this.targetObservers.set(guideId, observer);
  }

  /** Called by the renderer when the user clicks "Next". */
  advanceStep(guideId: string): void {
    const state = this.activeGuides.get(guideId);
    if (!state) return;

    try {
      const step = state.guide.steps[state.currentStepIndex];
      this.emitEvent(state, step.id, 'guide_step_completed');

      state.currentStepIndex += 1;
      this.showCurrentStep(state);
    } catch (err) {
      // Runs from a click handler: never let it surface as an uncaught error.
      this.reportError(err, 'advance');
    }
  }

  /**
   * Called by the renderer when the user clicks "Back": shows the previous
   * step again (a guide_step_viewed, no guide_step_completed — nothing was
   * completed). On the first step there is nothing to go back to.
   */
  previousStep(guideId: string): void {
    const state = this.activeGuides.get(guideId);
    if (!state || state.currentStepIndex === 0) return;

    state.currentStepIndex -= 1;
    this.showCurrentStep(state, true);
  }

  /** Called by the renderer when the user dismisses the guide. */
  dismissGuide(guideId: string): void {
    const state = this.activeGuides.get(guideId);
    if (!state) return;

    try {
      state.status = 'dismissed';
      const step = state.guide.steps[state.currentStepIndex];
      this.emitEvent(state, step?.id, 'guide_dismissed');
      this.finished.add(finishedKey(state.guide));
      this.teardownGuide(guideId);
      this.queued = []; // nothing else pops up on this page view
    } catch (err) {
      this.reportError(err, 'dismiss');
    }
  }

  private completeGuide(state: GuideRuntimeState): void {
    state.status = 'completed';
    this.emitEvent(state, undefined, 'guide_completed');
    this.finished.add(finishedKey(state.guide));
    this.teardownGuide(state.guide.id);
    this.showNextQueued();
  }

  private teardownGuide(guideId: string): void {
    try {
      this.renderer?.clear(guideId);
    } catch (err) {
      // Also reached from the render-failure path: a renderer that can't
      // clear must not keep the engine's bookkeeping from moving on.
      this.reportError(err, 'render');
    }
    this.stopObserving(guideId);
    this.activeGuides.delete(guideId);
  }

  /** Help-center events carry no guide; otherwise they're queued like guide events. */
  private emitHelpEvent(
    eventType: 'help_opened' | 'help_searched',
    metadata?: Record<string, unknown>,
  ): void {
    if (!this.options || !this.eventQueue || this.disabled || this.previewMode) return;
    this.eventQueue.push({
      sessionId: this.sessionId,
      eventType,
      occurredAt: new Date().toISOString(),
      metadata,
    });
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
