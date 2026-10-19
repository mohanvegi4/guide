import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { loadAuthConfig } from '../src/auth/config';
import { DEV_TOKEN_ISSUER, verifyStudioToken } from '../src/auth/studio';
import { adminPool, app, closePools, resetData, studioToken } from './helpers';

afterAll(closePools);
beforeEach(resetData);

const devConfig = () => loadAuthConfig({ NODE_ENV: 'test', JWT_SECRET: process.env.JWT_SECRET });

describe('Studio tokens (development HS256)', () => {
  it('verifies a valid dev token into an identity', async () => {
    const identity = await verifyStudioToken(studioToken('alice'), devConfig(), null);
    expect(identity).toEqual({
      issuer: DEV_TOKEN_ISSUER,
      sub: 'alice',
      email: 'alice@example.com',
      emailVerified: true,
      name: 'alice',
    });
  });

  const invalid: Array<[string, () => string]> = [
    ['garbage', () => 'not-a-jwt'],
    [
      'wrong secret',
      () => jwt.sign({}, 'x'.repeat(40), { subject: 'a', issuer: DEV_TOKEN_ISSUER, expiresIn: '5m' }),
    ],
    ['expired', () => studioToken('a', {}, { expiresIn: -60 })],
    ['wrong issuer', () => studioToken('a', {}, { issuer: 'someone-else' })],
    [
      'no subject',
      () => jwt.sign({}, process.env.JWT_SECRET!, { issuer: DEV_TOKEN_ISSUER, expiresIn: '5m' }),
    ],
    ['no exp', () => jwt.sign({ sub: 'a', iss: DEV_TOKEN_ISSUER }, process.env.JWT_SECRET!)],
    [
      'alg:none',
      () => {
        const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
        return `${b64({ alg: 'none' })}.${b64({ sub: 'a', iss: DEV_TOKEN_ISSUER, exp: Date.now() / 1000 + 300 })}.`;
      },
    ],
  ];
  it.each(invalid)('rejects: %s', async (_name, make) => {
    expect(await verifyStudioToken(make(), devConfig(), null)).toBeNull();
  });

  it('is never accepted outside development/test', async () => {
    const prod = loadAuthConfig({
      NODE_ENV: 'production',
      JWT_SECRET: process.env.JWT_SECRET,
      OIDC_ISSUER: 'https://idp.example',
      OIDC_AUDIENCE: 'api',
    });
    expect(prod.devTokenSecret).toBeUndefined();
    expect(await verifyStudioToken(studioToken('alice'), prod, null)).toBeNull();
  });
});

describe('auth config', () => {
  it('requires OIDC outside development', () => {
    expect(() => loadAuthConfig({ NODE_ENV: 'production', JWT_SECRET: 'y'.repeat(40) })).toThrow(
      /OIDC_ISSUER is required/,
    );
    expect(() => loadAuthConfig({ JWT_SECRET: 'y'.repeat(40) })).toThrow(/OIDC_ISSUER is required/); // unset NODE_ENV
  });

  it('needs some sign-in method in development', () => {
    expect(() => loadAuthConfig({ NODE_ENV: 'development' })).toThrow(/No Studio sign-in configured/);
  });

  it('refuses a short JWT_SECRET', () => {
    expect(() => loadAuthConfig({ NODE_ENV: 'development', JWT_SECRET: 'short' })).toThrow(/at least 32/);
  });
});

describe('Studio sign-in', () => {
  it('401s without a token, and with an invalid one', async () => {
    expect((await request(app).get('/v1/me')).status).toBe(401);
    expect((await request(app).get('/v1/me').set('Authorization', 'Bearer nope')).status).toBe(401);
  });

  it('creates the Studio user on first sign-in (just-in-time) and reuses it after', async () => {
    const first = await request(app)
      .get('/v1/me')
      .set('Authorization', `Bearer ${studioToken('carol')}`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      user: { id: expect.any(String), email: 'carol@example.com', name: 'carol', platformAdmin: false },
      orgs: [],
    });
    const second = await request(app)
      .get('/v1/me')
      .set('Authorization', `Bearer ${studioToken('carol')}`);
    expect(second.body.user.id).toBe(first.body.user.id);
    const rows = await adminPool.query(`SELECT oidc_issuer, oidc_sub FROM studio_user`);
    expect(rows.rows).toEqual([{ oidc_issuer: DEV_TOKEN_ISSUER, oidc_sub: 'carol' }]);
  });

  it('GET /auth/config is public and exposes no secrets', async () => {
    const res = await request(app).get('/auth/config');
    expect(res.body).toEqual({ oidc: null, tokenPaste: true });
  });
});
