import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { PoolClient } from 'pg';
import { asyncHandler } from '../../asyncHandler';
import { HttpError, notFound } from '../../httpError';
import { sanitizePlainText, sanitizeStepContent } from '../../sanitize';
import { PREVIEW_TTL_SECONDS, previewPath, previewSecret, signPreviewToken } from '../../preview';
import {
  RESOLVED_ROUTE_MATCH_SQL,
  idParam,
  parseBody,
  requireAppRole,
  routeMatchSchema,
  sitePathSchema,
  studio,
} from './context';
import { guideAnalyticsQuerySchema, rangeSql, toRange } from './analytics';
import { findPage } from './pages';
import { MAX_GUIDE_TAGS, visitorTagSchema } from '../../auth/visitor';
import { toVersionResponse, versionColumns } from '../../services/versions';
import {
  analyticsEnvironmentId,
  firstEnvironmentId,
  listEnvironments,
  productionEnvironmentId,
  releasesOf,
  revertRelease,
  setRelease,
} from '../../services/environments';

/**
 * Authoring routes for one application's guides: /v1/apps/:appId/guides/...
 *
 * Who can do what (per-app role ladder; org owners/admins act as app_admin):
 *   viewer     read guides, versions, analytics
 *   editor     + create guides, save drafts, mint preview links
 *   publisher  + publish, enable/disable, roll back
 *
 * Isolation: RLS only shows guides of apps in the session's
 * app set; every query here also filters by app_id explicitly.
 */
export const guidesRouter = Router({ mergeParams: true });

/** ?by=account returns at most this many accounts (the ones shown the guide most). */
const TOP_ACCOUNTS = 50;

interface AccountRow {
  /** null: events from visitors the host page didn't attach to an account. */
  accountId: string | null;
  shown: number;
  completed: number;
  dismissed: number;
  visitors: number;
}


// ------------------------------------------------------------
// Version payloads (shared by draft save + publish)
// ------------------------------------------------------------
// Targets must use the data-guide-id convention (set by the Angular/Vue
// anchor directives, or by hand) rather than arbitrary CSS selectors, which
// break on markup refactors.
const DATA_GUIDE_ID_SELECTOR = /^\[data-guide-id="[A-Za-z0-9_-]+"\]$/;

const stepSchema = z.object({
  // Authors' tools send back the id of a step they're editing so it stays the
  // same across drafts and versions — that's what lets per-step analytics
  // follow a step through edits. New steps omit it and get one assigned.
  id: z.string().uuid().optional(),
  order: z.number().int().nonnegative(),
  // No step type (migration 004): every step is the same card. A `type` an
  // older client still sends is dropped here like any unknown key.
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

// Help center listing for this version. Text fields are plain text (they're
// rendered with textContent, and sanitized to plain text on save anyway).
const helpSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(''),
  keywords: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  // Where to send the visitor before starting the guide. A same-origin path
  // only (no scheme, no "//host"), so a help link can't send anyone off-site.
  startPath: sitePathSchema.optional(),
});

