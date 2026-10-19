import { Pool } from 'pg';
import { runMigrations } from '../src/migrate';

/**
 * Rebuilds the test database schema from scratch once per test run, using the
 * same migration runner as production so the tests exercise the real schema
 * (including RLS policies) rather than a hand-maintained copy.
 */
export default async function setup(): Promise<void> {
  const url =
    process.env.TEST_DATABASE_URL ?? 'postgres://guide_engine:guide_engine@localhost:5433/guide_engine_test';
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await runMigrations(pool, () => undefined);
  } catch (err) {
    throw new Error(
      `Could not prepare the test database (${(err as Error).message}). Is Postgres running? Try \`npm run db:up\` from the repo root.`,
    );
  } finally {
    await pool.end();
  }
}
