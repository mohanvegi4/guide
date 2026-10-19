import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../asyncHandler';
import { StudioRequest } from '../../auth/studio';
import { resolveStudioContext, presentInvitation } from '../../db';
import { HttpError, forbidden, notFound } from '../../httpError';
import { generateInviteToken, hashToken } from '../../keys';
import { idParam, parseBody, requireOrgRole, studio } from './context';

export const membersRouter = Router();

const appRoleSchema = z.enum(['viewer', 'editor', 'publisher', 'app_admin']);
/** { "<app id>": role } — null removes the app grant. */
const appRolesSchema = z.record(z.string().uuid(), appRoleSchema.nullable());
const INVITE_TTL_DAYS = 7;

// ------------------------------------------------------------
// GET /v1/orgs/:orgId/members — everyone in the org with their org role and
// per-app roles (per-app roles only for apps you can see).
// ------------------------------------------------------------
membersRouter.get(
  '/orgs/:orgId/members',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const members = await studio(req, async (client, ctx) => {
      requireOrgRole(ctx, orgId, 'member');
      const rows = await client.query<{
        user_id: string;
        role: string;
        email: string | null;
        name: string | null;
      }>(
        `SELECT m.user_id, m.role, u.email, u.name
         FROM org_member m JOIN studio_user u ON u.id = m.user_id
         WHERE m.org_id = $1
         ORDER BY m.role, COALESCE(u.name, u.email)`,
        [orgId],
      );
      const grants = await client.query<{ user_id: string; app_id: string; role: string }>(
        `SELECT am.user_id, am.app_id, am.role
         FROM app_member am JOIN application a ON a.id = am.app_id
         WHERE a.org_id = $1`,
        [orgId],
      );
      return rows.rows.map((m) => ({
        userId: m.user_id,
        email: m.email,
        name: m.name,
        orgRole: m.role,
        appRoles: Object.fromEntries(
          grants.rows.filter((g) => g.user_id === m.user_id).map((g) => [g.app_id, g.role]),
        ),
      }));
    });
    res.json(members);
  }),
);

// ------------------------------------------------------------
// PATCH /v1/orgs/:orgId/members/:userId — change org role and/or app roles.
// Only owners can grant or take away "owner"; the last owner stays an owner.
// ------------------------------------------------------------
membersRouter.patch(
  '/orgs/:orgId/members/:userId',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const userId = idParam(req, 'userId');
    const body = parseBody(
      z.object({
        orgRole: z.enum(['owner', 'admin', 'member']).optional(),
        appRoles: appRolesSchema.optional(),
      }),
      req.body,
    );
    await studio(req, async (client, ctx) => {
      const myRole = requireOrgRole(ctx, orgId, 'admin');
      const target = await client.query<{ role: string }>(
        `SELECT role FROM org_member WHERE org_id = $1 AND user_id = $2 FOR UPDATE`,
        [orgId, userId],
      );
      if (!target.rows[0]) throw notFound();
      const current = target.rows[0].role;

      if (body.orgRole && body.orgRole !== current) {
        if ((body.orgRole === 'owner' || current === 'owner') && myRole !== 'owner') throw forbidden();
        if (current === 'owner') await assertNotLastOwner(client, orgId);
        await client.query(`UPDATE org_member SET role = $3 WHERE org_id = $1 AND user_id = $2`, [
          orgId,
          userId,
          body.orgRole,
        ]);
      }
      if (body.appRoles) await setAppRoles(client, orgId, userId, body.appRoles);
    });
    res.status(204).end();
  }),
);

