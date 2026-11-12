import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  addMember,
  adminPool,
  agent,
  app,
  as,
  closePools,
  liveGuide,
  resetData,
  sampleStep,
  sampleVersion,
  signUp,
  visitor,
} from './helpers';
import { createApp } from '../src/app';
import { withStudioSession } from '../src/db';
import { createLogger } from '../src/logging';

/**
 * A customer's data lifecycle: the owner exports the organization's data
 * (GET /orgs/:id/export) and deletes it (DELETE /orgs/:id), an app admin
 * deletes one app (DELETE /apps/:id), and a platform admin deletes an
 * organization on request (DELETE /platform/orgs/:id). Both halves are
 * checked: the routes' roles, and that the database policies themselves
 * refuse a non-owner.
 */
afterAll(closePools);
beforeEach(resetData);

const TABLES = [
  'organization',
  'application',
  'org_member',
  'invitation',
  'support_access_log',
  'app_page',
  'guide',
  'guide_version',
  'guide_event',
  'user_guide_state',
  'agent_error',
] as const;

/** Row counts per table, as the superuser sees them (RLS bypassed on purpose). */
async function rowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    counts[t] = (await adminPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  }
  return counts;
}

const userId = async (sub: string) =>
  (await adminPool.query<{ id: string }>(`SELECT id FROM studio_user WHERE oidc_sub = $1`, [sub])).rows[0].id;

/** Makes `sub` a platform admin the way the first one is made in real life: SQL by the DB owner. */
async function makePlatformAdmin(sub: string): Promise<string> {
  await request(app).get('/v1/me').set('Authorization', as(sub));
  return (
    await adminPool.query<{ id: string }>(
      `UPDATE studio_user SET platform_admin = TRUE WHERE oidc_sub = $1 RETURNING id`,
      [sub],
    )
  ).rows[0].id;
}

/**
 * An organization with a row in every table: users `owner`, `manager` and
 * `member` (an editor), a live guide with a draft, a saved page,
 * a pending invitation, events (shown / completed / dismissed), visitor
 * state, an agent error, and one logged support-access request by `root`.
 */
async function seedOrg(sub = 'owner', name = 'OCLC Inc.') {
  const org = await signUp(sub, name);
  await addMember(sub, org.orgId, 'manager', 'manager');
  await addMember(sub, org.orgId, 'member', 'editor');
  const page = await request(app)
    .post(`/v1/apps/${org.appId}/pages`)
    .set('Authorization', as(sub))
    .send({ name: 'Dashboard', routeMatch: { type: 'exact', value: '/dashboard' } });
  const live = await liveGuide(sub, org.appId);
  await request(app)
    .put(`/v1/apps/${org.appId}/guides/${live.guideId}/draft`)
    .set('Authorization', as(sub))
    .send({ steps: [{ ...sampleStep, content: '<p>draft</p>' }], pageId: page.body.id });
  await request(app)
    .post(`/v1/orgs/${org.orgId}/invitations`)
    .set('Authorization', as(sub))
    .send({ email: 'viewer@example.com', orgRole: 'viewer' });
  const ev = (eventType: string) => ({
    guideId: live.guideId,
    guideVersionId: live.versionId,
    sessionId: 's',
    eventType,
    occurredAt: new Date().toISOString(),
  });
  await agent(org.key, '/events', {
    ...visitor('v-1', 'acct-1'),
    events: [ev('guide_shown'), ev('guide_shown'), ev('guide_completed')],
  });
  await agent(org.key, '/events', { ...visitor('v-2', 'acct-2'), events: [ev('guide_dismissed')] });
  await agent(org.key, '/errors', { ...visitor(), message: 'render: boom' });
  await request(app)
    .put(`/v1/orgs/${org.orgId}/support-access`)
    .set('Authorization', as(sub))
    .send({ days: 1 });
  await makePlatformAdmin('root');
  await request(app)
    .get(`/v1/apps/${org.appId}/guides`)
    .set('Authorization', as('root'))
    .set('X-Support-Org', org.orgId);
  return { ...org, guideId: live.guideId, versionId: live.versionId, pageId: page.body.id as string };
}

