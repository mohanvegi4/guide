import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../asyncHandler';
import { withoutScope } from '../../db';
import { HttpError, notFound } from '../../httpError';
import { requestLogger } from '../../logging';
import { assertConfirmName, deleteOrganization } from '../../services/lifecycle';
import { idParam, parseBody, platform } from './context';

/**
 * Service administration: /v1/platform/... — for platform admins only
 * (studio_user.platform_admin; 403 for everyone else).
 *
 * What's here never shows a customer's guide content: organizations and
 * apps with usage counts, suspending an organization, disabling an app, the
 * global kill switch, and who the platform admins are. Reading INSIDE an
 * organization goes through support access instead (the owner grants it,
 * time-boxed; the X-Support-Org header on the ordinary routes — context.ts).
 */
export const platformRouter = Router();

const ORG_SUMMARY = `
  SELECT o.id, o.name, o.created_at, o.suspended_at, o.support_access_until,
         (SELECT COUNT(*)::int FROM org_member m WHERE m.org_id = o.id) AS members,
         (SELECT COUNT(*)::int FROM application a WHERE a.org_id = o.id) AS apps,
         (SELECT COUNT(*)::int FROM guide g JOIN application a ON a.id = g.app_id WHERE a.org_id = o.id) AS guides,
         (SELECT COUNT(*)::int FROM guide_event e JOIN application a ON a.id = e.app_id
           WHERE a.org_id = o.id AND e.occurred_at > now() - interval '30 days') AS events_30d,
         (SELECT COALESCE(json_agg(json_build_object('name', u.name, 'email', u.email) ORDER BY u.email), '[]')
            FROM org_member m JOIN studio_user u ON u.id = m.user_id
           WHERE m.org_id = o.id AND m.role = 'owner') AS owners
  FROM organization o`;

interface OrgSummaryRow {
  id: string;
  name: string;
  created_at: string;
  suspended_at: string | null;
  support_access_until: string | null;
  members: number;
  apps: number;
  guides: number;
  events_30d: number;
  owners: Array<{ name: string | null; email: string | null }>;
}

function toOrgSummary(r: OrgSummaryRow) {
  const until = r.support_access_until ? new Date(r.support_access_until) : null;
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    suspendedAt: r.suspended_at,
    // Only an open window counts; an expired one reads as "not granted".
    supportAccessUntil: until && until > new Date() ? until.toISOString() : null,
    owners: r.owners,
    usage: { members: r.members, apps: r.apps, guides: r.guides, events30d: r.events_30d },
  };
}

// GET /platform/orgs — every organization with usage
platformRouter.get(
  '/orgs',
  asyncHandler(async (req, res) => {
    const orgs = await platform(req, async (client) => {
      const result = await client.query<OrgSummaryRow>(`${ORG_SUMMARY} ORDER BY lower(o.name)`);
      return result.rows.map(toOrgSummary);
    });
    res.json(orgs);
  }),
);

// GET /platform/orgs/:orgId — one organization and its apps
platformRouter.get(
  '/orgs/:orgId',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const org = await platform(req, async (client) => {
      const result = await client.query<OrgSummaryRow>(`${ORG_SUMMARY} WHERE o.id = $1`, [orgId]);
      if (result.rows.length === 0) throw notFound();
      const apps = await client.query(
        `SELECT a.id, a.name, a.public_key, a.enabled, a.allowed_origins, a.created_at,
                (SELECT COUNT(*)::int FROM guide g WHERE g.app_id = a.id) AS guides,
                (SELECT COUNT(*)::int FROM guide_event e
                  WHERE e.app_id = a.id AND e.occurred_at > now() - interval '30 days') AS events_30d,
                (SELECT COUNT(*)::int FROM agent_error x
                  WHERE x.app_id = a.id AND x.occurred_at > now() - interval '24 hours') AS errors_24h
         FROM application a WHERE a.org_id = $1 ORDER BY lower(a.name)`,
        [orgId],
      );
      return {
        ...toOrgSummary(result.rows[0]),
        apps: apps.rows.map((a) => ({
          id: a.id,
          name: a.name,
          publicKey: a.public_key,
          enabled: a.enabled,
          websites: a.allowed_origins,
          createdAt: a.created_at,
          usage: { guides: a.guides, events30d: a.events_30d, errors24h: a.errors_24h },
        })),
      };
    });
    res.json(org);
  }),
);

// PUT /platform/orgs/:orgId/suspension — { suspended } : the agent serves
// nothing for a suspended organization's apps; the Studio shows a banner.
platformRouter.put(
  '/orgs/:orgId/suspension',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const body = parseBody(z.object({ suspended: z.boolean() }), req.body);
    const org = await platform(req, async (client) => {
      const updated = await client.query<{ id: string; suspended_at: string | null }>(
        `UPDATE organization
         SET suspended_at = CASE WHEN $2 THEN COALESCE(suspended_at, now()) ELSE NULL END
         WHERE id = $1 RETURNING id, suspended_at`,
        [orgId, body.suspended],
      );
      if (updated.rows.length === 0) throw notFound();
      // Keep the denormalized copy the agent reads in step.
      await client.query(`UPDATE application SET suspended_at = $2 WHERE org_id = $1`, [
        orgId,
        updated.rows[0].suspended_at,
      ]);
      return updated.rows[0];
    });
    res.json({ id: org.id, suspendedAt: org.suspended_at });
  }),
);

