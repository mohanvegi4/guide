import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { PoolClient } from 'pg';
import { withTenant } from '../db';
import { asyncHandler } from '../asyncHandler';
import { sanitizePlainText, sanitizeStepContent } from '../sanitize';
import { PREVIEW_TTL_SECONDS, previewPath, previewSecret, signPreviewToken } from '../preview';
import {
  AuthedRequest,
  GUIDE_ADMIN_ROLE,
  PLATFORM_ADMIN_ROLE,
  requireRole,
  requireTenant,
} from '../middleware/tenant';

/**
 * Two routers share one set of authoring handlers (createAuthoringRouter):
 *  - /guides            tenant scope: the caller's own guides (guide_admin),
 *                       plus the SDK-facing GET /guides/active
 *  - /platform/guides   global scope: guides shown to every tenant (platform_admin)
 */
export const guidesRouter = Router();
export const platformGuidesRouter = Router();

type Scope = 'tenant' | 'global';

/**
 * Who owns the guides a request may author, and how to open its DB session.
 * `owner` is the tenant id in tenant scope, or null in global scope; every
 * query matches ownership with ownedBy() below, so one SQL text serves both.
 */
interface ScopeContext {
  owner: string | null;
  run<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
}

function scopeContext(scope: Scope, req: AuthedRequest): ScopeContext {
  if (scope === 'tenant') {
    return { owner: req.tenantId!, run: (fn) => withTenant(req.tenantId!, fn) };
  }
  // Global scope still runs inside the admin's own tenant session (so tenant
  // data stays invisible); platformAdmin additionally unlocks writes to
  // global rows at the RLS level (migration 004). The flag is derived from
  // the verified role checked by requireRole — never from request input.
  return { owner: null, run: (fn) => withTenant(req.tenantId!, fn, { platformAdmin: true }) };
}

/**
 * Ownership predicate for guide alias `a` against parameter $n (the scope's
 * owner): the tenant's own rows when $n is a tenant id, global rows when $n
 * is NULL. App-level half of isolation; RLS is the other half.
 */
function ownedBy(a: string, n: number): string {
  return `(${a}.tenant_id = $${n}::uuid OR ($${n}::uuid IS NULL AND ${a}.is_global = TRUE))`;
}

const guideTypeSchema = z.enum(['tooltip', 'modal', 'banner', 'tour', 'checklist', 'survey', 'beacon']);
const uuidSchema = z.string().uuid();

/**
 * Validates `:id` as a UUID before it reaches Postgres. A malformed id would
 * otherwise raise a cast error (500); responding 404 keeps it
 * indistinguishable from "doesn't exist / belongs to another tenant".
 */
function guideIdParam(req: AuthedRequest, res: Response): string | null {
  const parsed = uuidSchema.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return parsed.data;
}

// ------------------------------------------------------------
// GET /guides/active — [SDK-facing] enabled guides for this tenant (its own
// plus global ones). Route pattern matching itself happens on the client
// (see @guide-engine/core matchesRoute) since it's easier to express there;
// this endpoint does the coarse "enabled + published + date window + tenant
// + not already finished by this user" filtering and hands back candidates
// in the SDK's Guide shape.
// ------------------------------------------------------------
guidesRouter.use(requireTenant);

guidesRouter.get(
  '/active',
  asyncHandler(async (req, res) => {
    const rows = await withTenant(req.tenantId!, async (client) => {
      // The explicit tenant filter matters: the active_guide view used to run
      // with its owner's privileges and bypass RLS entirely (fixed in
      // migration 002), so this WHERE is the app-level half of isolation.
      // Excludes guides this user already dismissed/completed, unless a newer
      // version has been published since (see events.ts recordFinishedGuides).
      const result = await client.query(
        `SELECT a.id, a.tenant_id, a.is_global, a.name, a.type, a.version_id, a.steps, a.route_match
         FROM active_guide a
         JOIN guide_version gv ON gv.id = a.version_id
         WHERE (a.tenant_id = $1 OR a.is_global = TRUE)
           AND NOT EXISTS (
             SELECT 1 FROM user_guide_state s
             WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.guide_id = a.id
               AND s.status IN ('dismissed', 'completed')
               AND s.last_seen_version >= gv.version_number
           )`,
        [req.tenantId, req.userId],
      );
      return result.rows;
    });

    res.json(
      rows.map((row) => ({
        id: row.id,
        versionId: row.version_id,
        tenantId: row.tenant_id,
        isGlobal: row.is_global,
        name: row.name,
        type: row.type,
        steps: row.steps,
        routeMatch: row.route_match,
      })),
    );
  }),
);