// DELETE — remove someone (org admins), or leave the org yourself.
membersRouter.delete(
  '/orgs/:orgId/members/:userId',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const userId = idParam(req, 'userId');
    await studio(req, async (client, ctx) => {
      const myRole = requireOrgRole(ctx, orgId, 'member');
      const self = userId === ctx.userId;
      if (!self && myRole === 'member') throw forbidden();
      const target = await client.query<{ role: string }>(
        // FOR UPDATE must also pass the UPDATE policy (admins only); a member
        // removing just themselves doesn't need the lock.
        `SELECT role FROM org_member WHERE org_id = $1 AND user_id = $2 ${myRole === 'member' ? '' : 'FOR UPDATE'}`,
        [orgId, userId],
      );
      if (!target.rows[0]) throw notFound();
      if (target.rows[0].role === 'owner') {
        if (!self && myRole !== 'owner') throw forbidden();
        await assertNotLastOwner(client, orgId);
      }
      // App grants go with the org membership.
      await client.query(
        `DELETE FROM app_member WHERE user_id = $2 AND app_id IN (SELECT id FROM application WHERE org_id = $1)`,
        [orgId, userId],
      );
      await client.query(`DELETE FROM org_member WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
    });
    res.status(204).end();
  }),
);

async function assertNotLastOwner(client: import('pg').PoolClient, orgId: string): Promise<void> {
  const owners = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM org_member WHERE org_id = $1 AND role = 'owner'`,
    [orgId],
  );
  if (owners.rows[0].n <= 1) throw new HttpError(409, 'last_owner');
}

async function setAppRoles(
  client: import('pg').PoolClient,
  orgId: string,
  userId: string,
  appRoles: Record<string, string | null>,
): Promise<void> {
  const ids = Object.keys(appRoles);
  if (ids.length === 0) return;
  // Every app must belong to this org.
  const owned = await client.query<{ id: string }>(
    `SELECT id FROM application WHERE org_id = $1 AND id = ANY($2::uuid[])`,
    [orgId, ids],
  );
  if (owned.rows.length !== ids.length) throw new HttpError(400, 'unknown_app');
  for (const [appId, role] of Object.entries(appRoles)) {
    if (role === null) {
      await client.query(`DELETE FROM app_member WHERE app_id = $1 AND user_id = $2`, [appId, userId]);
    } else {
      await client.query(
        `INSERT INTO app_member (app_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (app_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [appId, userId, role],
      );
    }
  }
}

// ------------------------------------------------------------
// Invitations. There's no email service: the Studio shows the link for the
// admin to send however they like. Single use, 7 days, revocable. Only a hash
// of the link token is stored.
// ------------------------------------------------------------
membersRouter.post(
  '/orgs/:orgId/invitations',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const body = parseBody(
      z.object({
        email: z.string().trim().email().max(320).optional(),
        orgRole: z.enum(['admin', 'member']).default('member'),
        appRoles: z.record(z.string().uuid(), appRoleSchema).default({}),
      }),
      req.body,
    );
    const token = generateInviteToken();
    const invitation = await studio(req, async (client, ctx) => {
      requireOrgRole(ctx, orgId, 'admin');
      const ids = Object.keys(body.appRoles);
      if (ids.length > 0) {
        const owned = await client.query(
          `SELECT id FROM application WHERE org_id = $1 AND id = ANY($2::uuid[])`,
          [orgId, ids],
        );
        if (owned.rows.length !== ids.length) throw new HttpError(400, 'unknown_app');
      }
      return (
        await client.query(
          `INSERT INTO invitation (org_id, email, org_role, app_roles, token_hash, created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))
           RETURNING id, email, org_role, app_roles, expires_at`,
          [
            orgId,
            body.email?.toLowerCase() ?? null,
            body.orgRole,
            JSON.stringify(body.appRoles),
            hashToken(token),
            ctx.userId,
            INVITE_TTL_DAYS,
          ],
        )
      ).rows[0];
    });
    res.status(201).json({ ...invitation, token });
  }),
);

membersRouter.get(
  '/orgs/:orgId/invitations',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const rows = await studio(req, async (client, ctx) => {
      requireOrgRole(ctx, orgId, 'admin');
      return (
        await client.query(
          `SELECT id, email, org_role, app_roles, created_at, expires_at FROM invitation
           WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
          [orgId],
        )
      ).rows;
    });
    res.json(rows);
  }),
);

