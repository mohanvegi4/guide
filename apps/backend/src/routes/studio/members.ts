import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../asyncHandler';
import { StudioRequest } from '../../auth/studio';
import { OrgRole, resolveStudioContext, presentInvitation } from '../../db';
import { HttpError, forbidden, notFound } from '../../httpError';
import { generateInviteToken, hashToken } from '../../keys';
import { getMailer, invitationMail, loadMailConfig } from '../../mail';
import { idParam, parseBody, requireOrgRole, studio } from './context';

export const membersRouter = Router();

/**
 * One role per person, for every site of the organization:
 *   owner    everything, incl. ownership, support access, export / delete
 *   manager  runs the organization: sites, members, invitations
 *   editor   guides, pages, publishing and site settings on every site
 *   viewer   read-only
 * Managers manage members and invitations; only owners hand out or take
 * away "owner", and an organization always keeps at least one owner.
 */
const ORG_ROLES = ['owner', 'manager', 'editor', 'viewer'] as const;
const INVITABLE_ROLES = ['manager', 'editor', 'viewer'] as const;
const INVITE_TTL_DAYS = 7;

// GET /v1/orgs/:orgId/members — everyone in the org with their role
membersRouter.get(
  '/orgs/:orgId/members',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const members = await studio(req, async (client, ctx) => {
      requireOrgRole(ctx, orgId, 'viewer');
      const rows = await client.query<{
        user_id: string;
        role: OrgRole;
        email: string | null;
        name: string | null;
      }>(
        `SELECT m.user_id, m.role, u.email, u.name
         FROM org_member m JOIN studio_user u ON u.id = m.user_id
         WHERE m.org_id = $1
         ORDER BY array_position(ARRAY['owner','manager','editor','viewer'], m.role::text), COALESCE(u.name, u.email)`,
        [orgId],
      );
      return rows.rows.map((m) => ({ userId: m.user_id, email: m.email, name: m.name, orgRole: m.role }));
    });
    res.json(members);
  }),
);

// PATCH /v1/orgs/:orgId/members/:userId — { orgRole }
membersRouter.patch(
  '/orgs/:orgId/members/:userId',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const userId = idParam(req, 'userId');
    const body = parseBody(z.object({ orgRole: z.enum(ORG_ROLES) }), req.body);
    await studio(req, async (client, ctx) => {
      const myRole = requireOrgRole(ctx, orgId, 'manager');
      const target = await client.query<{ role: OrgRole }>(
        `SELECT role FROM org_member WHERE org_id = $1 AND user_id = $2 FOR UPDATE`,
        [orgId, userId],
      );
      if (!target.rows[0]) throw notFound();
      const current = target.rows[0].role;
      if (body.orgRole === current) return;
      // Ownership changes hands only between owners.
      if ((body.orgRole === 'owner' || current === 'owner') && myRole !== 'owner') throw forbidden();
      if (current === 'owner') await assertNotLastOwner(client, orgId);
      await client.query(`UPDATE org_member SET role = $3 WHERE org_id = $1 AND user_id = $2`, [
        orgId,
        userId,
        body.orgRole,
      ]);
    });
    res.status(204).end();
  }),
);

// DELETE — remove someone (managers), or leave the org yourself.
membersRouter.delete(
  '/orgs/:orgId/members/:userId',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const userId = idParam(req, 'userId');
    await studio(req, async (client, ctx) => {
      const myRole = requireOrgRole(ctx, orgId, 'viewer');
      const self = userId === ctx.userId;
      const manager = myRole === 'owner' || myRole === 'manager';
      if (!self && !manager) throw forbidden();
      const target = await client.query<{ role: OrgRole }>(
        // FOR UPDATE must also pass the UPDATE policy (managers only); someone
        // removing just themselves doesn't need the lock.
        `SELECT role FROM org_member WHERE org_id = $1 AND user_id = $2 ${manager ? 'FOR UPDATE' : ''}`,
        [orgId, userId],
      );
      if (!target.rows[0]) throw notFound();
      if (target.rows[0].role === 'owner') {
        if (!self && myRole !== 'owner') throw forbidden();
        await assertNotLastOwner(client, orgId);
      }
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

// ------------------------------------------------------------
// Invitations. Single use, 7 days, revocable. Only a hash of the link token
// is stored. The link is always returned to the inviter to send however they
// like; when the invitation has an email and mail is configured (SMTP_URL,
// MAIL_FROM, STUDIO_URL), it is also emailed, and `emailSent` says whether
// that worked. An invitation carries one role; "owner" is never invited —
// an owner promotes a member instead.
// ------------------------------------------------------------
membersRouter.post(
  '/orgs/:orgId/invitations',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const body = parseBody(
      z.object({
        email: z.string().trim().email().max(320).optional(),
        orgRole: z.enum(INVITABLE_ROLES).default('viewer'),
      }),
      req.body,
    );
    const token = generateInviteToken();
    const { invitation, orgName } = await studio(req, async (client, ctx) => {
      requireOrgRole(ctx, orgId, 'manager');
      const org = await client.query<{ name: string }>(`SELECT name FROM organization WHERE id = $1`, [
        orgId,
      ]);
      const invitation = (
        await client.query(
          `INSERT INTO invitation (org_id, email, org_role, token_hash, created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
           RETURNING id, email, org_role, expires_at`,
          [
            orgId,
            body.email?.toLowerCase() ?? null,
            body.orgRole,
            hashToken(token),
            ctx.userId,
            INVITE_TTL_DAYS,
          ],
        )
      ).rows[0];
      return { invitation, orgName: org.rows[0]?.name ?? 'an organization' };
    });

    // Email after the transaction committed: a mail failure must neither roll
    // the invitation back nor fail the request — the inviter still gets the link.
    let emailSent = false;
    const mail = loadMailConfig();
    if (body.email && mail.studioUrl) {
      const user = (req as StudioRequest).studioUser!;
      emailSent = await getMailer().send(
        invitationMail({
          to: body.email,
          inviterName: user.name || user.email || 'A teammate',
          orgName,
          link: `${mail.studioUrl}/invite/${token}`,
          expiresInDays: INVITE_TTL_DAYS,
        }),
      );
    }
    res.status(201).json({ ...invitation, token, emailSent });
  }),
);

membersRouter.get(
  '/orgs/:orgId/invitations',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const rows = await studio(req, async (client, ctx) => {
      requireOrgRole(ctx, orgId, 'manager');
      return (
        await client.query(
          `SELECT id, email, org_role, created_at, expires_at FROM invitation
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
      requireOrgRole(ctx, orgId, 'manager');
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
      `SELECT i.id, i.org_id, o.name AS org_name, i.email, i.org_role, i.expires_at, i.accepted_at,
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
    const row = await studio(req, (client) => loadInvitation(client, token));
    res.json({
      orgId: row.org_id,
      orgName: row.org_name,
      email: row.email,
      orgRole: row.org_role,
      expired: row.expired,
      accepted: row.accepted_at !== null,
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
