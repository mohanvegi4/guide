import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { pool, withAgentSession, withStudioSession } from '../src/db';
import { addMember, app, as, closePools, liveGuide, resetData, sampleVersion, signUp } from './helpers';

/**
 * Org/app isolation, both halves:
 *  - API: another org's ids are 404 (indistinguishable from "doesn't exist")
 *  - RLS: even raw SQL with no WHERE clause, in a correctly scoped session,
 *    can't see or touch another org's rows — independent of route code.
 */
afterAll(closePools);

let a: { orgId: string; appId: string; key: string };
let b: { orgId: string; appId: string; key: string };
let guideA: string;
let versionA: string;

beforeEach(async () => {
  await resetData();
  a = await signUp('alice', 'Acme');
  b = await signUp('zed', 'Globex');
  ({ guideId: guideA, versionId: versionA } = await liveGuide('alice', a.appId));
});

const userId = async (sub: string) =>
  (await request(app).get('/v1/me').set('Authorization', as(sub))).body.user.id as string;

describe('through the API', () => {
  it.each([
    ['org', 'get', () => `/v1/orgs/${a.orgId}`],
    ['org apps', 'get', () => `/v1/orgs/${a.orgId}/apps`],
    ['org members', 'get', () => `/v1/orgs/${a.orgId}/members`],
    ['invite', 'post', () => `/v1/orgs/${a.orgId}/invitations`],
    ['app', 'get', () => `/v1/apps/${a.appId}`],
    ['app settings', 'patch', () => `/v1/apps/${a.appId}`],
    ['rotate key', 'post', () => `/v1/apps/${a.appId}/rotate-key`],
    ['signing secret', 'post', () => `/v1/apps/${a.appId}/signing-secret`],
    ['guides', 'get', () => `/v1/apps/${a.appId}/guides`],
    ['guide', 'get', () => `/v1/apps/${a.appId}/guides/${guideA}`],
    ['draft', 'put', () => `/v1/apps/${a.appId}/guides/${guideA}/draft`],
    ['publish', 'post', () => `/v1/apps/${a.appId}/guides/${guideA}/publish`],
    ['flag', 'patch', () => `/v1/apps/${a.appId}/guides/${guideA}/flag`],
    ['rollback', 'post', () => `/v1/apps/${a.appId}/guides/${guideA}/rollback/1`],
    ['analytics', 'get', () => `/v1/apps/${a.appId}/guides/${guideA}/analytics`],
    ['preview token', 'post', () => `/v1/apps/${a.appId}/guides/${guideA}/preview-token`],
  ] as const)("Globex's admin gets 404 for Acme's %s", async (_n, method, path) => {
    const body = { ...sampleVersion, name: 'x', enabled: false, websites: [], versionId: versionA };
    const res = await request(app)[method](path()).set('Authorization', as('zed')).send(body);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it("can't reach Acme's guide through Globex's own app id", async () => {
    const res = await request(app)
      .get(`/v1/apps/${b.appId}/guides/${guideA}`)
      .set('Authorization', as('zed'));
    expect(res.status).toBe(404);
  });

  it('a viewer sees every app of their org, read-only', async () => {
    await addMember('alice', a.orgId, 'bob', 'viewer');
    expect(
      (await request(app).get(`/v1/apps/${a.appId}/guides`).set('Authorization', as('bob'))).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post(`/v1/apps/${a.appId}/guides`)
          .set('Authorization', as('bob'))
          .send({ name: 'x' })
      ).status,
    ).toBe(403);
  });
});

describe('directly in the database (RLS)', () => {
  it("a Globex session sees none of Acme's rows, even with no WHERE clause", async () => {
    const zed = await userId('zed');
    const seen = await withStudioSession(zed, async (c) => ({
      orgs: (await c.query(`SELECT id FROM organization`)).rows.map((r) => r.id),
      apps: (await c.query(`SELECT id FROM application`)).rows.map((r) => r.id),
      guides: (await c.query(`SELECT id FROM guide`)).rowCount,
      versions: (await c.query(`SELECT id FROM guide_version`)).rowCount,
      members: (await c.query(`SELECT org_id FROM org_member`)).rows.map((r) => r.org_id),
    }));
    expect(seen).toEqual({ orgs: [b.orgId], apps: [b.appId], guides: 0, versions: 0, members: [b.orgId] });
  });

  it("blocks writes to Acme's rows from a Globex session", async () => {
    const zed = await userId('zed');
    const changed = await withStudioSession(zed, async (c) => ({
      guides: (await c.query(`UPDATE guide SET enabled = FALSE`)).rowCount,
      apps: (await c.query(`UPDATE application SET enabled = FALSE WHERE org_id = $1`, [a.orgId])).rowCount,
      orgs: (await c.query(`UPDATE organization SET name = 'pwned' WHERE id = $1`, [a.orgId])).rowCount,
      deletedMembers: (await c.query(`DELETE FROM org_member WHERE org_id = $1`, [a.orgId])).rowCount,
    }));
    expect(changed).toEqual({ guides: 0, apps: 0, orgs: 0, deletedMembers: 0 });
  });

  it("can't add yourself to someone else's org (owner bootstrap can't be replayed)", async () => {
    const zed = await userId('zed');
    await expect(
      withStudioSession(zed, (c) =>
        c.query(`INSERT INTO org_member (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [a.orgId, zed]),
      ),
    ).rejects.toThrow(/row-level security/);
    // ...not even for an org you created yourself, once you've left it: the
    // creator-becomes-owner rule only holds inside the creating transaction.
    await withStudioSession(zed, (c) =>
      c.query(`DELETE FROM org_member WHERE org_id = $1 AND user_id = $2`, [b.orgId, zed]),
    );
    await expect(
      withStudioSession(zed, (c) =>
        c.query(`INSERT INTO org_member (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [b.orgId, zed]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("an agent session for Globex's key sees none of Acme's guides and can't write its events", async () => {
    const seen = await withAgentSession(b.key, async (c) => (await c.query(`SELECT id FROM guide`)).rowCount);
    expect(seen).toBe(0);
    await expect(
      withAgentSession(b.key, (c) =>
        c.query(
          `INSERT INTO guide_event (app_id, guide_id, guide_version_id, visitor_id, session_id, event_type)
           VALUES ($1, $2, $3, 'v', 's', 'guide_shown')`,
          [a.appId, guideA, versionA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('an agent session can read but never write guides', async () => {
    const changed = await withAgentSession(a.key, async (c) => ({
      read: (await c.query(`SELECT id FROM guide`)).rowCount,
      updated: (await c.query(`UPDATE guide SET enabled = FALSE`)).rowCount,
    }));
    expect(changed).toEqual({ read: 1, updated: 0 });
  });

  it('an unscoped session sees nothing', async () => {
    const client = await pool.connect();
    try {
      const r = await client.query(
        `SELECT (SELECT count(*) FROM guide)::int g, (SELECT count(*) FROM application)::int a, (SELECT count(*) FROM studio_user)::int u`,
      );
      expect(r.rows[0]).toEqual({ g: 0, a: 0, u: 0 });
    } finally {
      client.release();
    }
  });
});
