import { Pool, PoolClient } from 'pg';
import { decryptSecret, getSecretsKey } from './secrets';
import { logger } from './logging';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ------------------------------------------------------------
// Scoped database sessions.
//
// Every query against an org/app-scoped table runs inside one of the helpers
// below. Each opens a transaction and sets session variables (transaction-
// local) that the Row-Level Security policies in migration 005 read. The
// variables are derived ONLY from verified credentials — a Studio user id
// from a verified token, or an app resolved from its public key — never from
// request input. Unscoped sessions match no rows (fail closed).
//
// Above the organization level (migration 009):
//   withPlatformSession  a platform admin running the service: organizations,
//                        apps, members, counts — never guide content
//   withSupportSession   a platform admin reading ONE organization that has
//                        granted time-boxed support access: viewer-shaped
//                        context, READ ONLY transaction, every call logged
//
// NEVER query guide / guide_version / guide_event / agent_error /
// user_guide_state / organization / application / *_member / invitation /
// studio_user / support_access_log through pool.query() directly.
// ------------------------------------------------------------

/**
 * One role per person per organization, for every one of its sites:
 *   owner > manager > editor > viewer  (migrations 015/016)
 */
export type OrgRole = 'owner' | 'manager' | 'editor' | 'viewer';
const ORG_ROLE_RANK: Record<OrgRole, number> = { viewer: 0, editor: 1, manager: 2, owner: 3 };
export function orgRoleAtLeast(role: OrgRole | undefined, min: OrgRole): boolean {
  return role !== undefined && ORG_ROLE_RANK[role] >= ORG_ROLE_RANK[min];
}
/** What an organization role means inside each of its sites (the ladder route checks use). */
export function appRoleForOrgRole(role: OrgRole): AppRole {
  return role === 'viewer' ? 'viewer' : 'app_admin';
}
export type AppRole = 'viewer' | 'editor' | 'publisher' | 'app_admin';

/** What a Studio user can reach, resolved from their memberships at the start of each request. */
export interface StudioContext {
  userId: string;
  /** org id -> the user's role in it */
  orgs: Map<string, OrgRole>;
  /** app id -> owning org and the user's effective role (org owners/admins act as app_admin) */
  apps: Map<string, { orgId: string; role: AppRole }>;
  /** Set when this is a platform admin reading an organization under support access. */
  support?: { orgId: string; until: Date };
}

async function setVar(client: PoolClient, name: string, value: string): Promise<void> {
  // is_local = true: scoped to the current transaction only.
  await client.query('SELECT set_config($1, $2, true)', [name, value]);
}

const uuidArray = (ids: Iterable<string>) => `{${[...ids].join(',')}}`;

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const APP_ROLE_RANK: Record<AppRole, number> = { viewer: 0, editor: 1, publisher: 2, app_admin: 3 };

export function appRoleAtLeast(role: AppRole | undefined, min: AppRole): boolean {
  return role !== undefined && APP_ROLE_RANK[role] >= APP_ROLE_RANK[min];
}

/**
 * Reads the user's memberships (RLS lets a user read only their own rows at
 * this point) and publishes the derived id sets as session variables for the
 * content policies. Re-run it after membership changes within a transaction
 * (creating an org, accepting an invitation).
 */
