import express, { NextFunction, Request, Response, Router } from 'express';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { asyncHandler } from '../asyncHandler';
import { AgentApp, findAppByPublicKey, withAgentSession } from '../db';
import { HttpError, notFound } from '../httpError';
import { identityInputSchema, resolveVisitor, Visitor } from '../auth/visitor';
import { previewSecret, verifyPreviewToken } from '../preview';
import { createRateLimiter } from '../rateLimit';
import { RESOLVED_ROUTE_MATCH_SQL } from './studio/context';

/**
 * The public side: what the install snippet on customers' pages talks to.
 *
 *   GET  /agent/v1/:key/guides.js      the agent script (same file for every key)
 *   POST /v1/agent/:key/guides         kill switches + this visitor's active guides
 *   POST /v1/agent/:key/events         analytics batch (+ dismiss/complete state)
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
// key and the API origin from its own <script src>. Cacheable; a CDN can sit
// in front later without code changes.
// ------------------------------------------------------------
let bundle: Promise<string> | null = null;
function loadBundle(): Promise<string> {
  const path =
    process.env.AGENT_BUNDLE_PATH ?? join(__dirname, '..', '..', '..', 'agent', 'dist', 'guide-engine.js');
  bundle ??= readFile(path, 'utf-8').catch((err) => {
    bundle = null; // retry on the next request (e.g. after `npm run build`)
    throw err;
  });
  return bundle;
}

agentScriptRouter.get('/:key/guides.js', (req, res) => {
  if (!KEY_PATTERN.test(req.params.key)) {
    res.status(404).type('application/javascript').send('/* unknown key */');
    return;
  }
  loadBundle()
    .then((js) => {
      res
        .type('application/javascript')
        .set('Cache-Control', 'public, max-age=300')
        .set('Cross-Origin-Resource-Policy', 'cross-origin')
        .send(js);
    })
    .catch(() => res.status(503).type('application/javascript').send('/* agent bundle not built */'));
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

const allow = createRateLimiter(Number(process.env.AGENT_RATE_LIMIT_PER_MIN ?? 600));

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
    if (!allow(`${key}|${req.ip}`)) throw new HttpError(429, 'rate_limited');

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

function visitorFrom(req: Request, app: AgentApp): Visitor {
  const input = identityInputSchema.safeParse(req.body ?? {});
  if (!input.success) throw new HttpError(400, 'invalid_body');
  const result = resolveVisitor(app, input.data);
  if (!result.ok) throw new HttpError(401, result.error);
  return result.visitor;
}

// ------------------------------------------------------------
// POST /v1/agent/:key/guides — one round trip: kill switches + every guide
// this visitor should see right now (published, enabled, in its date window,
// their account allowed, not already finished at this version or later).
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
           AND (a.account_ids IS NULL OR $3::text = ANY(a.account_ids))
           AND NOT EXISTS (
             SELECT 1 FROM user_guide_state s
             WHERE s.app_id = $1 AND s.visitor_id = $2 AND s.guide_id = a.id
               AND s.status IN ('dismissed', 'completed')
               AND s.last_seen_version >= a.version_number
           )`,
        [scoped.id, visitor.visitorId, visitor.accountId],
      );
      return {
        enabled: true,
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
// start (published, enabled, in its date window, account allowed). Unlike
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
           AND (a.account_ids IS NULL OR $2::text = ANY(a.account_ids))
         ORDER BY a.help ->> 'title'`,
        [scoped.id, visitor.accountId],
      );
      return {
        enabled: true,
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
// POST /v1/agent/:key/events — fire-and-forget analytics batch.
// ------------------------------------------------------------
const eventSchema = z.object({
  guideId: z.string().uuid(),
  guideVersionId: z.string().uuid(),
  stepId: z.string().uuid().optional(),
  sessionId: z.string().min(1).max(100),
  eventType: z.enum([
    'guide_shown',
    'guide_step_viewed',
    'guide_step_completed',
    'guide_dismissed',
    'guide_completed',
    'guide_error',
    'survey_response',
  ]),
  occurredAt: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
});
const eventsBodySchema = z.object({ events: z.array(eventSchema).min(1).max(100) });
type AgentEvent = z.infer<typeof eventSchema>;

const TERMINAL_STATUS: Partial<Record<AgentEvent['eventType'], 'dismissed' | 'completed'>> = {
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
      // filter drops unknown ids instead of failing the whole batch).
      const ids = [...new Set(parsed.data.events.map((e) => e.guideId))];
      const known = await client.query<{ id: string }>(
        `SELECT id FROM guide WHERE id = ANY($1::uuid[]) AND app_id = $2`,
        [ids, scoped.id],
      );
      const knownIds = new Set(known.rows.map((r) => r.id));
      const events = parsed.data.events.filter((e) => knownIds.has(e.guideId));
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
          events.map((e) => e.guideId),
          events.map((e) => e.guideVersionId),
          events.map((e) => e.stepId ?? null),
          events.map((e) => e.sessionId),
          events.map((e) => e.eventType),
          events.map((e) => e.occurredAt),
          events.map((e) => JSON.stringify(e.metadata ?? {})),
        ],
      );
      await recordFinishedGuides(client, scoped.id, visitor.visitorId, events);
      return events.length;
    });
    res.status(202).json({ accepted });
  }),
);

/**
 * Persists per-visitor dismissal/completion so /guides stops serving a guide
 * the visitor already finished — until a NEWER version is published (GREATEST
 * means rolling back to an older version never brings it back).
 */
async function recordFinishedGuides(
  client: PoolClient,
  appId: string,
  visitorId: string,
  events: AgentEvent[],
) {
  // Last terminal event per guide wins; ON CONFLICT can't touch a row twice.
  const latest = new Map<string, { versionId: string; status: 'dismissed' | 'completed' }>();
  for (const e of [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
    const status = TERMINAL_STATUS[e.eventType];
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
       SET status = EXCLUDED.status,
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
