import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {
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
  SITE,
  visitor,
} from './helpers';
import { createRateLimiter } from '../src/rateLimit';

afterAll(closePools);
beforeEach(resetData);

const ids = (res: request.Response) => res.body.guides.map((g: { id: string }) => g.id);

describe('the install script', () => {
  it('serves the agent bundle for a well-formed key, cacheable and cross-origin', async () => {
    const { key } = await signUp('alice');
    const res = await request(app).get(`/agent/v1/${key}/guides.js`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toBe(
      'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
    );
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.text).toContain('__guideEngineTestBundle');
  });

  it('404s a malformed key', async () => {
    expect((await request(app).get('/agent/v1/not-a-key/guides.js')).status).toBe(404);
  });
});

describe('keys and websites', () => {
  it('serves guides to the app’s own website, with CORS for that origin only', async () => {
    const { key, appId } = await signUp('alice');
    const { guideId } = await liveGuide('alice', appId);
    const res = await agent(key, '/guides', visitor());
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(SITE);
    expect(res.body).toMatchObject({
      enabled: true,
      guides: [{ id: guideId, routeMatch: sampleVersion.routeMatch }],
    });
  });

  it('refuses other websites (fail closed), including when the app lists none', async () => {
    const { key } = await signUp('alice');
    const other = await agent(key, '/guides', visitor(), 'https://evil.test');
    expect(other.status).toBe(403);
    expect(other.body.error).toBe('origin_not_allowed');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();

    const bare = await signUp('bob', 'bare', []);
    expect((await agent(bare.key, '/guides', visitor())).status).toBe(403);
  });

  it('answers CORS preflights for allowed origins', async () => {
    const { key } = await signUp('alice');
    const res = await request(app).options(`/v1/agent/${key}/guides`).set('Origin', SITE);
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(SITE);
  });

  it('gives unknown, malformed and rotated keys the same 404', async () => {
    const { key, appId } = await signUp('alice');
    await request(app).post(`/v1/apps/${appId}/rotate-key`).set('Authorization', as('alice'));
    for (const k of [key, 'ge_pk_' + '0'.repeat(32), 'nope']) {
      const res = await agent(k, '/guides', visitor());
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    }
  });

  it("never serves one app's guides through another app's key", async () => {
    const a = await signUp('alice');
    const b = await signUp('zed');
    await liveGuide('alice', a.appId);
    const res = await agent(b.key, '/guides', visitor());
    expect(res.body.guides).toEqual([]);
  });

  it('accepts application/json too', async () => {
    const { key, appId } = await signUp('alice');
    await liveGuide('alice', appId);
    const res = await request(app).post(`/v1/agent/${key}/guides`).set('Origin', SITE).send(visitor());
    expect(res.body.guides).toHaveLength(1);
  });
});

