import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../asyncHandler';
import { StudioRequest } from '../../auth/studio';
import { HttpError, notFound } from '../../httpError';
import { generatePublicKey, generateSigningSecret } from '../../keys';
import { sanitizePlainText } from '../../sanitize';
import {
  APP_COLUMNS,
  AppRow,
  HELP_POSITIONS,
  createApp,
  createOrgWithApp,
  installSnippet,
} from '../../services/orgs';
import { idParam, parseBody, requireAppRole, requireOrgRole, studio, websitesSchema } from './context';

export const orgsRouter = Router();

const nameSchema = z.string().trim().min(1).max(200);
const appInputSchema = z.object({ name: nameSchema, websites: websitesSchema });

// ------------------------------------------------------------
// GET /v1/me — who you are, and every org and app you can reach (with your
// role). The Studio builds its navigation from this.
// ------------------------------------------------------------
orgsRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const user = (req as StudioRequest).studioUser!;
    const { orgs, platformAdmin } = await studio(req, async (client, ctx) => {
      const orgRows = await client.query<{ id: string; name: string; suspended_at: string | null }>(
        `SELECT id, name, suspended_at FROM organization WHERE id = ANY($1::uuid[]) ORDER BY name`,
        [[...ctx.orgs.keys()]],
      );
      // Own row: readable by id. The flag decides whether the Studio shows the Operator area.
      const me = await client.query<{ platform_admin: boolean }>(
        `SELECT platform_admin FROM studio_user WHERE id = $1`,
        [ctx.userId],
      );
      const appRows = await client.query<{ id: string; org_id: string; name: string }>(
        `SELECT id, org_id, name FROM application WHERE id = ANY($1::uuid[]) ORDER BY name`,
        [[...ctx.apps.keys()]],
      );
      return {
        platformAdmin: me.rows[0]?.platform_admin === true,
        orgs: orgRows.rows.map((o) => ({
          id: o.id,
          name: o.name,
          role: ctx.orgs.get(o.id),
          suspendedAt: o.suspended_at,
          apps: appRows.rows
            .filter((a) => a.org_id === o.id)
            .map((a) => ({ id: a.id, name: a.name, role: ctx.apps.get(a.id)!.role })),
        })),
      };
    });
    res.json({
      user: { id: user.id, email: user.email ?? null, name: user.name ?? null, platformAdmin },
      orgs,
    });
  }),
);

// ------------------------------------------------------------
// POST /v1/orgs — self-serve: create an organization (you become its owner)
// together with its first application.
// ------------------------------------------------------------
orgsRouter.post(
  '/orgs',
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ name: nameSchema, app: appInputSchema }), req.body);
    const created = await studio(req, (client, ctx) => createOrgWithApp(client, ctx, body));
    res.status(201).json({ org: { ...created.org, role: 'owner' }, app: created.app });
  }),
);

orgsRouter.get(
  '/orgs/:orgId',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const org = await studio(req, async (client, ctx) => {
      const role = requireOrgRole(ctx, orgId, 'member');
      const row = (await client.query(`SELECT id, name, created_at FROM organization WHERE id = $1`, [orgId]))
        .rows[0];
      return { ...row, role };
    });
    res.json(org);
  }),
);

orgsRouter.patch(
  '/orgs/:orgId',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const body = parseBody(z.object({ name: nameSchema }), req.body);
    const org = await studio(req, async (client, ctx) => {
      requireOrgRole(ctx, orgId, 'admin');
      return (
        await client.query(`UPDATE organization SET name = $1 WHERE id = $2 RETURNING id, name`, [
          body.name,
          orgId,
        ])
      ).rows[0];
    });
    res.json(org);
  }),
);

// ------------------------------------------------------------
// Applications
// ------------------------------------------------------------
orgsRouter.get(
  '/orgs/:orgId/apps',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const apps = await studio(req, async (client, ctx) => {
      requireOrgRole(ctx, orgId, 'member');
      // Only apps you have access to (RLS + the explicit id list).
      const visible = [...ctx.apps].filter(([, a]) => a.orgId === orgId).map(([id]) => id);
      const rows = await client.query<AppRow>(
        `SELECT ${APP_COLUMNS} FROM application WHERE org_id = $1 AND id = ANY($2::uuid[]) ORDER BY name`,
        [orgId, visible],
      );
      return rows.rows.map((a) => ({ ...a, role: ctx.apps.get(a.id)!.role }));
    });
    res.json(apps);
  }),
);

