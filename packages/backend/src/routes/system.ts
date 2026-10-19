import { Router, Response } from 'express';
import { withoutTenant, withTenant } from '../db';
import { AuthedRequest, requireTenant } from '../middleware/tenant';
import { asyncHandler } from '../asyncHandler';

export const systemRouter = Router();
systemRouter.use(requireTenant);

// ------------------------------------------------------------
// GET /system/flag — [SDK-facing] global + per-tenant kill switch check.
// Checked once at SDK init and cached client-side for the session.
// ------------------------------------------------------------
systemRouter.get(
  '/flag',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const globalEnabled = await withoutTenant(async (client) => {
      const result = await client.query(`SELECT value FROM system_config WHERE key = 'guide_engine_enabled'`);
      return result.rows[0]?.value !== 'false';
    });

    const tenantEnabled = await withTenant(req.tenantId!, async (client) => {
      const result = await client.query(
        `SELECT value FROM tenant_config WHERE tenant_id = $1 AND key = 'guide_engine_enabled'`,
        [req.tenantId],
      );
      // absence of a row means "no override" -> treated as enabled
      return result.rows[0]?.value !== 'false';
    });

    res.json({ globalEnabled, tenantEnabled });
  }),
);
