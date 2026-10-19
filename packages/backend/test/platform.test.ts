import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminPool, agent, app, as, closePools, liveGuide, resetData, signUp, visitor } from './helpers';
import { withPlatformSession } from '../src/db';

afterAll(closePools);
beforeEach(resetData);

/** Makes `sub` a platform admin the way the first one is made in real life: SQL by the DB owner. */
async function makePlatformAdmin(sub: string): Promise<string> {
  await request(app).get('/v1/me').set('Authorization', as(sub)); // provisions the user
  const r = await adminPool.query(
    `UPDATE studio_user SET platform_admin = TRUE WHERE oidc_sub = $1 RETURNING id`,
    [sub],
  );
  return r.rows[0].id;
}

const platform = (sub: string) => ({
  get: (path: string) => request(app).get(`/v1/platform${path}`).set('Authorization', as(sub)),
  put: (path: string, body: unknown) =>
    request(app).put(`/v1/platform${path}`).set('Authorization', as(sub)).send(body),
  patch: (path: string, body: unknown) =>
    request(app).patch(`/v1/platform${path}`).set('Authorization', as(sub)).send(body),
});

/** A Studio request made by a platform admin under an organization's support access. */
const asSupport = (sub: string, orgId: string, method: 'get' | 'put' | 'post', path: string) =>
  request(app)[method](`/v1${path}`).set('Authorization', as(sub)).set('X-Support-Org', orgId);

