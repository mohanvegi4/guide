import express, { NextFunction, Request, Response, Router } from 'express';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { asyncHandler } from '../asyncHandler';
import { AgentApp, findAppByPublicKey, withAgentSession } from '../db';
import { HttpError, notFound } from '../httpError';
import { parseIdentityInput, resolveVisitor, Visitor } from '../auth/visitor';
import { previewSecret, verifyPreviewToken } from '../preview';
import { rateLimiterFromEnv } from '../rateLimit';
import { RESOLVED_ROUTE_MATCH_SQL } from './studio/context';

/**
 * The public side: what the install snippet on customers' pages talks to.
 *
 *   GET  /agent/v1/:key/guides.js      the agent script (same file for every key)
 *   GET  /agent/v1/version             which build of the script this backend serves
 *   POST /v1/agent/:key/guides         kill switches + this visitor's active guides
 *   POST /v1/agent/:key/events         analytics batch (+ dismiss/complete state)
 *   POST /v1/agent/:key/errors         a sampled report of an exception inside the agent
 *   POST /v1/agent/:key/preview        resolve a signed preview link
 *
 * The key is public, so: CORS only for the app's own websites, a per-key and
 * per-client rate limit, optional signed visitor identity (auth/visitor.ts),
 * and an identical 404 for unknown and malformed keys (no enumeration).
 * Request bodies are JSON sent as text/plain — a CORS "simple" request, so
 * browsers skip the preflight round trip, and keepalive flushes on page exit
 * work everywhere.
 */
export const agentScriptRouter = Router();
export const agentApiRouter = Router({ mergeParams: true });

const KEY_PATTERN = /^ge_pk_[0-9a-f]{32}$/;

// ------------------------------------------------------------
// The agent script. One static bundle for every key — the agent reads its
// key and the API origin from its own <script src>.
//
// The snippet customers paste loads a STABLE URL, so that URL must keep
// working forever; what changes between deploys is the content. The content
// hash identifies it: a strong ETag, so browsers and a CDN revalidate with a
// cheap 304, and GET /agent/v1/version reports it so a deploy (or a
// rollback: redeploying an older image changes the hash back) can be
// confirmed from outside. The hash is recomputed from the file as served,
// not read from the banner build.mjs wrote — the two agree, but only the
// served bytes count.
// ------------------------------------------------------------
interface AgentBundle {
  js: string;
  /** package.json version of packages/agent, from the build banner ('unknown' without one). */
  version: string;
  /** First 16 hex chars of sha256 over the code after the banner line (the whole file without one). */
  hash: string;
}

const BANNER = /^\/\* guide-engine agent (\S+) [0-9a-f]{16} \*\/\n/;

/** @internal exported for unit tests */
export function describeBundle(js: string): AgentBundle {
  const banner = js.match(BANNER);
  const code = banner ? js.slice(banner[0].length) : js;
  return {
    js,
    version: banner?.[1] ?? 'unknown',
    hash: createHash('sha256').update(code).digest('hex').slice(0, 16),
  };
}

let bundle: Promise<AgentBundle> | null = null;
function loadBundle(): Promise<AgentBundle> {
  const path =
    process.env.AGENT_BUNDLE_PATH ?? join(__dirname, '..', '..', '..', 'agent', 'dist', 'guide-engine.js');
  bundle ??= readFile(path, 'utf-8')
    .then(describeBundle)
    .catch((err) => {
      bundle = null; // retry on the next request (e.g. after `npm run build`)
      throw err;
    });
  return bundle;
}

/**
 * Browsers revalidate after 5 minutes; a CDN keeps it for an hour and may
 * serve the stale copy for a day while it refetches in the background
 * (stale-while-revalidate), so an origin blip never takes the script down.
 * Either way a new build (or a rollback) is picked up within minutes: the
 * ETag differs, so the revalidation returns the new file.
 */
const SCRIPT_CACHE_CONTROL = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';

agentScriptRouter.get('/:key/guides.js', (req, res) => {
  if (!KEY_PATTERN.test(req.params.key)) {
    res.status(404).type('application/javascript').send('/* unknown key */');
    return;
  }
  loadBundle()
    .then((b) => {
      res
        .type('application/javascript')
        .set('Cache-Control', SCRIPT_CACHE_CONTROL)
        .set('Cross-Origin-Resource-Policy', 'cross-origin')
        .set('ETag', `"${b.hash}"`);
      // req.fresh compares If-None-Match against the ETag set above.
      if (req.fresh) {
        res.status(304).end();
        return;
      }
      res.send(b.js);
    })
    .catch(() => res.status(503).type('application/javascript').send('/* agent bundle not built */'));
});

