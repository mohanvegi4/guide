import { Router } from 'express';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { asyncHandler } from '../../asyncHandler';
import { HttpError, forbidden, notFound } from '../../httpError';
import { appRoleAtLeast } from '../../db';
import { sanitizePlainText } from '../../sanitize';
import { idParam, parseBody, requireAppRole, routeMatchSchema, sitePathSchema, studio } from './context';

/**
 * Saved pages for one application: /v1/apps/:appId/pages/...
 *
 * A page is a named URL rule ("Team settings" -> /settings/team) that guides
 * reference instead of each typing its own route (like Pendo's tagged pages).
 * Guides on a page follow it: change the page's URL and every guide using it
 * — live ones included — matches the new URL right away, no republish.
 *
 *   viewer     list / read pages (with which guides use them)
 *   editor     create pages; edit or delete pages no live guide uses
 *   publisher  edit pages live guides use (that changes what's live)
 *
 * A page can only be deleted when no guide's live version or draft uses it.
 */
export const pagesRouter = Router({ mergeParams: true });

const pageBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    routeMatch: routeMatchSchema,
    // Where the help center sends visitors for guides on this page.
    startPath: sitePathSchema.nullable().optional(),
  })
  .refine((v) => v.startPath || v.routeMatch.type === 'exact', {
    message: 'a start page is required when the URL is a pattern',
    path: ['startPath'],
  });

const PAGE_COLUMNS = 'p.id, p.name, p.match_type, p.match_value, p.start_path, p.created_at, p.updated_at';

interface PageRow {
  id: string;
  name: string;
  match_type: 'exact' | 'pattern';
  match_value: string;
  start_path: string | null;
  created_at: string;
  updated_at: string;
}

export function toPageResponse(row: PageRow) {
  return {
    id: row.id,
    name: row.name,
    routeMatch: { type: row.match_type, value: row.match_value },
    startPath: row.start_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Guides with a version released in any environment, or a working draft, on
 * the page. Other published versions don't count: they only matter again
 * after a rollback, and they keep a snapshot of the route to fall back on.
 */
async function pageUsage(client: PoolClient, appId: string, pageId: string) {
  const result = await client.query<{ id: string; name: string; live: boolean; draft: boolean }>(
    `SELECT g.id, g.name,
            bool_or(gv.published_at IS NOT NULL AND g.enabled) AS live,
            bool_or(gv.published_at IS NULL) AS draft
     FROM guide g
     JOIN guide_version gv ON gv.guide_id = g.id
     WHERE g.app_id = $1 AND gv.page_id = $2
       AND (gv.published_at IS NULL OR EXISTS (SELECT 1 FROM guide_release r WHERE r.version_id = gv.id))
     GROUP BY g.id, g.name
     ORDER BY g.name`,
    [appId, pageId],
  );
  return result.rows;
}

/**
 * Loads one of the app's pages (for a guide version referencing it). 400
 * rather than 404: the guide exists, it's the page id in the body that's bad.
 */
export async function findPage(client: PoolClient, appId: string, pageId: string): Promise<PageRow> {
  const result = await client.query<PageRow>(
    // KEY SHARE: a concurrent delete waits for this transaction (and then
    // sees the guide using the page) instead of racing it.
    `SELECT ${PAGE_COLUMNS} FROM app_page p WHERE p.id = $1 AND p.app_id = $2 FOR KEY SHARE`,
    [pageId, appId],
  );
  if (result.rows.length === 0) throw new HttpError(400, 'unknown_page');
  return result.rows[0];
}

function rethrowDuplicateName(err: unknown): never {
  if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'page_name_taken');
  throw err;
}

// GET / — the app's pages, with how many guides use each
pagesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const pages = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'viewer');
      const result = await client.query<PageRow & { guide_count: number; live_count: number }>(
        `SELECT ${PAGE_COLUMNS},
                COUNT(DISTINCT g.id)::int AS guide_count,
                COUNT(DISTINCT g.id) FILTER (
                  WHERE gv.published_at IS NOT NULL AND g.enabled)::int AS live_count
         FROM app_page p
         LEFT JOIN guide_version gv ON gv.page_id = p.id
           AND (gv.published_at IS NULL OR EXISTS (SELECT 1 FROM guide_release r WHERE r.version_id = gv.id))
         LEFT JOIN guide g ON g.id = gv.guide_id
         WHERE p.app_id = $1
         GROUP BY p.id
         ORDER BY lower(p.name)`,
        [appId],
      );
      return result.rows.map((r) => ({
        ...toPageResponse(r),
        usage: { guides: r.guide_count, live: r.live_count },
      }));
    });
    res.json(pages);
  }),
);

