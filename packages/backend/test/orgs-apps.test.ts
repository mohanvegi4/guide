import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addMember, adminPool, app, as, closePools, resetData, sampleVersion, signUp, SITE } from './helpers';

afterAll(closePools);
beforeEach(resetData);

describe('self-serve organizations', () => {
  it('creates an org (caller = owner) with its first app and a public key', async () => {
    const res = await request(app)
      .post('/v1/orgs')
      .set('Authorization', as('alice'))
      .send({
        name: 'Acme',
        app: { name: 'Web app', websites: ['https://app.acme.test/some/path', 'http://localhost:4200'] },
      });
    expect(res.status).toBe(201);
    expect(res.body.org).toMatchObject({ name: 'Acme', role: 'owner' });
    expect(res.body.app).toMatchObject({
      name: 'Web app',
      enabled: true,
      identity_mode: 'optional',
      has_signing_secret: false,
      // normalized to bare origins
      allowed_origins: ['https://app.acme.test', 'http://localhost:4200'],
    });
    expect(res.body.app.public_key).toMatch(/^ge_pk_[0-9a-f]{32}$/);

    const me = await request(app).get('/v1/me').set('Authorization', as('alice'));
    expect(me.body.orgs).toEqual([
      {
        id: res.body.org.id,
        name: 'Acme',
        role: 'owner',
        suspendedAt: null,
        apps: [{ id: res.body.app.id, name: 'Web app', role: 'app_admin' }],
      },
    ]);
  });

  it('rejects non-http(s) websites', async () => {
    const res = await request(app)
      .post('/v1/orgs')
      .set('Authorization', as('alice'))
      .send({ name: 'Acme', app: { name: 'x', websites: ['javascript:alert(1)'] } });
    expect(res.status).toBe(400);
  });

  it('lets one admin manage several apps in one org', async () => {
    const { orgId } = await signUp('alice');
    const second = await request(app)
      .post(`/v1/orgs/${orgId}/apps`)
      .set('Authorization', as('alice'))
      .send({ name: 'Admin console', websites: ['https://admin.acme.test'] });
    expect(second.status).toBe(201);
    const list = await request(app).get(`/v1/orgs/${orgId}/apps`).set('Authorization', as('alice'));
    expect(list.body.map((a: { name: string }) => a.name)).toEqual(['Admin console', 'alice org app']);
  });
});

describe('app settings', () => {
  it('rotates the public key', async () => {
    const { appId, key } = await signUp('alice');
    const res = await request(app).post(`/v1/apps/${appId}/rotate-key`).set('Authorization', as('alice'));
    expect(res.body.public_key).toMatch(/^ge_pk_/);
    expect(res.body.public_key).not.toBe(key);
    // the install snippet always carries the current key and the agent URL
    expect(res.body.snippet).toContain(`'${res.body.public_key}'`);
    expect(res.body.snippet).toContain('/agent/v1/');
    const fetched = await request(app).get(`/v1/apps/${appId}`).set('Authorization', as('alice'));
    expect(fetched.body.snippet).toContain(res.body.public_key);
  });

  it('returns a signing secret once, and only "has secret" afterwards', async () => {
    const { appId } = await signUp('alice');
    const created = await request(app)
      .post(`/v1/apps/${appId}/signing-secret`)
      .set('Authorization', as('alice'));
    expect(created.body.secret).toMatch(/^ge_sk_/);
    const fetched = await request(app).get(`/v1/apps/${appId}`).set('Authorization', as('alice'));
    expect(fetched.body.has_signing_secret).toBe(true);
    expect(JSON.stringify(fetched.body)).not.toContain(created.body.secret);
  });

  it('refuses "require signed identity" until a signing secret exists', async () => {
    const { appId } = await signUp('alice');
    const early = await request(app)
      .patch(`/v1/apps/${appId}`)
      .set('Authorization', as('alice'))
      .send({ identityMode: 'required' });
    expect(early.status).toBe(400);
    expect(early.body.error).toBe('signing_secret_required');
    await request(app).post(`/v1/apps/${appId}/signing-secret`).set('Authorization', as('alice'));
    const later = await request(app)
      .patch(`/v1/apps/${appId}`)
      .set('Authorization', as('alice'))
      .send({ identityMode: 'required' });
    expect(later.body.identity_mode).toBe('required');
  });

  it('updates websites and the app switch', async () => {
    const { appId } = await signUp('alice');
    const res = await request(app)
      .patch(`/v1/apps/${appId}`)
      .set('Authorization', as('alice'))
      .send({ websites: [SITE, 'https://beta.acme.test/x'], enabled: false });
    expect(res.body).toMatchObject({ allowed_origins: [SITE, 'https://beta.acme.test'], enabled: false });
  });
});