// GET /agent/v1/version — no key needed: a cheap uptime / deploy check.
// Never cached, so it always says what this origin serves right now.
agentScriptRouter.get('/version', (_req, res) => {
  loadBundle()
    .then((b) => res.set('Cache-Control', 'no-store').json({ version: b.version, hash: b.hash }))
    .catch(() => res.status(503).set('Cache-Control', 'no-store').json({ error: 'agent_bundle_not_built' }));
});

// ------------------------------------------------------------
// Per-request app resolution, CORS and rate limiting.
// ------------------------------------------------------------
interface AgentRequest extends Request {
  agentApp?: AgentApp;
}

// Tiny cache so the CORS check and the handler don't both hit the database.
const appCache = new Map<string, { app: AgentApp | null; at: number }>();
// Only the CORS/rate-limit check uses it; handlers re-read the app in their own session.
const APP_CACHE_MS = Number(process.env.AGENT_APP_CACHE_MS ?? 10_000);
async function cachedApp(key: string): Promise<AgentApp | null> {
  const hit = appCache.get(key);
  if (hit && Date.now() - hit.at < APP_CACHE_MS) return hit.app;
  const app = await findAppByPublicKey(key);
  appCache.set(key, { app, at: Date.now() });
  return app;
}

/** @internal tests only */
export function clearAgentCacheForTests(): void {
  appCache.clear();
}

// In-process in development; shared through Postgres in production (RATE_LIMIT_STORE).
const allow = rateLimiterFromEnv();

agentApiRouter.use(
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const key = String(req.params.key ?? '');
    const app = KEY_PATTERN.test(key) ? await cachedApp(key) : null;
    if (!app) throw notFound();

    // Browsers always send Origin on cross-origin requests; it must be one of
    // the app's websites. (Non-browser clients can claim any Origin — that's
    // what signed identity is for.)
    const origin = req.header('origin');
    if (origin) {
      if (!app.allowedOrigins.includes(origin)) throw new HttpError(403, 'origin_not_allowed');
      res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
    }
    if (req.method === 'OPTIONS') {
      res
        .set({
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
        })
        .status(204)
        .end();
      return;
    }
    if (!(await allow(`${key}|${req.ip}`))) throw new HttpError(429, 'rate_limited');

    (req as AgentRequest).agentApp = app;
    next();
  }),
);

// JSON bodies arrive as text/plain (see above); application/json works too.
agentApiRouter.use(express.text({ type: 'text/plain', limit: '256kb' }), (req, _res, next) => {
  if (typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch {
      next(new HttpError(400, 'invalid_body'));
      return;
    }
  }
  next();
});

/** Runs in the app's agent session; null result = the key vanished meanwhile. */
async function inApp<T>(req: Request, fn: (client: PoolClient, app: AgentApp) => Promise<T>): Promise<T> {
  const result = await withAgentSession(String(req.params.key), fn);
  if (result === null) throw notFound();
  return result;
}

/** Global kill switch (system_config, unscoped) AND the app's own switch AND the org not suspended. */
async function engineEnabled(client: PoolClient, app: AgentApp): Promise<boolean> {
  if (!app.enabled || app.suspendedAt) return false;
  const row = await client.query<{ value: string }>(
    `SELECT value FROM system_config WHERE key = 'guide_engine_enabled'`,
  );
  return row.rows[0]?.value !== 'false';
}

/**
 * Who may get a guide from `active_guide a`: its account allowlist and its
 * visitor tags (NULL = everyone, for either). Shared by /guides and /help so
 * the two never disagree. The tag test looks each of the guide's tags up in
 * the visitor's list, which Postgres can hash, rather than `&&`, which
 * compares every pair (up to 100 guide tags × 1000 visitor tags per row).
 */
function audienceSql(accountParam: string, tagsParam: string): string {
  return `(a.account_ids IS NULL OR ${accountParam}::text = ANY(a.account_ids))
           AND (a.visitor_tags IS NULL
                OR EXISTS (SELECT 1 FROM unnest(a.visitor_tags) AS t(tag) WHERE t.tag = ANY(${tagsParam}::text[])))`;
}

function visitorFrom(req: Request, app: AgentApp): Visitor {
  const input = parseIdentityInput(req.body);
  if (!input) throw new HttpError(400, 'invalid_body');
  const result = resolveVisitor(app, input);
  if (!result.ok) throw new HttpError(401, result.error);
  return result.visitor;
}