// Everything else is authoring. The role guard sits in front of the whole
// sub-router, so a newly added authoring route can't accidentally be left
// open to end-user SDK tokens. NOTE ON ROUTE ORDER: '/active' above is
// registered before the sub-router's '/:id', otherwise Express would match
// GET /guides/active as id = "active".
guidesRouter.use(requireRole(GUIDE_ADMIN_ROLE), createAuthoringRouter('tenant'));

platformGuidesRouter.use(requireTenant, requireRole(PLATFORM_ADMIN_ROLE), createAuthoringRouter('global'));

// ------------------------------------------------------------
// Version payloads (shared by draft save + publish)
// ------------------------------------------------------------
// Targets must use the data-guide-id convention (set by the Angular/Vue
// anchor directives) rather than arbitrary CSS selectors, which break on
// markup refactors.
const DATA_GUIDE_ID_SELECTOR = /^\[data-guide-id="[A-Za-z0-9_-]+"\]$/;

const stepSchema = z.object({
  // Authors' tools send back the id of a step they're editing so it stays the
  // same across drafts and versions — that's what lets per-step analytics
  // follow a step through edits. New steps omit it and get one assigned.
  id: z.string().uuid().optional(),
  order: z.number().int().nonnegative(),
  type: guideTypeSchema,
  targetSelector: z.string().regex(DATA_GUIDE_ID_SELECTOR, 'must be [data-guide-id="..."]').optional(),
  content: z.string().min(1).max(20_000),
  position: z.enum(['top', 'bottom', 'left', 'right', 'center']).optional(),
  // Only actions the SDK renderer actually handles.
  actions: z
    .array(
      z.object({
        label: z.string().min(1).max(100),
        action: z.enum(['next', 'back', 'dismiss', 'complete']),
      }),
    )
    .default([]),
});

const versionBodySchema = z
  .object({
    steps: z.array(stepSchema).min(1).max(50),
    routeMatch: z.object({ type: z.enum(['exact', 'pattern']), value: z.string().startsWith('/') }),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional(),
  })
  .refine((v) => !v.startAt || !v.endAt || v.startAt < v.endAt, {
    message: 'startAt must be before endAt',
    path: ['endAt'],
  })
  .refine(
    (v) => {
      const ids = v.steps.map((s) => s.id).filter(Boolean);
      return new Set(ids).size === ids.length;
    },
    { message: 'step ids must be unique', path: ['steps'] },
  );

type StepInput = z.infer<typeof stepSchema>;

/**
 * Turns validated step input into what gets persisted:
 *  - content/labels sanitized (see sanitize.ts for why this is on the write path)
 *  - sorted into display order so the SDK can trust array order
 *  - an id per step (kept if the author sent one, so it is stable across
 *    versions; generated for new steps) for step-level analytics
 * Returns null if sanitization emptied a step — e.g. content that was only a
 * <script> — since saving a blank step is never what the author intended.
 */
function prepareSteps(input: StepInput[]): Array<StepInput & { id: string }> | null {
  const steps = [...input]
    .sort((a, b) => a.order - b.order)
    .map((step) => ({
      ...step,
      id: step.id ?? randomUUID(),
      content: sanitizeStepContent(step.content),
      actions: step.actions.map((a) => ({ ...a, label: sanitizePlainText(a.label) })),
    }));
  const emptied = steps.some((s) => s.content === '' || s.actions.some((a) => a.label === ''));
  return emptied ? null : steps;
}

interface PreparedVersion {
  steps: Array<StepInput & { id: string }>;
  routeMatch: { type: 'exact' | 'pattern'; value: string };
  startAt: string | null;
  endAt: string | null;
}

/** Validates + sanitizes a version body; on failure sends the 400 itself and returns null. */
function parseVersionBody(body: unknown, res: Response): PreparedVersion | null {
  const parsed = versionBodySchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return null;
  }
  // Sanitize BEFORE persisting: drafts are rendered by preview links, and
  // published versions are immutable — unsafe content must never be stored.
  const steps = prepareSteps(parsed.data.steps);
  if (!steps) {
    res.status(400).json({ error: 'empty_content_after_sanitize' });
    return null;
  }
  const { routeMatch, startAt, endAt } = parsed.data;
  return { steps, routeMatch, startAt: startAt ?? null, endAt: endAt ?? null };
}