describe('visitor identity', () => {
  async function requiredApp() {
    const setup = await signUp('alice');
    const secret = (
      await request(app).post(`/v1/apps/${setup.appId}/signing-secret`).set('Authorization', as('alice'))
    ).body.secret as string;
    await request(app)
      .patch(`/v1/apps/${setup.appId}`)
      .set('Authorization', as('alice'))
      .send({ identityMode: 'required' });
    await liveGuide('alice', setup.appId);
    return { ...setup, secret };
  }
  const sign = (secret: string, claims: object, opts: jwt.SignOptions = {}) =>
    jwt.sign(claims, secret, { algorithm: 'HS256', expiresIn: '5m', ...opts });

  it('optional mode: plain visitor ids work; a visitor id is required', async () => {
    const { key, appId } = await signUp('alice');
    await liveGuide('alice', appId);
    expect((await agent(key, '/guides', visitor('v1'))).status).toBe(200);
    const none = await agent(key, '/guides', {});
    expect(none.status).toBe(401);
    expect(none.body.error).toBe('visitor_required');
  });

  it('required mode: refuses unsigned visitors, accepts a valid signed identity', async () => {
    const { key, secret } = await requiredApp();
    const unsigned = await agent(key, '/guides', visitor());
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.error).toBe('signed_identity_required');

    const signed = await agent(key, '/guides', {
      jwt: sign(secret, { visitor: { id: 'u1' }, account: { id: 'acme' } }),
    });
    expect(signed.status).toBe(200);
    expect(signed.body.guides).toHaveLength(1);
  });

  it.each([
    ['wrong secret', () => sign('ge_sk_wrong'.padEnd(40, 'x'), { visitor: { id: 'u1' } })],
    ['expired', (s: string) => sign(s, { visitor: { id: 'u1' } }, { expiresIn: -60 })],
    ['no exp', (s: string) => jwt.sign({ visitor: { id: 'u1' } }, s, { algorithm: 'HS256' })],
    ['no visitor', (s: string) => sign(s, { account: { id: 'acme' } })],
  ])('required mode rejects: %s', async (_name, make) => {
    const { key, secret } = await requiredApp();
    const res = await agent(key, '/guides', { jwt: (make as (s: string) => string)(secret) });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('identity_invalid');
  });

  it('reads tags from the signed identity and ignores tags sent beside it', async () => {
    const { key, secret, appId } = await requiredApp();
    await liveGuide('alice', appId, { ...sampleVersion, visitorTags: ['POS'] });
    const guides = async (claims: object, extra: object = {}) =>
      (await agent(key, '/guides', { jwt: sign(secret, claims), ...extra })).body.guides;
    // requiredApp() already published one untagged guide.
    expect(await guides({ visitor: { id: 'u1', tags: ['POS'] } })).toHaveLength(2);
    expect(await guides({ visitor: { id: 'u1' } }, { visitor: { id: 'u1', tags: ['POS'] } })).toHaveLength(1);

    const bad = await agent(key, '/guides', { jwt: sign(secret, { visitor: { id: 'u1', tags: ['no spaces'] } }) });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('identity_invalid');
  });

  it('signed claims win over plain ids sent alongside them', async () => {
    const { key, secret, appId } = await requiredApp();
    const g = (await request(app).get(`/v1/apps/${appId}/guides`).set('Authorization', as('alice'))).body[0];
    const versionId = (
      await request(app).get(`/v1/apps/${appId}/guides/${g.id}`).set('Authorization', as('alice'))
    ).body.versions[0].id;
    await agent(key, '/events', {
      jwt: sign(secret, { visitor: { id: 'real-user' } }),
      visitor: { id: 'spoofed' },
      events: [
        {
          guideId: g.id,
          guideVersionId: versionId,
          sessionId: 's',
          eventType: 'guide_shown',
          occurredAt: new Date().toISOString(),
        },
      ],
    });
    expect((await adminPool.query(`SELECT visitor_id FROM guide_event`)).rows).toEqual([
      { visitor_id: 'real-user' },
    ]);
  });
});

describe('targeting and kill switches', () => {
  it('limits a guide to listed accounts', async () => {
    const { key, appId } = await signUp('alice');
    await liveGuide('alice', appId, { ...sampleVersion, accountIds: ['acme', 'globex'] });
    expect((await agent(key, '/guides', visitor('v', 'acme'))).body.guides).toHaveLength(1);
    expect((await agent(key, '/guides', visitor('v', 'initech'))).body.guides).toHaveLength(0);
    expect((await agent(key, '/guides', visitor('v', null))).body.guides).toHaveLength(0);
  });

  it('limits a guide to visitors carrying any listed tag', async () => {
    const { key, appId } = await signUp('alice');
    await liveGuide('alice', appId, { ...sampleVersion, visitorTags: ['POINT_OF_SALE', 'CUSTOMERS:edit'] });
    const tagged = (tags?: string[]) => agent(key, '/guides', { visitor: { id: 'v', tags } });
    expect((await tagged(['CUSTOMERS:edit', 'CATALOG'])).body.guides).toHaveLength(1);
    expect((await tagged(['CATALOG'])).body.guides).toHaveLength(0);
    expect((await tagged([])).body.guides).toHaveLength(0);
    expect((await tagged()).body.guides).toHaveLength(0);
    // Tags are exact strings: case matters.
    expect((await tagged(['point_of_sale'])).body.guides).toHaveLength(0);
  });

  it('combines tags with the account allowlist: both must pass', async () => {
    const { key, appId } = await signUp('alice');
    await liveGuide('alice', appId, { ...sampleVersion, accountIds: ['acme'], visitorTags: ['POS'] });
    const call = (account: string, tags: string[]) =>
      agent(key, '/guides', { visitor: { id: 'v', tags }, account: { id: account } });
    expect((await call('acme', ['POS'])).body.guides).toHaveLength(1);
    expect((await call('globex', ['POS'])).body.guides).toHaveLength(0);
    expect((await call('acme', ['OTHER'])).body.guides).toHaveLength(0);
  });

  it('serves an untagged guide to every visitor, tagged or not', async () => {
    const { key, appId } = await signUp('alice');
    await liveGuide('alice', appId);
    expect((await agent(key, '/guides', { visitor: { id: 'v', tags: ['ANY'] } })).body.guides).toHaveLength(1);
    expect((await agent(key, '/guides', visitor())).body.guides).toHaveLength(1);
  });

  it('rejects malformed visitor tags', async () => {
    const { key, appId } = await signUp('alice');
    await liveGuide('alice', appId);
    for (const tags of [['has space'], [''], ['x'.repeat(101)], Array.from({ length: 1001 }, (_, i) => `t${i}`)]) {
      const res = await agent(key, '/guides', { visitor: { id: 'v', tags } });
      expect(res.status).toBe(400);
    }
    expect((await agent(key, '/guides', { visitor: { id: 'v', tags: ['a', 'a'] } })).status).toBe(200);
  });

  it('serves nothing when the app or the whole engine is switched off', async () => {
    const { key, appId } = await signUp('alice');
    await liveGuide('alice', appId);
    await request(app).patch(`/v1/apps/${appId}`).set('Authorization', as('alice')).send({ enabled: false });
    expect((await agent(key, '/guides', visitor())).body).toEqual({ enabled: false, guides: [] });

    await request(app).patch(`/v1/apps/${appId}`).set('Authorization', as('alice')).send({ enabled: true });
    await adminPool.query(`UPDATE system_config SET value = 'false' WHERE key = 'guide_engine_enabled'`);
    expect((await agent(key, '/guides', visitor())).body).toEqual({ enabled: false, guides: [] });
  });

  it('hides drafts, disabled guides and guides outside their date window', async () => {
    const { key, appId } = await signUp('alice');
    const g = await request(app)
      .post(`/v1/apps/${appId}/guides`)
      .set('Authorization', as('alice'))
      .send({ name: 'D', type: 'modal' });
    await request(app)
      .put(`/v1/apps/${appId}/guides/${g.body.id}/draft`)
      .set('Authorization', as('alice'))
      .send(sampleVersion);
    await request(app)
      .patch(`/v1/apps/${appId}/guides/${g.body.id}/flag`)
      .set('Authorization', as('alice'))
      .send({ enabled: true });
    expect((await agent(key, '/guides', visitor())).body.guides).toEqual([]);

    const later = new Date(Date.now() + 3600_000).toISOString();
    await liveGuide('alice', appId, { ...sampleVersion, startAt: later });
    expect((await agent(key, '/guides', visitor())).body.guides).toEqual([]);
  });
});

