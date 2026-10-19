import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { pool, withTenant } from '../src/db';
import { adminPool, app, createGlobalGuide, createTenant, resetData, samplePublishBody } from './helpers';
import { bearer, endUserBearer } from './auth-helpers';

/**
 * Tenant B must never read, change, or even confirm the existence of tenant
 * A's data. Cross-tenant access answers 404 — indistinguishable from "no such
 * guide" — never 403 or an empty-but-successful response.
 */
describe('tenant isolation', () => {
  let tenantA: string;
  let tenantB: string;
  let guideA: string;
  let versionA: string;

  beforeEach(async () => {
    await resetData();
    tenantA = await createTenant('Acme');
    tenantB = await createTenant('Globex');
    guideA = (
      await request(app)
        .post('/guides')
        .set('Authorization', bearer(tenantA))
        .send({ name: 'A', type: 'modal' })
    ).body.id;
    versionA = (
      await request(app)
        .post(`/guides/${guideA}/publish`)
        .set('Authorization', bearer(tenantA))
        .send(samplePublishBody)
    ).body.id;
    await request(app)
      .patch(`/guides/${guideA}/flag`)
      .set('Authorization', bearer(tenantA))
      .send({ enabled: true });
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.end();
  });

  const asB = () => bearer(tenantB);

  it.each([
    ['GET guide', () => request(app).get(`/guides/${guideA}`).set('Authorization', asB())],
    [
      'publish',
      () =>
        request(app).post(`/guides/${guideA}/publish`).set('Authorization', asB()).send(samplePublishBody),
    ],
    [
      'save draft',
      () => request(app).put(`/guides/${guideA}/draft`).set('Authorization', asB()).send(samplePublishBody),
    ],
    [
      'flag',
      () => request(app).patch(`/guides/${guideA}/flag`).set('Authorization', asB()).send({ enabled: false }),
    ],
    ['rollback', () => request(app).post(`/guides/${guideA}/rollback/1`).set('Authorization', asB())],
    ['analytics', () => request(app).get(`/guides/${guideA}/analytics`).set('Authorization', asB())],
    [
      'preview token',
      () =>
        request(app)
          .post(`/guides/${guideA}/preview-token`)
          .set('Authorization', asB())
          .send({ versionId: versionA }),
    ],
  ])("tenant B gets 404 for %s on tenant A's guide", async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it("leaves tenant A's guide untouched after B's attempts", async () => {
    await request(app).patch(`/guides/${guideA}/flag`).set('Authorization', asB()).send({ enabled: false });
    await request(app).post(`/guides/${guideA}/publish`).set('Authorization', asB()).send(samplePublishBody);
    const raw = await adminPool.query(
      `SELECT g.enabled, count(gv.*)::int AS versions FROM guide g JOIN guide_version gv ON gv.guide_id = g.id
       WHERE g.id = $1 GROUP BY g.enabled`,
      [guideA],
    );
    expect(raw.rows[0]).toEqual({ enabled: true, versions: 1 });
  });

  it("excludes tenant A's guides from B's list and active endpoints", async () => {
    expect((await request(app).get('/guides').set('Authorization', asB())).body).toEqual([]);
    expect(
      (await request(app).get('/guides/active').set('Authorization', endUserBearer(tenantB))).body,
    ).toEqual([]);
    expect(
      (await request(app).get('/guides/active').set('Authorization', endUserBearer(tenantA))).body,
    ).toHaveLength(1);
  });

  it("drops events B submits against A's guide id", async () => {
    const res = await request(app)
      .post('/events')
      .set('Authorization', endUserBearer(tenantB))
      .send({
        events: [
          {
            guideId: guideA,
            guideVersionId: versionA,
            sessionId: 's',
            eventType: 'guide_shown',
            occurredAt: new Date().toISOString(),
          },
        ],
      });
    expect(res.body.accepted).toBe(0);
    const raw = await adminPool.query(`SELECT count(*)::int AS n FROM guide_event`);
    expect(raw.rows[0].n).toBe(0);
  });

  describe('global guides', () => {
    let globalId: string;

    beforeEach(async () => {
      globalId = await createGlobalGuide('Platform announcement');
      const v = await adminPool.query<{ id: string }>(
        `INSERT INTO guide_version (guide_id, version_number, steps, route_match, published_at)
         VALUES ($1, 1, '[]', '{"type":"exact","value":"/"}', now()) RETURNING id`,
        [globalId],
      );
      await adminPool.query(
        `UPDATE guide SET current_version_id = $1, status = 'published', enabled = TRUE WHERE id = $2`,
        [v.rows[0].id, globalId],
      );
    });

    it('are served to every tenant via /guides/active', async () => {
      const b = (await request(app).get('/guides/active').set('Authorization', endUserBearer(tenantB))).body;
      expect(b.map((g: { id: string }) => g.id)).toEqual([globalId]);
      expect(b[0].isGlobal).toBe(true);
    });

    it('cannot be flagged, published or rolled back by a tenant', async () => {
      const flag = await request(app)
        .patch(`/guides/${globalId}/flag`)
        .set('Authorization', asB())
        .send({ enabled: false });
      const pub = await request(app)
        .post(`/guides/${globalId}/publish`)
        .set('Authorization', asB())
        .send(samplePublishBody);
      expect([flag.status, pub.status]).toEqual([404, 404]);
      const raw = await adminPool.query(`SELECT enabled FROM guide WHERE id = $1`, [globalId]);
      expect(raw.rows[0].enabled).toBe(true);
    });
  });

  describe('database-level enforcement (RLS), independent of app-level WHERE clauses', () => {
    it("hides tenant A's rows from a tenant B session even with no WHERE clause", async () => {
      const rows = await withTenant(tenantB, async (client) => ({
        guides: (await client.query(`SELECT id FROM guide`)).rowCount,
        versions: (await client.query(`SELECT id FROM guide_version`)).rowCount,
        active: (await client.query(`SELECT id FROM active_guide`)).rowCount,
      }));
      expect(rows).toEqual({ guides: 0, versions: 0, active: 0 });
    });

    it("blocks writes to tenant A's rows from a tenant B session", async () => {
      const result = await withTenant(tenantB, async (client) => ({
        updated: (await client.query(`UPDATE guide SET enabled = FALSE`)).rowCount,
        deleted: (await client.query(`DELETE FROM guide`)).rowCount,
      }));
      expect(result).toEqual({ updated: 0, deleted: 0 });
    });

    it('rejects inserting a row for another tenant', async () => {
      await expect(
        withTenant(tenantB, (client) =>
          client.query(
            `INSERT INTO guide (tenant_id, name, type, created_by) VALUES ($1, 'x', 'modal', 'evil')`,
            [tenantA],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('returns nothing when no tenant is set on the session (fail closed)', async () => {
      const client = await pool.connect();
      try {
        expect((await client.query(`SELECT id FROM guide`)).rowCount).toBe(0);
      } finally {
        client.release();
      }
    });
  });
});
