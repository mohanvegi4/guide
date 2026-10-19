import 'dotenv/config';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { pool } from './db';

/**
 * Minimal migration runner: applies every .sql file in migrations/ in
 * filename order, tracked in a schema_migrations table so re-runs are
 * idempotent. Good enough for early development — swap for a real tool
 * (node-pg-migrate, Flyway, etc.) once the schema starts changing often.
 *
 * Exported (rather than only run as a script) so the integration tests can
 * migrate their own test database with exactly the same code path.
 */
export async function runMigrations(targetPool: Pool, log: (msg: string) => void = console.log): Promise<void> {
  const client = await targetPool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const dir = join(__dirname, '..', 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const already = await client.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [file]);
      if (already.rows.length > 0) {
        log(`skip ${file} (already applied)`);
        continue;
      }

      log(`applying ${file}...`);
      const sql = readFileSync(join(dir, file), 'utf-8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    log('migrations complete');
  } finally {
    client.release();
  }
}

if (require.main === module) {
  runMigrations(pool)
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
