import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../asyncHandler';
import { analyticsEnvironmentId } from '../../services/environments';
import { idParam, parseBody, requireAppRole, studio } from './context';

/**
 * Per-app analytics rollup (viewer): one row per guide with its lifetime
 * shown / completed / dismissed counts, plus how many distinct visitors and
 * accounts the app's guides reached in the last 30 days. The per-guide
 * funnel lives next to the guide routes (guides.ts); the date-range query
 * parsing below is shared with it.
 */
export const analyticsRouter = Router();

// ------------------------------------------------------------
// ?from= & ?to= — an optional window on occurred_at.
// ------------------------------------------------------------
// A calendar date or an ISO 8601 timestamp (what Date.parse accepts for
// those two shapes; "yesterday" or "10/19/2026" are rejected up front).
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const isoDateOrTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/,
    'use an ISO date or timestamp',
  )
  .refine((s) => !Number.isNaN(Date.parse(s)), 'not a valid date');

export interface AnalyticsRange {
  /** Inclusive lower bound, or null for "since forever". */
  from: Date | null;
  /** Exclusive upper bound, or null for "until now". */
  to: Date | null;
}

/**
 * `from` is inclusive. A plain-date `to` covers that whole day (UTC), since
 * that's what "to 2026-10-19" means to a person; a timestamp `to` is
 * exclusive so adjacent windows don't double count.
 */
export function toRange(q: { from?: string; to?: string }): AnalyticsRange {
  return {
    from: q.from ? new Date(q.from) : null,
    to: q.to
      ? DATE_ONLY.test(q.to)
        ? new Date(Date.parse(q.to) + 24 * 60 * 60 * 1000)
        : new Date(q.to)
      : null,
  };
}

/** The per-guide analytics query string: an optional window, and an optional breakdown. */
/** ?environment= — whose numbers; omitted, production's. Analytics are never mixed across environments. */
export const environmentQuerySchema = z.object({ environment: z.string().uuid().optional() });

export const guideAnalyticsQuerySchema = z
  .object({
    by: z.enum(['account']).optional(),
    environment: z.string().uuid().optional(),
    from: isoDateOrTime.optional(),
    to: isoDateOrTime.optional(),
  })
  .refine(
    (q) => {
      const r = toRange(q);
      return !r.from || !r.to || r.from < r.to;
    },
    { message: 'to must be after from', path: ['to'] },
  );

/**
 * SQL fragment (starting with AND) restricting `occurred_at` to the range,
 * with its parameters numbered from `firstParam` — so callers can append
 * both to a query that already has positional parameters.
 */
export function rangeSql(range: AnalyticsRange, firstParam: number): { sql: string; params: Date[] } {
  const params: Date[] = [];
  let sql = '';
  if (range.from) {
    params.push(range.from);
    sql += ` AND occurred_at >= $${firstParam + params.length - 1}`;
  }
  if (range.to) {
    params.push(range.to);
    sql += ` AND occurred_at < $${firstParam + params.length - 1}`;
  }
  return { sql, params };
}

const REACH_WINDOW_DAYS = 30;

// ------------------------------------------------------------
// GET /v1/apps/:appId/analytics — every guide's totals + recent reach
// ------------------------------------------------------------
analyticsRouter.get(
  '/apps/:appId/analytics',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const query = parseBody(environmentQuerySchema, req.query);
    const stats = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'viewer');
      const environmentId = await analyticsEnvironmentId(client, appId, query.environment);
      // LEFT JOIN so guides without events still appear (with zeros): the
      // list page shows one row per guide. Events are joined on app_id too,
      // so the (app_id, guide_id) index serves the lookup.
      const guides = await client.query<{
        guide_id: string;
        name: string;
        shown: number;
        completed: number;
        dismissed: number;
      }>(
        `SELECT g.id AS guide_id, g.name,
                COUNT(e.id) FILTER (WHERE e.event_type = 'guide_shown')::int AS shown,
                COUNT(e.id) FILTER (WHERE e.event_type = 'guide_completed')::int AS completed,
                COUNT(e.id) FILTER (WHERE e.event_type = 'guide_dismissed')::int AS dismissed
         FROM guide g
         LEFT JOIN guide_event e ON e.guide_id = g.id AND e.app_id = g.app_id AND e.environment_id = $2
         WHERE g.app_id = $1
         GROUP BY g.id, g.name
         ORDER BY shown DESC, g.name`,
        [appId, environmentId],
      );
      // COUNT(DISTINCT account_id) skips NULLs: anonymous visitors count as
      // visitors but not as an account.
      const reach = await client.query<{ visitors: number; accounts: number }>(
        `SELECT COUNT(DISTINCT visitor_id)::int AS visitors, COUNT(DISTINCT account_id)::int AS accounts
         FROM guide_event
         WHERE app_id = $1 AND environment_id = $3 AND occurred_at >= now() - make_interval(days => $2)`,
        [appId, REACH_WINDOW_DAYS, environmentId],
      );
      return {
        environmentId,
        guides: guides.rows.map((g) => ({
          guideId: g.guide_id,
          name: g.name,
          shown: g.shown,
          completed: g.completed,
          dismissed: g.dismissed,
          // A fraction (0–1), not a percentage; the Studio formats it.
          completionRate: g.shown > 0 ? g.completed / g.shown : 0,
        })),
        visitors: reach.rows[0].visitors,
        accounts: reach.rows[0].accounts,
        windowDays: REACH_WINDOW_DAYS,
      };
    });
    res.json(stats);
  }),
);