orgsRouter.post(
  '/orgs/:orgId/apps',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const body = parseBody(appInputSchema, req.body);
    const app = await studio(req, async (client, ctx) => {
      requireOrgRole(ctx, orgId, 'admin');
      return createApp(client, orgId, body);
    });
    res.status(201).json({ ...app, role: 'app_admin' });
  }),
);

orgsRouter.get(
  '/apps/:appId',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const app = await studio(req, async (client, ctx) => {
      const { role } = requireAppRole(ctx, appId, 'viewer');
      const row = (
        await client.query<AppRow>(`SELECT ${APP_COLUMNS} FROM application WHERE id = $1`, [appId])
      ).rows[0];
      return { ...row, role, snippet: installSnippet(row.public_key) };
    });
    res.json(app);
  }),
);

const appPatchSchema = z
  .object({
    name: nameSchema.optional(),
    websites: websitesSchema.optional(),
    identityMode: z.enum(['optional', 'required']).optional(),
    enabled: z.boolean().optional(),
    helpEnabled: z.boolean().optional(),
    helpButtonLabel: z.string().trim().min(1).max(40).optional(),
    // Injected into the agent's stylesheet: hex colors only (also a DB CHECK).
    helpButtonColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex color like #4f46e5')
      .optional(),
    helpPosition: z.enum(HELP_POSITIONS).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

orgsRouter.patch(
  '/apps/:appId',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const body = parseBody(appPatchSchema, req.body);
    const app = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'app_admin');
      if (body.identityMode === 'required') {
        const has = await client.query(
          `SELECT signing_secret IS NOT NULL AS has FROM application WHERE id = $1`,
          [appId],
        );
        // Requiring signed identity without a secret would lock every visitor out.
        if (!has.rows[0]?.has) throw new HttpError(400, 'signing_secret_required');
      }
      const result = await client.query<AppRow>(
        `UPDATE application SET
           name = COALESCE($2, name),
           allowed_origins = COALESCE($3, allowed_origins),
           identity_mode = COALESCE($4::identity_mode, identity_mode),
           enabled = COALESCE($5, enabled),
           help_enabled = COALESCE($6, help_enabled),
           help_button_label = COALESCE($7, help_button_label),
           help_button_color = COALESCE($8, help_button_color),
           help_position = COALESCE($9, help_position)
         WHERE id = $1 RETURNING ${APP_COLUMNS}`,
        [
          appId,
          body.name ?? null,
          body.websites ?? null,
          body.identityMode ?? null,
          body.enabled ?? null,
          body.helpEnabled ?? null,
          body.helpButtonLabel ? sanitizePlainText(body.helpButtonLabel) || null : null,
          body.helpButtonColor ?? null,
          body.helpPosition ?? null,
        ],
      );
      return result.rows[0];
    });
    res.json(app);
  }),
);

// Rotating the key breaks every installed snippet immediately — the Studio
// confirms first. Use it if a key ends up somewhere it shouldn't.
orgsRouter.post(
  '/apps/:appId/rotate-key',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const app = await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'app_admin');
      return (
        await client.query<AppRow>(
          `UPDATE application SET public_key = $2 WHERE id = $1 RETURNING ${APP_COLUMNS}`,
          [appId, generatePublicKey()],
        )
      ).rows[0];
    });
    res.json({ ...app, snippet: installSnippet(app.public_key) });
  }),
);

// Generates (or rotates) the secret the customer's backend uses to sign
// visitor identities. Returned ONCE; afterwards only "has a secret" is shown.
orgsRouter.post(
  '/apps/:appId/signing-secret',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const secret = generateSigningSecret();
    await studio(req, async (client, ctx) => {
      requireAppRole(ctx, appId, 'app_admin');
      await client.query(`UPDATE application SET signing_secret = $2 WHERE id = $1`, [appId, secret]);
    });
    res.status(201).json({ secret });
  }),
);

