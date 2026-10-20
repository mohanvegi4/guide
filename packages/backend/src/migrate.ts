import 'dotenv/config';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { pool } from './db';

/**
 * The advisory lock every migration run holds for its whole duration, so two
 * runs against one database never interleave: the container entrypoint runs
 * migrations on every replica's start, and a deploy can race a manual
 * `npm run migrate`. Postgres keys these locks by two int4 values (shown as
 * classid / objid in pg_locks); these are the ASCII words "GUID" and "MIGR",
 * a fixed 64-bit key with no other meaning in the schema.
 */
export const MIGRATION_LOCK_KEY: readonly [number, number] = [0x47554944, 0x4d494752];

/**
 * Minimal migration runner: applies every .sql file in migrations/ in
 * filename order, tracked in a schema_migrations table so re-runs are
 * idempotent. Good enough for early development — swap for a real tool
 * (node-pg-migrate, Flyway, etc.) once the schema starts changing often.
 *
 * Concurrent runs are safe: the run takes a session-level advisory lock on
 * its one client before it so much as creates schema_migrations, and keeps
 * it until the finally block. A second runner blocks on the lock, then sees
 * every file already recorded and skips them all. Each file still applies in
 * its own transaction, so a failing migration rolls back alone.
 *
 * Exported (rather than only run as a script) so the integration tests can
 * migrate their own test database with exactly the same code path.
 */
export async function runMigrations(
  targetPool: Pool,
  log: (msg: string) => void = console.log,
  // Tests only: stop after this file, to build a database "as of" an older
  // schema and exercise a later migration's data conversion.
  options: { through?: string } = {},
): Promise<void> {
  const client = await targetPool.connect();
  let locked = false;
  try {
    // Try first so an operator can see why a boot is slow: a held lock means
    // another replica (or a release step) is mid-migration.
    const attempt = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS locked', [
      ...MIGRATION_LOCK_KEY,
    ]);
    if (attempt.rows[0].locked) {
      locked = true;
    } else {
      log('waiting for the migration lock (another migration run is in progress)...');
      await client.query('SELECT pg_advisory_lock($1, $2)', [...MIGRATION_LOCK_KEY]);
      locked = true;
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const dir = join(__dirname, '..', 'migrations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) => !options.through || f <= options.through);

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
    // Session locks also go away when the connection closes, but the client
    // returns to the pool, so release explicitly. An unlock failing (a dead
    // connection) must not hide the error that got us here.
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [...MIGRATION_LOCK_KEY]).catch(() => undefined);
    }
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
