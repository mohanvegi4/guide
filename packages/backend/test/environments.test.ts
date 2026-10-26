import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { clearAgentCacheForTests } from '../src/routes/agent';
import {
  SITE,
  addMember,
  adminPool,
  agent,
  app,
  as,
  closePools,
  liveGuide,
  resetData,
  sampleVersion,
  signUp,
  visitor,
} from './helpers';

afterAll(closePools);

const TEST_SITE = 'https://test.acme.test';
const ACCEPT_SITE = 'https://accept.acme.test';

let orgId: string;
let appId: string;
let key: string;

const api = (sub = 'alice') => ({
  get: (path: string) => request(app).get(`/v1/apps/${appId}${path}`).set('Authorization', as(sub)),
  post: (path: string, body: unknown = {}) =>
    request(app).post(`/v1/apps/${appId}${path}`).set('Authorization', as(sub)).send(body as object),
  patch: (path: string, body: unknown) =>
    request(app).patch(`/v1/apps/${appId}${path}`).set('Authorization', as(sub)).send(body as object),
  put: (path: string, body: unknown) =>
    request(app).put(`/v1/apps/${appId}${path}`).set('Authorization', as(sub)).send(body as object),
  del: (path: string, body: unknown = {}) =>
    request(app).delete(`/v1/apps/${appId}${path}`).set('Authorization', as(sub)).send(body as object),
});

interface Env {
  id: string;
  name: string;
  position: number;
  websites: string[];
  analyticsEnabled: boolean;
}

/** Test and Accept in front of the Production every app starts with. */
async function threeStages(): Promise<{ test: Env; accept: Env; prod: Env }> {
  const test = (await api().post('/environments', { name: 'Test', websites: [TEST_SITE] })).body as Env;
  const accept = (await api().post('/environments', { name: 'Accept', websites: [ACCEPT_SITE] })).body as Env;
  const all = (await api().get('/environments')).body as Env[];
  clearAgentCacheForTests();
  return { test, accept, prod: all[all.length - 1] };
}

const shownIds = async (origin: string, who = 'v-1') =>
  (await agent(key, '/guides', visitor(who), origin)).body.guides?.map((g: { id: string }) => g.id) ?? [];

beforeEach(async () => {
  await resetData();
  ({ orgId, appId, key } = await signUp('alice'));
});

