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
 * table (guide, guide_event, user_guide_state).
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config with is_local=true scopes this to the current transaction only
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
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