describe('events and per-visitor state', () => {
  async function setup() {
    const s = await signUp('alice');
    const live = await liveGuide('alice', s.appId);
    const ev = (eventType: string, versionId = live.versionId) => ({
      guideId: live.guideId,
      guideVersionId: versionId,
      sessionId: 's',
      eventType,
      occurredAt: new Date().toISOString(),
    });
    return { ...s, ...live, ev };
  }

  it('records events with visitor and account', async () => {
    const { key, ev } = await setup();
    const res = await agent(key, '/events', { ...visitor('v-9', 'acme'), events: [ev('guide_shown')] });
    expect(res.status).toBe(202);
    expect((await adminPool.query(`SELECT visitor_id, account_id FROM guide_event`)).rows).toEqual([
      { visitor_id: 'v-9', account_id: 'acme' },
    ]);
  });

  it("drops events for another app's guides", async () => {
    const { ev } = await setup();
    const other = await signUp('zed');
    const res = await agent(other.key, '/events', { ...visitor(), events: [ev('guide_shown')] });
    expect(res.body.accepted).toBe(0);
  });

  it('shows an automatic guide once: after guide_shown it is not served again until a newer version', async () => {
    const { key, appId, guideId, ev } = await setup();
    await agent(key, '/events', { ...visitor('v1'), events: [ev('guide_shown')] });
    // A reload mid-guide: nothing to start over.
    expect(ids(await agent(key, '/guides', visitor('v1')))).toEqual([]);
    expect(ids(await agent(key, '/guides', visitor('v2')))).toEqual([guideId]);
    // The help center still lists it (on demand, replayable).
    expect(ids(await agent(key, '/help', visitor('v1')))).toEqual([]); // not listed: no help entry
    // Finishing it later keeps the stronger state; a help replay's guide_shown doesn't downgrade it.
    await agent(key, '/events', { ...visitor('v1'), events: [ev('guide_completed')] });
    await agent(key, '/events', { ...visitor('v1'), events: [ev('guide_shown')] });
    const state = await adminPool.query(
      `SELECT status::text FROM user_guide_state WHERE visitor_id = 'v1' AND guide_id = $1`,
      [guideId],
    );
    expect(state.rows[0].status).toBe('completed');

    await request(app)
      .post(`/v1/apps/${appId}/guides/${guideId}/publish`)
      .set('Authorization', as('alice'))
      .send({ ...sampleVersion, steps: [{ ...sampleStep, content: '<p>v2</p>' }] });
    expect(ids(await agent(key, '/guides', visitor('v1')))).toEqual([guideId]);
  });

  it('hides a dismissed guide from that visitor until a newer version is published', async () => {
    const { key, appId, guideId, ev } = await setup();
    await agent(key, '/events', { ...visitor('v1'), events: [ev('guide_dismissed')] });
    expect(ids(await agent(key, '/guides', visitor('v1')))).toEqual([]);
    expect(ids(await agent(key, '/guides', visitor('v2')))).toEqual([guideId]);

    await request(app)
      .post(`/v1/apps/${appId}/guides/${guideId}/publish`)
      .set('Authorization', as('alice'))
      .send({ ...sampleVersion, steps: [{ ...sampleStep, content: '<p>v2</p>' }] });
    expect(ids(await agent(key, '/guides', visitor('v1')))).toEqual([guideId]);
  });

  it('rolling back to an older version does not bring a finished guide back', async () => {
    const { key, appId, guideId } = await setup();
    const v2 = await request(app)
      .post(`/v1/apps/${appId}/guides/${guideId}/publish`)
      .set('Authorization', as('alice'))
      .send(sampleVersion);
    await agent(key, '/events', {
      ...visitor('v1'),
      events: [
        {
          guideId,
          guideVersionId: v2.body.id,
          sessionId: 's',
          eventType: 'guide_completed',
          occurredAt: new Date().toISOString(),
        },
      ],
    });
    await request(app)
      .post(`/v1/apps/${appId}/guides/${guideId}/rollback/1`)
      .set('Authorization', as('alice'));
    expect(ids(await agent(key, '/guides', visitor('v1')))).toEqual([]);
  });

  it('rejects malformed batches', async () => {
    const { key } = await setup();
    expect((await agent(key, '/events', { ...visitor(), events: [] })).status).toBe(400);
    const raw = await request(app)
      .post(`/v1/agent/${key}/events`)
      .set('Origin', SITE)
      .set('Content-Type', 'text/plain')
      .send('{not json');
    expect(raw.status).toBe(400);
  });
});