const versionBodySchema = z
  .object({
    steps: z.array(stepSchema).min(1).max(50),
    // Where the guide shows: a saved page of the app (the guide then follows
    // the page's URL as it's edited), or a route of its own. Exactly one.
    pageId: z.string().uuid().nullable().optional(),
    routeMatch: routeMatchSchema.optional(),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional(),
    // Audience: omitted/null = every account of the app; otherwise only these
    // account ids (as the host page passes them to guideEngine.initialize).
    accountIds: z
      .array(z.string().trim().min(1).max(256))
      .min(1)
      .max(500)
      .transform((ids) => [...new Set(ids)])
      .nullable()
      .optional(),
    // Visitor tags: omitted/null = every visitor; otherwise only visitors who
    // carry at least one of these tags (from their host application's
    // permissions, passed as visitor.tags or inside the signed identity).
    // Duplicates are dropped before the count is checked.
    visitorTags: z
      .array(visitorTagSchema)
      .transform((tags) => [...new Set(tags)])
      .pipe(z.array(z.string()).min(1).max(MAX_GUIDE_TAGS))
      .nullable()
      .optional(),
    help: helpSchema.nullable().optional(),
    // How the guide starts. 'auto' (default): when the visitor lands on its
    // page, once per published version. 'manual': only from the help center
    // or a help link — so it needs a help listing to be reachable at all.
    activation: z.enum(['auto', 'manual']).default('auto'),
  })
  .refine((v) => v.activation === 'auto' || Boolean(v.help), {
    message: 'an on-demand guide must be listed in the help center',
    path: ['activation'],
  })
  .refine((v) => Boolean(v.pageId) !== Boolean(v.routeMatch), {
    message: 'choose a saved page (pageId) or a custom route (routeMatch)',
    path: ['routeMatch'],
  })
  // A wildcard route has no single page to send people to. (Saved pattern
  // pages always carry a start page of their own.)
  .refine((v) => !v.help || v.help.startPath || v.pageId || v.routeMatch?.type === 'exact', {
    message: 'a start page is required when the route is a pattern',
    path: ['help', 'startPath'],
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

interface PreparedVersion {
  steps: Array<StepInput & { id: string }>;
  pageId: string | null;
  /** Custom route, or (once resolved) a snapshot of the page's route. */
  routeMatch: { type: 'exact' | 'pattern'; value: string } | null;
  startAt: string | null;
  endAt: string | null;
  accountIds: string[] | null;
  visitorTags: string[] | null;
  help: { title: string; description: string; keywords: string[]; startPath?: string } | null;
  activation: 'auto' | 'manual';
}

/**
 * Turns validated step input into what gets persisted:
 *  - content/labels sanitized (see sanitize.ts for why this is on the write path)
 *  - sorted into display order so the SDK can trust array order
 *  - an id per step (kept if the author sent one, so it is stable across
 *    versions; generated for new steps) for step-level analytics
 * Throws if sanitization emptied a step — e.g. content that was only a
 * <script> — since saving a blank step is never what the author intended.
 */
function parseVersionBody(body: unknown): PreparedVersion {
  const parsed = parseBody(versionBodySchema, body);
  const steps = [...parsed.steps]
    .sort((a, b) => a.order - b.order)
    .map((step) => ({
      ...step,
      id: step.id ?? randomUUID(),
      content: sanitizeStepContent(step.content),
      actions: step.actions.map((a) => ({ ...a, label: sanitizePlainText(a.label) })),
    }));
  if (steps.some((s) => s.content === '' || s.actions.some((a) => a.label === ''))) {
    throw new HttpError(400, 'empty_content_after_sanitize');
  }
  return {
    steps,
    pageId: parsed.pageId ?? null,
    routeMatch: parsed.routeMatch ?? null,
    startAt: parsed.startAt ?? null,
    endAt: parsed.endAt ?? null,
    accountIds: parsed.accountIds ?? null,
    visitorTags: parsed.visitorTags ?? null,
    help: parsed.help
      ? {
          title: sanitizePlainText(parsed.help.title),
          description: sanitizePlainText(parsed.help.description),
          keywords: [
            ...new Set(parsed.help.keywords.map((k) => sanitizePlainText(k).toLowerCase()).filter(Boolean)),
          ],
          ...(parsed.help.startPath ? { startPath: parsed.help.startPath } : {}),
        }
      : null,
    activation: parsed.activation,
  };
}

/**
 * Locks one of the app's guides for the rest of the transaction. FOR UPDATE
 * serializes concurrent draft saves / publishes of the same guide, so two
 * requests can't compute the same next version_number or both create a draft.
 */
async function lockGuide(client: PoolClient, appId: string, guideId: string): Promise<void> {
  const result = await client.query(`SELECT id FROM guide WHERE id = $1 AND app_id = $2 FOR UPDATE`, [
    guideId,
    appId,
  ]);
  if (result.rows.length === 0) throw notFound();
}

const VERSION_COLUMNS = versionColumns();

/**
 * Creates or overwrites the guide's single working draft (published_at NULL).
 * A new draft takes MAX(version_number)+1, so version numbers stay monotonic
 * whichever way a version is eventually published. Caller must hold the lock.
 */
async function upsertDraft(client: PoolClient, appId: string, guideId: string, v: PreparedVersion) {
  // A page reference also stores a snapshot of the page's current route: the
  // fallback if the page is ever deleted (live guides always use the page).
  let routeMatch = v.routeMatch;
  if (v.pageId) {
    const page = await findPage(client, appId, v.pageId);
    routeMatch = { type: page.match_type, value: page.match_value };
  }
  const values = [
    JSON.stringify(v.steps),
    JSON.stringify(routeMatch),
    v.pageId,
    v.startAt,
    v.endAt,
    v.accountIds,
    v.help ? JSON.stringify(v.help) : null,
    v.activation,
    v.visitorTags,
  ];
  const updated = await client.query(
    `UPDATE guide_version SET steps = $2, route_match = $3, page_id = $4, start_at = $5, end_at = $6,
                              account_ids = $7, help = $8, activation = $9, visitor_tags = $10
     WHERE guide_id = $1 AND published_at IS NULL
     RETURNING ${VERSION_COLUMNS}`,
    [guideId, ...values],
  );
  if (updated.rows.length > 0) return updated.rows[0];

  const inserted = await client.query(
    `INSERT INTO guide_version
       (guide_id, version_number, steps, route_match, page_id, start_at, end_at, account_ids, help, activation,
        visitor_tags, published_at)
     SELECT $1, COALESCE(MAX(version_number), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL
     FROM guide_version WHERE guide_id = $1
     RETURNING ${VERSION_COLUMNS}`,
    [guideId, ...values],
  );
  return inserted.rows[0];
}

// ------------------------------------------------------------
// GET / — the app's guides
// ------------------------------------------------------------
guidesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const guides = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'viewer');
      const result = await client.query(
        `SELECT g.id, g.name, g.status, g.enabled, g.current_version_id,
                gv.version_number AS current_version_number, gv.activation, g.created_at, g.updated_at,
                p.id AS page_id, p.name AS page_name,
                COALESCE((
                  SELECT json_agg(json_build_object('environmentId', r.environment_id,
                                                    'versionNumber', rv.version_number)
                                  ORDER BY e.position)
                  FROM guide_release r
                  JOIN app_environment e ON e.id = r.environment_id
                  JOIN guide_version rv ON rv.id = r.version_id
                  WHERE r.guide_id = g.id), '[]') AS releases
         FROM guide g
         LEFT JOIN guide_version gv ON gv.id = g.current_version_id
         LEFT JOIN app_page p ON p.id = gv.page_id
         WHERE g.app_id = $1
         ORDER BY g.updated_at DESC`,
        [appId],
      );
      return result.rows;
    });
    res.json(guides);
  }),
);

