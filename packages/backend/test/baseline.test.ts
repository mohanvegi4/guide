import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { pool } from '../src/db';
import { adminPool, app, createTenant, resetData, samplePublishBody } from './helpers';
import { bearer } from './auth-helpers';

process.env.GUIDE_ENGINE_DEV_AUTH = 'true';

// Regression tests for starter-repo bugs fixed in Task 0.
describe('baseline fixes', () => {
  let tenantA: string;
  let tenantB: string;

  beforeEach(async () => {
    await resetData();
    tenantA = await createTenant('Acme');
    tenantB = await createTenant('Globex');
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.end();
  });

  async function publishedEnabledGuide(tenantId: string): Promise<string> {
    const created = await request(app).post('/guides').set('Authorization', bearer(tenantId)).send({
      name: 'Welcome',
      type: 'tooltip',
    });
    const id = created.body.id as string;
    await request(app)
      .post(`/guides/${id}/publish`)
      .set('Authorization', bearer(tenantId))
      .send(samplePublishBody);
    await request(app)
      .patch(`/guides/${id}/flag`)
      .set('Authorization', bearer(tenantId))
      .send({ enabled: true });
    return id;
  }

  it('routes GET /guides/active to the active handler, not /:id', async () => {
    const res = await request(app).get('/guides/active').set('Authorization', bearer(tenantA));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns active guides in the SDK Guide shape with step ids', async () => {
    const id = await publishedEnabledGuide(tenantA);
    const res = await request(app).get('/guides/active').set('Authorization', bearer(tenantA));
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id, isGlobal: false, routeMatch: samplePublishBody.routeMatch });
    expect(res.body[0].versionId).toEqual(expect.any(String));
    expect(res.body[0].steps[0].id).toEqual(expect.any(String));
  });

  it("does not leak another tenant's active guides", async () => {
    await publishedEnabledGuide(tenantA);
    const res = await request(app).get('/guides/active').set('Authorization', bearer(tenantB));
    expect(res.body).toEqual([]);
  });

  it('returns 404 (not 500) for a malformed guide id', async () => {
    const res = await request(app).get('/guides/not-a-uuid').set('Authorization', bearer(tenantA));
    expect(res.status).toBe(404);
  });

  it('accepts step-level events now that step ids exist and the step FK is gone', async () => {
    const id = await publishedEnabledGuide(tenantA);
    const active = await request(app).get('/guides/active').set('Authorization', bearer(tenantA));
    const guide = active.body[0];
    const res = await request(app)
      .post('/events')
      .set('Authorization', bearer(tenantA))
      .send({
        events: [
          {
            guideId: id,
            guideVersionId: guide.versionId,
            stepId: guide.steps[0].id,
            sessionId: 's1',
            eventType: 'guide_step_viewed',
            occurredAt: new Date().toISOString(),
          },
        ],
      });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(1);
  });
});
