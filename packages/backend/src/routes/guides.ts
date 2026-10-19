import { Router, Response } from 'express';
import { z } from 'zod';
import { withTenant } from '../db';
import { AuthedRequest, requireTenant } from '../middleware/tenant';

export const guidesRouter = Router();
guidesRouter.use(requireTenant);

// ------------------------------------------------------------
// POST /guides — create a draft guide for the caller's tenant
// ------------------------------------------------------------
const createGuideSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['tooltip', 'modal', 'banner', 'tour', 'checklist', 'survey', 'beacon']),
});

guidesRouter.post('/', async (req: AuthedRequest, res: Response) => {
  const parsed = createGuideSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }

  const { name, type } = parsed.data;

  const guide = await withTenant(req.tenantId!, async (client) => {
    const result = await client.query(
      `INSERT INTO guide (tenant_id, is_global, name, type, created_by)
       VALUES ($1, FALSE, $2, $3, $4)
       RETURNING id, name, type, status, enabled, created_at`,
      [req.tenantId, name, type, req.userId]
    );
    return result.rows[0];
  });

  res.status(201).json(guide);
});

// ------------------------------------------------------------
// GET /guides/:id — fetch a guide + its versions (tenant-scoped by RLS)
// ------------------------------------------------------------
guidesRouter.get('/:id', async (req: AuthedRequest, res: Response) => {
  const guide = await withTenant(req.tenantId!, async (client) => {
    const guideResult = await client.query(`SELECT * FROM guide WHERE id = $1`, [req.params.id]);
    if (guideResult.rows.length === 0) return null;

    const versionsResult = await client.query(
      `SELECT * FROM guide_version WHERE guide_id = $1 ORDER BY version_number DESC`,
      [req.params.id]
    );
    return { ...guideResult.rows[0], versions: versionsResult.rows };
  });

  if (!guide) {
    // Note: this 404 also covers "exists but belongs to another tenant" —
    // RLS means the row simply isn't visible, so we can't distinguish the
    // two cases, which is exactly the point (no tenant enumeration leak).
    res.status(404).json({ error: 'not_found' });
    return;
  }

  res.json(guide);
});

// ------------------------------------------------------------
// PATCH /guides/:id/flag — the primary admin on/off switch
// ------------------------------------------------------------
const flagSchema = z.object({ enabled: z.boolean() });

guidesRouter.patch('/:id/flag', async (req: AuthedRequest, res: Response) => {
  const parsed = flagSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }

  const updated = await withTenant(req.tenantId!, async (client) => {
    const result = await client.query(
      `UPDATE guide SET enabled = $1, updated_at = now() WHERE id = $2
       RETURNING id, enabled`,
      [parsed.data.enabled, req.params.id]
    );
    return result.rows[0] ?? null;
  });

  if (!updated) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(updated);
});

// ------------------------------------------------------------
// POST /guides/:id/publish — create a new immutable version from a draft
// payload and make it current
// ------------------------------------------------------------
const stepSchema = z.object({
  order: z.number().int().nonnegative(),
  type: z.enum(['tooltip', 'modal', 'banner', 'tour', 'checklist', 'survey', 'beacon']),
  targetSelector: z.string().optional(),
  content: z.string().min(1),
  position: z.string().optional(),
  actions: z.array(z.object({ label: z.string(), action: z.string() })).default([]),
});

const publishSchema = z.object({
  steps: z.array(stepSchema).min(1),
  routeMatch: z.object({ type: z.enum(['exact', 'pattern']), value: z.string() }),
  startAt: z.string().datetime().optional(),
  endAt: z.string().datetime().optional(),
});

guidesRouter.post('/:id/publish', async (req: AuthedRequest, res: Response) => {
  const parsed = publishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const { steps, routeMatch, startAt, endAt } = parsed.data;

  const version = await withTenant(req.tenantId!, async (client) => {
    const guideCheck = await client.query(`SELECT id FROM guide WHERE id = $1`, [req.params.id]);
    if (guideCheck.rows.length === 0) return null;

    const nextVersionResult = await client.query(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM guide_version WHERE guide_id = $1`,
      [req.params.id]
    );
    const nextVersion = nextVersionResult.rows[0].next;

    const versionResult = await client.query(
      `INSERT INTO guide_version (guide_id, version_number, steps, route_match, start_at, end_at, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       RETURNING id`,
      [req.params.id, nextVersion, JSON.stringify(steps), JSON.stringify(routeMatch), startAt ?? null, endAt ?? null]
    );
    const versionId = versionResult.rows[0].id;

    await client.query(
      `UPDATE guide SET current_version_id = $1, status = 'published', updated_at = now() WHERE id = $2`,
      [versionId, req.params.id]
    );

    return { id: versionId, versionNumber: nextVersion };
  });

  if (!version) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(201).json(version);
});

// ------------------------------------------------------------
// POST /guides/:id/rollback/:versionNumber
// ------------------------------------------------------------
guidesRouter.post('/:id/rollback/:versionNumber', async (req: AuthedRequest, res: Response) => {
  const updated = await withTenant(req.tenantId!, async (client) => {
    const versionResult = await client.query(
      `SELECT id FROM guide_version WHERE guide_id = $1 AND version_number = $2`,
      [req.params.id, req.params.versionNumber]
    );
    if (versionResult.rows.length === 0) return null;

    const result = await client.query(
      `UPDATE guide SET current_version_id = $1, updated_at = now() WHERE id = $2 RETURNING id, current_version_id`,
      [versionResult.rows[0].id, req.params.id]
    );
    return result.rows[0] ?? null;
  });

  if (!updated) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(updated);
});

// ------------------------------------------------------------
// GET /guides/active — [SDK-facing] enabled guides for this tenant
// matching the given route. Route pattern matching itself happens on
// the client (see @guide-engine/core matchesRoute) since it's easier
// to express there; this endpoint does the coarse "enabled + tenant"
// filtering and hands back candidates.
// ------------------------------------------------------------
guidesRouter.get('/active', async (req: AuthedRequest, res: Response) => {
  const guides = await withTenant(req.tenantId!, async (client) => {
    const result = await client.query(`SELECT * FROM active_guide`);
    return result.rows;
  });
  res.json(guides);
});

// ------------------------------------------------------------
// GET /guides/:id/analytics — basic funnel, scoped to caller's tenant
// ------------------------------------------------------------
guidesRouter.get('/:id/analytics', async (req: AuthedRequest, res: Response) => {
  const stats = await withTenant(req.tenantId!, async (client) => {
    const result = await client.query(
      `SELECT event_type, COUNT(*) AS count
       FROM guide_event
       WHERE guide_id = $1
       GROUP BY event_type`,
      [req.params.id]
    );
    return result.rows;
  });
  res.json({ guideId: req.params.id, counts: stats });
});