// POST / — create a guide (disabled, nothing published)
guidesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const body = parseBody(
      // A `type` an older client still sends is ignored (migration 004).
      z.object({ name: z.string().trim().min(1).max(200) }),
      req.body,
    );
    const guide = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'editor');
      const result = await client.query(
        `INSERT INTO guide (app_id, name, created_by)
         VALUES ($1, $2, $3)
         RETURNING id, name, status, enabled, created_at`,
        [appId, body.name, ctx.userId],
      );
      return result.rows[0];
    });
    res.status(201).json(guide);
  }),
);

// GET /:id — a guide + its versions (the draft has published_at = null)
guidesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const id = idParam(req, 'id');
    const guide = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'viewer');
      const guideResult = await client.query(`SELECT * FROM guide WHERE id = $1 AND app_id = $2`, [
        id,
        appId,
      ]);
      if (guideResult.rows.length === 0) throw notFound();
      const versions = await client.query(
        `SELECT * FROM guide_version WHERE guide_id = $1 ORDER BY version_number DESC`,
        [id],
      );
      return { ...guideResult.rows[0], versions: versions.rows };
    });
    res.json(guide);
  }),
);

// PATCH /:id/flag — the guide's on/off switch
guidesRouter.patch(
  '/:id/flag',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const id = idParam(req, 'id');
    const body = parseBody(z.object({ enabled: z.boolean() }), req.body);
    const updated = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'publisher');
      const result = await client.query(
        `UPDATE guide SET enabled = $1, updated_at = now() WHERE id = $2 AND app_id = $3 RETURNING id, enabled`,
        [body.enabled, id, appId],
      );
      if (result.rows.length === 0) throw notFound();
      return result.rows[0];
    });
    res.json(updated);
  }),
);

