import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { withStudioSession } from '../src/db';
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

afterAll(closePools);

let appId: string;
let key: string;
let guideId: string;
const base = () => `/v1/apps/${appId}/guides/${guideId}`;
const call = (method: 'get' | 'post' | 'put' | 'patch', path: string, body?: object) =>
  request(app)[method](path).set('Authorization', as('alice')).send(body);

beforeEach(async () => {
  await resetData();
  ({ appId, key } = await signUp('alice'));
  guideId = (await call('post', `/v1/apps/${appId}/guides`, { name: 'Welcome', type: 'tour' })).body.id;
});

describe('lifecycle', () => {
  it('create → publish → enable → served → disable → gone', async () => {
    const created = await call('get', base());
    expect(created.body).toMatchObject({ status: 'draft', enabled: false, versions: [] });

    const published = await call('post', `${base()}/publish`, sampleVersion);
    expect(published.status).toBe(201);
    expect(published.body.versionNumber).toBe(1);
    expect((await agent(key, '/guides', visitor())).body.guides).toEqual([]); // still disabled

    await call('patch', `${base()}/flag`, { enabled: true });
    expect((await agent(key, '/guides', visitor())).body.guides).toHaveLength(1);

    await call('patch', `${base()}/flag`, { enabled: false });
    expect((await agent(key, '/guides', visitor())).body.guides).toEqual([]);

    const list = await call('get', `/v1/apps/${appId}/guides`);
    expect(list.body).toEqual([
      expect.objectContaining({ id: guideId, status: 'published', current_version_number: 1 }),
    ]);
  });

  it('deletes a guide with its versions, events and visitor state; viewers cannot', async () => {
    await call('post', `${base()}/publish`, sampleVersion);
    await call('patch', `${base()}/flag`, { enabled: true });
    // A visitor sees it and leaves an event and some state behind.
    const seen = await agent(key, '/guides', visitor());
    expect(seen.body.guides.map((g: { id: string }) => g.id)).toEqual([guideId]);
    await adminPool.query(
      `INSERT INTO guide_event (app_id, guide_id, visitor_id, session_id, event_type) VALUES ($1, $2, 'v-1', 's-1', 'guide_shown')`,
      [appId, guideId],
    );
    await adminPool.query(
      `INSERT INTO user_guide_state (app_id, visitor_id, guide_id, status) VALUES ($1, 'v-1', $2, 'completed')`,
      [appId, guideId],
    );

    // Viewers may look, not delete.
    const orgId = (await call('get', '/v1/me')).body.orgs[0].id as string;
    await addMember('alice', orgId, 'vic', 'viewer');
    expect((await request(app).delete(base()).set('Authorization', as('vic')).send()).status).toBe(403);

    expect((await request(app).delete(base()).set('Authorization', as('alice')).send()).status).toBe(204);
    expect((await call('get', base())).status).toBe(404);
    expect((await request(app).delete(base()).set('Authorization', as('alice')).send()).status).toBe(404);
    const left = await adminPool.query(
      `SELECT (SELECT count(*) FROM guide_version WHERE guide_id = $1)::int AS versions,
              (SELECT count(*) FROM guide_event WHERE guide_id = $1)::int AS events,
              (SELECT count(*) FROM user_guide_state WHERE guide_id = $1)::int AS state`,
      [guideId],
    );
    expect(left.rows[0]).toEqual({ versions: 0, events: 0, state: 0 });
    expect((await agent(key, '/guides', visitor())).body.guides).toEqual([]);
  });

  it('saves one draft per guide and publishes it as-is with an empty body', async () => {
    const d1 = await call('put', `${base()}/draft`, sampleVersion);
    const d2 = await call('put', `${base()}/draft`, {
      ...sampleVersion,
      routeMatch: { type: 'exact', value: '/x' },
    });
    expect(d2.body.id).toBe(d1.body.id);
    expect(d2.body.publishedAt).toBeNull();
    const pub = await call('post', `${base()}/publish`);
    expect(pub.body).toMatchObject({ id: d1.body.id, routeMatch: { type: 'exact', value: '/x' } });
    expect(pub.body.publishedAt).toEqual(expect.any(String));
  });

  it('400s publishing with no body and no draft', async () => {
    const res = await call('post', `${base()}/publish`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_draft_to_publish');
  });

  it('keeps version numbers monotonic and rolls back only to published versions', async () => {
    await call('post', `${base()}/publish`, sampleVersion);
    const draft = await call('put', `${base()}/draft`, sampleVersion);
    expect(draft.body.versionNumber).toBe(2);
    expect((await call('post', `${base()}/rollback/2`)).status).toBe(404); // a draft
    const v2 = await call('post', `${base()}/publish`, {
      ...sampleVersion,
      steps: [{ ...sampleStep, content: '<p>two</p>' }],
    });
    expect(v2.body).toMatchObject({ id: draft.body.id, versionNumber: 2 });

    await call('patch', `${base()}/flag`, { enabled: true });
    const content = async () => (await agent(key, '/guides', visitor())).body.guides[0].steps[0].content;
    expect(await content()).toBe('<p>two</p>');
    await call('post', `${base()}/rollback/1`);
    expect(await content()).toBe(sampleStep.content);
  });

  it('enforces published-version immutability in the database', async () => {
    const v1 = await call('post', `${base()}/publish`, sampleVersion);
    const alice = (await call('get', '/v1/me')).body.user.id;
    const result = await withStudioSession(alice, async (c) => ({
      updated: (await c.query(`UPDATE guide_version SET steps = '[]' WHERE id = $1`, [v1.body.id])).rowCount,
      deleted: (await c.query(`DELETE FROM guide_version WHERE id = $1`, [v1.body.id])).rowCount,
    }));
    expect(result).toEqual({ updated: 0, deleted: 0 });
  });

  it('validates audience: a deduplicated account allowlist, or everyone', async () => {
    const v = await call('put', `${base()}/draft`, {
      ...sampleVersion,
      accountIds: ['acme', 'acme', 'globex'],
    });
    expect(v.body.accountIds).toEqual(['acme', 'globex']);
    expect((await call('put', `${base()}/draft`, { ...sampleVersion, accountIds: [] })).status).toBe(400);
    expect(
      (await call('put', `${base()}/draft`, { ...sampleVersion, accountIds: null })).body.accountIds,
    ).toBeNull();
  });

  it('validates visitor tags: a deduplicated list of up to 100 well-formed tags, or everyone', async () => {
    const v = await call('put', `${base()}/draft`, {
      ...sampleVersion,
      visitorTags: ['POINT_OF_SALE', 'CUSTOMERS:edit', 'POINT_OF_SALE'],
    });
    expect(v.status).toBe(200);
    expect(v.body.visitorTags).toEqual(['POINT_OF_SALE', 'CUSTOMERS:edit']);
    for (const visitorTags of [[], ['has space'], ['<b>'], Array.from({ length: 101 }, (_, i) => `t${i}`)]) {
      expect((await call('put', `${base()}/draft`, { ...sampleVersion, visitorTags })).status).toBe(400);
    }
    // The cap counts distinct tags.
    const withDuplicate = [...Array.from({ length: 100 }, (_, i) => `t${i}`), 't0'];
    expect((await call('put', `${base()}/draft`, { ...sampleVersion, visitorTags: withDuplicate })).body.visitorTags).toHaveLength(100);
    expect((await call('put', `${base()}/draft`, sampleVersion)).body.visitorTags).toBeNull();

    // Published with the version, and immutable like the rest of it.
    const pub = await call('post', `${base()}/publish`, { ...sampleVersion, visitorTags: ['POS'] });
    expect(pub.body.visitorTags).toEqual(['POS']);
    const detail = await call('get', base());
    expect(detail.body.versions[0].visitor_tags).toEqual(['POS']);
  });
});

describe('sanitization on the write path', () => {
  it('strips <script> from content and labels in the returned AND stored version', async () => {
    const res = await call('post', `${base()}/publish`, {
      ...sampleVersion,
      steps: [
        {
          ...sampleStep,
          content: '<p>Hi</p><script>alert(document.cookie)</script>',
          actions: [{ label: '<img src=x onerror=alert(1)>Done', action: 'complete' }],
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.steps[0]).toMatchObject({
      content: '<p>Hi</p>',
      actions: [{ label: 'Done', action: 'complete' }],
    });
    const raw = await adminPool.query(`SELECT steps::text AS steps FROM guide_version WHERE guide_id = $1`, [
      guideId,
    ]);
    expect(raw.rows[0].steps).not.toMatch(/script|onerror/i);
  });

  it('rejects a step that is empty after sanitization, and non data-guide-id selectors', async () => {
    const empty = await call('put', `${base()}/draft`, {
      ...sampleVersion,
      steps: [{ ...sampleStep, content: '<script>x()</script>' }],
    });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('empty_content_after_sanitize');
    const css = await call('put', `${base()}/draft`, {
      ...sampleVersion,
      steps: [{ ...sampleStep, targetSelector: '.btn' }],
    });
    expect(css.status).toBe(400);
  });
});

describe('stable step ids + analytics', () => {
  it('keeps ids the author sends back, assigns new ones, rejects duplicates', async () => {
    const v1 = await call('post', `${base()}/publish`, {
      ...sampleVersion,
      steps: [sampleStep, { ...sampleStep, order: 1, content: '<p>two</p>' }],
    });
    const [s1, s2] = v1.body.steps.map((s: { id: string }) => s.id);
    const v2 = await call('post', `${base()}/publish`, {
      ...sampleVersion,
      steps: [
        { ...sampleStep, id: s2, order: 0 },
        { ...sampleStep, id: s1, order: 1 },
        { ...sampleStep, order: 2, content: '<p>new</p>' },
      ],
    });
    expect(v2.body.steps.slice(0, 2).map((s: { id: string }) => s.id)).toEqual([s2, s1]);
    expect([s1, s2]).not.toContain(v2.body.steps[2].id);

    const dup = await call('put', `${base()}/draft`, {
      ...sampleVersion,
      steps: [
        { ...sampleStep, id: s1 },
        { ...sampleStep, id: s1, order: 1 },
      ],
    });
    expect(dup.status).toBe(400);
  });

  it('counts events overall and per step, across versions and accounts', async () => {
    const { guideId: g, versionId } = await liveGuide('alice', appId);
    const stepId = (await call('get', `/v1/apps/${appId}/guides/${g}`)).body.versions[0].steps[0].id;
    const ev = (eventType: string) => ({
      guideId: g,
      guideVersionId: versionId,
      stepId,
      sessionId: 's',
      eventType,
      occurredAt: new Date().toISOString(),
    });
    await agent(key, '/events', {
      ...visitor('v1', 'acme'),
      events: [ev('guide_shown'), ev('guide_step_completed')],
    });
    await agent(key, '/events', { ...visitor('v2', 'globex'), events: [ev('guide_shown')] });

    const stats = await call('get', `/v1/apps/${appId}/guides/${g}/analytics`);
    expect(stats.body.counts).toEqual(
      expect.arrayContaining([
        { event_type: 'guide_shown', count: 2 },
        { event_type: 'guide_step_completed', count: 1 },
      ]),
    );
    expect(stats.body.steps).toEqual(
      expect.arrayContaining([{ step_id: stepId, event_type: 'guide_shown', count: 2 }]),
    );
  });
});
