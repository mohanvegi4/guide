import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addMember, agent, app, as, closePools, liveGuide, resetData, signUp, visitor } from './helpers';

afterAll(closePools);

let orgId: string;
let appId: string;
let key: string;
let guideId: string;
let versionId: string;

const get = (path: string, sub = 'alice') => request(app).get(path).set('Authorization', as(sub));
const guideAnalytics = (query = '', sub = 'alice') =>
  get(`/v1/apps/${appId}/guides/${guideId}/analytics${query}`, sub);

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

/** Records `types` for one visitor/account at `occurredAt`, through the public agent API. */
async function record(
  who: { visitor: string; account: string | null },
  types: string[],
  occurredAt = new Date().toISOString(),
): Promise<void> {
  const res = await agent(key, '/events', {
    ...visitor(who.visitor, who.account),
    events: types.map((eventType) => ({
      guideId,
      guideVersionId: versionId,
      sessionId: `s-${who.visitor}`,
      eventType,
      occurredAt,
    })),
  });
  if (res.status !== 202) throw new Error(`events failed: ${res.status} ${JSON.stringify(res.body)}`);
}

beforeEach(async () => {
  await resetData();
  ({ orgId, appId, key } = await signUp('alice'));
  ({ guideId, versionId } = await liveGuide('alice', appId));
});

describe('GET /apps/:appId/guides/:id/analytics?by=account', () => {
  it('breaks the funnel down by account, top accounts first, with anonymous visitors as their own row', async () => {
    await record({ visitor: 'v1', account: 'acme' }, ['guide_shown', 'guide_completed']);
    await record({ visitor: 'v2', account: 'acme' }, ['guide_shown', 'guide_dismissed']);
    await record({ visitor: 'v2', account: 'acme' }, ['guide_shown']); // same visitor again
    await record({ visitor: 'v3', account: 'globex' }, ['guide_shown', 'guide_completed']);
    await record({ visitor: 'v4', account: null }, ['guide_shown']);

    const plain = await guideAnalytics();
    expect(plain.status).toBe(200);
    expect(plain.body.accounts).toBeUndefined();

    const res = await guideAnalytics('?by=account');
    expect(res.status).toBe(200);
    expect(res.body.accounts).toEqual([
      { accountId: 'acme', shown: 3, completed: 1, dismissed: 1, visitors: 2 },
      { accountId: 'globex', shown: 1, completed: 1, dismissed: 0, visitors: 1 },
      { accountId: null, shown: 1, completed: 0, dismissed: 0, visitors: 1 },
    ]);
    // The totals are still there and reconcile with the breakdown.
    expect(res.body.counts).toEqual(expect.arrayContaining([{ event_type: 'guide_shown', count: 5 }]));
  });

  it('rejects an unknown breakdown', async () => {
    const res = await guideAnalytics('?by=visitor');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });
});