// DELETE /:id — remove the guide for good. Its versions, analytics events and
// per-visitor state go with it through the foreign keys' ON DELETE CASCADE
// (run by the table owner, so no event-delete policy is needed). Like pages,
// editors may do this: the Studio asks for confirmation and names what's lost.
guidesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const id = idParam(req, 'id');
    await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'editor');
      const deleted = await client.query(`DELETE FROM guide WHERE id = $1 AND app_id = $2`, [id, appId]);
      if (deleted.rowCount === 0) throw notFound();
    });
    res.status(204).end();
  }),
);

// PUT /:id/draft — save work-in-progress without going live
guidesRouter.put(
  '/:id/draft',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const id = idParam(req, 'id');
    const version = parseVersionBody(req.body);
    const draft = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'editor');
      await lockGuide(client, appId, id);
      return upsertDraft(client, appId, id, version);
    });
    res.json(toVersionResponse(draft));
  }),
);

// ------------------------------------------------------------
// POST /:id/publish — turn the draft into a published version and release
// it to the app's first environment (the only one, for a single-stage app,
// so it goes live right away). Later stages get it by promotion.
//  - With a body: saves it as the draft, then publishes that draft (one step).
//  - With no body: publishes the existing draft as-is (what was previewed is
//    exactly what ships).
// Published versions are immutable from then on (enforced by RLS).
// ------------------------------------------------------------
guidesRouter.post(
  '/:id/publish',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const id = idParam(req, 'id');
    const hasBody = req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0;
    const version = hasBody ? parseVersionBody(req.body) : null;

    const row = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'publisher');
      await lockGuide(client, appId, id);

      let draftId: string;
      if (version) {
        draftId = (await upsertDraft(client, appId, id, version)).id;
      } else {
        const existing = await client.query(
          `SELECT id FROM guide_version WHERE guide_id = $1 AND published_at IS NULL`,
          [id],
        );
        if (existing.rows.length === 0) throw new HttpError(400, 'no_draft_to_publish');
        draftId = existing.rows[0].id;
      }

      const promoted = await client.query(
        `UPDATE guide_version SET published_at = now() WHERE id = $1 AND published_at IS NULL
         RETURNING ${VERSION_COLUMNS}`,
        [draftId],
      );
      await setRelease(client, {
        appId,
        guideId: id,
        environmentId: await firstEnvironmentId(client, appId),
        versionId: promoted.rows[0].id,
        actor: ctx.userId,
      });
      return promoted.rows[0];
    });
    res.status(201).json(toVersionResponse(row));
  }),
);

// POST /:id/rollback/:versionNumber — make an older published version live in
// production (the last environment). Other stages: POST /:id/releases.
guidesRouter.post(
  '/:id/rollback/:versionNumber',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const id = idParam(req, 'id');
    const versionNumber = z.coerce.number().int().positive().safeParse(req.params.versionNumber);
    if (!versionNumber.success) throw notFound();

    const updated = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'publisher');
      await lockGuide(client, appId, id);
      // Only published versions are valid rollback targets.
      const target = await client.query(
        `SELECT id FROM guide_version WHERE guide_id = $1 AND version_number = $2 AND published_at IS NOT NULL`,
        [id, versionNumber.data],
      );
      if (target.rows.length === 0) throw notFound();
      await setRelease(client, {
        appId,
        guideId: id,
        environmentId: await productionEnvironmentId(client, appId),
        versionId: target.rows[0].id,
        actor: ctx.userId,
      });
      return { id, current_version_id: target.rows[0].id };
    });
    res.json(updated);
  }),
);

