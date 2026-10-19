import type { Request, Response } from 'express';

/**
 * Turns a request into a bounded label — the Express route pattern, such as
 * `/v1/apps/:appId/guides/:id` — for logs and metric labels. Raw paths are
 * never used: they carry ids, public keys and invitation tokens, and would
 * give Prometheus one time series per guide.
 *
 * Express only knows the matched pattern while a route handler is running:
 * `req.route.path` is the leaf, `req.baseUrl` the mounted prefix with its
 * params already substituted. Once an error unwinds back to the app-level
 * error handler, baseUrl and params are reset, so asyncHandler captures the
 * pattern into `res.locals.route` on the way out. Requests that never reach a
 * route (401 before the Studio router, 404/403/429 in the agent middleware,
 * unknown paths) are classified by prefix instead.
 */
export const AGENT_ENDPOINTS = ['guides', 'help', 'events', 'preview'] as const;
export type AgentEndpoint = (typeof AGENT_ENDPOINTS)[number] | 'script' | 'other';

const AGENT_API = /^\/v1\/agent\/[^/]+(?:\/([^/?#]*))?/;
const AGENT_SCRIPT = /^\/agent\/v1\/[^/]+\/guides\.js$/;

function pathOf(req: Request): string {
  const url = req.originalUrl || req.url || '';
  const end = url.indexOf('?');
  return end === -1 ? url : url.slice(0, end);
}

/** Which public agent endpoint a request targets, or null when it isn't an agent request. */
export function agentEndpoint(req: Request): AgentEndpoint | null {
  const path = pathOf(req);
  if (AGENT_SCRIPT.test(path)) return 'script';
  const match = AGENT_API.exec(path);
  if (!match) return null;
  const segment = match[1] ?? '';
  return (AGENT_ENDPOINTS as readonly string[]).includes(segment) ? (segment as AgentEndpoint) : 'other';
}

// Segments that still look like identifiers after param substitution — a
// router mounted without mergeParams loses its parent's params — are masked
// so a mislabel can never become unbounded cardinality.
const LOOKS_LIKE_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|ge_pk_[0-9a-f]{32}|[A-Za-z0-9_-]{32,})$/i;

/** The matched pattern, available only while the request is inside its route handler. */
export function matchedRoutePattern(req: Request): string | null {
  const leaf: unknown = req.route?.path;
  if (typeof leaf !== 'string') return null;
  const params = Object.entries(req.params ?? {});
  const base = (req.baseUrl ?? '')
    .split('/')
    .map((segment) => {
      if (segment === '') return segment;
      const param = params.find(([, value]) => value === segment);
      if (param) return `:${param[0]}`;
      return LOOKS_LIKE_ID.test(segment) ? ':id' : segment;
    })
    .join('/');
  return base + (leaf === '/' ? '' : leaf);
}

/** Records the pattern for later (error handler, response logging) if it isn't known yet. */
export function rememberRoute(req: Request, res: Response): void {
  if (typeof res.locals.route === 'string') return;
  const pattern = matchedRoutePattern(req);
  if (pattern) res.locals.route = pattern;
}

/** The label to log and count under. Always one of a bounded set. */
export function routeLabel(req: Request, res: Response): string {
  if (typeof res.locals.route === 'string') return res.locals.route;
  const matched = matchedRoutePattern(req);
  if (matched) return matched;
  const endpoint = agentEndpoint(req);
  if (endpoint === 'script') return '/agent/v1/:key/guides.js';
  if (endpoint) return `/v1/agent/:key/${endpoint === 'other' ? '*' : endpoint}`;
  const path = pathOf(req);
  if (path.startsWith('/v1/')) return '/v1/*';
  if (path.startsWith('/auth/')) return '/auth/*';
  return 'unmatched';
}

const KEY_PREFIX_LENGTH = 'ge_pk_'.length + 8;

/** The first characters of an agent request's public key — enough to find the app, never the key. */
export function agentKeyPrefix(req: Request): string | null {
  const match = /^\/v1\/agent\/([^/?#]+)|^\/agent\/v1\/([^/?#]+)\//.exec(pathOf(req));
  const key = match?.[1] ?? match?.[2];
  return key ? key.slice(0, KEY_PREFIX_LENGTH) : null;
}
