import { Router } from 'express';
import { withTenant } from '../db';
import { asyncHandler } from '../asyncHandler';
import { requireTenant } from '../middleware/tenant';
import { previewSecret, verifyPreviewToken } from '../preview';

export const previewRouter = Router();
previewRouter.use(requireTenant);

// ------------------------------------------------------------
// GET /preview/guide — [SDK-facing] resolve a signed preview token
// (X-Guide-Preview header) to the exact guide version it names, ignoring
// `enabled` and publish state. Requires BOTH a valid session (any role — it's
// the end user's own host-app token) AND a preview token for that same
// tenant: a leaked preview link is useless outside the tenant it was minted for.
// Global guides are previewable too (inside the minting admin's own tenant).
// ------------------------------------------------------------
previewRouter.get(
  '/guide',
  asyncHandler(async (req, res) => {
    const secret = previewSecret();
    if (!secret) {
      res.status(503).json({ error: 'preview_not_configured' });
      return;
    }

    const token = req.header('x-guide-preview');
    const claims = token ? verifyPreviewToken(token, secret) : null;
    if (!claims) {
      res.status(403).json({ error: 'invalid_preview_token' });
      return;
    }
    // 404, not 403: don't confirm to another tenant that the guide exists.
    if (claims.tenantId !== req.tenantId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const row = await withTenant(req.tenantId!, async (client) => {
      const result = await client.query(
        `SELECT g.id, g.tenant_id, g.is_global, g.name, g.type,
                gv.id AS version_id, gv.steps, gv.route_match
         FROM guide_version gv JOIN guide g ON g.id = gv.guide_id
         WHERE gv.id = $1 AND g.id = $2 AND (g.tenant_id = $3 OR g.is_global = TRUE)`,
        [claims.versionId, claims.guideId, req.tenantId]
      );
      return result.rows[0] ?? null;
    });

    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    res.json({
      id: row.id,
      versionId: row.version_id,
      tenantId: row.tenant_id,
      isGlobal: row.is_global,
      name: row.name,
      type: row.type,
      steps: row.steps,
      routeMatch: row.route_match,
      preview: true,
    });
  })
);