// ------------------------------------------------------------
// Releases per environment.
//  GET  /:id/releases                     what each environment runs, and its log
//  POST /:id/releases {environmentId, versionId | null}
//                                         release a published version there (null withdraws)
//  POST /:id/promote {from}               give the next stage what `from` runs
//  POST /:id/releases/:environmentId/revert
//                                         undo that environment's latest release change
// Releasing is publishing in all but name, so it needs the publisher role.
// ------------------------------------------------------------
guidesRouter.get(
  '/:id/releases',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const id = idParam(req, 'id');
    const releases = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'viewer');
      const exists = await client.query(`SELECT 1 FROM guide WHERE id = $1 AND app_id = $2`, [id, appId]);
      if (exists.rows.length === 0) throw notFound();
      return releasesOf(client, appId, id);
    });
    res.json(releases);
  }),
);

guidesRouter.post(
  '/:id/releases',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const id = idParam(req, 'id');
    const body = parseBody(
      z.object({ environmentId: z.string().uuid(), versionId: z.string().uuid().nullable() }),
      req.body,
    );
    const releases = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'publisher');
      await lockGuide(client, appId, id);
      await setRelease(client, { appId, guideId: id, ...body, actor: ctx.userId });
      return releasesOf(client, appId, id);
    });
    res.json(releases);
  }),
);

guidesRouter.post(
  '/:id/promote',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const id = idParam(req, 'id');
    const body = parseBody(z.object({ from: z.string().uuid() }), req.body);
    const releases = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'publisher');
      await lockGuide(client, appId, id);
      const environments = await listEnvironments(client, appId);
      const index = environments.findIndex((e) => e.id === body.from);
      if (index < 0) throw notFound();
      const next = environments[index + 1];
      if (!next) throw new HttpError(409, 'already_in_production');
      const source = await client.query<{ version_id: string }>(
        `SELECT version_id FROM guide_release WHERE guide_id = $1 AND environment_id = $2`,
        [id, body.from],
      );
      if (source.rows.length === 0) throw new HttpError(409, 'nothing_to_promote');
      await setRelease(client, {
        appId,
        guideId: id,
        environmentId: next.id,
        versionId: source.rows[0].version_id,
        actor: ctx.userId,
      });
      return releasesOf(client, appId, id);
    });
    res.json(releases);
  }),
);

guidesRouter.post(
  '/:id/releases/:environmentId/revert',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const id = idParam(req, 'id');
    const environmentId = idParam(req, 'environmentId');
    const releases = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'publisher');
      await lockGuide(client, appId, id);
      await revertRelease(client, { appId, guideId: id, environmentId, actor: ctx.userId });
      return releasesOf(client, appId, id);
    });
    res.json(releases);
  }),
);

// ------------------------------------------------------------
// POST /:id/preview-token — mint a short-lived signed link that
// force-renders one version (draft or published) on the app's website,
// ignoring the enabled flag and publish state. See preview.ts.
// ------------------------------------------------------------
guidesRouter.post(
  '/:id/preview-token',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const id = idParam(req, 'id');
    const body = parseBody(z.object({ versionId: z.string().uuid() }), req.body);
    const secret = previewSecret();
    if (!secret) throw new HttpError(503, 'preview_not_configured');

    const found = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'editor');
      const version = await client.query(
        `SELECT gv.id, a.allowed_origins, ${RESOLVED_ROUTE_MATCH_SQL} AS route_match,
                COALESCE(gv.help ->> 'startPath', p.start_path) AS start_path
         FROM guide_version gv JOIN guide g ON g.id = gv.guide_id JOIN application a ON a.id = g.app_id
         LEFT JOIN app_page p ON p.id = gv.page_id
         WHERE gv.id = $1 AND g.id = $2 AND g.app_id = $3`,
        [body.versionId, id, appId],
      );
      if (version.rows.length === 0) throw notFound();
      return version.rows[0];
    });

    const token = signPreviewToken({ guideId: id, versionId: found.id, appId }, secret);
    // Open it on the app's first website; the author can paste the token
    // onto any of the app's other websites too.
    const site: string | undefined = found.allowed_origins[0];
    res.status(201).json({
      token,
      url: site ? previewUrl(site, found.start_path ?? previewPath(found.route_match), token) : null,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_SECONDS * 1000).toISOString(),
    });
  }),
);