// ------------------------------------------------------------
// Support access (Pendo-style): the organization's OWNER opens the door for
// Guide Engine support for a limited time; while it's open, platform admins
// may read the organization (never write), and every request is logged here
// for the organization's admins to see. Off by default.
// ------------------------------------------------------------
const SUPPORT_ACCESS_MAX_DAYS = 90;

async function supportAccessStatus(client: import('pg').PoolClient, orgId: string) {
  const org = await client.query<{
    until: string | null;
    granted_by_name: string | null;
    granted_by_email: string | null;
  }>(
    `SELECT o.support_access_until AS until, u.name AS granted_by_name, u.email AS granted_by_email
     FROM organization o LEFT JOIN studio_user u ON u.id = o.support_access_granted_by
     WHERE o.id = $1`,
    [orgId],
  );
  if (org.rows.length === 0) throw notFound();
  const log = await client.query<{
    method: string;
    path: string;
    occurred_at: string;
    admin_name: string | null;
    admin_email: string | null;
  }>(
    `SELECT method, path, occurred_at, admin_name, admin_email
     FROM support_access_log WHERE org_id = $1 ORDER BY occurred_at DESC LIMIT 200`,
    [orgId],
  );
  const row = org.rows[0];
  const until = row.until ? new Date(row.until) : null;
  return {
    active: until !== null && until > new Date(),
    until: row.until,
    grantedBy:
      row.granted_by_email || row.granted_by_name
        ? { name: row.granted_by_name, email: row.granted_by_email }
        : null,
    maxDays: SUPPORT_ACCESS_MAX_DAYS,
    log: log.rows.map((l) => ({
      method: l.method,
      path: l.path,
      occurredAt: l.occurred_at,
      admin: { name: l.admin_name, email: l.admin_email },
    })),
  };
}

// GET /orgs/:orgId/support-access — status + the access log (org admins)
orgsRouter.get(
  '/orgs/:orgId/support-access',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const status = await studio(req, async (client, ctx) => {
      requireOrgRole(ctx, orgId, 'admin');
      return supportAccessStatus(client, orgId);
    });
    res.json(status);
  }),
);

// PUT /orgs/:orgId/support-access — { days } : open (or extend) the window (owners only)
orgsRouter.put(
  '/orgs/:orgId/support-access',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const body = parseBody(
      z.object({ days: z.number().int().min(1).max(SUPPORT_ACCESS_MAX_DAYS) }),
      req.body,
    );
    const status = await studio(req, async (client, ctx) => {
      requireOrgRole(ctx, orgId, 'owner');
      await client.query(
        `UPDATE organization
         SET support_access_until = now() + make_interval(days => $2), support_access_granted_by = $3
         WHERE id = $1`,
        [orgId, body.days, ctx.userId],
      );
      return supportAccessStatus(client, orgId);
    });
    res.json(status);
  }),
);

// DELETE /orgs/:orgId/support-access — close the window now (owners only)
orgsRouter.delete(
  '/orgs/:orgId/support-access',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const status = await studio(req, async (client, ctx) => {
      requireOrgRole(ctx, orgId, 'owner');
      await client.query(
        `UPDATE organization SET support_access_until = NULL, support_access_granted_by = NULL WHERE id = $1`,
        [orgId],
      );
      return supportAccessStatus(client, orgId);
    });
    res.json(status);
  }),
);

// GET /support-context — what a platform admin may see of the organization
// named by X-Support-Org: the org and its apps as a viewer. The Studio uses
// it to enter support mode; it only answers under an open support window.
orgsRouter.get(
  '/support-context',
  asyncHandler(async (req, res) => {
    const context = await studio(req, async (client, ctx) => {
      if (!ctx.support) throw notFound();
      const org = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM organization WHERE id = $1`,
        [ctx.support.orgId],
      );
      const apps = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM application WHERE org_id = $1 ORDER BY name`,
        [ctx.support.orgId],
      );
      return {
        id: org.rows[0].id,
        name: org.rows[0].name,
        role: 'member' as const,
        apps: apps.rows.map((a) => ({ id: a.id, name: a.name, role: 'viewer' as const })),
        supportAccessUntil: ctx.support.until.toISOString(),
      };
    });
    res.json(context);
  }),
);
