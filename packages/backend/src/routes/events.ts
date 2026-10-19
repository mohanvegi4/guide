import { Router, Response } from 'express';
import { z } from 'zod';
import { PoolClient } from 'pg';
import { withTenant } from '../db';
import { asyncHandler } from '../asyncHandler';
import { AuthedRequest, requireTenant } from '../middleware/tenant';

export const eventsRouter = Router();
eventsRouter.use(requireTenant);

const eventSchema = z.object({
  guideId: z.string().uuid(),
  guideVersionId: z.string().uuid(),
  stepId: z.string().uuid().optional(),
  sessionId: z.string(),
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

type IngestedEvent = z.infer<typeof eventSchema>;

/** Event types after which a guide shouldn't be shown to that user again (until a newer version). */
const TERMINAL_STATUS: Partial<Record<IngestedEvent['eventType'], 'dismissed' | 'completed'>> = {
  guide_dismissed: 'dismissed',
  guide_completed: 'completed',
};

/**
 * Persists per-user dismissal/completion into user_guide_state so
 * /guides/active can stop serving a guide the user has already finished —
 * without this, a dismissed guide reappeared on the very next navigation.
 *
 * Records the version number the user finished; a guide re-appears only once
 * a NEWER version is published (GREATEST means rolling back to an older
 * version never resurrects it). Derived from the event stream rather than a
 * separate endpoint so the SDK has exactly one write path.
 */
async function recordFinishedGuides(
  client: PoolClient,
  tenantId: string,
  userId: string,
  events: IngestedEvent[],
): Promise<void> {
  // Last terminal event per guide wins. Deduping matters: ON CONFLICT DO
  // UPDATE can't touch the same row twice in one statement.
  const latest = new Map<string, { versionId: string; status: 'dismissed' | 'completed' }>();
  for (const e of [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
    const status = TERMINAL_STATUS[e.eventType];
    if (status) latest.set(e.guideId, { versionId: e.guideVersionId, status });
  }
  if (latest.size === 0) return;

  const guideIds = [...latest.keys()];
  // The JOIN on guide_version (guide_id AND id) ignores a versionId that
  // doesn't belong to that guide, so a client can't claim a bogus version.
  await client.query(
    `INSERT INTO user_guide_state (tenant_id, user_id, guide_id, status, last_seen_version, updated_at)
     SELECT $1, $2, e.guide_id, e.status::user_guide_status, gv.version_number, now()
     FROM UNNEST($3::uuid[], $4::uuid[], $5::text[]) AS e(guide_id, version_id, status)
     JOIN guide_version gv ON gv.id = e.version_id AND gv.guide_id = e.guide_id
     ON CONFLICT (tenant_id, user_id, guide_id) DO UPDATE
       SET status = EXCLUDED.status,
           last_seen_version = GREATEST(user_guide_state.last_seen_version, EXCLUDED.last_seen_version),
           updated_at = now()`,
    [
      tenantId,
      userId,
      guideIds,
      guideIds.map((id) => latest.get(id)!.versionId),
      guideIds.map((id) => latest.get(id)!.status),
    ],
  );
}

const batchSchema = z.object({
  events: z.array(eventSchema).min(1).max(100), // cap batch size defensively
});

// ------------------------------------------------------------
// POST /events — [SDK-facing] batched, fire-and-forget event ingestion.
// Always returns quickly; never let this become a bottleneck for the SDK.
// ------------------------------------------------------------
eventsRouter.post(
  '/',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      // Still 400 on genuinely malformed input, but the SDK treats any
      // non-2xx as "drop and move on" — it never retries indefinitely.
      res.status(400).json({ error: 'invalid_body' });
      return;
    }

    const accepted = await withTenant(req.tenantId!, async (client) => {
      // Only accept events for guides this tenant can actually see (own or
      // global). The guide_id FK check bypasses RLS, so without this a tenant
      // could write events against another tenant's guide id. Unknown ids are
      // dropped silently — the SDK treats ingestion as fire-and-forget anyway.
      const requestedIds = [...new Set(parsed.data.events.map((e) => e.guideId))];
      const visible = await client.query<{ id: string }>(
        `SELECT id FROM guide WHERE id = ANY($1::uuid[]) AND (tenant_id = $2 OR is_global = TRUE)`,
        [requestedIds, req.tenantId],
      );
      const visibleIds = new Set(visible.rows.map((r) => r.id));
      const events = parsed.data.events.filter((e) => visibleIds.has(e.guideId));
      if (events.length === 0) return 0;

      // Batch insert via UNNEST — one round trip regardless of batch size.
      await client.query(
        `INSERT INTO guide_event
         (tenant_id, guide_id, guide_version_id, step_id, user_id, session_id, event_type, occurred_at, metadata)
       SELECT $1, * FROM UNNEST(
         $2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::guide_event_type[], $8::timestamptz[], $9::jsonb[]
       )`,
        [
          req.tenantId,
          events.map((e) => e.guideId),
          events.map((e) => e.guideVersionId),
          events.map((e) => e.stepId ?? null),
          events.map(() => req.userId),
          events.map((e) => e.sessionId),
          events.map((e) => e.eventType),
          events.map((e) => e.occurredAt),
          events.map((e) => JSON.stringify(e.metadata ?? {})),
        ],
      );
      await recordFinishedGuides(client, req.tenantId!, req.userId!, events);
      return events.length;
    });

    res.status(202).json({ accepted });
  }),
);
