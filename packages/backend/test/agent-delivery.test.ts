import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'crypto';
import {
  addMember,
  adminPool,
  agent,
  app,
  as,
  closePools,
  resetData,
  signUp,
  SITE,
  visitor,
} from './helpers';
import { describeBundle } from '../src/routes/agent';
import { withAgentSession, withStudioSession } from '../src/db';

/**
 * Serving the agent script at scale (caching, rollbacks, a version check)
 * and agent-side error reporting. The script under test is the fixture
 * test/fixtures/agent-bundle.js, whose banner names version 0.0.0-test.
 */

afterAll(closePools);
beforeEach(resetData);

const FIXTURE_CODE = 'window.__guideEngineTestBundle = true;\n';
const FIXTURE_HASH = createHash('sha256').update(FIXTURE_CODE).digest('hex').slice(0, 16);

describe('the agent script: ETag and revalidation', () => {
  it('carries a strong ETag made from the content hash, and CDN-friendly cache headers', async () => {
    const { key } = await signUp('alice');
    const res = await request(app).get(`/agent/v1/${key}/guides.js`);
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBe(`"${FIXTURE_HASH}"`);
    expect(res.headers['cache-control']).toBe(
      'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
    );
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.text.startsWith(`/* guide-engine agent 0.0.0-test ${FIXTURE_HASH} */`)).toBe(true);
  });

  it('answers If-None-Match with 304 (strong or weak form, in a list), and a stale tag with the file', async () => {
    const { key } = await signUp('alice');
    const url = `/agent/v1/${key}/guides.js`;
    for (const tag of [`"${FIXTURE_HASH}"`, `W/"${FIXTURE_HASH}"`, `"other", "${FIXTURE_HASH}"`]) {
      const res = await request(app).get(url).set('If-None-Match', tag);
      expect(res.status, tag).toBe(304);
      expect(res.text ?? '').toBe('');
      // The 304 refreshes the cached copy's lifetime too.
      expect(res.headers['cache-control']).toContain('max-age=300');
      expect(res.headers['etag']).toBe(`"${FIXTURE_HASH}"`);
    }
    const stale = await request(app).get(url).set('If-None-Match', '"0123456789abcdef"');
    expect(stale.status).toBe(200);
    expect(stale.text).toContain('__guideEngineTestBundle');
  });

  it('describes a bundle from its banner, or from the whole file when there is none', () => {
    const banner = `/* guide-engine agent 1.2.3 ${'0'.repeat(16)} */\n`;
    expect(describeBundle(banner + FIXTURE_CODE)).toMatchObject({ version: '1.2.3', hash: FIXTURE_HASH });
    expect(describeBundle(FIXTURE_CODE)).toMatchObject({
      version: 'unknown',
      hash: createHash('sha256').update(FIXTURE_CODE).digest('hex').slice(0, 16),
    });
    // The hash is recomputed from the code, never trusted from the banner.
    expect(describeBundle(banner + FIXTURE_CODE).hash).not.toBe('0'.repeat(16));
  });
});