/**
 * The URL class keeps the token in the query even when the path has its own
 * query or a #fragment (string concatenation would bury it in the fragment,
 * where the agent never looks). The agent reads ?guidePreview on any page,
 * so the path is only a sensible landing spot.
 */
function previewUrl(site: string, path: string, token: string): string {
  const url = new URL(path, site);
  url.searchParams.set('guidePreview', token);
  return url.toString();
}

// GET /:id/analytics — funnel counts, overall and per step, for everyone;
// ?from=&to= narrows the window, ?by=account adds the top accounts.
guidesRouter.get(
  '/:id/analytics',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const id = idParam(req, 'id');
    const query = parseBody(guideAnalyticsQuerySchema, req.query);
    // Every query below starts with (app_id, guide_id, environment_id) = ($1, $2, $3).
    const range = rangeSql(toRange(query), 4);
    const stats = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'viewer');
      const exists = await client.query(`SELECT 1 FROM guide WHERE id = $1 AND app_id = $2`, [id, appId]);
      if (exists.rows.length === 0) throw notFound();
      const environmentId = await analyticsEnvironmentId(client, appId, query.environment);
      const params = [appId, id, environmentId, ...range.params];
      const counts = await client.query(
        `SELECT event_type, COUNT(*)::int AS count FROM guide_event
         WHERE app_id = $1 AND guide_id = $2 AND environment_id = $3 ${range.sql} GROUP BY event_type`,
        params,
      );
      // Step ids are stable across versions, so a step's numbers accumulate
      // through edits instead of resetting on each publish.
      const steps = await client.query(
        `SELECT step_id, event_type, COUNT(*)::int AS count FROM guide_event
         WHERE app_id = $1 AND guide_id = $2 AND environment_id = $3 AND step_id IS NOT NULL ${range.sql}
         GROUP BY step_id, event_type`,
        params,
      );
      // How often the guide was started on demand from the help center.
      const help = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM guide_event
         WHERE app_id = $1 AND guide_id = $2 AND environment_id = $3
           AND event_type = 'guide_shown' AND metadata ->> 'source' = 'help'
           ${range.sql}`,
        params,
      );
      let accounts: AccountRow[] | undefined;
      if (query.by === 'account') {
        // The 50 accounts that saw the guide most. NULL account_id (visitors
        // the host page didn't attach to an account) is its own row, so the
        // numbers still add up to the totals above.
        const rows = await client.query<{
          account_id: string | null;
          shown: number;
          completed: number;
          dismissed: number;
          visitors: number;
        }>(
          `SELECT account_id,
                  COUNT(*) FILTER (WHERE event_type = 'guide_shown')::int AS shown,
                  COUNT(*) FILTER (WHERE event_type = 'guide_completed')::int AS completed,
                  COUNT(*) FILTER (WHERE event_type = 'guide_dismissed')::int AS dismissed,
                  COUNT(DISTINCT visitor_id)::int AS visitors
           FROM guide_event
           WHERE app_id = $1 AND guide_id = $2 AND environment_id = $3 ${range.sql}
           GROUP BY account_id
           ORDER BY shown DESC, account_id ASC NULLS LAST
           LIMIT ${TOP_ACCOUNTS}`,
          params,
        );
        accounts = rows.rows.map((r) => ({
          accountId: r.account_id,
          shown: r.shown,
          completed: r.completed,
          dismissed: r.dismissed,
          visitors: r.visitors,
        }));
      }
      return {
        environmentId,
        counts: counts.rows,
        steps: steps.rows,
        startedFromHelp: help.rows[0].n,
        ...(accounts ? { accounts } : {}),
      };
    });
    res.json({ guideId: id, ...stats });
  }),
);