describe('roles', () => {
  // Each person below is an org MEMBER with one role on the app, except the
  // org admin, who manages every app in the org.
  const people = ['viewer', 'editor', 'publisher', 'app_admin'] as const;
  let ctx: { orgId: string; appId: string; guideId: string };

  beforeEach(async () => {
    const { orgId, appId } = await signUp('owner');
    for (const role of people) await addMember('owner', orgId, role, 'member', { [appId]: role });
    await addMember('owner', orgId, 'orgadmin', 'admin');
    await addMember('owner', orgId, 'outsider', 'member'); // in the org, no app grant
    const g = await request(app)
      .post(`/v1/apps/${appId}/guides`)
      .set('Authorization', as('owner'))
      .send({ name: 'G', type: 'modal' });
    ctx = { orgId, appId, guideId: g.body.id };
  });

  const status = async (sub: string, method: 'get' | 'post' | 'put' | 'patch', path: string, body?: object) =>
    (await request(app)[method](path).set('Authorization', as(sub)).send(body)).status;

  it.each([
    // [who,       read, draft, publish, settings]
    ['viewer', 200, 403, 403, 403],
    ['editor', 200, 200, 403, 403],
    ['publisher', 200, 200, 201, 403],
    ['app_admin', 200, 200, 201, 200],
    ['orgadmin', 200, 200, 201, 200],
    ['outsider', 404, 404, 404, 404],
  ])('%s', async (who, read, draft, publish, settings) => {
    const base = `/v1/apps/${ctx.appId}/guides/${ctx.guideId}`;
    expect(await status(who, 'get', base)).toBe(read);
    expect(await status(who, 'put', `${base}/draft`, sampleVersion)).toBe(draft);
    expect(await status(who, 'post', `${base}/publish`, sampleVersion)).toBe(publish);
    expect(await status(who, 'patch', `/v1/apps/${ctx.appId}`, { name: 'Renamed' })).toBe(settings);
  });

  it('only org admins create apps and see every app', async () => {
    expect(await status('app_admin', 'post', `/v1/orgs/${ctx.orgId}/apps`, { name: 'x', websites: [] })).toBe(
      403,
    );
    const created = await request(app)
      .post(`/v1/orgs/${ctx.orgId}/apps`)
      .set('Authorization', as('orgadmin'))
      .send({ name: 'Second', websites: [] });
    expect(created.status).toBe(201);
    // members only see apps they were granted
    const viewerApps = await request(app)
      .get(`/v1/orgs/${ctx.orgId}/apps`)
      .set('Authorization', as('viewer'));
    expect(viewerApps.body.map((a: { name: string }) => a.name)).toEqual(['owner org app']);
    const adminApps = await request(app)
      .get(`/v1/orgs/${ctx.orgId}/apps`)
      .set('Authorization', as('orgadmin'));
    expect(adminApps.body).toHaveLength(2);
  });

  it('keeps raw rows consistent: one owner, grants per app', async () => {
    const rows = await adminPool.query(
      `SELECT role, count(*)::int AS n FROM org_member GROUP BY role ORDER BY role`,
    );
    expect(rows.rows).toEqual([
      { role: 'owner', n: 1 },
      { role: 'admin', n: 1 },
      { role: 'member', n: 5 },
    ]);
  });
});
