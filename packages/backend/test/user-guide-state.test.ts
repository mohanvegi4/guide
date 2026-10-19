import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { pool } from '../src/db';
import { adminPool, app, createTenant, resetData, samplePublishBody, sampleStep } from './helpers';
import { bearer, endUserBearer } from './auth-helpers';

/** Dismissed/completed guides stay hidden for that user until a newer version is published. */
describe('per-user guide state', () => {
  let tenant: string;
  let guideId: string;

  beforeEach(async () => {
    await resetData();
    tenant = await createTenant('Acme');
    guideId = (
      await request(app)
        .post('/guides')
        .set('Authorization', bearer(tenant))
        .send({ name: 'G', type: 'tooltip' })
    ).body.id;
    await publish();
    await request(app)
      .patch(`/guides/${guideId}/flag`)
      .set('Authorization', bearer(tenant))
      .send({ enabled: true });
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.end();
  });

  async function publish(content = sampleStep.content) {
    return (
      await request(app)
        .post(`/guides/${guideId}/publish`)
        .set('Authorization', bearer(tenant))
        .send({ ...samplePublishBody, steps: [{ ...sampleStep, content }] })
    ).body as { id: string; versionNumber: number };
  }

  async function active(user: string) {
    const res = await request(app).get('/guides/active').set('Authorization', endUserBearer(tenant, user));
    return res.body as Array<{ id: string; versionId: string }>;
  }

  async function finish(user: string, eventType: 'guide_dismissed' | 'guide_completed') {
    const [guide] = await active(user);
    const res = await request(app)
      .post('/events')
      .set('Authorization', endUserBearer(tenant, user))
      .send({
        events: [
          {
            guideId,
            guideVersionId: guide.versionId,
            sessionId: 's',
            eventType,
            occurredAt: new Date().toISOString(),
          },
        ],
      });
    expect(res.status).toBe(202);
  }

  it.each(['guide_dismissed', 'guide_completed'] as const)(
    '%s hides the guide for that user only',
    async (eventType) => {
      await finish('alice', eventType);
      expect(await active('alice')).toEqual([]);
      expect((await active('bob')).map((g) => g.id)).toEqual([guideId]);

      const state = await adminPool.query(
        `SELECT status, last_seen_version FROM user_guide_state WHERE user_id = 'alice'`,
      );
      expect(state.rows).toEqual([{ status: eventType.replace('guide_', ''), last_seen_version: 1 }]);
    },
  );

  it('shows the guide again once a newer version is published', async () => {
    await finish('alice', 'guide_dismissed');
    await publish('<p>v2: important update</p>');
    const [guide] = await active('alice');
    expect(guide.id).toBe(guideId);
  });

  it('does not re-show after a rollback to an older version', async () => {
    await publish('<p>v2</p>');
    await finish('alice', 'guide_completed'); // finished v2
    await request(app).post(`/guides/${guideId}/rollback/1`).set('Authorization', bearer(tenant));
    expect(await active('alice')).toEqual([]);
  });

  it('ignores a terminal event whose version does not belong to the guide', async () => {
    const other = (
      await request(app)
        .post('/guides')
        .set('Authorization', bearer(tenant))
        .send({ name: 'O', type: 'modal' })
    ).body.id;
    const otherVersion = (
      await request(app)
        .post(`/guides/${other}/publish`)
        .set('Authorization', bearer(tenant))
        .send(samplePublishBody)
    ).body.id;
    await request(app)
      .post('/events')
      .set('Authorization', endUserBearer(tenant, 'alice'))
      .send({
        events: [
          {
            guideId,
            guideVersionId: otherVersion,
            sessionId: 's',
            eventType: 'guide_dismissed',
            occurredAt: new Date().toISOString(),
          },
        ],
      });
    expect((await active('alice')).map((g) => g.id)).toEqual([guideId]);
  });
});
