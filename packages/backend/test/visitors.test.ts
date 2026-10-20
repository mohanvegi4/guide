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
  signUp,
  visitor,
} from './helpers';
import { withStudioSession } from '../src/db';

afterAll(closePools);
beforeEach(resetData);

const visitors = (appId: string, id: string) => `/v1/apps/${appId}/visitors/${encodeURIComponent(id)}`;

/** Two visitors, each with a shown + completed event (so each also has a state row). */
async function seed() {
  const org = await signUp('alice');
  const g = await liveGuide('alice', org.appId);
  for (const id of ['v-1', 'v-2']) {
    const event = (eventType: string, minutesAgo: number) => ({
      guideId: g.guideId,
      guideVersionId: g.versionId,
      sessionId: 's',
      eventType,
      occurredAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      metadata: { source: 'help' },
    });
    await agent(org.key, '/events', {
      ...visitor(id),
      events: [event('guide_shown', 2), event('guide_completed', 1)],
    });
  }
  return { ...org, ...g };
}

describe('forget this visitor', () => {
  it('exports everything held about one visitor of one app', async () => {
    const { appId } = await seed();
    const res = await request(app).get(visitors(appId, 'v-1')).set('Authorization', as('alice'));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="guide-engine-visitor-v-1-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.body.visitorId).toBe('v-1');
    expect(res.body.events.map((e: { eventType: string }) => e.eventType)).toEqual([
      'guide_shown',
      'guide_completed',
    ]);
    expect(res.body.events[0]).toMatchObject({
      accountId: 'acme',
      sessionId: 's',
      metadata: { source: 'help' },
    });
    expect(res.body.guideState).toEqual([
      { guideId: expect.any(String), status: 'completed', lastSeenVersion: 1, updatedAt: expect.any(String) },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('v-2');
  });

  it('deletes that visitor’s events and state, nothing else, and the guide shows again for them', async () => {
    const { appId, key } = await seed();
    expect((await agent(key, '/guides', visitor('v-1'))).body.guides).toHaveLength(0); // finished

    const res = await request(app).delete(visitors(appId, 'v-1')).set('Authorization', as('alice'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ visitorId: 'v-1', events: 2, guideState: 1 });

    const left = await adminPool.query(`SELECT visitor_id, COUNT(*)::int AS n FROM guide_event GROUP BY 1`);
    expect(left.rows).toEqual([{ visitor_id: 'v-2', n: 2 }]);
    expect((await adminPool.query(`SELECT visitor_id FROM user_guide_state`)).rows).toEqual([
      { visitor_id: 'v-2' },
    ]);
    expect((await agent(key, '/guides', visitor('v-1'))).body.guides).toHaveLength(1); // forgotten = fresh
    expect((await agent(key, '/guides', visitor('v-2'))).body.guides).toHaveLength(0);

    // Forgetting again, or an unknown id, is a harmless no-op.
    expect(
      (await request(app).delete(visitors(appId, 'v-1')).set('Authorization', as('alice'))).body,
    ).toEqual({
      visitorId: 'v-1',
      events: 0,
      guideState: 0,
    });
  });

  it('handles ids with characters that need escaping, and rejects empty or oversized ids', async () => {
    const { appId, key, guideId, versionId } = await seed();
    const odd = 'user/42 #7?x=y';
    await agent(key, '/events', {
      ...visitor(odd),
      events: [
        {
          guideId,
          guideVersionId: versionId,
          sessionId: 's',
          eventType: 'guide_shown',
          occurredAt: new Date().toISOString(),
        },
      ],
    });
    const res = await request(app).get(visitors(appId, odd)).set('Authorization', as('alice'));
    expect(res.body.events).toHaveLength(1);
    expect(res.headers['content-disposition']).toContain('guide-engine-visitor-user_42_7_x_y-');
    expect(
      (await request(app).delete(visitors(appId, odd)).set('Authorization', as('alice'))).body.events,
    ).toBe(1);
    expect(
      (
        await request(app)
          .get(visitors(appId, 'x'.repeat(257)))
          .set('Authorization', as('alice'))
      ).status,
    ).toBe(400);
  });

  it('is for managers and owners only, in the API and in the database', async () => {
    const { orgId, appId } = await seed();
    await addMember('alice', orgId, 'eddie', 'editor');
    await addMember('alice', orgId, 'pat', 'viewer');
    await addMember('alice', orgId, 'andy', 'manager');
    await signUp('bob');

    for (const sub of ['eddie', 'pat']) {
      expect((await request(app).get(visitors(appId, 'v-1')).set('Authorization', as(sub))).status).toBe(403);
      expect((await request(app).delete(visitors(appId, 'v-1')).set('Authorization', as(sub))).status).toBe(
        403,
      );
    }
    expect((await request(app).delete(visitors(appId, 'v-1')).set('Authorization', as('bob'))).status).toBe(
      404,
    );

    // Even raw SQL in a viewer's session deletes nothing and sees no state.
    const pat = (await adminPool.query(`SELECT id FROM studio_user WHERE oidc_sub = 'pat'`)).rows[0].id;
    const seen = await withStudioSession(pat, async (client) => ({
      deleted: (await client.query(`DELETE FROM guide_event WHERE visitor_id = 'v-1'`)).rowCount,
      state: (await client.query(`SELECT 1 FROM user_guide_state`)).rowCount,
    }));
    expect(seen).toEqual({ deleted: 0, state: 0 });
    expect((await adminPool.query(`SELECT COUNT(*)::int AS n FROM guide_event`)).rows[0].n).toBe(4);

    // A manager can.
    expect(
      (await request(app).delete(visitors(appId, 'v-1')).set('Authorization', as('andy'))).body.events,
    ).toBe(2);
  });
});