export async function resolveStudioContext(client: PoolClient, userId: string): Promise<StudioContext> {
  await setVar(client, 'app.current_user_id', userId);

  const orgRows = await client.query<{ org_id: string; role: OrgRole }>(
    `SELECT org_id, role FROM org_member WHERE user_id = $1`,
    [userId],
  );
  const orgs = new Map(orgRows.rows.map((r) => [r.org_id, r.role]));
  const orgIds = [...orgs.keys()];
  const adminOrgIds = orgIds.filter((id) => orgRoleAtLeast(orgs.get(id), 'manager'));
  const ownerOrgIds = orgIds.filter((id) => orgs.get(id) === 'owner');
  await setVar(client, 'app.org_ids', uuidArray(orgIds));
  await setVar(client, 'app.admin_org_ids', uuidArray(adminOrgIds));
  // Owner-only actions (deleting the organization) are enforced in the DB too.
  await setVar(client, 'app.owner_org_ids', uuidArray(ownerOrgIds));

  // Roles are organization-wide: every member sees every site of their orgs
  // (application_select on app_org_ids), with the role derived from the org role.
  const appRows = await client.query<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM application WHERE org_id = ANY($1::uuid[])`,
    [orgIds],
  );
  const apps = new Map<string, { orgId: string; role: AppRole }>();
  for (const a of appRows.rows)
    apps.set(a.id, { orgId: a.org_id, role: appRoleForOrgRole(orgs.get(a.org_id)!) });

  await setVar(client, 'app.app_ids', uuidArray(apps.keys()));
  // Sites the user may change settings on: editors and up. Destructive site
  // actions (delete, rotate keys, forget visitors) additionally require the
  // manager role in the API.
  await setVar(
    client,
    'app.admin_app_ids',
    uuidArray([...apps].filter(([, a]) => a.role === 'app_admin').map(([id]) => id)),
  );

  return { userId, orgs, apps };
}

/** A Studio request: scoped to what the (verified) user's memberships allow. */
export function withStudioSession<T>(
  userId: string,
  fn: (client: PoolClient, ctx: StudioContext) => Promise<T>,
): Promise<T> {
  return inTransaction(async (client) => fn(client, await resolveStudioContext(client, userId)));
}

/** True if the user carries the platform_admin flag (readable: it's their own row). */
async function isPlatformAdmin(client: PoolClient, userId: string): Promise<boolean> {
  await setVar(client, 'app.current_user_id', userId);
  const row = await client.query<{ platform_admin: boolean }>(
    `SELECT platform_admin FROM studio_user WHERE id = $1`,
    [userId],
  );
  return row.rows[0]?.platform_admin === true;
}

/**
 * A platform admin's request: organizations, apps, members and counts across
 * every customer (the *_platform policies), never guide content. Resolves to
 * null when the user isn't a platform admin, so callers can answer 403.
 */
export function withPlatformSession<T>(
  userId: string,
  fn: (client: PoolClient, userId: string) => Promise<T>,
): Promise<T | null> {
  return inTransaction(async (client) => {
    if (!(await isPlatformAdmin(client, userId))) return null;
    await setVar(client, 'app.platform_admin', 'true');
    return fn(client, userId);
  });
}

/**
 * A platform admin reading one organization that has granted support access
 * (organization.support_access_until in the future, not suspended):
 *  - the request is written to support_access_log first (its own transaction,
 *    so the log survives whatever the read does);
 *  - the session is shaped like an org member who is a viewer on every app,
 *    so the ordinary Studio handlers and policies apply unchanged;
 *  - the transaction is READ ONLY: Postgres refuses any write, whatever a
 *    handler tries.
 * Resolves to null when the user isn't a platform admin, the organization
 * doesn't exist, or access isn't open: all of them answer 404.
 */
export async function withSupportSession<T>(
  userId: string,
  orgId: string,
  request: { method: string; path: string },
  fn: (client: PoolClient, ctx: StudioContext) => Promise<T>,
): Promise<T | null> {
  const access = await withPlatformSession(userId, async (client) => {
    const org = await client.query<{ until: Date | null; suspended: boolean }>(
      `SELECT support_access_until AS until, suspended_at IS NOT NULL AS suspended
       FROM organization WHERE id = $1`,
      [orgId],
    );
    const row = org.rows[0];
    if (!row?.until || row.until <= new Date() || row.suspended) return null;
    await client.query(
      `INSERT INTO support_access_log (org_id, admin_user_id, admin_name, admin_email, method, path)
       SELECT $1, u.id, u.name, u.email, $3, $4 FROM studio_user u WHERE u.id = $2`,
      [orgId, userId, request.method, request.path.slice(0, 500)],
    );
    return { until: row.until };
  });
  if (!access) return null;

  return inTransaction(async (client) => {
    if (!(await isPlatformAdmin(client, userId))) return null;
    await setVar(client, 'app.platform_admin', 'true');
    const apps = await client.query<{ id: string }>(`SELECT id FROM application WHERE org_id = $1`, [orgId]);
    // From here on, the shape of an org member who may only look.
    await setVar(client, 'app.platform_admin', 'false');
    await setVar(client, 'app.org_ids', uuidArray([orgId]));
    await setVar(client, 'app.admin_org_ids', uuidArray([]));
    await setVar(client, 'app.owner_org_ids', uuidArray([]));
    await setVar(client, 'app.app_ids', uuidArray(apps.rows.map((a) => a.id)));
    await setVar(client, 'app.admin_app_ids', uuidArray([]));
    await client.query(`SET LOCAL transaction_read_only = on`);
    const ctx: StudioContext = {
      userId,
      orgs: new Map([[orgId, 'viewer']]),
      apps: new Map(apps.rows.map((a) => [a.id, { orgId, role: 'viewer' as AppRole }])),
      support: { orgId, until: access.until },
    };
    return fn(client, ctx);
  });
}

/** The app as the agent sees it after resolving a public key. */
export interface AgentApp {
  id: string;
  orgId: string;
  enabled: boolean;
  /** Set when the owning organization is suspended (denormalized by the suspend endpoint). */
  suspendedAt: Date | null;
  identityMode: 'optional' | 'required';
  signingSecret: string | null;
  allowedOrigins: string[];
  /** 'path' or 'hash': which part of the URL the agent matches routes on. */
  routeMode: 'path' | 'hash';
}

/** Resolves a public key (no transaction; used for CORS checks and preflights). */
export async function findAppByPublicKey(publicKey: string): Promise<AgentApp | null> {
  return inTransaction(async (client) => {
    await setVar(client, 'app.public_key', publicKey);
    return loadAgentApp(client, publicKey);
  });
}

async function loadAgentApp(client: PoolClient, publicKey: string): Promise<AgentApp | null> {
  const result = await client.query(
    `SELECT id, org_id, enabled, suspended_at, identity_mode, signing_secret, allowed_origins, route_mode
     FROM application WHERE public_key = $1`,
    [publicKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    enabled: row.enabled,
    suspendedAt: row.suspended_at,
    identityMode: row.identity_mode,
    signingSecret: row.signing_secret ? readSigningSecret(row.signing_secret, row.id) : null,
    allowedOrigins: row.allowed_origins,
    routeMode: row.route_mode === 'hash' ? 'hash' : 'path',
  };
}

/**
 * An agent (install snippet) request: scoped to the single app that owns
 * `publicKey`. Resolves to null for an unknown key.
 */
export function withAgentSession<T>(
  publicKey: string,
  fn: (client: PoolClient, app: AgentApp) => Promise<T>,
): Promise<T | null> {
  return inTransaction(async (client) => {
    await setVar(client, 'app.public_key', publicKey);
    const app = await loadAgentApp(client, publicKey);
    if (!app) return null;
    await setVar(client, 'app.current_app_id', app.id);
    return fn(client, app);
  });
}

/**
 * Looks up / provisions the studio_user row for a verified token identity
 * ("<issuer>|<sub>"). The identity variable is what lets this session see
 * that one row before the user id is known.
 */
export function withIdentity<T>(identity: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction(async (client) => {
    await setVar(client, 'app.current_identity', identity);
    return fn(client);
  });
}

/** Marks the invitation (by token hash) the caller presented, for the accept-invite policies. */
export async function presentInvitation(client: PoolClient, tokenHash: string): Promise<void> {
  await setVar(client, 'app.invite_token_hash', tokenHash);
}

/**
 * Signing secrets are encrypted at rest when SECRETS_KEY is set (secrets.ts).
 * One that can't be decrypted (the key changed, or isn't set) counts as no
 * secret: signed identities for that app stop verifying — fail closed — and
 * the operator sees why in the log.
 */
function readSigningSecret(stored: string, appId: string): string | null {
  try {
    return decryptSecret(stored, getSecretsKey());
  } catch (err) {
    logger.error({ appId, err }, 'signing secret unreadable: signed identities for this app will not verify');
    return null;
  }
}

/** The retention job (retention.ts): may read and delete guide_event and agent_error rows, nothing else. */
export function withRetentionSession<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction(async (client) => {
    await setVar(client, 'app.retention', 'true');
    return fn(client);
  });
}

/**
 * Operator scripts only (encrypt-secrets): the platform-admin scope without
 * a user — the same trust as running a migration. Never reachable from a
 * request.
 */
export function withMaintenanceSession<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction(async (client) => {
    await setVar(client, 'app.platform_admin', 'true');
    return fn(client);
  });
}

/** For tables that genuinely aren't scoped (system_config, schema_migrations, agent_rate_limit). */
export async function withoutScope<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Refuses to run if the connected role would bypass Row-Level Security.
 * Superusers and BYPASSRLS roles skip RLS unconditionally (even with FORCE
 * ROW LEVEL SECURITY), which would silently remove the DB-level half of
 * isolation. Called at boot so a misconfigured DATABASE_URL fails loudly.
 */
export async function assertRlsEnforceable(): Promise<void> {
  const result = await withoutScope((client) =>
    client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    ),
  );
  const role = result.rows[0];
  if (!role || role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `Refusing to start: database role "${role?.rolname ?? 'unknown'}" bypasses Row-Level Security ` +
        '(superuser or BYPASSRLS). Connect as a NOSUPERUSER NOBYPASSRLS role — see docker/init.sql.',
    );
  }
}