describe('GET /apps/:appId/guides/:id/analytics?from=&to=', () => {
  it('counts only events in the window (from inclusive, a date "to" covers its whole day)', async () => {
    await record({ visitor: 'old', account: 'acme' }, ['guide_shown'], daysAgo(40));
    await record({ visitor: 'mid', account: 'acme' }, ['guide_shown', 'guide_completed'], daysAgo(10));
    await record({ visitor: 'new', account: 'globex' }, ['guide_shown'], daysAgo(0));

    const all = await guideAnalytics('?by=account');
    expect(all.body.counts).toEqual(expect.arrayContaining([{ event_type: 'guide_shown', count: 3 }]));

    const recent = await guideAnalytics(`?from=${daysAgo(20)}&by=account`);
    expect(recent.body.counts).toEqual(
      expect.arrayContaining([
        { event_type: 'guide_shown', count: 2 },
        { event_type: 'guide_completed', count: 1 },
      ]),
    );
    expect(recent.body.accounts.map((a: { accountId: string }) => a.accountId)).toEqual(['acme', 'globex']);

    const middle = await guideAnalytics(`?from=${daysAgo(20)}&to=${daysAgo(5)}&by=account`);
    expect(middle.body.counts).toEqual(
      expect.arrayContaining([
        { event_type: 'guide_shown', count: 1 },
        { event_type: 'guide_completed', count: 1 },
      ]),
    );
    expect(middle.body.accounts).toEqual([
      { accountId: 'acme', shown: 1, completed: 1, dismissed: 0, visitors: 1 },
    ]);

    // Today as a plain date includes today's event; yesterday as a plain date excludes it.
    const today = daysAgo(0).slice(0, 10);
    const yesterday = daysAgo(1).slice(0, 10);
    expect((await guideAnalytics(`?from=${today}&to=${today}`)).body.counts).toEqual([
      { event_type: 'guide_shown', count: 1 },
    ]);
    expect((await guideAnalytics(`?from=${daysAgo(20)}&to=${yesterday}`)).body.counts).toEqual(
      expect.arrayContaining([{ event_type: 'guide_shown', count: 1 }]),
    );
  });

  it('rejects to before from, and non-ISO dates', async () => {
    const backwards = await guideAnalytics(`?from=${daysAgo(1)}&to=${daysAgo(5)}`);
    expect(backwards.status).toBe(400);
    expect(backwards.body.error).toBe('invalid_body');
    expect(backwards.body.details.fieldErrors.to).toEqual(['to must be after from']);
    expect((await guideAnalytics('?from=yesterday')).status).toBe(400);
    expect((await guideAnalytics('?from=2026-13-45')).status).toBe(400);
    expect((await guideAnalytics('?from=10/19/2026')).status).toBe(400);
  });
});

describe('GET /apps/:appId/analytics', () => {
  it('rolls up every guide (zeros included) with completion rate, and distinct reach over 30 days', async () => {
    const other = await request(app)
      .post(`/v1/apps/${appId}/guides`)
      .set('Authorization', as('alice'))
      .send({ name: 'Quiet', type: 'tooltip' });
    await record({ visitor: 'v1', account: 'acme' }, ['guide_shown', 'guide_completed']);
    await record({ visitor: 'v2', account: 'acme' }, ['guide_shown', 'guide_dismissed']);
    await record({ visitor: 'v3', account: null }, ['guide_shown']);
    await record({ visitor: 'v4', account: 'globex' }, ['guide_shown', 'guide_completed']);
    // Long ago: counts towards the guide's totals, not towards recent reach.
    await record({ visitor: 'ancient', account: 'initech' }, ['guide_shown'], daysAgo(45));

    const res = await get(`/v1/apps/${appId}/analytics`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      guides: [
        { guideId, name: 'G', shown: 5, completed: 2, dismissed: 1, completionRate: 0.4 },
        { guideId: other.body.id, name: 'Quiet', shown: 0, completed: 0, dismissed: 0, completionRate: 0 },
      ],
      visitors: 4,
      accounts: 2,
      windowDays: 30,
    });
  });

  it('is empty, not an error, for an app without guides', async () => {
    const fresh = await signUp('zed');
    const res = await get(`/v1/apps/${fresh.appId}/analytics`, 'zed');
    expect(res.body).toEqual({ guides: [], visitors: 0, accounts: 0, windowDays: 30 });
  });
});

describe('access', () => {
  it('viewers can read both; non-members get 404 for both', async () => {
    await addMember('alice', orgId, 'viewer', 'member', { [appId]: 'viewer' });
    expect((await get(`/v1/apps/${appId}/analytics`, 'viewer')).status).toBe(200);
    expect((await guideAnalytics('?by=account', 'viewer')).status).toBe(200);

    await signUp('mallory'); // has an org of their own, but not this one
    expect((await get(`/v1/apps/${appId}/analytics`, 'mallory')).status).toBe(404);
    expect((await guideAnalytics('?by=account', 'mallory')).status).toBe(404);
  });

  it("404s for another app's guide id", async () => {
    const theirs = await signUp('zed');
    const { guideId: theirGuide } = await liveGuide('zed', theirs.appId);
    expect((await get(`/v1/apps/${appId}/guides/${theirGuide}/analytics?by=account`)).status).toBe(404);
  });
});
