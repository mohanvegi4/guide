import { Router, Response } from 'express';
import { z } from 'zod';
import { withTenant } from '../db';
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

const batchSchema = z.object({
  events: z.array(eventSchema).min(1).max(100), // cap batch size defensively
});

// ------------------------------------------------------------
// POST /events — [SDK-facing] batched, fire-and-forget event ingestion.
// Always returns quickly; never let this become a bottleneck for the SDK.
// ------------------------------------------------------------
eventsRouter.post('/', async (req: AuthedRequest, res: Response) => {
  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) {
    // Still 400 on genuinely malformed input, but the SDK treats any
    // non-2xx as "drop and move on" — it never retries indefinitely.
    res.status(400).json({ error: 'invalid_body' });
    return;
  }

  await withTenant(req.tenantId!, async (client) => {
    // Batch insert via UNNEST — one round trip regardless of batch size.
    const events = parsed.data.events;
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
      ]
    );
  });

  res.status(202).json({ accepted: parsed.data.events.length });
});
