import { Pool, PoolClient } from 'pg';

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
// NEVER query guide / guide_version / guide_event / user_guide_state /
// organization / application / *_member / invitation / studio_user through
// pool.query() directly.
// ------------------------------------------------------------

export type OrgRole = 'owner' | 'admin' | 'member';
export type AppRole = 'viewer' | 'editor' | 'publisher' | 'app_admin';

/** What a Studio user can reach, resolved from their memberships at the start of each request. */
export interface StudioContext {
  userId: string;
  /** org id -> the user's role in it */
  orgs: Map<string, OrgRole>;
  /** app id -> owning org and the user's effective role (org owners/admins act as app_admin) */
  apps: Map<string, { orgId: string; role: AppRole }>;
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
  const adminOrgIds = [...orgs].filter(([, role]) => role !== 'member').map(([id]) => id);
  await setVar(client, 'app.org_ids', uuidArray(orgs.keys()));
  await setVar(client, 'app.admin_org_ids', uuidArray(adminOrgIds));

  const memberRows = await client.query<{ app_id: string; role: AppRole }>(
    `SELECT app_id, role FROM app_member WHERE user_id = $1`,
    [userId],
  );
  // Admin orgs' apps are visible via application_select (org_id = ANY(admin_org_ids)).
  const adminApps = await client.query<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM application WHERE org_id = ANY($1::uuid[])`,
    [adminOrgIds],
  );

  const apps = new Map<string, { orgId: string; role: AppRole }>();
  for (const a of adminApps.rows) apps.set(a.id, { orgId: a.org_id, role: 'app_admin' });

  // Per-app grants: publish them first so their application rows become visible.
  await setVar(
    client,
    'app.app_ids',
    uuidArray(new Set([...apps.keys(), ...memberRows.rows.map((r) => r.app_id)])),
  );
  if (memberRows.rows.length > 0) {
    const memberApps = await client.query<{ id: string; org_id: string }>(
      `SELECT id, org_id FROM application WHERE id = ANY($1::uuid[])`,
      [memberRows.rows.map((r) => r.app_id)],
    );
    const orgOf = new Map(memberApps.rows.map((a) => [a.id, a.org_id]));
    for (const m of memberRows.rows) {
      const orgId = orgOf.get(m.app_id);
      // An app grant only counts while the user is still a member of the org.
      if (!orgId || !orgs.has(orgId) || apps.has(m.app_id)) continue;
      apps.set(m.app_id, { orgId, role: m.role });
    }
  }

  // Final, consistent sets (drops grants for orgs the user has left).
  await setVar(client, 'app.app_ids', uuidArray(apps.keys()));
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

/** The app as the agent sees it after resolving a public key. */
export interface AgentApp {
  id: string;
  orgId: string;
  enabled: boolean;
  identityMode: 'optional' | 'required';
  signingSecret: string | null;
  allowedOrigins: string[];
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
    `SELECT id, org_id, enabled, identity_mode, signing_secret, allowed_origins
     FROM application WHERE public_key = $1`,
    [publicKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    enabled: row.enabled,
    identityMode: row.identity_mode,
    signingSecret: row.signing_secret,
    allowedOrigins: row.allowed_origins,
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

/** For tables that genuinely aren't scoped (system_config, schema_migrations). */
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
