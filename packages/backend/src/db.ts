import { Pool, PoolClient } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Runs `fn` with a client that has `app.current_tenant_id` set for the
 * duration of the transaction. This is what makes the Postgres Row-Level
 * Security policies in the schema actually enforce tenant isolation —
 * every query executed through this client is automatically scoped.
 *
 * ALWAYS use this instead of pool.query() directly for any tenant-scoped
 * table (guide, guide_version, guide_event, user_guide_state, tenant_config).
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
  options: { platformAdmin?: boolean } = {}
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config with is_local=true scopes this to the current transaction only
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
    // Unlocks the global-guide write policies (migration 004). Only ever set
    // from a verified platform_admin role — never from request input.
    await client.query('SELECT set_config($1, $2, true)', [
      'app.is_platform_admin',
      options.platformAdmin ? 'true' : 'false',
    ]);
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

/** For queries that genuinely aren't tenant-scoped (system_config, tenant table itself). */
export async function withoutTenant<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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
 * tenant isolation. Called at boot so a misconfigured DATABASE_URL fails
 * loudly instead of quietly running without defense in depth.
 */
export async function assertRlsEnforceable(): Promise<void> {
  const result = await withoutTenant((client) =>
    client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    )
  );
  const role = result.rows[0];
  if (!role || role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `Refusing to start: database role "${role?.rolname ?? 'unknown'}" bypasses Row-Level Security ` +
        '(superuser or BYPASSRLS). Connect as a NOSUPERUSER NOBYPASSRLS role — see docker/init.sql.'
    );
  }
}