/**
 * Locks a guide the scope owns for the rest of the transaction. FOR UPDATE
 * serializes concurrent draft saves / publishes of the same guide, so two
 * requests can't compute the same next version_number or both create a draft.
 */
async function lockOwnedGuide(client: PoolClient, guideId: string, owner: string | null): Promise<boolean> {
  const result = await client.query(
    `SELECT id FROM guide g WHERE g.id = $1 AND ${ownedBy('g', 2)} FOR UPDATE`,
    [guideId, owner],
  );
  return result.rows.length > 0;
}

const VERSION_COLUMNS = 'id, version_number, steps, route_match, start_at, end_at, published_at';

/**
 * Creates or overwrites the guide's single working draft (published_at NULL).
 * A new draft takes MAX(version_number)+1, so version numbers stay monotonic
 * whichever way a version is eventually published. Caller must hold the lock.
 */
async function upsertDraft(client: PoolClient, guideId: string, v: PreparedVersion) {
  const values = [JSON.stringify(v.steps), JSON.stringify(v.routeMatch), v.startAt, v.endAt];
  const updated = await client.query(
    `UPDATE guide_version SET steps = $2, route_match = $3, start_at = $4, end_at = $5
     WHERE guide_id = $1 AND published_at IS NULL
     RETURNING ${VERSION_COLUMNS}`,
    [guideId, ...values],
  );
  if (updated.rows.length > 0) return updated.rows[0];

  const inserted = await client.query(
    `INSERT INTO guide_version (guide_id, version_number, steps, route_match, start_at, end_at, published_at)
     SELECT $1, COALESCE(MAX(version_number), 0) + 1, $2, $3, $4, $5, NULL
     FROM guide_version WHERE guide_id = $1
     RETURNING ${VERSION_COLUMNS}`,
    [guideId, ...values],
  );
  return inserted.rows[0];
}

function toVersionResponse(row: Record<string, unknown>) {
  return {
    id: row.id,
    versionNumber: row.version_number,
    steps: row.steps,
    routeMatch: row.route_match,
    startAt: row.start_at,
    endAt: row.end_at,
    publishedAt: row.published_at,
  };
}

const createGuideSchema = z.object({
  name: z.string().min(1),
  type: guideTypeSchema,
});
const flagSchema = z.object({ enabled: z.boolean() });
const previewTokenSchema = z.object({ versionId: z.string().uuid() });

