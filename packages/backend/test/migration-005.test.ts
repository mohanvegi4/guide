import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../src/migrate';

/**
 * Migration 005 converts the tenant model into organizations/applications.
 * This builds a separate database "as of" 004, fills it with old-shape data
 * (tenants, a global guide, events, per-user state including a cross-tenant
 * duplicate), applies 005, and checks nothing was lost or misassigned.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL!;
const DB = 'guide_engine_migtest';
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
  su = new Pool({ connectionString: suUrl }); // superuser: sees old rows regardless of RLS
  await runMigrations(app, () => undefined, { through: '004_platform_admin.sql' });

  const t = (await su.query(`INSERT INTO tenant (name) VALUES ('Acme'), ('Globex') RETURNING id`)).rows;
  ids.acme = t[0].id;
  ids.globex = t[1].id;
  await su.query(
    `INSERT INTO tenant_config (tenant_id, key, value) VALUES ($1, 'guide_engine_enabled', 'false')`,
    [ids.globex],
  );
  ids.tour = (
    await su.query(
      `INSERT INTO guide (tenant_id, name, type, created_by, enabled, status) VALUES ($1, 'Tour', 'tour', 'x', TRUE, 'published') RETURNING id`,
      [ids.acme],
    )
  ).rows[0].id;
  ids.notice = (
    await su.query(
      `INSERT INTO guide (tenant_id, is_global, name, type, created_by) VALUES (NULL, TRUE, 'Notice', 'banner', 'ops') RETURNING id`,
    )
  ).rows[0].id;
  ids.v1 = (
    await su.query(
      `INSERT INTO guide_version (guide_id, version_number, steps, route_match, published_at) VALUES ($1, 1, '[]', '{}', now()) RETURNING id`,
      [ids.tour],
    )
  ).rows[0].id;
  await su.query(`UPDATE guide SET current_version_id = $1 WHERE id = $2`, [ids.v1, ids.tour]);
  await su.query(
    `INSERT INTO guide_event (tenant_id, guide_id, guide_version_id, user_id, session_id, event_type) VALUES ($1, $2, $3, 'bob', 's', 'guide_shown')`,
    [ids.acme, ids.tour, ids.v1],
  );
  // Same user id finished the GLOBAL guide under two tenants: must collapse to the newest.
  await su.query(
    `INSERT INTO user_guide_state (tenant_id, user_id, guide_id, status, last_seen_version, updated_at)
     VALUES ($1, 'bob', $2, 'dismissed', 1, now() - interval '1 day'), ($3, 'bob', $2, 'completed', 1, now())`,
    [ids.acme, ids.notice, ids.globex],
  );

  await runMigrations(app, () => undefined);
});

afterAll(async () => {
  await app?.end();
  await su?.end();
});

const q = async (sql: string, params: unknown[] = []) => (await su.query(sql, params)).rows;

describe('migration 005 (tenants -> organizations/applications)', () => {
  it('turns each tenant into an org (same id) with one Default app, and keeps global guides in their own org', async () => {
    expect(await q(`SELECT id, name FROM organization ORDER BY name`)).toEqual([
      { id: ids.acme, name: 'Acme' },
      { id: ids.globex, name: 'Globex' },
      { id: expect.any(String), name: 'Migrated global guides' },
    ]);
    const apps = await q(
      `SELECT o.name AS org, a.name, a.enabled, a.public_key FROM application a JOIN organization o ON o.id = a.org_id ORDER BY o.name`,
    );
    expect(apps.map((a) => [a.org, a.name, a.enabled])).toEqual([
      ['Acme', 'Default app', true],
      ['Globex', 'Default app', false], // per-tenant kill switch carried over
      ['Migrated global guides', 'Global guides', true],
    ]);
    for (const a of apps) expect(a.public_key).toMatch(/^ge_pk_[0-9a-f]{32}$/);
  });

  it('moves guides into their apps', async () => {
    expect(
      await q(
        `SELECT g.name, o.name AS org FROM guide g JOIN application a ON a.id = g.app_id JOIN organization o ON o.id = a.org_id ORDER BY g.name`,
      ),
    ).toEqual([
      { name: 'Notice', org: 'Migrated global guides' },
      { name: 'Tour', org: 'Acme' },
    ]);
  });

  it('keeps events, with the old tenant as the account and the user as the visitor', async () => {
    expect(await q(`SELECT visitor_id, account_id, app_id IS NOT NULL AS has_app FROM guide_event`)).toEqual([
      { visitor_id: 'bob', account_id: ids.acme, has_app: true },
    ]);
  });

  it('re-keys per-user state by app and visitor, keeping the newest duplicate', async () => {
    expect(await q(`SELECT visitor_id, status FROM user_guide_state`)).toEqual([
      { visitor_id: 'bob', status: 'completed' },
    ]);
  });

  it('drops the tenant tables and leaves RLS forced on every scoped table', async () => {
    expect(await q(`SELECT to_regclass('tenant') AS t, to_regclass('tenant_config') AS c`)).toEqual([
      { t: null, c: null },
    ]);
    const unforced = await q(
      `SELECT relname FROM pg_class
       WHERE relname = ANY($1) AND NOT (relrowsecurity AND relforcerowsecurity)`,
      [
        [
          'guide',
          'guide_version',
          'guide_event',
          'user_guide_state',
          'organization',
          'application',
          'studio_user',
          'org_member',
          'app_member',
          'invitation',
        ],
      ],
    );
    expect(unforced).toEqual([]);
  });

  it('hides everything from an app-role session with no scope set (fail closed)', async () => {
    const rows = await app.query(
      `SELECT (SELECT count(*) FROM guide)::int AS g, (SELECT count(*) FROM organization)::int AS o, (SELECT count(*) FROM application)::int AS a`,
    );
    expect(rows.rows[0]).toEqual({ g: 0, o: 0, a: 0 });
  });
});