// DELETE /platform/orgs/:orgId — { confirmName } : an operator handling a
// customer's deletion request (GDPR, contract end) when no owner is left to
// do it from the Studio. Same deletion as the owner's; logged at warn with
// who did it, since it is irreversible and happens outside the customer's
// own Studio.
platformRouter.delete(
  '/orgs/:orgId',
  asyncHandler(async (req, res) => {
    const orgId = idParam(req, 'orgId');
    const body = parseBody(z.object({ confirmName: z.string().max(200) }), req.body);
    const { name, adminUserId } = await platform(req, async (client, userId) => {
      const org = await client.query<{ name: string }>(`SELECT name FROM organization WHERE id = $1`, [
        orgId,
      ]);
      if (org.rows.length === 0) throw notFound();
      assertConfirmName(org.rows[0].name, body.confirmName);
      const deleted = await deleteOrganization(client, orgId);
      return { name: deleted.name, adminUserId: userId };
    });
    requestLogger(req).warn({ orgId, orgName: name, adminUserId }, 'organization deleted by platform admin');
    res.status(204).end();
  }),
);

// PATCH /platform/apps/:appId — { enabled } : the per-app switch, e.g. for abuse
platformRouter.patch(
  '/apps/:appId',
  asyncHandler(async (req, res) => {
    const appId = idParam(req, 'appId');
    const body = parseBody(z.object({ enabled: z.boolean() }), req.body);
    const app = await platform(req, async (client) => {
      const updated = await client.query<{ id: string; enabled: boolean }>(
        `UPDATE application SET enabled = $2 WHERE id = $1 RETURNING id, enabled`,
        [appId, body.enabled],
      );
      if (updated.rows.length === 0) throw notFound();
      return updated.rows[0];
    });
    res.json(app);
  }),
);

// GET / PUT /platform/kill-switch — the global switch (system_config is unscoped)
platformRouter.get(
  '/kill-switch',
  asyncHandler(async (req, res) => {
    const enabled = await platform(req, () =>
      withoutScope(async (client) => {
        const row = await client.query<{ value: string }>(
          `SELECT value FROM system_config WHERE key = 'guide_engine_enabled'`,
        );
        return row.rows[0]?.value !== 'false';
      }),
    );
    res.json({ enabled });
  }),
);

platformRouter.put(
  '/kill-switch',
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ enabled: z.boolean() }), req.body);
    await platform(req, () =>
      withoutScope((client) =>
        client.query(
          `INSERT INTO system_config (key, value) VALUES ('guide_engine_enabled', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [String(body.enabled)],
        ),
      ),
    );
    res.json({ enabled: body.enabled });
  }),
);

// GET /platform/admins — who runs the service
platformRouter.get(
  '/admins',
  asyncHandler(async (req, res) => {
    const admins = await platform(req, async (client) => {
      const result = await client.query(
        `SELECT id, email, name, last_seen_at FROM studio_user WHERE platform_admin ORDER BY email`,
      );
      return result.rows.map((r) => ({ id: r.id, email: r.email, name: r.name, lastSeenAt: r.last_seen_at }));
    });
    res.json(admins);
  }),
);

// PUT /platform/admins — { email, platformAdmin } : grant or revoke the flag.
// The user must have signed in before (we never create accounts here), and
// you can't revoke yourself — someone else has to.
platformRouter.put(
  '/admins',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ email: z.string().trim().email(), platformAdmin: z.boolean() }),
      req.body,
    );
    const users = await platform(req, async (client, userId) => {
      // One person can have several rows (one per identity provider — e.g. a
      // dev token and SSO during development): the flag follows the email.
      const targets = await client.query<{ id: string }>(
        `SELECT id FROM studio_user WHERE lower(email) = lower($1) AND email_verified`,
        [body.email],
      );
      if (targets.rows.length === 0) throw new HttpError(400, 'unknown_user');
      if (!body.platformAdmin && targets.rows.some((t) => t.id === userId)) {
        throw new HttpError(400, 'cannot_revoke_self');
      }
      const updated = await client.query<{ id: string; email: string; name: string | null }>(
        `UPDATE studio_user SET platform_admin = $2 WHERE lower(email) = lower($1) AND email_verified
         RETURNING id, email, name`,
        [body.email, body.platformAdmin],
      );
      return updated.rows;
    });
    res.json({
      email: users[0].email,
      name: users[0].name,
      platformAdmin: body.platformAdmin,
      users: users.length,
    });
  }),
);