describe('platform admins (service administration)', () => {
  it('is closed to everyone else, including org owners', async () => {
    await signUp('alice');
    expect((await platform('alice').get('/orgs')).status).toBe(403);
    expect((await platform('alice').get('/kill-switch')).status).toBe(403);
    expect((await platform('nobody').get('/orgs')).status).toBe(403);
    const me = await request(app).get('/v1/me').set('Authorization', as('alice'));
    expect(me.body.user.platformAdmin).toBe(false);
  });

  it('lists every organization with owners and usage, and one organization with its apps', async () => {
    const alice = await signUp('alice', 'Acme');
    const bob = await signUp('bob', 'Globex');
    await liveGuide('alice', alice.appId);
    await agent(alice.key, '/events', {
      ...visitor(),
      events: [
        {
          guideId: (await adminPool.query(`SELECT id FROM guide`)).rows[0].id,
          guideVersionId: (await adminPool.query(`SELECT id FROM guide_version`)).rows[0].id,
          sessionId: 's',
          eventType: 'guide_shown',
          occurredAt: new Date().toISOString(),
        },
      ],
    });
    await makePlatformAdmin('root');

    expect((await request(app).get('/v1/me').set('Authorization', as('root'))).body.user.platformAdmin).toBe(
      true,
    );
    const list = await platform('root').get('/orgs');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      {
        id: alice.orgId,
        name: 'Acme',
        createdAt: expect.any(String),
        suspendedAt: null,
        supportAccessUntil: null,
        owners: [{ name: 'alice', email: 'alice@example.com' }],
        usage: { members: 1, apps: 1, guides: 1, events30d: 1 },
      },
      {
        id: bob.orgId,
        name: 'Globex',
        createdAt: expect.any(String),
        suspendedAt: null,
        supportAccessUntil: null,
        owners: [{ name: 'bob', email: 'bob@example.com' }],
        usage: { members: 1, apps: 1, guides: 0, events30d: 0 },
      },
    ]);

    const one = await platform('root').get(`/orgs/${alice.orgId}`);
    expect(one.body.apps).toEqual([
      {
        id: alice.appId,
        name: 'Acme app',
        publicKey: alice.key,
        enabled: true,
        websites: ['https://app.acme.test'],
        createdAt: expect.any(String),
        usage: { guides: 1, events30d: 1 },
      },
    ]);
  });

  it('never exposes guide content: the platform session cannot read versions or pages', async () => {
    const { appId } = await signUp('alice');
    await liveGuide('alice', appId);
    const rootId = await makePlatformAdmin('root');
    const seen = await withPlatformSession(rootId, async (client) => ({
      guides: (await client.query(`SELECT id FROM guide`)).rowCount,
      versions: (await client.query(`SELECT id FROM guide_version`)).rowCount,
      pages: (await client.query(`SELECT id FROM app_page`)).rowCount,
    }));
    expect(seen).toEqual({ guides: 1, versions: 0, pages: 0 });
  });

  it('suspends an organization: its apps serve nothing, members see it on /me, new apps inherit it', async () => {
    const { orgId, appId, key } = await signUp('alice');
    await liveGuide('alice', appId);
    await makePlatformAdmin('root');
    expect((await agent(key, '/guides', visitor())).body.enabled).toBe(true);

    const off = await platform('root').put(`/orgs/${orgId}/suspension`, { suspended: true });
    expect(off.status).toBe(200);
    expect(off.body.suspendedAt).toEqual(expect.any(String));
    expect((await agent(key, '/guides', visitor())).body).toEqual({ enabled: false, guides: [] });
    expect((await agent(key, '/help', visitor())).body.enabled).toBe(false);
    const me = await request(app).get('/v1/me').set('Authorization', as('alice'));
    expect(me.body.orgs[0].suspendedAt).toEqual(expect.any(String));

    const created = await request(app)
      .post(`/v1/orgs/${orgId}/apps`)
      .set('Authorization', as('alice'))
      .send({ name: 'Second', websites: [] });
    expect(created.body.suspended_at).toEqual(expect.any(String));

    await platform('root').put(`/orgs/${orgId}/suspension`, { suspended: false });
    expect((await agent(key, '/guides', visitor())).body.enabled).toBe(true);
    expect(
      (await request(app).get(`/v1/apps/${created.body.id}`).set('Authorization', as('alice'))).body
        .suspended_at,
    ).toBeNull();
  });

  it('disables one app, and flips the global kill switch', async () => {
    const { appId, key } = await signUp('alice');
    await liveGuide('alice', appId);
    await makePlatformAdmin('root');

    expect((await platform('root').patch(`/apps/${appId}`, { enabled: false })).body).toEqual({
      id: appId,
      enabled: false,
    });
    expect((await agent(key, '/guides', visitor())).body.enabled).toBe(false);
    await platform('root').patch(`/apps/${appId}`, { enabled: true });

    expect((await platform('root').get('/kill-switch')).body).toEqual({ enabled: true });
    await platform('root').put('/kill-switch', { enabled: false });
    expect((await agent(key, '/guides', visitor())).body.enabled).toBe(false);
    await platform('root').put('/kill-switch', { enabled: true });
    expect((await agent(key, '/guides', visitor())).body.enabled).toBe(true);
  });

  it('grants and revokes the flag by email, never for yourself, only for people who have signed in', async () => {
    await makePlatformAdmin('root');
    await request(app).get('/v1/me').set('Authorization', as('sam')); // sam exists now

    expect(
      (await platform('root').put('/admins', { email: 'ghost@example.com', platformAdmin: true })).body.error,
    ).toBe('unknown_user');
    expect(
      (await platform('root').put('/admins', { email: 'SAM@example.com', platformAdmin: true })).status,
    ).toBe(200);
    expect((await platform('sam').get('/orgs')).status).toBe(200);
    expect((await platform('root').get('/admins')).body.map((a: { email: string }) => a.email)).toEqual([
      'root@example.com',
      'sam@example.com',
    ]);
    expect(
      (await platform('root').put('/admins', { email: 'root@example.com', platformAdmin: false })).body.error,
    ).toBe('cannot_revoke_self');
    await platform('sam').put('/admins', { email: 'root@example.com', platformAdmin: false });
    expect((await platform('root').get('/orgs')).status).toBe(403);
  });
});