membersRouter.delete(
  '/orgs/:orgId/invitations/:invitationId',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const invitationId = idParam(req, 'invitationId');
    await studio(req, async (client, ctx) => {
      requireOrgRole(ctx, orgId, 'admin');
      const deleted = await client.query(`DELETE FROM invitation WHERE id = $1 AND org_id = $2`, [
        invitationId,
        orgId,
      ]);
      if (deleted.rowCount === 0) throw notFound();
    });
    res.status(204).end();
  }),
);

const tokenSchema = z.string().min(20).max(100);

/** Reads the invitation the caller holds the link for (RLS: by token hash). */
async function loadInvitation(client: import('pg').PoolClient, token: string, lock = false) {
  await presentInvitation(client, hashToken(token));
  const row = (
    await client.query(
      `SELECT i.id, i.org_id, o.name AS org_name, i.email, i.org_role, i.app_roles, i.expires_at, i.accepted_at,
              i.expires_at <= now() AS expired
       FROM invitation i JOIN organization o ON o.id = i.org_id
       WHERE i.token_hash = $1 ${lock ? 'FOR UPDATE OF i' : ''}`,
      [hashToken(token)],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row;
}

// GET /v1/invitations/:token — what you're being invited to (for the accept screen).
membersRouter.get(
  '/invitations/:token',
  asyncHandler(async (req, res) => {
    const token = parseBody(tokenSchema, req.params.token);
    const inv = await studio(req, async (client) => {
      const row = await loadInvitation(client, token);
      const apps = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM application WHERE org_id = $1 AND id = ANY($2::uuid[])`,
        [row.org_id, Object.keys(row.app_roles)],
      );
      return { row, apps: apps.rows };
    });
    res.json({
      orgId: inv.row.org_id,
      orgName: inv.row.org_name,
      email: inv.row.email,
      orgRole: inv.row.org_role,
      apps: inv.apps.map((a) => ({ id: a.id, name: a.name, role: inv.row.app_roles[a.id] })),
      expired: inv.row.expired,
      accepted: inv.row.accepted_at !== null,
    });
  }),
);

// POST /v1/invitations/:token/accept
membersRouter.post(
  '/invitations/:token/accept',
  asyncHandler(async (req, res) => {
    const token = parseBody(tokenSchema, req.params.token);
    const user = (req as StudioRequest).studioUser!;
    const orgId = await studio(req, async (client, ctx) => {
      const inv = await loadInvitation(client, token, true);
      if (inv.accepted_at) throw new HttpError(410, 'invitation_used');
      if (inv.expired) throw new HttpError(410, 'invitation_expired');
      // An invitation addressed to an email can only be used by that
      // (provider-verified) email.
      if (inv.email && !(user.emailVerified && user.email?.toLowerCase() === inv.email)) {
        throw new HttpError(403, 'invitation_email_mismatch');
      }
      if (ctx.orgs.has(inv.org_id)) throw new HttpError(409, 'already_member');

      await client.query(`INSERT INTO org_member (org_id, user_id, role) VALUES ($1, $2, $3)`, [
        inv.org_id,
        ctx.userId,
        inv.org_role,
      ]);
      for (const [appId, role] of Object.entries(inv.app_roles as Record<string, string>)) {
        // Skip grants for apps deleted since the invitation was created.
        await client.query(
          `INSERT INTO app_member (app_id, user_id, role)
           SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM application WHERE id = $1 AND org_id = $4)`,
          [appId, ctx.userId, role, inv.org_id],
        );
      }
      await client.query(`UPDATE invitation SET accepted_at = now(), accepted_by = $2 WHERE id = $1`, [
        inv.id,
        ctx.userId,
      ]);
      await resolveStudioContext(client, ctx.userId);
      return inv.org_id as string;
    });
    res.status(201).json({ orgId });
  }),
);