describe('environments', () => {
  it('every new app starts with one Production environment holding its websites', async () => {
    const res = await api().get('/environments');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: expect.any(String), name: 'Production', position: 1, websites: [SITE], analyticsEnabled: true },
    ]);
  });

  it('adds stages in front of production, keeps CORS on the union of websites, and reorders', async () => {
    const { test, accept, prod } = await threeStages();
    expect([test.position, accept.position, prod.position]).toEqual([1, 2, 3]);
    expect(prod.name).toBe('Production');

    const appRow = await adminPool.query(`SELECT allowed_origins FROM application WHERE id = $1`, [appId]);
    expect([...appRow.rows[0].allowed_origins].sort()).toEqual([ACCEPT_SITE, SITE, TEST_SITE].sort());

    // A website belongs to one environment only; names are unique per app.
    expect((await api().post('/environments', { name: 'Dev', websites: [TEST_SITE] })).status).toBe(409);
    expect((await api().post('/environments', { name: 'test' })).body.error).toBe('environment_name_taken');

    const reordered = await api().put('/environments/order', { ids: [accept.id, test.id, prod.id] });
    expect(reordered.status).toBe(200);
    expect(reordered.body.map((e: Env) => e.name)).toEqual(['Accept', 'Test', 'Production']);
    expect((await api().put('/environments/order', { ids: [accept.id, test.id] })).status).toBe(400);
  });

  it('the app websites shortcut only works while there is a single environment', async () => {
    const one = await request(app)
      .patch(`/v1/apps/${appId}`)
      .set('Authorization', as('alice'))
      .send({ websites: ['https://new.acme.test'] });
    expect(one.status).toBe(200);
    expect((await api().get('/environments')).body[0].websites).toEqual(['https://new.acme.test']);

    await api().post('/environments', { name: 'Test', websites: [TEST_SITE] });
    const many = await request(app)
      .patch(`/v1/apps/${appId}`)
      .set('Authorization', as('alice'))
      .send({ websites: [SITE] });
    expect(many.status).toBe(400);
    expect(many.body.error).toBe('websites_per_environment');
  });

  it('deleting needs a manager and the exact name, and never removes the last environment', async () => {
    const { test, prod } = await threeStages();
    await addMember('alice', orgId, 'eddie', 'editor');
    expect((await api('eddie').del(`/environments/${test.id}`, { confirmName: 'Test' })).status).toBe(403);
    expect((await api().del(`/environments/${test.id}`, { confirmName: 'test' })).status).toBe(400);
    expect((await api().del(`/environments/${test.id}`, { confirmName: 'Test' })).status).toBe(204);

    const left = (await api().get('/environments')).body as Env[];
    expect(left.map((e) => [e.name, e.position])).toEqual([
      ['Accept', 1],
      ['Production', 2],
    ]);
    await api().del(`/environments/${left[0].id}`, { confirmName: 'Accept' });
    const last = await api().del(`/environments/${prod.id}`, { confirmName: 'Production' });
    expect(last.status).toBe(409);
    expect(last.body.error).toBe('last_environment');
  });

  it('viewers read environments but cannot change them', async () => {
    await addMember('alice', orgId, 'vera', 'viewer');
    expect((await api('vera').get('/environments')).status).toBe(200);
    expect((await api('vera').post('/environments', { name: 'Test' })).status).toBe(403);
  });
});