// POST / — save a new page
pagesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const body = parseBody(pageBodySchema, req.body);
    const name = sanitizePlainText(body.name);
    if (!name) throw new HttpError(400, 'empty_content_after_sanitize');
    const page = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'editor');
      const result = await client
        .query<PageRow>(
          `INSERT INTO app_page AS p (app_id, name, match_type, match_value, start_path, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${PAGE_COLUMNS}`,
          [appId, name, body.routeMatch.type, body.routeMatch.value, body.startPath ?? null, ctx.userId],
        )
        .catch(rethrowDuplicateName);
      return result.rows[0];
    });
    res.status(201).json({ ...toPageResponse(page), usage: { guides: 0, live: 0 } });
  }),
);

// GET /:pageId — one page and the guides on it
pagesRouter.get(
  '/:pageId',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const pageId = idParam(req, 'pageId');
    const page = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'viewer');
      const result = await client.query<PageRow>(
        `SELECT ${PAGE_COLUMNS} FROM app_page p WHERE p.id = $1 AND p.app_id = $2`,
        [pageId, appId],
      );
      if (result.rows.length === 0) throw notFound();
      return { ...toPageResponse(result.rows[0]), guides: await pageUsage(client, appId, pageId) };
    });
    res.json(page);
  }),
);

// PUT /:pageId — rename / change the URL. Live guides follow immediately.
pagesRouter.put(
  '/:pageId',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const pageId = idParam(req, 'pageId');
    const body = parseBody(pageBodySchema, req.body);
    const name = sanitizePlainText(body.name);
    if (!name) throw new HttpError(400, 'empty_content_after_sanitize');
    const page = await studio(req, async (client, ctx) => {
      const { role } = requireAppRole(ctx, appId, 'editor');
      const current = await client.query<PageRow>(
        `SELECT ${PAGE_COLUMNS} FROM app_page p WHERE p.id = $1 AND p.app_id = $2 FOR UPDATE`,
        [pageId, appId],
      );
      if (current.rows.length === 0) throw notFound();
      const before = current.rows[0];
      const guides = await pageUsage(client, appId, pageId);
      // Changing where a live guide shows is a publish in all but name.
      const changesLive =
        guides.some((g) => g.live) &&
        (before.match_type !== body.routeMatch.type ||
          before.match_value !== body.routeMatch.value ||
          (before.start_path ?? null) !== (body.startPath ?? null));
      if (changesLive && !appRoleAtLeast(role, 'publisher')) throw forbidden();

      const result = await client
        .query<PageRow>(
          `UPDATE app_page AS p SET name = $3, match_type = $4, match_value = $5, start_path = $6, updated_at = now()
           WHERE p.id = $1 AND p.app_id = $2
           RETURNING ${PAGE_COLUMNS}`,
          [pageId, appId, name, body.routeMatch.type, body.routeMatch.value, body.startPath ?? null],
        )
        .catch(rethrowDuplicateName);
      return { ...toPageResponse(result.rows[0]), guides };
    });
    res.json(page);
  }),
);

// DELETE /:pageId — only when no guide's live version or draft is on it
pagesRouter.delete(
  '/:pageId',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const pageId = idParam(req, 'pageId');
    await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'editor');
      const exists = await client.query(`SELECT 1 FROM app_page WHERE id = $1 AND app_id = $2 FOR UPDATE`, [
        pageId,
        appId,
      ]);
      if (exists.rows.length === 0) throw notFound();
      const guides = await pageUsage(client, appId, pageId);
      if (guides.length > 0) {
        throw new HttpError(409, 'page_in_use', { guides: guides.map(({ id, name }) => ({ id, name })) });
      }
      await client.query(`DELETE FROM app_page WHERE id = $1 AND app_id = $2`, [pageId, appId]);
    });
    res.status(204).end();
  }),
);
