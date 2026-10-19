import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addMember, adminPool, app, as, closePools, resetData, signUp, studioToken } from './helpers';
import { jsonOutbox } from '../src/mail';

afterAll(closePools);
beforeEach(resetData);

async function invite(adminSub: string, orgId: string, body: object) {
  return request(app).post(`/v1/orgs/${orgId}/invitations`).set('Authorization', as(adminSub)).send(body);
}

describe('invitations', () => {
  it('invites with an org role and app roles; accepting grants exactly those', async () => {
    const { orgId, appId } = await signUp('alice');
    const inv = await invite('alice', orgId, { orgRole: 'member', appRoles: { [appId]: 'editor' } });
    expect(inv.status).toBe(201);
    expect(inv.body.token.length).toBeGreaterThan(20);

    const preview = await request(app)
      .get(`/v1/invitations/${inv.body.token}`)
      .set('Authorization', as('bob'));
    expect(preview.body).toMatchObject({
      orgName: 'alice org',
      orgRole: 'member',
      apps: [{ id: appId, name: 'alice org app', role: 'editor' }],
      expired: false,
      accepted: false,
    });

    const accepted = await request(app)
      .post(`/v1/invitations/${inv.body.token}/accept`)
      .set('Authorization', as('bob'));
    expect(accepted.status).toBe(201);
    const me = await request(app).get('/v1/me').set('Authorization', as('bob'));
    expect(me.body.orgs).toEqual([
      {
        id: orgId,
        name: 'alice org',
        role: 'member',
        suspendedAt: null,
        apps: [{ id: appId, name: 'alice org app', role: 'editor' }],
      },
    ]);
  });

  it('stores only a hash of the link token', async () => {
    const { orgId } = await signUp('alice');
    const inv = await invite('alice', orgId, {});
    const raw = await adminPool.query(`SELECT token_hash FROM invitation`);
    expect(raw.rows[0].token_hash).not.toBe(inv.body.token);
    expect(raw.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is single-use', async () => {
    const { orgId } = await signUp('alice');
    const inv = await invite('alice', orgId, {});
    await request(app).post(`/v1/invitations/${inv.body.token}/accept`).set('Authorization', as('bob'));
    const again = await request(app)
      .post(`/v1/invitations/${inv.body.token}/accept`)
      .set('Authorization', as('carol'));
    expect(again.status).toBe(410);
    expect(again.body.error).toBe('invitation_used');
  });

  it('expires', async () => {
    const { orgId } = await signUp('alice');
    const inv = await invite('alice', orgId, {});
    await adminPool.query(`UPDATE invitation SET expires_at = now() - interval '1 minute'`);
    const res = await request(app)
      .post(`/v1/invitations/${inv.body.token}/accept`)
      .set('Authorization', as('bob'));
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('invitation_expired');
  });

  it('when addressed to an email, only that verified email can accept', async () => {
    const { orgId } = await signUp('alice');
    const inv = await invite('alice', orgId, { email: 'Bob@Example.com' });
    const wrong = await request(app)
      .post(`/v1/invitations/${inv.body.token}/accept`)
      .set('Authorization', as('mallory'));
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe('invitation_email_mismatch');
    const right = await request(app)
      .post(`/v1/invitations/${inv.body.token}/accept`)
      .set('Authorization', `Bearer ${studioToken('bob-2', { email: 'bob@example.com' })}`);
    expect(right.status).toBe(201);
  });

  it('unknown tokens are 404, and revoked invitations stop working', async () => {
    const { orgId } = await signUp('alice');
    expect(
      (
        await request(app)
          .get(`/v1/invitations/${'x'.repeat(43)}`)
          .set('Authorization', as('bob'))
      ).status,
    ).toBe(404);
    const inv = await invite('alice', orgId, {});
    expect(
      (
        await request(app)
          .delete(`/v1/orgs/${orgId}/invitations/${inv.body.id}`)
          .set('Authorization', as('alice'))
      ).status,
    ).toBe(204);
    expect(
      (await request(app).post(`/v1/invitations/${inv.body.token}/accept`).set('Authorization', as('bob')))
        .status,
    ).toBe(404);
  });

  it('only org admins can invite, and nobody can invite an owner', async () => {
    const { orgId } = await signUp('alice');
    await addMember('alice', orgId, 'bob', 'member');
    expect((await invite('bob', orgId, {})).status).toBe(403);
    expect((await invite('alice', orgId, { orgRole: 'owner' })).status).toBe(400);
  });

  it("can't grant roles on another org's app", async () => {
    const a = await signUp('alice');
    const b = await signUp('zed');
    const res = await invite('alice', a.orgId, { appRoles: { [b.appId]: 'app_admin' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_app');
  });
});

describe('invitation emails', () => {
  const mailEnv = {
    SMTP_URL: 'json://',
    MAIL_FROM: 'Guide Engine <no-reply@example.test>',
    STUDIO_URL: 'https://studio.example.test/',
  };

  afterEach(() => {
    process.env.SMTP_URL = '';
    process.env.MAIL_FROM = '';
    process.env.STUDIO_URL = '';
    jsonOutbox.length = 0;
  });

  it('are off by default: the link is returned and nothing is sent', async () => {
    const { orgId } = await signUp('alice');
    const res = await invite('alice', orgId, { email: 'bob@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(false);
    expect(res.body.token.length).toBeGreaterThan(20);
    expect(jsonOutbox).toHaveLength(0);
    expect((await request(app).get('/auth/config')).body.mailEnabled).toBe(false);
  });

  it('send the invite link when SMTP_URL, MAIL_FROM and STUDIO_URL are set', async () => {
    Object.assign(process.env, mailEnv);
    expect((await request(app).get('/auth/config')).body.mailEnabled).toBe(true);
    const { orgId } = await signUp('alice');
    const res = await invite('alice', orgId, { email: 'Bob@Example.com' });
    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(true);
    expect(jsonOutbox).toHaveLength(1);
    const mail = jsonOutbox[0];
    expect(mail.to).toBe('Bob@Example.com');
    expect(mail.from).toBe(mailEnv.MAIL_FROM);
    expect(mail.subject).toBe('alice invited you to alice org on Guide Studio');
    const link = `https://studio.example.test/invite/${res.body.token}`;
    expect(mail.text).toContain(link);
    expect(mail.html).toContain(`href="${link}"`);
    expect(mail.text).toContain('expires in 7 days');
    // The emailed link is the real one: it opens the invitation.
    const preview = await request(app)
      .get(`/v1/invitations/${res.body.token}`)
      .set('Authorization', as('bob'));
    expect(preview.status).toBe(200);
  });

  it('escape names in the HTML body', async () => {
    Object.assign(process.env, mailEnv);
    const { orgId } = await signUp('alice', '<b>Acme</b> & co');
    const res = await request(app)
      .post(`/v1/orgs/${orgId}/invitations`)
      .set('Authorization', `Bearer ${studioToken('alice', { name: 'Al <script>' })}`)
      .send({ email: 'bob@example.com' });
    expect(res.body.emailSent).toBe(true);
    expect(jsonOutbox[0].html).toContain('Al &lt;script&gt;');
    expect(jsonOutbox[0].html).toContain('&lt;b&gt;Acme&lt;/b&gt; &amp; co');
    expect(jsonOutbox[0].html).not.toContain('<script>');
  });

  it('skip sending, but still create the invitation, without an email or without STUDIO_URL', async () => {
    Object.assign(process.env, mailEnv);
    const { orgId } = await signUp('alice');
    expect((await invite('alice', orgId, {})).body.emailSent).toBe(false);
    process.env.STUDIO_URL = '';
    expect((await request(app).get('/auth/config')).body.mailEnabled).toBe(false);
    const res = await invite('alice', orgId, { email: 'bob@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(false);
    expect(jsonOutbox).toHaveLength(0);
  });
});

describe('managing members', () => {
  it('changes app roles and removes app grants with the membership', async () => {
    const { orgId, appId } = await signUp('alice');
    await addMember('alice', orgId, 'bob', 'member', { [appId]: 'viewer' });
    const me = await request(app).get('/v1/me').set('Authorization', as('bob'));
    const bobId = me.body.user.id;

    await request(app)
      .patch(`/v1/orgs/${orgId}/members/${bobId}`)
      .set('Authorization', as('alice'))
      .send({ appRoles: { [appId]: 'publisher' } });
    const members = await request(app).get(`/v1/orgs/${orgId}/members`).set('Authorization', as('alice'));
    expect(members.body.find((m: { userId: string }) => m.userId === bobId)).toMatchObject({
      orgRole: 'member',
      appRoles: { [appId]: 'publisher' },
    });

    await request(app).delete(`/v1/orgs/${orgId}/members/${bobId}`).set('Authorization', as('alice'));
    expect((await adminPool.query(`SELECT count(*)::int AS n FROM app_member`)).rows[0].n).toBe(0);
    expect((await request(app).get(`/v1/apps/${appId}`).set('Authorization', as('bob'))).status).toBe(404);
  });

  it('protects owners: only owners change owners, and the last owner stays', async () => {
    const { orgId } = await signUp('alice');
    await addMember('alice', orgId, 'bob', 'admin');
    const aliceId = (await request(app).get('/v1/me').set('Authorization', as('alice'))).body.user.id;
    const bobId = (await request(app).get('/v1/me').set('Authorization', as('bob'))).body.user.id;

    // admin can't demote or remove the owner, or make themselves owner
    expect(
      (
        await request(app)
          .patch(`/v1/orgs/${orgId}/members/${aliceId}`)
          .set('Authorization', as('bob'))
          .send({ orgRole: 'member' })
      ).status,
    ).toBe(403);
    expect(
      (await request(app).delete(`/v1/orgs/${orgId}/members/${aliceId}`).set('Authorization', as('bob')))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`/v1/orgs/${orgId}/members/${bobId}`)
          .set('Authorization', as('bob'))
          .send({ orgRole: 'owner' })
      ).status,
    ).toBe(403);
    // the last owner can't leave or step down
    expect(
      (await request(app).delete(`/v1/orgs/${orgId}/members/${aliceId}`).set('Authorization', as('alice')))
        .status,
    ).toBe(409);
    // ...but can hand over ownership, then step down
    await request(app)
      .patch(`/v1/orgs/${orgId}/members/${bobId}`)
      .set('Authorization', as('alice'))
      .send({ orgRole: 'owner' });
    expect(
      (
        await request(app)
          .patch(`/v1/orgs/${orgId}/members/${aliceId}`)
          .set('Authorization', as('alice'))
          .send({ orgRole: 'member' })
      ).status,
    ).toBe(204);
  });

  it('lets a member leave', async () => {
    const { orgId } = await signUp('alice');
    await addMember('alice', orgId, 'bob', 'member');
    const bobId = (await request(app).get('/v1/me').set('Authorization', as('bob'))).body.user.id;
    expect(
      (await request(app).delete(`/v1/orgs/${orgId}/members/${bobId}`).set('Authorization', as('bob')))
        .status,
    ).toBe(204);
    expect((await request(app).get('/v1/me').set('Authorization', as('bob'))).body.orgs).toEqual([]);
  });
});
