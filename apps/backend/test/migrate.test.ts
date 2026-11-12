import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import {
  MIGRATION_LOCK_KEY,
  assertMigrationsApplied,
  pendingMigrations,
  runMigrations,
} from '../src/migrate';

/**
 * Two backend replicas start at the same time, and each runs the migrations
 * (docker-entrypoint.sh). The runner serializes them with an advisory lock:
 * this runs two migrations concurrently against a fresh scratch database,
 * each with its own pool (its own session), and checks that both finish,
 * that every file was applied exactly once, and that the lock is gone
 * afterwards.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL!;
const DB = 'guide_engine_locktest';
const appUrl = ADMIN_URL.replace(/postgres:postgres@/, 'guide_engine:guide_engine@').replace(
  /\/[^/]+$/,
  `/${DB}`,
);
const suUrl = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);

const MIGRATION_FILES = readdirSync(join(__dirname, '..', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();

let admin: Pool;
let su: Pool;
const pools: Pool[] = [];
const appPool = (): Pool => {
  const p = new Pool({ connectionString: appUrl });
  pools.push(p);
  return p;
};

beforeAll(async () => {
  admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB} OWNER guide_engine`);
  su = new Pool({ connectionString: suUrl });
});

afterAll(async () => {
  for (const p of pools) await p.end();
  await su?.end();
  // No FORCE here: it would cut off connections the pools are still closing.
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.end();
});

/** Advisory locks on this database with the runner's key, as the superuser sees them. */
async function heldMigrationLocks(): Promise<number> {
  const r = await su.query(
    `SELECT count(*)::int AS n FROM pg_locks
     WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid = $1 AND objid = $2`,
    [...MIGRATION_LOCK_KEY],
  );
  return r.rows[0].n;
}

describe('runMigrations under concurrency', () => {
  const logs: string[][] = [[], []];

  it('serializes two concurrent runs: one applies every file, the other waits and skips them', async () => {
    const runs = [0, 1].map((i) => runMigrations(appPool(), (m) => logs[i].push(m)));
    await expect(Promise.all(runs)).resolves.toEqual([undefined, undefined]);

    const applied = logs.map((l) => l.filter((m) => m.startsWith('applying ')).length);
    const skipped = logs.map((l) => l.filter((m) => m.startsWith('skip ')).length);
    // Copies: a run's own counts are indexed by position below.
    expect([...applied].sort((a, b) => a - b)).toEqual([0, MIGRATION_FILES.length]);
    expect([...skipped].sort((a, b) => a - b)).toEqual([0, MIGRATION_FILES.length]);
    // The one that skipped is the one that had to wait for the lock.
    const waiter = logs.findIndex((l) => l.some((m) => m.startsWith('waiting for the migration lock')));
    expect(waiter).not.toBe(-1);
    expect(skipped[waiter]).toBe(MIGRATION_FILES.length);
    for (const l of logs) expect(l[l.length - 1]).toBe('migrations complete');
  });

  it('recorded every file exactly once', async () => {
    const rows = await su.query<{ filename: string; n: number }>(
      `SELECT filename, count(*)::int AS n FROM schema_migrations GROUP BY filename ORDER BY filename`,
    );
    expect(rows.rows).toEqual(MIGRATION_FILES.map((filename) => ({ filename, n: 1 })));
  });

  it('released the lock: nothing holds it, and a third run goes straight through', async () => {
    expect(await heldMigrationLocks()).toBe(0);

    const third: string[] = [];
    await runMigrations(appPool(), (m) => third.push(m));
    expect(third.some((m) => m.startsWith('waiting'))).toBe(false);
    expect(third.filter((m) => m.startsWith('skip ')).length).toBe(MIGRATION_FILES.length);
    expect(await heldMigrationLocks()).toBe(0);
  });

  it('releases the lock when a migration fails', async () => {
    // Make schema_migrations unreadable for the app role, so the run throws
    // after it has taken the lock; the error path must still release it.
    await su.query(`REVOKE SELECT ON schema_migrations FROM guide_engine`);
    try {
      await expect(runMigrations(appPool(), () => undefined)).rejects.toThrow(/permission denied/);
    } finally {
      await su.query(`GRANT SELECT ON schema_migrations TO guide_engine`);
    }
    expect(await heldMigrationLocks()).toBe(0);
  });
});

/**
 * The boot check for RUN_MIGRATIONS=false deployments: a schema behind the
 * code must be reported (production: refuse to start; development: warn)
 * instead of failing at the first query. Its own scratch database, since the
 * suite above leaves everything applied.
 */
describe('pendingMigrations and the boot check', () => {
  const PENDING_DB = 'guide_engine_pendingtest';
  let db: Pool;

  beforeAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${PENDING_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${PENDING_DB} OWNER guide_engine`);
    db = new Pool({ connectionString: appUrl.replace(`/${DB}`, `/${PENDING_DB}`) });
  });

  afterAll(async () => {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${PENDING_DB}`);
  });

  it('lists every file on a fresh database (no schema_migrations table yet)', async () => {
    expect(MIGRATION_FILES.length).toBeGreaterThan(0);
    await expect(pendingMigrations(db)).resolves.toEqual(MIGRATION_FILES);
  });

  it('refuses to start in production, naming the files and how to migrate', async () => {
    const warn = vi.fn();
    const err = await assertMigrationsApplied(db, { NODE_ENV: 'production' }, warn).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/^Refusing to start in production/);
    for (const file of MIGRATION_FILES) expect(message).toContain(` - ${file}`);
    expect(message).toContain('node dist/migrate.js');
    expect(message).toContain('RUN_MIGRATIONS=true');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and continues outside production', async () => {
    const warn = vi.fn();
    await expect(assertMigrationsApplied(db, { NODE_ENV: 'development' }, warn)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(MIGRATION_FILES[0]);
    // NODE_ENV unset (the dev server) is not production either.
    await expect(assertMigrationsApplied(db, {}, warn)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('lists exactly the files the database has not recorded', async () => {
    await runMigrations(db, () => undefined);
    // As if the newest file had shipped after this database was migrated.
    const newest = MIGRATION_FILES[MIGRATION_FILES.length - 1];
    await db.query(`DELETE FROM schema_migrations WHERE filename = $1`, [newest]);
    await expect(pendingMigrations(db)).resolves.toEqual([newest]);
    await expect(assertMigrationsApplied(db, { NODE_ENV: 'production' }, () => undefined)).rejects.toThrow(
      '1 database migration(s) not applied',
    );
    await db.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [newest]);
  });

  it('is empty after runMigrations, and the boot check is silent', async () => {
    await runMigrations(db, () => undefined);
    await expect(pendingMigrations(db)).resolves.toEqual([]);
    const warn = vi.fn();
    await expect(assertMigrationsApplied(db, { NODE_ENV: 'production' }, warn)).resolves.toBeUndefined();
    await expect(assertMigrationsApplied(db, { NODE_ENV: 'development' }, warn)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
