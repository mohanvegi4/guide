import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { loadAuthConfig } from '../src/auth/config';
import { AuthedRequest, requireTenant, verifyAndDecodeToken } from '../src/middleware/tenant';
import { pool } from '../src/db';
import { app } from './helpers';
import { endUserBearer, signToken } from './auth-helpers';

const TENANT = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

// Minimal app: requireTenant + an echo route. No database involved, so these
// tests isolate the auth boundary itself.
const echoApp = express();
echoApp.get('/whoami', requireTenant, (req, res) => {
  const { tenantId, userId, roles } = req as AuthedRequest;
  res.json({ tenantId, userId, roles });
});

afterAll(async () => {
  await pool.end();
});

describe('requireTenant (JWT)', () => {
  it('populates req.tenantId / req.userId / req.role from a valid token', async () => {
    const token = signToken({ tenantId: TENANT, userId: 'u-42', role: 'guide_admin' });
    const res = await request(echoApp).get('/whoami').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tenantId: TENANT, userId: 'u-42', roles: ['guide_admin'] });
  });

  it('accepts a roles array claim (as identity providers often issue)', async () => {
    const token = signToken({ tenantId: TENANT, userId: 'u', roles: ['guide_admin', 'platform_admin'] });
    const res = await request(echoApp).get('/whoami').set('Authorization', `Bearer ${token}`);
    expect(res.body.roles).toEqual(['guide_admin', 'platform_admin']);
  });

  it('401s with no Authorization header', async () => {
    const res = await request(echoApp).get('/whoami');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_auth');
  });

  it('401s with a non-Bearer scheme', async () => {
    const res = await request(echoApp).get('/whoami').set('Authorization', `Basic abc`);
    expect(res.status).toBe(401);
  });

  const invalidCases: Array<[string, () => string]> = [
    ['garbage', () => 'not-a-jwt'],
    ['wrong secret', () => jwt.sign({ tenantId: TENANT, userId: 'u' }, 'x'.repeat(40), { expiresIn: '5m' })],
    ['expired', () => signToken({ tenantId: TENANT, userId: 'u' }, { expiresIn: -60 })],
    [
      'no exp claim',
      () =>
        jwt.sign({ tenantId: TENANT, userId: 'u' }, process.env.JWT_SECRET!, {
          algorithm: 'HS256',
          issuer: process.env.JWT_ISSUER,
          audience: process.env.JWT_AUDIENCE,
        }),
    ],
    ['wrong audience', () => signToken({ tenantId: TENANT, userId: 'u' }, { audience: 'someone-else' })],
    ['wrong issuer', () => signToken({ tenantId: TENANT, userId: 'u' }, { issuer: 'evil' })],
    ['missing tenantId', () => signToken({ userId: 'u' })],
    ['missing userId', () => signToken({ tenantId: TENANT })],
    ['non-uuid tenantId', () => signToken({ tenantId: 'acme', userId: 'u' })],
    [
      'alg:none',
      () => {
        const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const exp = Math.floor(Date.now() / 1000) + 300;
        return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ tenantId: TENANT, userId: 'u', exp })}.`;
      },
    ],
    ['dev-style token while dev auth is off', () => `${TENANT}:u:guide_admin`],
  ];

  it.each(invalidCases)('401s for %s', async (_name, makeToken) => {
    const res = await request(echoApp).get('/whoami').set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });
});

describe('dev auth bypass gating', () => {
  const base = { JWT_SECRET: 'y'.repeat(40), GUIDE_ENGINE_DEV_AUTH: 'true' };

  it('is allowed in development and test', () => {
    expect(loadAuthConfig({ ...base, NODE_ENV: 'development' }).devAuth).toBe(true);
    expect(loadAuthConfig({ ...base, NODE_ENV: 'test' }).devAuth).toBe(true);
  });

  it('refuses to boot in production', () => {
    expect(() => loadAuthConfig({ ...base, NODE_ENV: 'production' })).toThrow(/GUIDE_ENGINE_DEV_AUTH/);
  });

  it('refuses to boot when NODE_ENV is unset or unrecognized (e.g. staging)', () => {
    expect(() => loadAuthConfig({ ...base })).toThrow(/unset/);
    expect(() => loadAuthConfig({ ...base, NODE_ENV: 'staging' })).toThrow(/staging/);
  });

  it('accepts a dev token only when enabled, and still validates its tenant id', async () => {
    const devConfig = loadAuthConfig({ ...base, NODE_ENV: 'development' });
    expect(await verifyAndDecodeToken(`${TENANT}:u1:guide_admin`, devConfig)).toEqual({
      tenantId: TENANT,
      userId: 'u1',
      roles: ['guide_admin'],
    });
    expect(await verifyAndDecodeToken('acme:u1', devConfig)).toBeNull();

    const prodConfig = loadAuthConfig({ JWT_SECRET: 'y'.repeat(40), NODE_ENV: 'production' });
    expect(await verifyAndDecodeToken(`${TENANT}:u1`, prodConfig)).toBeNull();
  });
});

describe('auth config validation', () => {
  it('refuses to boot with neither JWT_SECRET nor OIDC outside dev auth', () => {
    expect(() => loadAuthConfig({ NODE_ENV: 'production' })).toThrow(/No token verification configured/);
  });

  it('refuses a short JWT_SECRET', () => {
    expect(() => loadAuthConfig({ NODE_ENV: 'production', JWT_SECRET: 'short' })).toThrow(/at least 32/);
  });
});

describe('authorization (guide_admin role)', () => {
  it('403s an end-user token on authoring routes', async () => {
    const auth = endUserBearer(TENANT);
    expect((await request(app).get('/guides').set('Authorization', auth)).status).toBe(403);
    expect(
      (await request(app).post('/guides').set('Authorization', auth).send({ name: 'x', type: 'modal' }))
        .status,
    ).toBe(403);
    expect(
      (await request(app).patch(`/guides/${TENANT}/flag`).set('Authorization', auth).send({ enabled: true }))
        .status,
    ).toBe(403);
  });
});

describe('/auth endpoints', () => {
  it('GET /auth/config is public and exposes no secrets', async () => {
    const res = await request(app).get('/auth/config');
    expect(res.status).toBe(200);
    // No OIDC configured in the test env: paste-a-token is the only login.
    expect(res.body).toEqual({ oidc: null, tokenPaste: true });
  });

  it('GET /auth/me returns the verified identity, and 401s without a token', async () => {
    const token = signToken({ tenantId: TENANT, userId: 'u-1', roles: ['platform_admin'] });
    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.body).toEqual({ tenantId: TENANT, userId: 'u-1', roles: ['platform_admin'] });
    expect((await request(app).get('/auth/me')).status).toBe(401);
  });
});
