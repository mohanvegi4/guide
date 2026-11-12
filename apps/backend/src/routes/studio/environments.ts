import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../asyncHandler';
import { StudioRequest } from '../../auth/studio';
import { HttpError, notFound } from '../../httpError';
import { requestLogger } from '../../logging';
import { sanitizePlainText } from '../../sanitize';
import {
  EnvironmentRow,
  assertWebsitesFree,
  listEnvironments,
  syncAllowedOrigins,
  syncCurrentVersion,
} from '../../services/environments';
import { idParam, parseBody, requireAppManager, requireAppRole, studio, websitesSchema } from './context';

/**
 * An app's environments (release stages): /v1/apps/:appId/environments.
 * Read by every member; changed by editors and up, like the websites they
 * own (application_update); deleting one, with every release in it, needs a
 * manager, like deleting the app.
 */
export const environmentsRouter = Router({ mergeParams: true });

const environmentNameSchema = z.string().trim().min(1).max(40);

environmentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const environments = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'viewer');
      return listEnvironments(client, appId);
    });
    res.json(environments);
  }),
);

// POST / — { name, websites?, analyticsEnabled? }: a new stage, added before
// production (the last stage stays production) unless `last` is true.
environmentsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const body = parseBody(
      z.object({
        name: environmentNameSchema,
        websites: websitesSchema.default([]),
        analyticsEnabled: z.boolean().default(true),
        last: z.boolean().default(false),
      }),
      req.body,
    );
    const created = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'app_admin');
      await assertWebsitesFree(client, appId, body.websites, null);
      const existing = await listEnvironments(client, appId);
      // New stages go in front of production, which normally comes last.
      const position = body.last || existing.length === 0 ? existing.length + 1 : existing.length;
      if (!body.last) {
        await client.query(`UPDATE app_environment SET position = position + 1 WHERE app_id = $1 AND position >= $2`, [
          appId,
          position,
        ]);
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO app_environment (app_id, name, position, origins, analytics_enabled)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [appId, sanitizePlainText(body.name), position, body.websites, body.analyticsEnabled],
      ).catch(nameTaken);
      await syncAllowedOrigins(client, appId);
      if (body.last) await syncCurrentVersion(client, appId);
      return (await listEnvironments(client, appId)).find((e) => e.id === inserted.rows[0].id)!;
    });
    res.status(201).json(created);
  }),
);

// PATCH /:environmentId — { name?, websites?, analyticsEnabled? }
environmentsRouter.patch(
  '/:environmentId',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const environmentId = idParam(req, 'environmentId');
    const body = parseBody(
      z
        .object({
          name: environmentNameSchema.optional(),
          websites: websitesSchema.optional(),
          analyticsEnabled: z.boolean().optional(),
        })
        .refine((v) => Object.keys(v).length > 0, 'nothing to update'),
      req.body,
    );
    const updated = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'app_admin');
      if (body.websites) await assertWebsitesFree(client, appId, body.websites, environmentId);
      const result = await client.query(
        `UPDATE app_environment SET
           name = COALESCE($3, name),
           origins = COALESCE($4, origins),
           analytics_enabled = COALESCE($5, analytics_enabled)
         WHERE id = $1 AND app_id = $2 RETURNING id`,
        [
          environmentId,
          appId,
          body.name ? sanitizePlainText(body.name) : null,
          body.websites ?? null,
          body.analyticsEnabled ?? null,
        ],
      ).catch(nameTaken);
      if (result.rows.length === 0) throw notFound();
      await syncAllowedOrigins(client, appId);
      return (await listEnvironments(client, appId)).find((e) => e.id === environmentId)!;
    });
    res.json(updated);
  }),
);

// PUT /order — { ids: every environment id, in promotion order }. The last
// becomes production, so guide.current_version_id follows it.
environmentsRouter.put(
  '/order',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const body = parseBody(z.object({ ids: z.array(z.string().uuid()).min(1).max(20) }), req.body);
    const environments = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'app_admin');
      const existing = await listEnvironments(client, appId);
      const same =
        body.ids.length === existing.length &&
        new Set(body.ids).size === body.ids.length &&
        existing.every((e) => body.ids.includes(e.id));
      if (!same) throw new HttpError(400, 'order_must_list_every_environment');
      // Positions are unique per app, checked at commit (deferred), so swaps work.
      for (const [index, id] of body.ids.entries()) {
        await client.query(`UPDATE app_environment SET position = $3 WHERE id = $1 AND app_id = $2`, [
          id,
          appId,
          index + 1,
        ]);
      }
      await syncCurrentVersion(client, appId);
      return body.ids.map((id) => existing.find((e) => e.id === id)!).map((e, i) => ({ ...e, position: i + 1 }));
    });
    res.json(environments);
  }),
);

// DELETE /:environmentId — { confirmName }. Its releases, visitor state and
// the environment link on its events go with it. The last one can't go.
environmentsRouter.delete(
  '/:environmentId',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const environmentId = idParam(req, 'environmentId');
    const body = parseBody(z.object({ confirmName: z.string() }), req.body);
    await studio(req, async (client, ctx) => {
      requireAppManager(ctx, appId);
      const existing = await listEnvironments(client, appId);
      const target: EnvironmentRow | undefined = existing.find((e) => e.id === environmentId);
      if (!target) throw notFound();
      if (existing.length === 1) throw new HttpError(409, 'last_environment');
      if (body.confirmName !== target.name) throw new HttpError(400, 'confirmation_mismatch');
      await client.query(`DELETE FROM app_environment WHERE id = $1 AND app_id = $2`, [environmentId, appId]);
      // Close the gap so positions stay 1..n.
      await client.query(
        `UPDATE app_environment SET position = position - 1 WHERE app_id = $1 AND position > $2`,
        [appId, target.position],
      );
      await syncAllowedOrigins(client, appId);
      await syncCurrentVersion(client, appId);
      requestLogger(req).warn(
        { appId, environmentId, userId: (req as StudioRequest).studioUser?.id },
        'environment deleted',
      );
    });
    res.status(204).end();
  }),
);

/** The (app_id, lower(name)) unique index: a clear 409 instead of a 500. */
function nameTaken(err: { code?: string }): never {
  if (err.code === '23505') throw new HttpError(409, 'environment_name_taken');
  throw err;
}