describe('preview links', () => {
  async function draftOnlyGuide() {
    const s = await signUp('alice');
    const g = await request(app)
      .post(`/v1/apps/${s.appId}/guides`)
      .set('Authorization', as('alice'))
      .send({ name: 'P', type: 'modal' });
    const draft = await request(app)
      .put(`/v1/apps/${s.appId}/guides/${g.body.id}/draft`)
      .set('Authorization', as('alice'))
      .send({ ...sampleVersion, routeMatch: { type: 'exact', value: '/projects' } });
    const minted = await request(app)
      .post(`/v1/apps/${s.appId}/guides/${g.body.id}/preview-token`)
      .set('Authorization', as('alice'))
      .send({ versionId: draft.body.id });
    return { ...s, guideId: g.body.id, draftId: draft.body.id, minted };
  }

  it("links to the app's website and renders a disabled, unpublished draft", async () => {
    const { key, guideId, draftId, minted } = await draftOnlyGuide();
    expect(minted.body.url).toBe(`${SITE}/projects?guidePreview=${encodeURIComponent(minted.body.token)}`);
    const res = await agent(key, '/preview', { token: minted.body.token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: guideId, versionId: draftId, preview: true });
  });

  it("only resolves through the same app's key", async () => {
    const { minted } = await draftOnlyGuide();
    const other = await signUp('zed');
    expect((await agent(other.key, '/preview', { token: minted.body.token })).status).toBe(404);
  });

  it('rejects tampered and expired tokens', async () => {
    const { key, guideId, draftId, appId } = await draftOnlyGuide();
    const expired = jwt.sign(
      { typ: 'guide_preview', guideId, versionId: draftId, appId },
      process.env.PREVIEW_TOKEN_SECRET!,
      {
        audience: 'guide-preview',
        issuer: 'guide-engine',
        expiresIn: -10,
      },
    );
    expect((await agent(key, '/preview', { token: expired })).status).toBe(403);
    expect((await agent(key, '/preview', { token: 'x.y.z' })).status).toBe(403);
  });

  it('needs at least editor on the app to mint', async () => {
    const { appId, guideId, draftId } = await draftOnlyGuide();
    const res = await request(app)
      .post(`/v1/apps/${appId}/guides/${guideId}/preview-token`)
      .set('Authorization', as('stranger'))
      .send({ versionId: draftId });
    expect(res.status).toBe(404);
  });
});

describe('rate limiting', () => {
  it('allows `limit` requests per window, then refuses until it resets', () => {
    const allow = createRateLimiter(3, 1000);
    expect([allow('k', 0), allow('k', 1), allow('k', 2), allow('k', 3)]).toEqual([true, true, true, false]);
    expect(allow('other', 4)).toBe(true);
    expect(allow('k', 1001)).toBe(true);
  });
});
