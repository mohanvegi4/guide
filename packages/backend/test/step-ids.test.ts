import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { pool } from '../src/db';
import { adminPool, app, createTenant, resetData, samplePublishBody, sampleStep } from './helpers';
import { bearer, endUserBearer } from './auth-helpers';

describe('stable step ids + per-step analytics', () => {
  let tenant: string;
  let guideId: string;

  beforeEach(async () => {
    await resetData();
    tenant = await createTenant('Acme');
    guideId = (
      await request(app)
        .post('/guides')
        .set('Authorization', bearer(tenant))
        .send({ name: 'G', type: 'tour' })
    ).body.id;
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.end();
  });

  const publish = (steps: object[]) =>
    request(app)
      .post(`/guides/${guideId}/publish`)
      .set('Authorization', bearer(tenant))
      .send({ ...samplePublishBody, steps });

  it('keeps step ids the author sends back, and assigns ids to new steps', async () => {
    const v1 = (await publish([sampleStep, { ...sampleStep, order: 1, content: '<p>two</p>' }])).body;
    const [a, b] = v1.steps.map((s: { id: string }) => s.id);

    // v2: reorder, edit, and add a step — existing ids travel with their steps.
    const v2 = (
      await publish([
        { ...sampleStep, id: b, order: 0, content: '<p>two (edited)</p>' },
        { ...sampleStep, id: a, order: 1 },
        { ...sampleStep, order: 2, content: '<p>new</p>' },
      ])
    ).body;
    expect(v2.steps.map((s: { id: string }) => s.id).slice(0, 2)).toEqual([b, a]);
    expect(v2.steps[2].id).toEqual(expect.any(String));
    expect([a, b]).not.toContain(v2.steps[2].id);
  });

  it('rejects duplicate step ids in one version', async () => {
    const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    const res = await publish([
      { ...sampleStep, id },
      { ...sampleStep, id, order: 1 },
    ]);
    expect(res.status).toBe(400);
  });

  it('returns per-step counts that accumulate across versions', async () => {
    const v1 = (await publish([sampleStep])).body;
    const stepId = v1.steps[0].id;
    const v2 = (await publish([{ ...sampleStep, id: stepId, content: '<p>edited</p>' }])).body;

    const ev = (versionId: string, eventType: string) => ({
      guideId,
      guideVersionId: versionId,
      stepId,
      sessionId: 's',
      eventType,
      occurredAt: new Date().toISOString(),
    });
    await request(app)
      .post('/events')
      .set('Authorization', endUserBearer(tenant))
      .send({
        events: [ev(v1.id, 'guide_shown'), ev(v2.id, 'guide_shown'), ev(v2.id, 'guide_step_completed')],
      });

    const stats = await request(app).get(`/guides/${guideId}/analytics`).set('Authorization', bearer(tenant));
    expect(stats.body.steps).toEqual(
      expect.arrayContaining([
        { step_id: stepId, event_type: 'guide_shown', count: 2 },
        { step_id: stepId, event_type: 'guide_step_completed', count: 1 },
      ]),
    );
  });
});
