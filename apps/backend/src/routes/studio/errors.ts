import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../asyncHandler';
import { idParam, requireAppRole, studio } from './context';

/**
 * Recent agent errors for one app (/v1/apps/:appId/errors): what the
 * install snippet reported from customers' pages (routes/agent.ts). Read
 * only — rows age out through retention. Any member of the app may look:
 * it's diagnostic text about their own site, with nothing in it they
 * couldn't see in their own browser console.
 */
export const errorsRouter = Router({ mergeParams: true });

const limitSchema = z.coerce.number().int().min(1).max(200).default(50);

interface AgentErrorRow {
  id: string;
  message: string;
  stack: string | null;
  agent_version: string | null;
  url: string | null;
  occurred_at: string;
}

// GET /apps/:appId/errors?limit=50 — newest first
errorsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const limit = limitSchema.safeParse(req.query.limit);
    const rows = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'viewer');
      const result = await client.query<AgentErrorRow>(
        `SELECT id, message, stack, agent_version, url, occurred_at
         FROM agent_error WHERE app_id = $1
         ORDER BY occurred_at DESC, id LIMIT $2`,
        [appId, limit.success ? limit.data : 50],
      );
      return result.rows;
    });
    res.json(
      rows.map((r) => ({
        id: r.id,
        message: r.message,
        stack: r.stack,
        agentVersion: r.agent_version,
        url: r.url,
        occurredAt: r.occurred_at,
      })),
    );
  }),
);
