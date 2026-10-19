import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { pool, withTenant } from '../src/db';
import { adminPool, app, createTenant, resetData, samplePublishBody } from './helpers';
import { bearer, endUserBearer, platformBearer } from './auth-helpers';

describe('global guides (platform_admin)', () => {
  let home: string; // platform admin's own tenant
  let tenantA: string;
  let tenantB: string;

  beforeEach(async () => {
    await resetData();
    home = await createTenant('Platform');
    tenantA = await createTenant('Acme');
    tenantB = await createTenant('Globex');
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.end();
  });

  const asPlatform = () => platformBearer(home);

  async function liveGlobalGuide(): Promise<{ id: string; versionId: string }> {
    const created = await request(app)
      .post('/platform/guides')
      .set('Authorization', asPlatform())
      .send({ name: 'Maintenance notice', type: 'banner' });
    expect(created.status).toBe(201);
    expect(created.body.is_global).toBe(true);
    const id = created.body.id as string;
    const pub = await request(app)
      .post(`/platform/guides/${id}/publish`)
      .set('Authorization', asPlatform())
      .send(samplePublishBody);
    expect(pub.status).toBe(201);
    await request(app)
      .patch(`/platform/guides/${id}/flag`)
      .set('Authorization', asPlatform())
      .send({ enabled: true });
    return { id, versionId: pub.body.id };
  }

  it('lets a platform admin create, publish and enable a guide every tenant sees', async () => {
    const { id } = await liveGlobalGuide();
    for (const t of [tenantA, tenantB, home]) {
      const active = await request(app).get('/guides/active').set('Authorization', endUserBearer(t));
      expect(active.body.map((g: { id: string }) => g.id)).toEqual([id]);
    }
    const raw = await adminPool.query(`SELECT tenant_id, is_global, enabled FROM guide WHERE id = $1`, [id]);
    expect(raw.rows[0]).toEqual({ tenant_id: null, is_global: true, enabled: true });
  });

  it('lists only global guides in platform scope, and keeps them out of tenant lists', async () => {
    const { id } = await liveGlobalGuide();
    await request(app)
      .post('/guides')
      .set('Authorization', bearer(tenantA))
      .send({ name: 'A own', type: 'modal' });

    const platformList = await request(app).get('/platform/guides').set('Authorization', asPlatform());
    expect(platformList.body.map((g: { id: string }) => g.id)).toEqual([id]);
    const tenantList = await request(app).get('/guides').set('Authorization', bearer(tenantA));
    expect(tenantList.body.map((g: { name: string }) => g.name)).toEqual(['A own']);
  });

  it('403s guide_admins (and end users) on platform routes', async () => {
    expect((await request(app).get('/platform/guides').set('Authorization', bearer(tenantA))).status).toBe(
      403,
    );
    expect(
      (await request(app).get('/platform/guides').set('Authorization', endUserBearer(tenantA))).status,
    ).toBe(403);
    expect((await request(app).get('/platform/guides')).status).toBe(401);
  });

  it("gives platform admins no access to tenants' own guides", async () => {
    const own = (
      await request(app)
        .post('/guides')
        .set('Authorization', bearer(tenantA))
        .send({ name: 'A', type: 'modal' })
    ).body.id;
    await request(app)
      .post(`/guides/${own}/publish`)
      .set('Authorization', bearer(tenantA))
      .send(samplePublishBody);

    for (const call of [
      () => request(app).get(`/platform/guides/${own}`),
      () => request(app).patch(`/platform/guides/${own}/flag`).send({ enabled: true }),
      () => request(app).post(`/platform/guides/${own}/publish`).send(samplePublishBody),
      () => request(app).get(`/platform/guides/${own}/analytics`),
    ]) {
      expect((await call().set('Authorization', asPlatform())).status).toBe(404);
    }
  });

  it('aggregates global-guide analytics across tenants for platform admins only', async () => {
    const { id, versionId } = await liveGlobalGuide();
    const shown = {
      guideId: id,
      guideVersionId: versionId,
      sessionId: 's',
      eventType: 'guide_shown',
      occurredAt: new Date().toISOString(),
    };
    await request(app)
      .post('/events')
      .set('Authorization', endUserBearer(tenantA))
      .send({ events: [shown] });
    await request(app)
      .post('/events')
      .set('Authorization', endUserBearer(tenantB))
      .send({ events: [shown, shown] });

    const platform = await request(app)
      .get(`/platform/guides/${id}/analytics`)
      .set('Authorization', asPlatform());
    expect(platform.body.counts).toEqual([{ event_type: 'guide_shown', count: 3 }]);

    // A tenant looking at the same global guide sees only its own usage.
    const tenant = await request(app).get(`/guides/${id}/analytics`).set('Authorization', bearer(tenantA));
    expect(tenant.body.counts).toEqual([{ event_type: 'guide_shown', count: 1 }]);
  });

  it('previews a draft of a global guide inside the admin’s own tenant', async () => {
    const id = (
      await request(app)
        .post('/platform/guides')
        .set('Authorization', asPlatform())
        .send({ name: 'G', type: 'modal' })
    ).body.id;
    const draft = await request(app)
      .put(`/platform/guides/${id}/draft`)
      .set('Authorization', asPlatform())
      .send(samplePublishBody);
    const minted = await request(app)
      .post(`/platform/guides/${id}/preview-token`)
      .set('Authorization', asPlatform())
      .send({ versionId: draft.body.id });
    expect(minted.status).toBe(201);

    const res = await request(app)
      .get('/preview/guide')
      .set('Authorization', endUserBearer(home))
      .set('X-Guide-Preview', minted.body.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, isGlobal: true, preview: true });
  });

  describe('database-level enforcement', () => {
    it('allows global writes only with the platform-admin session flag', async () => {
      const { id } = await liveGlobalGuide();
      const without = await withTenant(tenantA, (c) =>
        c.query(`UPDATE guide SET enabled = FALSE WHERE id = $1`, [id]),
      );
      expect(without.rowCount).toBe(0);
      const withFlag = await withTenant(
        home,
        (c) => c.query(`UPDATE guide SET enabled = FALSE WHERE id = $1`, [id]),
        {
          platformAdmin: true,
        },
      );
      expect(withFlag.rowCount).toBe(1);
    });

    it("never widens access to another tenant's own rows, even with the flag", async () => {
      const own = (
        await request(app)
          .post('/guides')
          .set('Authorization', bearer(tenantA))
          .send({ name: 'A', type: 'modal' })
      ).body.id;
      const result = await withTenant(
        home,
        async (c) => ({
          visible: (await c.query(`SELECT id FROM guide WHERE id = $1`, [own])).rowCount,
          updated: (await c.query(`UPDATE guide SET enabled = TRUE WHERE id = $1`, [own])).rowCount,
          events: (await c.query(`SELECT id FROM guide_event WHERE guide_id = $1`, [own])).rowCount,
        }),
        { platformAdmin: true },
      );
      expect(result).toEqual({ visible: 0, updated: 0, events: 0 });
    });

    it('keeps published global versions immutable', async () => {
      const { versionId } = await liveGlobalGuide();
      const res = await withTenant(
        home,
        (c) => c.query(`UPDATE guide_version SET steps = '[]' WHERE id = $1`, [versionId]),
        {
          platformAdmin: true,
        },
      );
      expect(res.rowCount).toBe(0);
    });
  });
});