function createAuthoringRouter(scope: Scope): Router {
  const router = Router();

  // ------------------------------------------------------------
  // GET / — list the guides this scope owns. Tenant scope deliberately
  // excludes global guides: tenants can't edit them.
  // ------------------------------------------------------------
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const ctx = scopeContext(scope, req);
      const guides = await ctx.run(async (client) => {
        const result = await client.query(
          `SELECT g.id, g.name, g.type, g.status, g.enabled, g.is_global, g.current_version_id,
                  gv.version_number AS current_version_number, g.created_at, g.updated_at
           FROM guide g
           LEFT JOIN guide_version gv ON gv.id = g.current_version_id
           WHERE ${ownedBy('g', 1)}
           ORDER BY g.updated_at DESC`,
          [ctx.owner],
        );
        return result.rows;
      });
      res.json(guides);
    }),
  );

  // ------------------------------------------------------------
  // POST / — create a draft guide in this scope
  // ------------------------------------------------------------
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const parsed = createGuideSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
        return;
      }
      const { name, type } = parsed.data;
      const ctx = scopeContext(scope, req);

      const guide = await ctx.run(async (client) => {
        // Owner NULL => global guide (tenant_id NULL, is_global TRUE), which
        // satisfies chk_tenant_or_global and only the platform-admin RLS policy.
        const result = await client.query(
          `INSERT INTO guide (tenant_id, is_global, name, type, created_by)
           VALUES ($1::uuid, $1::uuid IS NULL, $2, $3, $4)
           RETURNING id, name, type, status, enabled, is_global, created_at`,
          [ctx.owner, name, type, req.userId],
        );
        return result.rows[0];
      });

      res.status(201).json(guide);
    }),
  );

  // ------------------------------------------------------------
  // GET /:id — a guide + its versions
  // ------------------------------------------------------------
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = guideIdParam(req, res);
      if (!id) return;
      const ctx = scopeContext(scope, req);

      const guide = await ctx.run(async (client) => {
        const guideResult = await client.query(
          `SELECT * FROM guide g WHERE g.id = $1 AND ${ownedBy('g', 2)}`,
          [id, ctx.owner],
        );
        if (guideResult.rows.length === 0) return null;

        const versionsResult = await client.query(
          `SELECT * FROM guide_version WHERE guide_id = $1 ORDER BY version_number DESC`,
          [id],
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
    }),
  );

  // ------------------------------------------------------------
  // PATCH /:id/flag — the primary admin on/off switch
  // ------------------------------------------------------------
  router.patch(
    '/:id/flag',
    asyncHandler(async (req, res) => {
      const id = guideIdParam(req, res);
      if (!id) return;
      const parsed = flagSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body' });
        return;
      }
      const ctx = scopeContext(scope, req);

      const updated = await ctx.run(async (client) => {
        // Ownership filter (not just RLS): tenants must never toggle global guides.
        const result = await client.query(
          `UPDATE guide g SET enabled = $1, updated_at = now() WHERE g.id = $2 AND ${ownedBy('g', 3)}
           RETURNING id, enabled`,
          [parsed.data.enabled, id, ctx.owner],
        );
        return result.rows[0] ?? null;
      });

      if (!updated) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json(updated);
    }),
  );

  // ------------------------------------------------------------
  // PUT /:id/draft — save work-in-progress without going live
  // ------------------------------------------------------------
  router.put(
    '/:id/draft',
    asyncHandler(async (req, res) => {
      const id = guideIdParam(req, res);
      if (!id) return;
      const version = parseVersionBody(req.body, res);
      if (!version) return;
      const ctx = scopeContext(scope, req);

      const draft = await ctx.run(async (client) => {
        if (!(await lockOwnedGuide(client, id, ctx.owner))) return null;
        return upsertDraft(client, id, version);
      });

      if (!draft) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json(toVersionResponse(draft));
    }),
  );

  // ------------------------------------------------------------
  // POST /:id/publish — promote a version to live.
  //  - With a body: saves it as the draft, then promotes that draft (one step).
  //  - With no body: promotes the existing draft as-is (what was previewed is
  //    exactly what ships).
  // Published versions are immutable from then on (enforced by RLS, 003/004).
  // ------------------------------------------------------------
  router.post(
    '/:id/publish',
    asyncHandler(async (req, res) => {
      const id = guideIdParam(req, res);
      if (!id) return;

      const hasBody = req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0;
      const version = hasBody ? parseVersionBody(req.body, res) : null;
      if (hasBody && !version) return;
      const ctx = scopeContext(scope, req);

      const result = await ctx.run(async (client) => {
        if (!(await lockOwnedGuide(client, id, ctx.owner))) return 'not_found' as const;

        let draftId: string;
        if (version) {
          draftId = (await upsertDraft(client, id, version)).id;
        } else {
          const existing = await client.query(
            `SELECT id FROM guide_version WHERE guide_id = $1 AND published_at IS NULL`,
            [id],
          );
          if (existing.rows.length === 0) return 'no_draft' as const;
          draftId = existing.rows[0].id;
        }

        const promoted = await client.query(
          `UPDATE guide_version SET published_at = now() WHERE id = $1 AND published_at IS NULL
           RETURNING ${VERSION_COLUMNS}`,
          [draftId],
        );
        const row = promoted.rows[0];

        await client.query(
          `UPDATE guide g SET current_version_id = $1, status = 'published', updated_at = now()
           WHERE g.id = $2 AND ${ownedBy('g', 3)}`,
          [row.id, id, ctx.owner],
        );
        return row;
      });

      if (result === 'not_found') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (result === 'no_draft') {
        res.status(400).json({ error: 'no_draft_to_publish' });
        return;
      }
      res.status(201).json(toVersionResponse(result));
    }),
  );

  // ------------------------------------------------------------
  // POST /:id/preview-token — mint a short-lived signed link that
  // force-renders one version (draft or published) in the host app, ignoring
  // the enabled flag and publish state. See preview.ts. The token is bound to
  // the caller's own tenant — for a global guide, the platform admin previews
  // it inside their own tenant's product.
  // ------------------------------------------------------------
  router.post(
    '/:id/preview-token',
    asyncHandler(async (req, res) => {
      const id = guideIdParam(req, res);
      if (!id) return;
      const parsed = previewTokenSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body' });
        return;
      }
      const secret = previewSecret();
      if (!secret) {
        res.status(503).json({ error: 'preview_not_configured' });
        return;
      }
      const ctx = scopeContext(scope, req);

      const version = await ctx.run(async (client) => {
        const result = await client.query(
          `SELECT gv.id, gv.route_match
           FROM guide_version gv JOIN guide g ON g.id = gv.guide_id
           WHERE gv.id = $1 AND g.id = $2 AND ${ownedBy('g', 3)}`,
          [parsed.data.versionId, id, ctx.owner],
        );
        return result.rows[0] ?? null;
      });
      if (!version) {
        res.status(404).json({ error: 'not_found' });
        return;
      }

      const token = signPreviewToken({ guideId: id, versionId: version.id, tenantId: req.tenantId! }, secret);
      const appBase = process.env.PREVIEW_APP_BASE_URL?.replace(/\/$/, '');
      const url = appBase
        ? `${appBase}${previewPath(version.route_match)}?guidePreview=${encodeURIComponent(token)}`
        : null;

      res.status(201).json({
        token,
        url,
        expiresAt: new Date(Date.now() + PREVIEW_TTL_SECONDS * 1000).toISOString(),
      });
    }),
  );

  // ------------------------------------------------------------
  // POST /:id/rollback/:versionNumber
  // ------------------------------------------------------------
  router.post(
    '/:id/rollback/:versionNumber',
    asyncHandler(async (req, res) => {
      const id = guideIdParam(req, res);
      if (!id) return;
      const versionNumber = z.coerce.number().int().positive().safeParse(req.params.versionNumber);
      if (!versionNumber.success) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const ctx = scopeContext(scope, req);

      const updated = await ctx.run(async (client) => {
        if (!(await lockOwnedGuide(client, id, ctx.owner))) return null;

        // Only published versions are valid rollback targets.
        const versionResult = await client.query(
          `SELECT id FROM guide_version
           WHERE guide_id = $1 AND version_number = $2 AND published_at IS NOT NULL`,
          [id, versionNumber.data],
        );
        if (versionResult.rows.length === 0) return null;

        const result = await client.query(
          `UPDATE guide g SET current_version_id = $1, updated_at = now()
           WHERE g.id = $2 AND ${ownedBy('g', 3)}
           RETURNING id, current_version_id`,
          [versionResult.rows[0].id, id, ctx.owner],
        );
        return result.rows[0] ?? null;
      });

      if (!updated) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json(updated);
    }),
  );

  // ------------------------------------------------------------
  // GET /:id/analytics — funnel counts, overall and per step.
  // Tenant scope: the caller's own tenant's events only (also for global
  // guides it can see). Global scope: aggregate counts across ALL tenants
  // for a global guide — only counts are returned, never per-tenant or
  // per-user rows (RLS policy guide_event_global_select, migration 004).
  // ------------------------------------------------------------
  router.get(
    '/:id/analytics',
    asyncHandler(async (req, res) => {
      const id = guideIdParam(req, res);
      if (!id) return;
      const ctx = scopeContext(scope, req);
      // NULL = no tenant filter (global scope).
      const eventTenant = scope === 'tenant' ? req.tenantId! : null;

      const stats = await ctx.run(async (client) => {
        // Check visibility first so another tenant's guide id is a 404, not a
        // 200 with empty counts (which would confirm the id exists).
        const visible =
          scope === 'tenant'
            ? `(g.tenant_id = $2 OR g.is_global = TRUE)` // tenants may see their own usage of global guides
            : ownedBy('g', 2);
        const guideCheck = await client.query(`SELECT id FROM guide g WHERE g.id = $1 AND ${visible}`, [
          id,
          scope === 'tenant' ? req.tenantId : null,
        ]);
        if (guideCheck.rows.length === 0) return null;

        const counts = await client.query(
          `SELECT event_type, COUNT(*)::int AS count
           FROM guide_event
           WHERE guide_id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
           GROUP BY event_type`,
          [id, eventTenant],
        );
        // Per-step breakdown. Step ids are stable across versions, so a step's
        // numbers accumulate through edits instead of resetting on each publish.
        const steps = await client.query(
          `SELECT step_id, event_type, COUNT(*)::int AS count
           FROM guide_event
           WHERE guide_id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid) AND step_id IS NOT NULL
           GROUP BY step_id, event_type`,
          [id, eventTenant],
        );
        return { counts: counts.rows, steps: steps.rows };
      });

      if (!stats) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ guideId: id, scope, ...stats });
    }),
  );

  return router;
}
