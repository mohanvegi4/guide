import { PoolClient } from 'pg';
import { HttpError, notFound } from '../httpError';
import { APP_COLUMNS, AppRow } from './orgs';
import { toVersionResponse, versionColumns, VersionResponse, VersionRow } from './versions';

/**
 * A customer's data lifecycle: taking an organization's data out (export)
 * and deleting it, or one of its applications (GDPR, contract end).
 *
 * Both run inside a caller-provided scoped session: a Studio session for an
 * owner / app admin, or a platform session for an operator handling a
 * deletion request. Row-Level Security decides what each may see or delete;
 * the routes check the role first so a refusal is a clean 403/404.
 */

/** The document GET /v1/orgs/:orgId/export answers with. */
export interface OrganizationExport {
  format: 'guide-engine-organization';
  formatVersion: 1;
  exportedAt: string;
  organization: { id: string; name: string; createdAt: string };
  members: Array<{
    userId: string;
    email: string | null;
    name: string | null;
    orgRole: string;
  }>;
  /** Pending (unaccepted, unexpired) invitations. Never the link token. */
  invitations: Array<{
    id: string;
    email: string | null;
    orgRole: string;
    createdAt: string;
    expiresAt: string;
  }>;
  apps: Array<{
    id: string;
    name: string;
    publicKey: string;
    websites: string[];
    identityMode: 'optional' | 'required';
    hasSigningSecret: boolean;
    enabled: boolean;
    helpEnabled: boolean;
    helpButtonLabel: string;
    helpButtonColor: string;
    helpPosition: string;
    routeMode: string;
    suspendedAt: string | null;
    createdAt: string;
    environments: Array<{ id: string; name: string; position: number; websites: string[]; analyticsEnabled: boolean }>;
    pages: Array<{
      id: string;
      name: string;
      routeMatch: { type: string; value: string };
      startPath: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
    guides: Array<{
      id: string;
      name: string;
      type: string;
      status: string;
      enabled: boolean;
      currentVersionId: string | null;
      createdBy: string;
      createdAt: string;
      updatedAt: string;
      /** Lifetime totals. Raw events are not exported: they identify end users. */
      analytics: { shown: number; completed: number; dismissed: number };
      versions: Array<VersionResponse & { createdAt: string }>;
      releases: Array<{ environmentId: string; versionId: string; releasedAt: string }>;
    }>;
  }>;
  notes: string[];
}

/**
 * Everything the organization authored, as one JSON document: the org, its
 * apps (every column the Studio shows, never the signing secret), saved
 * pages, guides with every version, members, pending invitations, and
 * per-guide analytics totals.
 *
 * Raw guide_event / user_guide_state rows are deliberately left out: they
 * carry the customer's end-user ids, which an authoring export has no
 * business copying around. A data-subject request about one visitor is
 * served by a platform operator from the database (see README, "Your data").
 *
 * Expects an owner's Studio session: an owner is app_admin on every app, so
 * RLS shows all of the organization's rows.
 */
export async function exportOrganization(client: PoolClient, orgId: string): Promise<OrganizationExport> {
  const org = (
    await client.query<{ id: string; name: string; created_at: string }>(
      `SELECT id, name, created_at FROM organization WHERE id = $1`,
      [orgId],
    )
  ).rows[0];
  if (!org) throw notFound();

  const members = await client.query<{
    user_id: string;
    role: string;
    email: string | null;
    name: string | null;
  }>(
    `SELECT m.user_id, m.role, u.email, u.name
     FROM org_member m JOIN studio_user u ON u.id = m.user_id
     WHERE m.org_id = $1
     ORDER BY array_position(ARRAY['owner','manager','editor','viewer'], m.role::text), COALESCE(u.name, u.email), m.user_id`,
    [orgId],
  );
  const invitations = await client.query<{
    id: string;
    email: string | null;
    org_role: string;
    created_at: string;
    expires_at: string;
  }>(
    `SELECT id, email, org_role, created_at, expires_at FROM invitation
     WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at`,
    [orgId],
  );
  const apps = await client.query<AppRow>(
    `SELECT ${APP_COLUMNS} FROM application WHERE org_id = $1 ORDER BY name, id`,
    [orgId],
  );
  const appIds = apps.rows.map((a) => a.id);
  const pages = await client.query<{
    id: string;
    app_id: string;
    name: string;
    match_type: string;
    match_value: string;
    start_path: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, app_id, name, match_type, match_value, start_path, created_at, updated_at
     FROM app_page WHERE app_id = ANY($1::uuid[]) ORDER BY app_id, name`,
    [appIds],
  );
  // Totals per guide, joined on app_id too so the (app_id, guide_id) index serves it.
  const guides = await client.query<{
    id: string;
    app_id: string;
    name: string;
    type: string;
    status: string;
    enabled: boolean;
    current_version_id: string | null;
    created_by: string;
    created_at: string;
    updated_at: string;
    shown: number;
    completed: number;
    dismissed: number;
  }>(
    `SELECT g.id, g.app_id, g.name, g.type, g.status, g.enabled, g.current_version_id,
            g.created_by, g.created_at, g.updated_at,
            COUNT(e.id) FILTER (WHERE e.event_type = 'guide_shown')::int AS shown,
            COUNT(e.id) FILTER (WHERE e.event_type = 'guide_completed')::int AS completed,
            COUNT(e.id) FILTER (WHERE e.event_type = 'guide_dismissed')::int AS dismissed
     FROM guide g
     LEFT JOIN guide_event e ON e.guide_id = g.id AND e.app_id = g.app_id
     WHERE g.app_id = ANY($1::uuid[])
     GROUP BY g.id
     ORDER BY g.app_id, g.created_at, g.id`,
    [appIds],
  );
  const versions = await client.query<VersionRow & { guide_id: string; created_at: string }>(
    `SELECT ${versionColumns('v')}, v.guide_id, v.created_at
     FROM guide_version v JOIN guide g ON g.id = v.guide_id
     WHERE g.app_id = ANY($1::uuid[]) ORDER BY v.guide_id, v.version_number`,
    [appIds],
  );

  const environments = await client.query<{
    id: string;
    app_id: string;
    name: string;
    position: number;
    origins: string[];
    analytics_enabled: boolean;
  }>(
    `SELECT id, app_id, name, position, origins, analytics_enabled FROM app_environment
     WHERE app_id = ANY($1::uuid[]) ORDER BY app_id, position`,
    [appIds],
  );
  const releases = await client.query<{ guide_id: string; environment_id: string; version_id: string; released_at: string }>(
    `SELECT guide_id, environment_id, version_id, released_at FROM guide_release WHERE app_id = ANY($1::uuid[])`,
    [appIds],
  );

  return {
    format: 'guide-engine-organization',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    organization: { id: org.id, name: org.name, createdAt: org.created_at },
    members: members.rows.map((m) => ({
      userId: m.user_id,
      email: m.email,
      name: m.name,
      orgRole: m.role,
    })),
    invitations: invitations.rows.map((i) => ({
      id: i.id,
      email: i.email,
      orgRole: i.org_role,
      createdAt: i.created_at,
      expiresAt: i.expires_at,
    })),
    apps: apps.rows.map((a) => ({
      id: a.id,
      name: a.name,
      publicKey: a.public_key,
      websites: a.allowed_origins,
      identityMode: a.identity_mode,
      hasSigningSecret: a.has_signing_secret,
      enabled: a.enabled,
      helpEnabled: a.help_enabled,
      helpButtonLabel: a.help_button_label,
      helpButtonColor: a.help_button_color,
      helpPosition: a.help_position,
      routeMode: a.route_mode,
      suspendedAt: a.suspended_at,
      createdAt: a.created_at,
      environments: environments.rows
        .filter((e) => e.app_id === a.id)
        .map((e) => ({
          id: e.id,
          name: e.name,
          position: e.position,
          websites: e.origins,
          analyticsEnabled: e.analytics_enabled,
        })),
      pages: pages.rows
        .filter((p) => p.app_id === a.id)
        .map((p) => ({
          id: p.id,
          name: p.name,
          routeMatch: { type: p.match_type, value: p.match_value },
          startPath: p.start_path,
          createdAt: p.created_at,
          updatedAt: p.updated_at,
        })),
      guides: guides.rows
        .filter((g) => g.app_id === a.id)
        .map((g) => ({
          id: g.id,
          name: g.name,
          type: g.type,
          status: g.status,
          enabled: g.enabled,
          currentVersionId: g.current_version_id,
          createdBy: g.created_by,
          createdAt: g.created_at,
          updatedAt: g.updated_at,
          analytics: { shown: g.shown, completed: g.completed, dismissed: g.dismissed },
          versions: versions.rows
            .filter((v) => v.guide_id === g.id)
            .map((v) => ({ ...toVersionResponse(v), createdAt: v.created_at })),
          releases: releases.rows
            .filter((r) => r.guide_id === g.id)
            .map((r) => ({ environmentId: r.environment_id, versionId: r.version_id, releasedAt: r.released_at })),
        })),
    })),
    notes: [
      'Signing secrets are never exported; generate new ones after importing elsewhere.',
      'Analytics are lifetime totals per guide. Raw events and per-visitor state are not included ' +
        'because they identify your end users; a platform operator can extract them from the database ' +
        'for a data-subject request.',
    ],
  };
}

/** `guide-engine-<org name as a slug>-<YYYY-MM-DD>.json` */
export function exportFilename(orgName: string, now = new Date()): string {
  const slug =
    orgName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'organization';
  return `guide-engine-${slug}-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * Deletes an organization and everything in it: apps, guides and their
 * versions, saved pages, events, visitor state, agent errors, memberships,
 * invitations and the support access log. One statement: every child table
 * cascades from its parent (migrations/001_schema.sql explains why that
 * is the safe route under RLS). Studio user accounts stay.
 *
 * Throws 404 when the session may not delete it (not an owner, not a
 * platform admin, or no such organization): the policies simply match no row.
 */
export async function deleteOrganization(client: PoolClient, orgId: string): Promise<{ name: string }> {
  const deleted = await client.query<{ name: string }>(
    `DELETE FROM organization WHERE id = $1 RETURNING name`,
    [orgId],
  );
  if (deleted.rows.length === 0) throw notFound();
  return deleted.rows[0];
}

/** Deletes one application with its guides, pages, events, visitor state, agent errors and grants. */
export async function deleteApplication(client: PoolClient, appId: string): Promise<{ name: string }> {
  const deleted = await client.query<{ name: string }>(
    `DELETE FROM application WHERE id = $1 RETURNING name`,
    [appId],
  );
  if (deleted.rows.length === 0) throw notFound();
  return deleted.rows[0];
}

/**
 * Type-the-name confirmation for destructive requests: the body must carry
 * the exact current name. A mismatch is a 400 the Studio turns into "the
 * name you typed doesn't match", and nothing is deleted.
 */
export function assertConfirmName(actual: string, confirmName: string): void {
  if (actual !== confirmName) throw new HttpError(400, 'confirmation_mismatch');
}