describe('support access (customer-granted, time-boxed, read-only, logged)', () => {
  it('is off by default: a platform admin cannot read an organization', async () => {
    const { orgId, appId } = await signUp('alice');
    await makePlatformAdmin('root');
    expect((await asSupport('root', orgId, 'get', `/apps/${appId}/guides`)).status).toBe(404);
    expect((await asSupport('root', orgId, 'get', '/support-context')).status).toBe(404);
    // And the header does nothing for anyone who isn't a platform admin.
    await signUp('bob');
    expect((await asSupport('bob', orgId, 'get', `/apps/${appId}/guides`)).status).toBe(404);
  });

  it('owners grant it for up to 90 days; admins can see the window and the log; members cannot', async () => {
    const { orgId } = await signUp('alice');
    const grant = (sub: string, days: number) =>
      request(app).put(`/v1/orgs/${orgId}/support-access`).set('Authorization', as(sub)).send({ days });
    expect((await grant('alice', 0)).status).toBe(400);
    expect((await grant('alice', 91)).status).toBe(400);
    const granted = await grant('alice', 7);
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({
      active: true,
      maxDays: 90,
      grantedBy: { email: 'alice@example.com' },
      log: [],
    });
    const until = new Date(granted.body.until).getTime();
    expect(until).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);
    expect(until).toBeLessThan(Date.now() + 7.1 * 86_400_000);

    const { addMember } = await import('./helpers');
    await addMember('alice', orgId, 'adam', 'admin');
    await addMember('alice', orgId, 'mel', 'member');
    expect(
      (await request(app).get(`/v1/orgs/${orgId}/support-access`).set('Authorization', as('adam'))).status,
    ).toBe(200);
    expect((await grant('adam', 7)).status).toBe(403); // admins can look, only owners open the door
    expect(
      (await request(app).get(`/v1/orgs/${orgId}/support-access`).set('Authorization', as('mel'))).status,
    ).toBe(403);
  });

  it('while open: a platform admin reads like a viewer, cannot write (role and database), and every call is logged', async () => {
    const { orgId, appId } = await signUp('alice');
    const g = await liveGuide('alice', appId);
    await request(app)
      .put(`/v1/orgs/${orgId}/support-access`)
      .set('Authorization', as('alice'))
      .send({ days: 1 });
    await makePlatformAdmin('root');

    const context = await asSupport('root', orgId, 'get', '/support-context');
    expect(context.body).toMatchObject({
      id: orgId,
      role: 'member',
      apps: [{ id: appId, role: 'viewer' }],
      supportAccessUntil: expect.any(String),
    });
    const guides = await asSupport('root', orgId, 'get', `/apps/${appId}/guides`);
    expect(guides.status).toBe(200);
    expect(guides.body.map((x: { id: string }) => x.id)).toEqual([g.guideId]);
    expect(
      (await asSupport('root', orgId, 'get', `/apps/${appId}/guides/${g.guideId}`)).body.versions,
    ).toHaveLength(1);
    expect(
      (await asSupport('root', orgId, 'get', `/apps/${appId}/guides/${g.guideId}/analytics`)).status,
    ).toBe(200);
    expect((await asSupport('root', orgId, 'get', `/orgs/${orgId}/members`)).status).toBe(200);

    // Writes: the viewer role says no (403), and so would Postgres (READ ONLY transaction).
    const write = await asSupport('root', orgId, 'put', `/apps/${appId}/guides/${g.guideId}/draft`).send({
      steps: [{ order: 0, type: 'tooltip', content: '<p>x</p>', actions: [] }],
      routeMatch: { type: 'exact', value: '/x' },
    });
    expect(write.status).toBe(403);
    expect(
      (await asSupport('root', orgId, 'post', `/orgs/${orgId}/apps`).send({ name: 'X', websites: [] }))
        .status,
    ).toBe(403);

    const status = await request(app)
      .get(`/v1/orgs/${orgId}/support-access`)
      .set('Authorization', as('alice'));
    const paths = status.body.log.map((l: { method: string; path: string }) => `${l.method} ${l.path}`);
    expect(paths).toContain(`GET /v1/apps/${appId}/guides`);
    expect(paths).toContain(`PUT /v1/apps/${appId}/guides/${g.guideId}/draft`);
    expect(status.body.log[0].admin.email).toBe('root@example.com');
    // Other organizations stay closed.
    const other = await signUp('bob');
    expect((await asSupport('root', other.orgId, 'get', `/apps/${other.appId}/guides`)).status).toBe(404);
  });

  it('closes when revoked, when it expires, and while the organization is suspended', async () => {
    const { orgId, appId } = await signUp('alice');
    await makePlatformAdmin('root');
    const guides = () => asSupport('root', orgId, 'get', `/apps/${appId}/guides`);
    const open = () =>
      request(app)
        .put(`/v1/orgs/${orgId}/support-access`)
        .set('Authorization', as('alice'))
        .send({ days: 3 });

    await open();
    expect((await guides()).status).toBe(200);
    const revoked = await request(app)
      .delete(`/v1/orgs/${orgId}/support-access`)
      .set('Authorization', as('alice'));
    expect(revoked.body.active).toBe(false);
    expect((await guides()).status).toBe(404);

    await open();
    await adminPool.query(
      `UPDATE organization SET support_access_until = now() - interval '1 minute' WHERE id = $1`,
      [orgId],
    );
    expect((await guides()).status).toBe(404);
    expect((await platform('root').get('/orgs')).body[0].supportAccessUntil).toBeNull();

    await open();
    await platform('root').put(`/orgs/${orgId}/suspension`, { suspended: true });
    expect((await guides()).status).toBe(404);
  });
});