describe('GET /v1/orgs/:orgId/export', () => {
  it('gives the owner one JSON download with everything the organization authored', async () => {
    const oclc = await seedOrg();
    const res = await request(app).get(`/v1/orgs/${oclc.orgId}/export`).set('Authorization', as('owner'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="guide-engine-oclc-inc-${new Date().toISOString().slice(0, 10)}.json"`,
    );

    const doc = res.body;
    expect(doc.format).toBe('guide-engine-organization');
    expect(doc.organization).toEqual({ id: oclc.orgId, name: 'OCLC Inc.', createdAt: expect.any(String) });
    expect(doc.members.map((m: { email: string; orgRole: string }) => [m.email, m.orgRole])).toEqual([
      ['owner@example.com', 'owner'],
      ['manager@example.com', 'manager'],
      ['member@example.com', 'editor'],
    ]);
    expect(doc.invitations).toEqual([
      {
        id: expect.any(String),
        email: 'viewer@example.com',
        orgRole: 'viewer',
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
      },
    ]);
    expect(doc.apps).toHaveLength(1);
    const [exportedApp] = doc.apps;
    expect(exportedApp).toMatchObject({
      id: oclc.appId,
      name: 'OCLC Inc. app',
      publicKey: oclc.key,
      websites: ['https://app.oclc.test'],
      hasSigningSecret: false,
      routeMode: 'path',
    });
    expect(exportedApp.pages).toEqual([
      expect.objectContaining({
        id: oclc.pageId,
        name: 'Dashboard',
        routeMatch: { type: 'exact', value: '/dashboard' },
      }),
    ]);
    expect(exportedApp.guides).toHaveLength(1);
    const [guide] = exportedApp.guides;
    expect(guide).toMatchObject({
      id: oclc.guideId,
      name: 'G',
      status: 'published',
      enabled: true,
      currentVersionId: oclc.versionId,
      analytics: { shown: 2, completed: 1, dismissed: 1 },
    });
    expect(
      guide.versions.map((v: { versionNumber: number; publishedAt: string | null }) => v.versionNumber),
    ).toEqual([1, 2]);
    expect(guide.versions[0]).toMatchObject({
      id: oclc.versionId,
      steps: [expect.objectContaining({ content: '<p>Invite your team</p>' })],
      routeMatch: sampleVersion.routeMatch,
      visitorTags: null,
      activation: 'auto',
      publishedAt: expect.any(String),
    });
    expect(guide.versions[1]).toMatchObject({ pageId: oclc.pageId, publishedAt: null });
  });

  it('never carries secrets, link tokens or end-user ids', async () => {
    const oclc = await seedOrg();
    await request(app).post(`/v1/apps/${oclc.appId}/signing-secret`).set('Authorization', as('owner'));
    const res = await request(app).get(`/v1/orgs/${oclc.orgId}/export`).set('Authorization', as('owner'));
    const text = JSON.stringify(res.body);
    expect(res.body.apps[0].hasSigningSecret).toBe(true);
    expect(text).not.toContain('ge_sk_');
    expect(text).not.toMatch(/"signing_?secret"/i); // only the hasSigningSecret flag
    expect(text).not.toMatch(/token/i);
    expect(text).not.toContain('v-1');
    expect(text).not.toContain('v-2');
    expect(text).not.toContain('acct-1');
  });

  it('is for owners only: admins and members get 403, outsiders and support access do not get it either', async () => {
    const oclc = await seedOrg();
    await signUp('rival', 'Globex');
    const status = async (sub: string, headers: Record<string, string> = {}) =>
      (await request(app).get(`/v1/orgs/${oclc.orgId}/export`).set('Authorization', as(sub)).set(headers))
        .status;
    expect(await status('manager')).toBe(403);
    expect(await status('member')).toBe(403);
    expect(await status('rival')).toBe(404);
    // A platform admin: not a member (404); under the open support window, a viewer (403).
    expect(await status('root')).toBe(404);
    expect(await status('root', { 'X-Support-Org': oclc.orgId })).toBe(403);
  });
});

describe('DELETE /v1/orgs/:orgId', () => {
  const del = (sub: string, orgId: string, confirmName: string, headers: Record<string, string> = {}) =>
    request(app).delete(`/v1/orgs/${orgId}`).set('Authorization', as(sub)).set(headers).send({ confirmName });

  it('refuses a wrong confirmation name and deletes nothing', async () => {
    const oclc = await seedOrg();
    const before = await rowCounts();
    const res = await del('owner', oclc.orgId, 'oclc corp.');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('confirmation_mismatch');
    expect((await del('owner', oclc.orgId, '')).status).toBe(400);
    expect(
      (await request(app).delete(`/v1/orgs/${oclc.orgId}`).set('Authorization', as('owner'))).status,
    ).toBe(400);
    expect(await rowCounts()).toEqual(before);
  });

  it("is refused for an admin (403), a member (403) and another organization's owner (404), deleting nothing", async () => {
    const oclc = await seedOrg();
    await signUp('rival', 'Globex');
    const before = await rowCounts();
    expect((await del('manager', oclc.orgId, 'OCLC Inc.')).status).toBe(403);
    expect((await del('member', oclc.orgId, 'OCLC Inc.')).status).toBe(403);
    expect((await del('rival', oclc.orgId, 'OCLC Inc.')).status).toBe(404);
    expect((await del('root', oclc.orgId, 'OCLC Inc.')).status).toBe(404);
    expect((await del('root', oclc.orgId, 'OCLC Inc.', { 'X-Support-Org': oclc.orgId })).status).toBe(403);
    // Unchanged, except that the refused support-access attempt was itself logged (as every one is).
    expect(await rowCounts()).toEqual({ ...before, support_access_log: before.support_access_log + 1 });
  });

  it('is refused by the database itself for anyone but an owner, whatever the route does', async () => {
    const oclc = await seedOrg();
    await signUp('rival', 'Globex');
    const rawDelete = async (sub: string) =>
      withStudioSession(await userId(sub), async (client) => {
        const r = await client.query(`DELETE FROM organization WHERE id = $1`, [oclc.orgId]);
        return r.rowCount;
      });
    expect(await rawDelete('manager')).toBe(0);
    expect(await rawDelete('member')).toBe(0);
    expect(await rawDelete('rival')).toBe(0);
    expect((await rowCounts()).organization).toBe(2);
    // ...and allowed for the owner (rolled back here by throwing, so the rest of the org survives).
    await expect(
      withStudioSession(await userId('owner'), async (client) => {
        const r = await client.query(`DELETE FROM organization WHERE id = $1`, [oclc.orgId]);
        throw new Error(`deleted ${r.rowCount}`);
      }),
    ).rejects.toThrow('deleted 1');
    expect((await rowCounts()).organization).toBe(2);
  });

  it('deletes everything that belongs to the organization, and nothing else', async () => {
    const oclc = await seedOrg();
    const globex = await seedOrg('rival', 'Globex');
    const before = await rowCounts();
    for (const t of TABLES) expect(before[t], t).toBeGreaterThan(0);

    const res = await del('owner', oclc.orgId, 'OCLC Inc.');
    expect(res.status).toBe(204);

    // OCLC's rows are gone from every table...
    const left = async (sql: string, id: string) => (await adminPool.query(sql, [id])).rowCount;
    expect(await left(`SELECT 1 FROM organization WHERE id = $1`, oclc.orgId)).toBe(0);
    for (const t of ['application', 'org_member', 'invitation', 'support_access_log'] as const) {
      expect(await left(`SELECT 1 FROM ${t} WHERE org_id = $1`, oclc.orgId), t).toBe(0);
    }
    for (const t of [
      'app_page',
      'guide',
      'guide_event',
      'user_guide_state',
      'agent_error',
    ] as const) {
      expect(await left(`SELECT 1 FROM ${t} WHERE app_id = $1`, oclc.appId), t).toBe(0);
    }
    expect(await left(`SELECT 1 FROM guide_version WHERE guide_id = $1`, oclc.guideId)).toBe(0);

    // ...Globex is untouched (every table still holds exactly its half)...
    const after = await rowCounts();
    for (const t of TABLES) expect(after[t], t).toBe(before[t] / 2);
    expect((await adminPool.query(`SELECT 1 FROM organization WHERE id = $1`, [globex.orgId])).rowCount).toBe(
      1,
    );

    // ...and the people still exist as Studio users (they may belong elsewhere).
    const people = await adminPool.query<{ oidc_sub: string }>(`SELECT oidc_sub FROM studio_user ORDER BY 1`);
    expect(people.rows.map((p) => p.oidc_sub)).toEqual(['manager', 'member', 'owner', 'rival', 'root']);

    // The owner's /me no longer lists it; the install snippet's key is dead.
    const me = await request(app).get('/v1/me').set('Authorization', as('owner'));
    expect(me.status).toBe(200);
    expect(me.body.orgs).toEqual([]);
    expect((await agent(oclc.key, '/guides', visitor())).status).toBe(404);
    expect((await agent(globex.key, '/guides', visitor())).status).toBe(200);
  });
});

describe('DELETE /v1/platform/orgs/:orgId (operators handling a deletion request)', () => {
  /** A logger writing JSON lines into memory, and an app using it. */
  function appWithLog() {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger(
      { NODE_ENV: 'test', LOG_LEVEL: 'info' },
      { write: (line) => void lines.push(JSON.parse(line)) },
    );
    return { logged: createApp({ logger }), lines };
  }
  const del = (api: typeof app, sub: string, orgId: string, confirmName: string) =>
    request(api).delete(`/v1/platform/orgs/${orgId}`).set('Authorization', as(sub)).send({ confirmName });

  it('is closed to everyone who is not a platform admin, including the owner', async () => {
    const oclc = await seedOrg();
    const before = await rowCounts();
    expect((await del(app, 'owner', oclc.orgId, 'OCLC Inc.')).status).toBe(403);
    expect((await del(app, 'manager', oclc.orgId, 'OCLC Inc.')).status).toBe(403);
    expect((await del(app, 'nobody', oclc.orgId, 'OCLC Inc.')).status).toBe(403);
    expect(await rowCounts()).toEqual(before);
  });

  it('needs the exact name, answers 404 for an unknown organization', async () => {
    const oclc = await seedOrg();
    const before = await rowCounts();
    const wrong = await del(app, 'root', oclc.orgId, 'OCLC');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('confirmation_mismatch');
    expect((await del(app, 'root', '00000000-0000-4000-8000-000000000000', 'x')).status).toBe(404);
    expect(await rowCounts()).toEqual(before);
  });

  it('deletes the organization like the owner would, and logs who did it at warn level', async () => {
    const oclc = await seedOrg();
    const globex = await seedOrg('rival', 'Globex');
    const { logged, lines } = appWithLog();
    const rootId = await userId('root');

    expect((await del(logged, 'root', oclc.orgId, 'OCLC Inc.')).status).toBe(204);

    expect((await adminPool.query(`SELECT 1 FROM organization WHERE id = $1`, [oclc.orgId])).rowCount).toBe(
      0,
    );
    expect(
      (await adminPool.query(`SELECT 1 FROM guide_event WHERE app_id = $1`, [oclc.appId])).rowCount,
    ).toBe(0);
    expect((await adminPool.query(`SELECT 1 FROM organization WHERE id = $1`, [globex.orgId])).rowCount).toBe(
      1,
    );
    expect((await request(app).get('/v1/me').set('Authorization', as('owner'))).body.orgs).toEqual([]);

    const audit = lines.find((l) => l.msg === 'organization deleted by platform admin');
    expect(audit).toMatchObject({
      level: 'warn',
      orgId: oclc.orgId,
      orgName: 'OCLC Inc.',
      adminUserId: rootId,
    });
  });
});

describe('DELETE /v1/apps/:appId', () => {
  const del = (sub: string, appId: string, confirmName: string) =>
    request(app).delete(`/v1/apps/${appId}`).set('Authorization', as(sub)).send({ confirmName });

  it('lets a manager delete the app with all its data; the org and its other apps stay', async () => {
    const oclc = await seedOrg();
    await addMember('owner', oclc.orgId, 'manager-2', 'manager');
    const second = await request(app)
      .post(`/v1/orgs/${oclc.orgId}/apps`)
      .set('Authorization', as('owner'))
      .send({ name: 'Second', websites: [] });
    const before = await rowCounts();

    expect((await del('manager-2', oclc.appId, 'oclc corp. app')).body.error).toBe('confirmation_mismatch');
    expect(await rowCounts()).toEqual(before);
    expect((await del('manager-2', oclc.appId, 'OCLC Inc. app')).status).toBe(204);

    for (const t of [
      'app_page',
      'guide',
      'guide_event',
      'user_guide_state',
      'agent_error',
    ] as const) {
      expect((await adminPool.query(`SELECT 1 FROM ${t} WHERE app_id = $1`, [oclc.appId])).rowCount, t).toBe(
        0,
      );
    }
    expect(
      (await adminPool.query(`SELECT 1 FROM guide_version WHERE guide_id = $1`, [oclc.guideId])).rowCount,
    ).toBe(0);
    const after = await rowCounts();
    expect(after.organization).toBe(1);
    expect(after.org_member).toBe(before.org_member);
    expect(after.invitation).toBe(before.invitation);
    expect(after.application).toBe(1);
    expect((await agent(oclc.key, '/guides', visitor())).status).toBe(404);
    const me = await request(app).get('/v1/me').set('Authorization', as('owner'));
    expect(me.body.orgs[0].apps).toEqual([{ id: second.body.id, name: 'Second', role: 'app_admin' }]);
  });

  it('is refused for lower roles and outsiders, and allowed for org admins', async () => {
    const oclc = await seedOrg();
    await signUp('rival', 'Globex');
    const before = await rowCounts();
    expect((await del('member', oclc.appId, 'OCLC Inc. app')).status).toBe(403); // editor
    expect((await del('rival', oclc.appId, 'OCLC Inc. app')).status).toBe(404);
    expect((await del('root', oclc.appId, 'OCLC Inc. app')).status).toBe(404);
    expect(await rowCounts()).toEqual(before);
    expect((await del('manager', oclc.appId, 'OCLC Inc. app')).status).toBe(204);
    expect((await adminPool.query(`SELECT 1 FROM application WHERE id = $1`, [oclc.appId])).rowCount).toBe(0);
    expect((await rowCounts()).application).toBe(1); // Globex's
  });
});
