import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { pool } from '../src/db';
import { adminPool, app, createTenant, resetData, samplePublishBody, sampleStep } from './helpers';
import { bearer, endUserBearer } from './auth-helpers';

describe('guide lifecycle', () => {
  let tenant: string;
  const admin = () => bearer(tenant);
  const user = () => endUserBearer(tenant);

  beforeEach(async () => {
    await resetData();
    tenant = await createTenant('Acme');
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.end();
  });

  async function activeIds(): Promise<string[]> {
    const res = await request(app).get('/guides/active').set('Authorization', user());
    expect(res.status).toBe(200);
    return res.body.map((g: { id: string }) => g.id);
  }

  it('create → publish → enable → active → disable → gone', async () => {
    // create
    const created = await request(app)
      .post('/guides')
      .set('Authorization', admin())
      .send({ name: 'Tour', type: 'tour' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'draft', enabled: false });
    const id = created.body.id as string;

    // publish (guides are created disabled, so not active yet)
    const published = await request(app)
      .post(`/guides/${id}/publish`)
      .set('Authorization', admin())
      .send(samplePublishBody);
    expect(published.status).toBe(201);
    expect(published.body.versionNumber).toBe(1);
    expect(await activeIds()).toEqual([]);

    // flag on → visible to end users
    const on = await request(app)
      .patch(`/guides/${id}/flag`)
      .set('Authorization', admin())
      .send({ enabled: true });
    expect(on.body).toEqual({ id, enabled: true });
    expect(await activeIds()).toEqual([id]);

    // flag off → disappears
    await request(app).patch(`/guides/${id}/flag`).set('Authorization', admin()).send({ enabled: false });
    expect(await activeIds()).toEqual([]);

    // listed for the author throughout
    const list = await request(app).get('/guides').set('Authorization', admin());
    expect(list.body).toEqual([
      expect.objectContaining({ id, status: 'published', current_version_number: 1 }),
    ]);
  });

  it('rollback switches which version /guides/active serves', async () => {
    const id = (
      await request(app).post('/guides').set('Authorization', admin()).send({ name: 'G', type: 'tooltip' })
    ).body.id;
    await request(app).post(`/guides/${id}/publish`).set('Authorization', admin()).send(samplePublishBody);
    await request(app)
      .post(`/guides/${id}/publish`)
      .set('Authorization', admin())
      .send({ ...samplePublishBody, steps: [{ ...sampleStep, content: '<p>Version two</p>' }] });
    await request(app).patch(`/guides/${id}/flag`).set('Authorization', admin()).send({ enabled: true });

    const contentNow = async () =>
      (await request(app).get('/guides/active').set('Authorization', user())).body[0].steps[0].content;
    expect(await contentNow()).toBe('<p>Version two</p>');

    const rb = await request(app).post(`/guides/${id}/rollback/1`).set('Authorization', admin());
    expect(rb.status).toBe(200);
    expect(await contentNow()).toBe(sampleStep.content);
  });

  it('respects the start/end window', async () => {
    const id = (
      await request(app).post('/guides').set('Authorization', admin()).send({ name: 'G', type: 'banner' })
    ).body.id;
    await request(app).patch(`/guides/${id}/flag`).set('Authorization', admin()).send({ enabled: true });
    const hour = 3600_000;

    await request(app)
      .post(`/guides/${id}/publish`)
      .set('Authorization', admin())
      .send({ ...samplePublishBody, startAt: new Date(Date.now() + hour).toISOString() });
    expect(await activeIds()).toEqual([]); // not started yet

    await request(app)
      .post(`/guides/${id}/publish`)
      .set('Authorization', admin())
      .send({ ...samplePublishBody, endAt: new Date(Date.now() - hour).toISOString() });
    expect(await activeIds()).toEqual([]); // already ended

    await request(app)
      .post(`/guides/${id}/publish`)
      .set('Authorization', admin())
      .send({
        ...samplePublishBody,
        startAt: new Date(Date.now() - hour).toISOString(),
        endAt: new Date(Date.now() + hour).toISOString(),
      });
    expect(await activeIds()).toEqual([id]);
  });

  it('reports global and per-tenant kill switches via /system/flag', async () => {
    const flag = async () => (await request(app).get('/system/flag').set('Authorization', user())).body;
    expect(await flag()).toEqual({ globalEnabled: true, tenantEnabled: true });

    await adminPool.query(
      `INSERT INTO tenant_config (tenant_id, key, value) VALUES ($1, 'guide_engine_enabled', 'false')`,
      [tenant],
    );
    expect(await flag()).toEqual({ globalEnabled: true, tenantEnabled: false });

    await adminPool.query(`UPDATE system_config SET value = 'false' WHERE key = 'guide_engine_enabled'`);
    expect(await flag()).toEqual({ globalEnabled: false, tenantEnabled: false });
  });

  it('counts ingested events in analytics', async () => {
    const id = (
      await request(app).post('/guides').set('Authorization', admin()).send({ name: 'G', type: 'tooltip' })
    ).body.id;
    const version = (
      await request(app).post(`/guides/${id}/publish`).set('Authorization', admin()).send(samplePublishBody)
    ).body;
    const event = (eventType: string) => ({
      guideId: id,
      guideVersionId: version.id,
      sessionId: 's',
      eventType,
      occurredAt: new Date().toISOString(),
    });
    const ingest = await request(app)
      .post('/events')
      .set('Authorization', user())
      .send({ events: [event('guide_shown'), event('guide_shown'), event('guide_completed')] });
    expect(ingest.status).toBe(202);

    const stats = await request(app).get(`/guides/${id}/analytics`).set('Authorization', admin());
    expect(stats.status).toBe(200);
    expect(stats.body.counts).toEqual(
      expect.arrayContaining([
        { event_type: 'guide_shown', count: 2 },
        { event_type: 'guide_completed', count: 1 },
      ]),
    );
  });
});
