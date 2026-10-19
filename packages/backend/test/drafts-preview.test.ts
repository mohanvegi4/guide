import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { pool, withTenant } from '../src/db';
import { signPreviewToken } from '../src/preview';
import { adminPool, app, createTenant, resetData, samplePublishBody, sampleStep } from './helpers';
import { bearer, endUserBearer, signToken } from './auth-helpers';

const draftBody = {
  steps: [{ ...sampleStep, content: '<p>Draft copy</p><script>x()</script>' }],
  routeMatch: { type: 'exact', value: '/projects' },
};

describe('drafts', () => {
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
  });

  it('saves a sanitized draft that is not live, and updates it in place', async () => {
    const first = await request(app)
      .put(`/guides/${guideId}/draft`)
      .set('Authorization', bearer(tenant))
      .send(draftBody);
    expect(first.status).toBe(200);
    expect(first.body.publishedAt).toBeNull();
    expect(first.body.steps[0].content).toBe('<p>Draft copy</p>');

    const second = await request(app)
      .put(`/guides/${guideId}/draft`)
      .set('Authorization', bearer(tenant))
      .send({ ...draftBody, routeMatch: { type: 'exact', value: '/other' } });
    expect(second.body.id).toBe(first.body.id); // one draft per guide
    expect(second.body.versionNumber).toBe(1);

    await request(app)
      .patch(`/guides/${guideId}/flag`)
      .set('Authorization', bearer(tenant))
      .send({ enabled: true });
    const active = await request(app).get('/guides/active').set('Authorization', endUserBearer(tenant));
    expect(active.body).toEqual([]); // drafts never reach end users
  });

  it('publishes the existing draft when POST /publish has no body', async () => {
    const draft = await request(app)
      .put(`/guides/${guideId}/draft`)
      .set('Authorization', bearer(tenant))
      .send(draftBody);
    const pub = await request(app)
      .post(`/guides/${guideId}/publish`)
      .set('Authorization', bearer(tenant))
      .send();
    expect(pub.status).toBe(201);
    expect(pub.body.id).toBe(draft.body.id);
    expect(pub.body.publishedAt).toEqual(expect.any(String));
  });

  it('400s publishing with no body and no draft', async () => {
    const res = await request(app)
      .post(`/guides/${guideId}/publish`)
      .set('Authorization', bearer(tenant))
      .send();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_draft_to_publish');
  });

  it('keeps version numbers monotonic across drafts and direct publishes', async () => {
    const v1 = await request(app)
      .post(`/guides/${guideId}/publish`)
      .set('Authorization', bearer(tenant))
      .send(samplePublishBody);
    const draft = await request(app)
      .put(`/guides/${guideId}/draft`)
      .set('Authorization', bearer(tenant))
      .send(draftBody);
    const v2 = await request(app)
      .post(`/guides/${guideId}/publish`)
      .set('Authorization', bearer(tenant))
      .send(samplePublishBody);
    expect([v1.body.versionNumber, draft.body.versionNumber, v2.body.versionNumber]).toEqual([1, 2, 2]);
    expect(v2.body.id).toBe(draft.body.id); // publishing with a body promotes the draft row
  });

  it('cannot roll back to a draft', async () => {
    await request(app).put(`/guides/${guideId}/draft`).set('Authorization', bearer(tenant)).send(draftBody);
    const res = await request(app).post(`/guides/${guideId}/rollback/1`).set('Authorization', bearer(tenant));
    expect(res.status).toBe(404);
  });

  it('enforces published-version immutability at the database level', async () => {
    const v1 = await request(app)
      .post(`/guides/${guideId}/publish`)
      .set('Authorization', bearer(tenant))
      .send(samplePublishBody);
    // Bypass the routes entirely: even a buggy route running as the app role
    // can't rewrite or delete history.
    const result = await withTenant(tenant, async (client) => {
      const upd = await client.query(`UPDATE guide_version SET steps = '[]' WHERE id = $1`, [v1.body.id]);
      const del = await client.query(`DELETE FROM guide_version WHERE id = $1`, [v1.body.id]);
      return { updated: upd.rowCount, deleted: del.rowCount };
    });
    expect(result).toEqual({ updated: 0, deleted: 0 });
  });
});

describe('preview', () => {
  let tenantA: string;
  let tenantB: string;
  let guideId: string;
  let draftId: string;

  beforeEach(async () => {
    await resetData();
    tenantA = await createTenant('Acme');
    tenantB = await createTenant('Globex');
    guideId = (
      await request(app)
        .post('/guides')
        .set('Authorization', bearer(tenantA))
        .send({ name: 'G', type: 'modal' })
    ).body.id;
    // Disabled (default) and never published — only a draft exists.
    draftId = (
      await request(app).put(`/guides/${guideId}/draft`).set('Authorization', bearer(tenantA)).send(draftBody)
    ).body.id;
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.end();
  });

  async function mint(versionId = draftId, tenant = tenantA) {
    return request(app)
      .post(`/guides/${guideId}/preview-token`)
      .set('Authorization', bearer(tenant))
      .send({ versionId });
  }

  function fetchPreview(token: string, auth = endUserBearer(tenantA)) {
    return request(app).get('/preview/guide').set('Authorization', auth).set('X-Guide-Preview', token);
  }

  it('mints a 15-minute link to the route, and renders a disabled, unpublished draft', async () => {
    const minted = await mint();
    expect(minted.status).toBe(201);
    expect(minted.body.url).toMatch(/^http:\/\/app\.test\/projects\?guidePreview=/);
    const ttl = new Date(minted.body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);

    const res = await fetchPreview(minted.body.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: guideId, versionId: draftId, preview: true });
    expect(res.body.steps[0].content).toBe('<p>Draft copy</p>');
  });

  it('rejects an expired token', async () => {
    const expired = jwt.sign(
      { typ: 'guide_preview', guideId, versionId: draftId, tenantId: tenantA },
      process.env.PREVIEW_TOKEN_SECRET!,
      { audience: 'guide-preview', issuer: 'guide-engine', expiresIn: -10 },
    );
    expect((await fetchPreview(expired)).status).toBe(403);
  });

  it('rejects a tampered token', async () => {
    const token = (await mint()).body.token as string;
    const [h, p, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...payload, versionId: guideId })).toString('base64url');
    expect((await fetchPreview(`${h}.${forged}.${sig}`)).status).toBe(403);
  });

  it('rejects a token signed with the wrong key or audience (e.g. an auth JWT)', async () => {
    expect(
      (await fetchPreview(signToken({ tenantId: tenantA, userId: 'u', guideId, versionId: draftId }))).status,
    ).toBe(403);
    const wrongKey = signPreviewToken({ guideId, versionId: draftId, tenantId: tenantA }, 'z'.repeat(40));
    expect((await fetchPreview(wrongKey)).status).toBe(403);
  });

  it("404s when tenant B's session presents tenant A's preview token", async () => {
    const token = (await mint()).body.token;
    expect((await fetchPreview(token, endUserBearer(tenantB))).status).toBe(404);
  });

  it("404s when tenant B tries to mint a preview token for tenant A's guide", async () => {
    expect((await mint(draftId, tenantB)).status).toBe(404);
  });

  it('requires a session as well as the preview token', async () => {
    const token = (await mint()).body.token;
    const res = await request(app).get('/preview/guide').set('X-Guide-Preview', token);
    expect(res.status).toBe(401);
  });
});
