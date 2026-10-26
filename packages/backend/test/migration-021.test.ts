import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../src/migrate';

/**
 * Migration 021 adds environments. This builds a separate database "as of"
 * 020 with an app that has a live guide, a draft-only guide, events and
 * visitor state, applies 021, and checks everything lands in one
 * "Production" environment with the same websites and live versions.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL!;
const DB = 'guide_engine_migtest_021';
const appUrl = ADMIN_URL.replace(/postgres:postgres@/, 'guide_engine:guide_engine@').replace(
  /\/[^/]+$/,
  `/${DB}`,
);
const suUrl = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);

let app: Pool;
let su: Pool;
const ids: Record<string, string> = {};

beforeAll(async () => {
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`CREATE DATABASE ${DB} OWNER guide_engine`);
  await admin.end();

  app = new Pool({ connectionString: appUrl });
  su = new Pool({ connectionString: suUrl }); // superuser: writes old-shape rows regardless of RLS
  await runMigrations(app, () => undefined, { through: '020_visitor_tags.sql' });

  const one = async (sql: string, params: unknown[] = []) => (await su.query(sql, params)).rows[0].id as string;
  ids.org = await one(`INSERT INTO organization (name) VALUES ('Acme') RETURNING id`);
  ids.app = await one(
    `INSERT INTO application (org_id, name, public_key, allowed_origins)
     VALUES ($1, 'Console', 'ge_pk_migtest021', '{https://a.test,https://b.test}') RETURNING id`,
    [ids.org],
  );
  ids.live = await one(
    `INSERT INTO guide (app_id, name, type, created_by, enabled, status) VALUES ($1, 'Live', 'tour', 'x', TRUE, 'published') RETURNING id`,
    [ids.app],
  );
  ids.draft = await one(`INSERT INTO guide (app_id, name, type, created_by) VALUES ($1, 'Draft', 'tooltip', 'x') RETURNING id`, [
    ids.app,
  ]);
  ids.v1 = await one(
    `INSERT INTO guide_version (guide_id, version_number, steps, route_match, published_at) VALUES ($1, 1, '[]', '{}', now()) RETURNING id`,
    [ids.live],
  );
  await su.query(`UPDATE guide SET current_version_id = $1 WHERE id = $2`, [ids.v1, ids.live]);
  await su.query(
    `INSERT INTO guide_event (app_id, guide_id, guide_version_id, visitor_id, session_id, event_type)
     VALUES ($1, $2, $3, 'bob', 's', 'guide_shown')`,
    [ids.app, ids.live, ids.v1],
  );
  await su.query(`INSERT INTO user_guide_state (app_id, visitor_id, guide_id, status) VALUES ($1, 'bob', $2, 'completed')`, [
    ids.app,
    ids.live,
  ]);

  await runMigrations(app, () => undefined);
});

afterAll(async () => {
  await app?.end();
  await su?.end();
});

const q = async (sql: string, params: unknown[] = []) => (await su.query(sql, params)).rows;

describe('migration 021 (environments)', () => {
  it('gives every app one Production environment with its websites, analytics on', async () => {
    expect(await q(`SELECT app_id, name, position, origins, analytics_enabled FROM app_environment`)).toEqual([
      {
        app_id: ids.app,
        name: 'Production',
        position: 1,
        origins: ['https://a.test', 'https://b.test'],
        analytics_enabled: true,
      },
    ]);
  });

  it('turns live versions into Production releases, with a log entry to revert to', async () => {
    const [env] = await q(`SELECT id FROM app_environment`);
    expect(await q(`SELECT guide_id, environment_id, version_id FROM guide_release`)).toEqual([
      { guide_id: ids.live, environment_id: env.id, version_id: ids.v1 },
    ]);
    expect(await q(`SELECT guide_id, action, version_id, reverted_at FROM guide_release_event`)).toEqual([
      { guide_id: ids.live, action: 'release', version_id: ids.v1, reverted_at: null },
    ]);
    // The view serves exactly what was live before.
    expect(await q(`SELECT id, version_id, environment_id FROM active_guide`)).toEqual([
      { id: ids.live, version_id: ids.v1, environment_id: env.id },
    ]);
  });

  it('files existing events and visitor state under Production, and keeps RLS forced', async () => {
    const [env] = await q(`SELECT id FROM app_environment`);
    expect(await q(`SELECT environment_id FROM guide_event`)).toEqual([{ environment_id: env.id }]);
    expect(await q(`SELECT environment_id, visitor_id FROM user_guide_state`)).toEqual([
      { environment_id: env.id, visitor_id: 'bob' },
    ]);
    const forced = await q(
      `SELECT relname FROM pg_class WHERE relname = ANY($1) AND relforcerowsecurity ORDER BY relname`,
      [['application', 'guide', 'guide_event', 'user_guide_state', 'app_environment', 'guide_release', 'guide_release_event']],
    );
    expect(forced.map((r) => r.relname)).toEqual([
      'app_environment',
      'application',
      'guide',
      'guide_event',
      'guide_release',
      'guide_release_event',
      'user_guide_state',
    ]);
  });
});
