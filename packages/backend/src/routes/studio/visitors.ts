import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../asyncHandler';
import { HttpError } from '../../httpError';
import { requestLogger } from '../../logging';
import { idParam, requireAppRole, studio } from './context';

/**
 * One end user's data in one app: /v1/apps/:appId/visitors/:visitorId
 *
 * Customers are the controllers for their end users, and they identify them
 * by the visitor id their own site passed to guideEngine.initialize(). When
 * an end user asks "what do you hold about me?" or "forget me", the app's
 * admin answers from here (app_admin role; policies in migration 014):
 *   GET     everything keyed by that visitor id, as a JSON download
 *   DELETE  the same rows, gone in one transaction ("forget this visitor")
 * Agent error reports carry no visitor id, so they are not involved.
 */
export const visitorsRouter = Router({ mergeParams: true });

/** Visitor ids are the customer's own strings; the agent caps them at 256 characters too. */
const visitorIdSchema = z.string().min(1).max(256);

function visitorParam(raw: unknown): string {
  const parsed = visitorIdSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_visitor_id');
  return parsed.data;
}

// GET /:visitorId — export (an attachment, like the organization export)
visitorsRouter.get(
  '/:visitorId',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const visitorId = visitorParam(req.params.visitorId);
    const data = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'app_admin');
      const events = await client.query(
        `SELECT guide_id, guide_version_id, step_id, account_id, session_id, event_type, occurred_at, metadata
         FROM guide_event WHERE app_id = $1 AND visitor_id = $2 ORDER BY occurred_at`,
        [appId, visitorId],
      );
      const state = await client.query(
        `SELECT guide_id, status, last_seen_version, updated_at
         FROM user_guide_state WHERE app_id = $1 AND visitor_id = $2 ORDER BY updated_at`,
        [appId, visitorId],
      );
      return {
        appId,
        visitorId,
        exportedAt: new Date().toISOString(),
        events: events.rows.map((e) => ({
          guideId: e.guide_id,
          guideVersionId: e.guide_version_id,
          stepId: e.step_id,
          accountId: e.account_id,
          sessionId: e.session_id,
          eventType: e.event_type,
          occurredAt: e.occurred_at,
          metadata: e.metadata,
        })),
        guideState: state.rows.map((s) => ({
          guideId: s.guide_id,
          status: s.status,
          lastSeenVersion: s.last_seen_version,
          updatedAt: s.updated_at,
        })),
        notes: [
          'Events are what the Guide Engine agent recorded on the customer’s site for this visitor id: which guides and steps were shown, completed or dismissed, and help-center opens and searches.',
          'Guide state is what keeps a finished guide from showing again.',
          'The anonymous visitor id, when the site did not sign the visitor in, lives in the browser’s storage for that site; Guide Engine holds nothing else about the person.',
        ],
      };
    });
    res.attachment(`guide-engine-visitor-${safeName(visitorId)}-${data.exportedAt.slice(0, 10)}.json`);
    res.json(data);
  }),
);

// DELETE /:visitorId — forget this visitor
visitorsRouter.delete(
  '/:visitorId',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const visitorId = visitorParam(req.params.visitorId);
    const counts = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'app_admin');
      const events = await client.query(`DELETE FROM guide_event WHERE app_id = $1 AND visitor_id = $2`, [
        appId,
        visitorId,
      ]);
      const state = await client.query(`DELETE FROM user_guide_state WHERE app_id = $1 AND visitor_id = $2`, [
        appId,
        visitorId,
      ]);
      return { events: events.rowCount ?? 0, guideState: state.rowCount ?? 0 };
    });
    // Deletions are logged (not the id itself: it may be personal data).
    requestLogger(req).warn({ appId, ...counts }, 'visitor forgotten');
    res.json({ visitorId, ...counts });
  }),
);

/** A file-name-safe rendering of the visitor id (which the customer may have made anything). */
function safeName(visitorId: string): string {
  const cleaned = visitorId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
  return cleaned || 'visitor';
}