describe('GET /agent/v1/version', () => {
  it('reports the served build without a key, uncached', async () => {
    const res = await request(app).get('/agent/v1/version');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '0.0.0-test', hash: FIXTURE_HASH });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /v1/agent/:key/errors', () => {
  const report = {
    message: 'render: Cannot read properties of null',
    stack: 'TypeError: Cannot read properties of null\n    at renderStep (guides.js:1:2)',
    url: 'https://app.acme.test/dashboard?tab=1',
    agentVersion: '0.1.0',
  };

  it('stores a report for the app, as text', async () => {
    const { key, appId } = await signUp('alice');
    const res = await agent(key, '/errors', { ...visitor(), ...report });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect(res.headers['access-control-allow-origin']).toBe(SITE);

    const rows = await adminPool.query(
      `SELECT app_id, message, stack, agent_version, url, occurred_at FROM agent_error`,
    );
    expect(rows.rows).toEqual([
      {
        app_id: appId,
        message: report.message,
        stack: report.stack,
        agent_version: report.agentVersion,
        url: report.url,
        occurred_at: expect.any(Date),
      },
    ]);
  });

  it('needs only a message; the rest is optional', async () => {
    const { key } = await signUp('alice');
    expect((await agent(key, '/errors', { message: 'init: boom' })).body).toEqual({ accepted: true });
    const row = (await adminPool.query(`SELECT stack, agent_version, url FROM agent_error`)).rows[0];
    expect(row).toEqual({ stack: null, agent_version: null, url: null });
  });

  it('rejects malformed reports', async () => {
    const { key } = await signUp('alice');
    for (const body of [
      {},
      { message: '' },
      { message: 'x'.repeat(501) },
      { message: 'ok', stack: 'x'.repeat(4001) },
      { message: 'ok', url: 'x'.repeat(2001) },
      { message: 42 },
    ]) {
      const res = await agent(key, '/errors', body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect((await adminPool.query(`SELECT COUNT(*)::int AS n FROM agent_error`)).rows[0].n).toBe(0);
  });

  it('applies the same key and website checks as every agent route', async () => {
    const { key } = await signUp('alice');
    expect((await agent(key, '/errors', report, 'https://evil.test')).status).toBe(403);
    expect((await agent('ge_pk_' + '0'.repeat(32), '/errors', report)).status).toBe(404);
  });

  it('acknowledges but drops reports once an app has 1000 in the last hour', async () => {
    const { key, appId } = await signUp('alice');
    const other = await signUp('bob', 'bob org', [SITE]);
    await adminPool.query(
      `INSERT INTO agent_error (app_id, message, occurred_at)
       SELECT $1, 'flood ' || i, now() - (i || ' seconds')::interval FROM generate_series(1, 999) AS i`,
      [appId],
    );
    expect((await agent(key, '/errors', report)).body).toEqual({ accepted: true }); // the 1000th
    expect((await agent(key, '/errors', report)).body).toEqual({ accepted: false }); // over the cap
    const count = async (id: string) =>
      (await adminPool.query(`SELECT COUNT(*)::int AS n FROM agent_error WHERE app_id = $1`, [id])).rows[0].n;
    expect(await count(appId)).toBe(1000);
    // Per app: another app is unaffected.
    expect((await agent(other.key, '/errors', report)).body).toEqual({ accepted: true });
    expect(await count(other.appId)).toBe(1);
  });

  it('counts only the last hour towards the cap', async () => {
    const { key, appId } = await signUp('alice');
    await adminPool.query(
      `INSERT INTO agent_error (app_id, message, occurred_at)
       SELECT $1, 'yesterday ' || i, now() - interval '1 day' FROM generate_series(1, 1000) AS i`,
      [appId],
    );
    expect((await agent(key, '/errors', report)).body).toEqual({ accepted: true });
  });
});

describe('GET /v1/apps/:appId/errors (Studio)', () => {
  it('lists an app’s recent errors, newest first, to any member of the app', async () => {
    const { orgId, appId, key } = await signUp('alice');
    await addMember('alice', orgId, 'vic', 'member', { [appId]: 'viewer' });
    await agent(key, '/errors', { message: 'first', url: 'https://app.acme.test/a' });
    await agent(key, '/errors', { message: 'second', agentVersion: '0.1.0' });

    const res = await request(app).get(`/v1/apps/${appId}/errors`).set('Authorization', as('vic'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: expect.any(String),
        message: 'second',
        stack: null,
        agentVersion: '0.1.0',
        url: null,
        occurredAt: expect.any(String),
      },
      {
        id: expect.any(String),
        message: 'first',
        stack: null,
        agentVersion: null,
        url: 'https://app.acme.test/a',
        occurredAt: expect.any(String),
      },
    ]);

    const limited = await request(app)
      .get(`/v1/apps/${appId}/errors?limit=1`)
      .set('Authorization', as('vic'));
    expect(limited.body.map((e: { message: string }) => e.message)).toEqual(['second']);
    // A silly limit falls back to the default rather than failing.
    expect(
      (await request(app).get(`/v1/apps/${appId}/errors?limit=x`).set('Authorization', as('vic'))).status,
    ).toBe(200);
  });

  it('is 404 for someone outside the app', async () => {
    const { appId, key } = await signUp('alice');
    await signUp('mallory');
    await agent(key, '/errors', { message: 'private' });
    const res = await request(app).get(`/v1/apps/${appId}/errors`).set('Authorization', as('mallory'));
    expect(res.status).toBe(404);
  });

  it('is isolated in RLS: another app’s agent session and an unrelated Studio user see no rows', async () => {
    const alice = await signUp('alice');
    const bob = await signUp('bob');
    await agent(alice.key, '/errors', { message: 'alice only' });

    const viaBobsAgent = await withAgentSession(bob.key, (client) =>
      client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM agent_error`).then((r) => r.rows[0].n),
    );
    expect(viaBobsAgent).toBe(0);
    const bobId = (await adminPool.query(`SELECT id FROM studio_user WHERE oidc_sub = 'bob'`)).rows[0].id;
    const viaBobsStudio = await withStudioSession(bobId, (client) =>
      client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM agent_error`).then((r) => r.rows[0].n),
    );
    expect(viaBobsStudio).toBe(0);
  });
});

describe('platform usage', () => {
  it('counts each app’s errors in the last 24 hours', async () => {
    const { orgId, appId, key } = await signUp('alice');
    await request(app).get('/v1/me').set('Authorization', as('root')); // creates the user
    await adminPool.query(`UPDATE studio_user SET platform_admin = TRUE WHERE oidc_sub = 'root'`);
    await agent(key, '/errors', { message: 'today' });
    await adminPool.query(
      `INSERT INTO agent_error (app_id, message, occurred_at) VALUES ($1, 'last week', now() - interval '7 days')`,
      [appId],
    );
    const res = await request(app).get(`/v1/platform/orgs/${orgId}`).set('Authorization', as('root'));
    expect(res.status).toBe(200);
    expect(res.body.apps[0].usage).toEqual({ guides: 0, events30d: 0, errors24h: 1 });
  });
});