// ------------------------------------------------------------
// POST /v1/agent/:key/guides — one round trip: kill switches + every guide
// this visitor should see right now (published, enabled, in its date window,
// their account allowed, at least one of their tags listed when the guide
// names tags, not already shown or finished at this version or later, and
// starting automatically — on-demand guides only come through /help).
// Route matching happens in the agent.
// ------------------------------------------------------------
agentApiRouter.post(
  '/guides',
  asyncHandler(async (req, res) => {
    const app = (req as AgentRequest).agentApp!;
    const visitor = visitorFrom(req, app);
    const body = await inApp(req, async (client, scoped) => {
      if (!(await engineEnabled(client, scoped))) return { enabled: false, guides: [] };
      const rows = await client.query(
        `SELECT a.id, a.app_id, a.name, a.type, a.version_id, a.steps, a.route_match
         FROM active_guide a
         WHERE a.app_id = $1
           AND a.activation = 'auto'
           AND ${audienceSql('$3', '$4')}
           AND NOT EXISTS (
             SELECT 1 FROM user_guide_state s
             WHERE s.app_id = $1 AND s.visitor_id = $2 AND s.guide_id = a.id
               AND s.status IN ('shown', 'dismissed', 'completed')
               AND s.last_seen_version >= a.version_number
           )`,
        [scoped.id, visitor.visitorId, visitor.accountId, visitor.tags],
      );
      return {
        enabled: true,
        routeMode: scoped.routeMode,
        guides: rows.rows.map((r) => ({
          id: r.id,
          versionId: r.version_id,
          name: r.name,
          type: r.type,
          steps: r.steps,
          routeMatch: r.route_match,
        })),
      };
    });
    res.json(body);
  }),
);

// ------------------------------------------------------------
// POST /v1/agent/:key/help — the help center: settings for the default button
// plus every guide authors listed in the help center that this visitor may
// start (published, enabled, in its date window, account and tags allowed). Unlike
// /guides, finished guides stay listed: help is on demand, so they can be
// replayed any time. Not route-filtered: the agent sends the visitor to a
// guide's start page if they're elsewhere.
// ------------------------------------------------------------
agentApiRouter.post(
  '/help',
  asyncHandler(async (req, res) => {
    const app = (req as AgentRequest).agentApp!;
    const visitor = visitorFrom(req, app);
    const body = await inApp(req, async (client, scoped) => {
      const settings = await client.query<{
        help_enabled: boolean;
        help_button_label: string;
        help_button_color: string;
        help_position: string;
      }>(
        `SELECT help_enabled, help_button_label, help_button_color, help_position
         FROM application WHERE id = $1`,
        [scoped.id],
      );
      const s = settings.rows[0];
      if (!s?.help_enabled || !(await engineEnabled(client, scoped))) return { enabled: false, guides: [] };
      const rows = await client.query(
        `SELECT a.id, a.name, a.type, a.version_id, a.steps, a.route_match, a.help, a.page_start_path
         FROM active_guide a
         WHERE a.app_id = $1 AND a.help IS NOT NULL
           AND ${audienceSql('$2', '$3')}
         ORDER BY a.help ->> 'title'`,
        [scoped.id, visitor.accountId, visitor.tags],
      );
      return {
        enabled: true,
        routeMode: scoped.routeMode,
        button: {
          label: s.help_button_label,
          color: s.help_button_color,
          position: s.help_position,
        },
        guides: rows.rows.map((r) => ({
          id: r.id,
          versionId: r.version_id,
          name: r.name,
          type: r.type,
          steps: r.steps,
          routeMatch: r.route_match,
          help: {
            title: r.help.title,
            description: r.help.description ?? '',
            keywords: r.help.keywords ?? [],
            // Default start page: the saved page's start page, else the
            // guide's own (exact) route.
            startPath: r.help.startPath ?? r.page_start_path ?? r.route_match.value,
          },
        })),
      };
    });
    res.json(body);
  }),
);