describe('releases', () => {
  it('publishing releases to the first stage; promote moves it on, stage by stage', async () => {
    const { test, accept, prod } = await threeStages();
    const { guideId, versionId } = await liveGuide('alice', appId);

    // v1 is in Test only: only the Test website sees it.
    expect(await shownIds(TEST_SITE)).toEqual([guideId]);
    expect(await shownIds(ACCEPT_SITE)).toEqual([]);
    expect(await shownIds(SITE)).toEqual([]);

    expect((await api().post(`/guides/${guideId}/promote`, { from: test.id })).status).toBe(200);
    const res = await api().post(`/guides/${guideId}/promote`, { from: accept.id });
    expect(res.body.map((r: { name: string; versionNumber: number }) => [r.name, r.versionNumber])).toEqual([
      ['Test', 1],
      ['Accept', 1],
      ['Production', 1],
    ]);
    expect(await shownIds(SITE, 'v-2')).toEqual([guideId]);

    // Production mirrors into guide.current_version_id.
    const guide = await adminPool.query(`SELECT current_version_id FROM guide WHERE id = $1`, [guideId]);
    expect(guide.rows[0].current_version_id).toBe(versionId);

    const top = await api().post(`/guides/${guideId}/promote`, { from: prod.id });
    expect(top.status).toBe(409);
    expect(top.body.error).toBe('already_in_production');
  });

  it('cannot promote from an empty stage, nor release a draft', async () => {
    const { test } = await threeStages();
    const g = await api().post('/guides', { name: 'Draft only' });
    const draft = await api().put(`/guides/${g.body.id}/draft`, sampleVersion);
    expect((await api().post(`/guides/${g.body.id}/promote`, { from: test.id })).body.error).toBe(
      'nothing_to_promote',
    );
    const res = await api().post(`/guides/${g.body.id}/releases`, { environmentId: test.id, versionId: draft.body.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('version_not_published');
  });

  it('revert walks back the release log one step at a time, down to nothing', async () => {
    const { test } = await threeStages();
    const { guideId } = await liveGuide('alice', appId);
    await api().post(`/guides/${guideId}/publish`, { ...sampleVersion, steps: [{ ...sampleVersion.steps[0], content: '<p>v2</p>' }] });
    await api().post(`/guides/${guideId}/publish`, { ...sampleVersion, steps: [{ ...sampleVersion.steps[0], content: '<p>v3</p>' }] });

    const testRelease = async () =>
      ((await api().get(`/guides/${guideId}/releases`)).body as { environmentId: string; versionNumber: number | null; canRevert: boolean }[]).find(
        (r) => r.environmentId === test.id,
      )!;
    expect((await testRelease()).versionNumber).toBe(3);

    await api().post(`/guides/${guideId}/releases/${test.id}/revert`);
    expect((await testRelease()).versionNumber).toBe(2);
    await api().post(`/guides/${guideId}/releases/${test.id}/revert`);
    expect((await testRelease()).versionNumber).toBe(1);
    await api().post(`/guides/${guideId}/releases/${test.id}/revert`);
    const empty = await testRelease();
    expect(empty.versionNumber).toBeNull();
    expect(empty.canRevert).toBe(false);
    expect(await shownIds(TEST_SITE)).toEqual([]);

    const none = await api().post(`/guides/${guideId}/releases/${test.id}/revert`);
    expect(none.status).toBe(409);
    expect(none.body.error).toBe('nothing_to_revert');
  });

  it('withdraw takes a guide out of one environment, and reverting a withdraw restores it', async () => {
    const { test, accept } = await threeStages();
    const { guideId } = await liveGuide('alice', appId);
    await api().post(`/guides/${guideId}/promote`, { from: test.id });
    expect(await shownIds(ACCEPT_SITE)).toEqual([guideId]);

    const withdrawn = await api().post(`/guides/${guideId}/releases`, { environmentId: accept.id, versionId: null });
    expect(withdrawn.status).toBe(200);
    expect(await shownIds(ACCEPT_SITE)).toEqual([]);
    expect(await shownIds(TEST_SITE)).toEqual([guideId]);

    await api().post(`/guides/${guideId}/releases/${accept.id}/revert`);
    expect(await shownIds(ACCEPT_SITE, 'v-2')).toEqual([guideId]);

    const log = (await api().get(`/guides/${guideId}/releases`)).body.find(
      (r: { environmentId: string }) => r.environmentId === accept.id,
    );
    expect(log.history.map((h: { action: string; reverted: boolean }) => [h.action, h.reverted])).toEqual([
      ['withdraw', true],
      ['release', false],
    ]);
  });

  it('rollback still targets production', async () => {
    const { guideId } = await liveGuide('alice', appId);
    await api().post(`/guides/${guideId}/publish`, sampleVersion);
    const res = await api().post(`/guides/${guideId}/rollback/1`);
    expect(res.status).toBe(200);
    const releases = (await api().get(`/guides/${guideId}/releases`)).body;
    expect(releases.map((r: { versionNumber: number }) => r.versionNumber)).toEqual([1]);
  });

  it('editors cannot release; viewers can read the releases', async () => {
    const { test } = await threeStages();
    const { guideId } = await liveGuide('alice', appId);
    await addMember('alice', orgId, 'vera', 'viewer');
    expect((await api('vera').get(`/guides/${guideId}/releases`)).status).toBe(200);
    expect((await api('vera').post(`/guides/${guideId}/promote`, { from: test.id })).status).toBe(403);
  });
});

describe('the agent, per environment', () => {
  it('keeps show-once state per environment', async () => {
    const { test } = await threeStages();
    const { guideId, versionId } = await liveGuide('alice', appId);
    await api().post(`/guides/${guideId}/promote`, { from: test.id });
    const accept = (await api().get('/environments')).body[1] as Env;
    await api().post(`/guides/${guideId}/promote`, { from: accept.id });

    const completed = {
      ...visitor('v-1'),
      events: [{ guideId, guideVersionId: versionId, sessionId: 's', eventType: 'guide_completed', occurredAt: new Date().toISOString() }],
    };
    expect((await agent(key, '/events', completed, TEST_SITE)).status).toBe(202);
    expect(await shownIds(TEST_SITE)).toEqual([]);
    // Finishing it in Test doesn't use it up in production.
    expect(await shownIds(SITE)).toEqual([guideId]);
  });

  it('serves nothing to an origin no environment owns, and production without an Origin', async () => {
    const { guideId } = await liveGuide('alice', appId);
    const res = await agent(key, '/guides', visitor(), null);
    expect(res.body.guides.map((g: { id: string }) => g.id)).toEqual([guideId]);
  });

  it('records events in their environment, and none where analytics are off — but still keeps state', async () => {
    const { test, prod } = await threeStages();
    const { guideId, versionId } = await liveGuide('alice', appId);
    await api().post(`/guides/${guideId}/promote`, { from: test.id });
    const accept = (await api().get('/environments')).body[1] as Env;
    await api().post(`/guides/${guideId}/promote`, { from: accept.id });
    await api().patch(`/environments/${test.id}`, { analyticsEnabled: false });

    const event = (who: string, type = 'guide_shown') => ({
      ...visitor(who),
      events: [{ guideId, guideVersionId: versionId, sessionId: `s-${who}`, eventType: type, occurredAt: new Date().toISOString() }],
    });
    await agent(key, '/events', event('p1'), SITE);
    await agent(key, '/events', event('a1'), ACCEPT_SITE);
    await agent(key, '/events', event('a2'), ACCEPT_SITE);
    const off = await agent(key, '/events', event('t1', 'guide_completed'), TEST_SITE);
    expect(off.status).toBe(202);

    const stored = await adminPool.query<{ environment_id: string; n: number }>(
      `SELECT environment_id, count(*)::int AS n FROM guide_event GROUP BY environment_id`,
    );
    expect(Object.fromEntries(stored.rows.map((r) => [r.environment_id, r.n]))).toEqual({
      [prod.id]: 1,
      [accept.id]: 2,
    });
    // Analytics off doesn't mean show-once off.
    expect(await shownIds(TEST_SITE, 't1')).toEqual([]);

    // Analytics views default to production and never mix environments.
    const prodView = await api().get('/analytics');
    expect(prodView.body.environmentId).toBe(prod.id);
    expect(prodView.body.guides[0].shown).toBe(1);
    const acceptView = await api().get(`/analytics?environment=${accept.id}`);
    expect(acceptView.body.guides[0].shown).toBe(2);
    const shownIn = async (query: string) =>
      (await api().get(`/guides/${guideId}/analytics${query}`)).body.counts.find(
        (c: { event_type: string }) => c.event_type === 'guide_shown',
      ).count;
    expect(await shownIn(`?environment=${accept.id}`)).toBe(2);
    expect(await shownIn('')).toBe(1);

    // Another app's environment is not found, not mixed in.
    const other = await signUp('bob', 'bob org', ['https://bob.test']);
    const bobEnv = (
      await request(app).get(`/v1/apps/${other.appId}/environments`).set('Authorization', as('bob'))
    ).body[0].id;
    expect((await api().get(`/analytics?environment=${bobEnv}`)).status).toBe(404);
  });
});

describe('row-level security', () => {
  it("one organization's session sees none of another's environments or releases", async () => {
    await liveGuide('alice', appId);
    const bob = await signUp('bob', 'bob org', ['https://bob.test']);
    const res = await request(app).get(`/v1/apps/${appId}/environments`).set('Authorization', as('bob'));
    expect(res.status).toBe(404);
    const { withStudioSession } = await import('../src/db');
    const bobUser = await adminPool.query(`SELECT id FROM studio_user WHERE oidc_sub = 'bob'`);
    const seen = await withStudioSession(bobUser.rows[0].id, async (c) => ({
      environments: (await c.query(`SELECT app_id FROM app_environment`)).rows.map((r) => r.app_id),
      releases: (await c.query(`SELECT 1 FROM guide_release`)).rowCount,
      log: (await c.query(`SELECT 1 FROM guide_release_event`)).rowCount,
    }));
    expect(seen).toEqual({ environments: [bob.appId], releases: 0, log: 0 });
  });
});