// ------------------------------------------------------------
// POST /v1/agent/:key/events — fire-and-forget analytics batch. Two shapes:
// guide events (always name a guide and version) and help-center events
// (never do — they're about the help panel itself).
// ------------------------------------------------------------
const eventBase = {
  sessionId: z.string().min(1).max(100),
  occurredAt: z.string().datetime(),
};
const guideEventSchema = z.object({
  ...eventBase,
  guideId: z.string().uuid(),
  guideVersionId: z.string().uuid(),
  stepId: z.string().uuid().optional(),
  eventType: z.enum([
    'guide_shown',
    'guide_step_viewed',
    'guide_step_completed',
    'guide_dismissed',
    'guide_completed',
    'guide_error',
    'survey_response',
  ]),
  metadata: z.record(z.unknown()).optional(),
});
/** The query is capped (it's stored as typed, never rendered as HTML); other metadata keys are dropped. */
const HELP_QUERY_MAX = 200;
const helpEventSchema = z.object({
  ...eventBase,
  eventType: z.enum(['help_opened', 'help_searched']),
  metadata: z
    .object({
      query: z
        .string()
        .transform((q) => q.slice(0, HELP_QUERY_MAX))
        .optional(),
      results: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
const eventSchema = z.union([guideEventSchema, helpEventSchema]);
const eventsBodySchema = z.object({ events: z.array(eventSchema).min(1).max(100) });
type AgentEvent = z.infer<typeof eventSchema>;
type GuideEvent = z.infer<typeof guideEventSchema>;

function isGuideEvent(e: AgentEvent): e is GuideEvent {
  return 'guideId' in e;
}

/**
 * Events that change what /guides serves this visitor. 'shown' is recorded as
 * soon as a guide starts, so a reload mid-guide doesn't start it over: an
 * automatic guide shows once per published version, like Pendo's default.
 * Dismissed / completed are kept over a later 'shown' at the same version
 * (a help-center replay) so the stronger state is never lost.
 */
type VisitorGuideStatus = 'shown' | 'dismissed' | 'completed';
const STATUS_FOR_EVENT: Partial<Record<GuideEvent['eventType'], VisitorGuideStatus>> = {
  guide_shown: 'shown',
  guide_dismissed: 'dismissed',
  guide_completed: 'completed',
};

agentApiRouter.post(
  '/events',
  asyncHandler(async (req, res) => {
    const app = (req as AgentRequest).agentApp!;
    const visitor = visitorFrom(req, app);
    const parsed = eventsBodySchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_body');

    const accepted = await inApp(req, async (client, scoped) => {
      // Only events for this app's guides (RLS also enforces it; the explicit
      // filter drops unknown ids instead of failing the whole batch). Help
      // events name no guide, so there's nothing to check for them.
      const ids = [...new Set(parsed.data.events.filter(isGuideEvent).map((e) => e.guideId))];
      const known = await client.query<{ id: string }>(
        `SELECT id FROM guide WHERE id = ANY($1::uuid[]) AND app_id = $2`,
        [ids, scoped.id],
      );
      const knownIds = new Set(known.rows.map((r) => r.id));
      const events = parsed.data.events.filter((e) => !isGuideEvent(e) || knownIds.has(e.guideId));
      if (events.length === 0) return 0;

      // Batch insert via UNNEST — one round trip regardless of batch size.
      await client.query(
        `INSERT INTO guide_event
           (app_id, guide_id, guide_version_id, step_id, visitor_id, account_id, session_id, event_type, occurred_at, metadata)
         SELECT $1, e.guide_id, e.version_id, e.step_id, $2, $3, e.session_id, e.event_type, e.occurred_at, e.metadata
         FROM UNNEST($4::uuid[], $5::uuid[], $6::uuid[], $7::text[], $8::guide_event_type[], $9::timestamptz[], $10::jsonb[])
           AS e(guide_id, version_id, step_id, session_id, event_type, occurred_at, metadata)`,
        [
          scoped.id,
          visitor.visitorId,
          visitor.accountId,
          events.map((e) => (isGuideEvent(e) ? e.guideId : null)),
          events.map((e) => (isGuideEvent(e) ? e.guideVersionId : null)),
          events.map((e) => (isGuideEvent(e) ? (e.stepId ?? null) : null)),
          events.map((e) => e.sessionId),
          events.map((e) => e.eventType),
          events.map((e) => e.occurredAt),
          events.map((e) => JSON.stringify(e.metadata ?? {})),
        ],
      );
      await recordFinishedGuides(client, scoped.id, visitor.visitorId, events.filter(isGuideEvent));
      return events.length;
    });
    res.status(202).json({ accepted });
  }),
);

/**
 * Persists per-visitor shown/dismissed/completed state so /guides stops
 * serving a guide the visitor already saw or finished — until a NEWER version
 * is published (GREATEST means rolling back to an older version never brings
 * it back).
 */
async function recordFinishedGuides(
  client: PoolClient,
  appId: string,
  visitorId: string,
  events: GuideEvent[],
) {
  // Last state-changing event per guide wins; ON CONFLICT can't touch a row twice.
  const latest = new Map<string, { versionId: string; status: VisitorGuideStatus }>();
  for (const e of [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
    const status = STATUS_FOR_EVENT[e.eventType];
    if (status) latest.set(e.guideId, { versionId: e.guideVersionId, status });
  }
  if (latest.size === 0) return;
  const guideIds = [...latest.keys()];
  // The JOIN ignores a version that doesn't belong to that guide.
  await client.query(
    `INSERT INTO user_guide_state (app_id, visitor_id, guide_id, status, last_seen_version, updated_at)
     SELECT $1, $2, e.guide_id, e.status::user_guide_status, gv.version_number, now()
     FROM UNNEST($3::uuid[], $4::uuid[], $5::text[]) AS e(guide_id, version_id, status)
     JOIN guide_version gv ON gv.id = e.version_id AND gv.guide_id = e.guide_id
     ON CONFLICT (app_id, visitor_id, guide_id) DO UPDATE
       SET status = CASE
             WHEN EXCLUDED.status = 'shown'
                  AND user_guide_state.status IN ('dismissed', 'completed')
                  AND user_guide_state.last_seen_version >= EXCLUDED.last_seen_version
             THEN user_guide_state.status
             ELSE EXCLUDED.status END,
           last_seen_version = GREATEST(user_guide_state.last_seen_version, EXCLUDED.last_seen_version),
           updated_at = now()`,
    [
      appId,
      visitorId,
      guideIds,
      guideIds.map((id) => latest.get(id)!.versionId),
      guideIds.map((id) => latest.get(id)!.status),
    ],
  );
}

// ------------------------------------------------------------
// POST /v1/agent/:key/errors — an exception the agent swallowed (sampled
// client-side, at most a few per page load). Free text from a public
// endpoint: length-capped here, stored as is, and only ever rendered as
// text. Per app, at most ERROR_CAP_PER_HOUR rows an hour are kept, so one
// broken page on a busy site can't fill the table; beyond that the report
// is acknowledged and dropped.
// ------------------------------------------------------------
const ERROR_CAP_PER_HOUR = 1000;

const errorReportSchema = z.object({
  message: z.string().min(1).max(500),
  stack: z.string().max(4000).optional(),
  url: z.string().max(2000).optional(),
  agentVersion: z.string().max(50).optional(),
});

agentApiRouter.post(
  '/errors',
  asyncHandler(async (req, res) => {
    const parsed = errorReportSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_body');
    const report = parsed.data;

    const accepted = await inApp(req, async (client, scoped) => {
      const recent = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM agent_error
         WHERE app_id = $1 AND occurred_at > now() - interval '1 hour'`,
        [scoped.id],
      );
      if (recent.rows[0].n >= ERROR_CAP_PER_HOUR) return false;
      await client.query(
        `INSERT INTO agent_error (app_id, message, stack, agent_version, url) VALUES ($1, $2, $3, $4, $5)`,
        [scoped.id, report.message, report.stack ?? null, report.agentVersion ?? null, report.url ?? null],
      );
      return true;
    });
    res.status(202).json({ accepted });
  }),
);

// ------------------------------------------------------------
// POST /v1/agent/:key/preview — resolve a signed preview link to the exact
// version it names (draft or published, enabled or not). The token must
// belong to THIS app; kill switches still apply.
// ------------------------------------------------------------
agentApiRouter.post(
  '/preview',
  asyncHandler(async (req, res) => {
    const secret = previewSecret();
    if (!secret) throw new HttpError(503, 'preview_not_configured');
    const body = z.object({ token: z.string().min(1).max(4096) }).safeParse(req.body);
    const claims = body.success ? verifyPreviewToken(body.data.token, secret) : null;
    if (!claims) throw new HttpError(403, 'invalid_preview_token');

    const guide = await inApp(req, async (client, scoped) => {
      if (claims.appId !== scoped.id || !(await engineEnabled(client, scoped))) return null;
      const row = await client.query(
        `SELECT g.id, g.name, g.type, gv.id AS version_id, gv.steps, ${RESOLVED_ROUTE_MATCH_SQL} AS route_match
         FROM guide_version gv JOIN guide g ON g.id = gv.guide_id
         LEFT JOIN app_page p ON p.id = gv.page_id
         WHERE gv.id = $1 AND g.id = $2 AND g.app_id = $3`,
        [claims.versionId, claims.guideId, scoped.id],
      );
      return row.rows[0] ?? null;
    });
    if (!guide) throw notFound();
    res.json({
      id: guide.id,
      versionId: guide.version_id,
      name: guide.name,
      type: guide.type,
      steps: guide.steps,
      routeMatch: guide.route_match,
      preview: true,
    });
  }),
);
