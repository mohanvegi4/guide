import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { generateKeyPairSync, KeyObject } from 'crypto';
import jwt from 'jsonwebtoken';
import { loadAuthConfig, OidcConfig } from '../src/auth/config';
import { createOidcVerifier } from '../src/auth/oidc';
import { verifyAndDecodeToken } from '../src/middleware/tenant';

const TENANT = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

/**
 * A minimal OIDC provider: discovery document + JWKS served over real HTTP,
 * so the verifier's discovery, key lookup and caching run for real.
 */
let server: Server;
let issuer: string;
let privateKey: KeyObject;
let publicKey: KeyObject;
let discoveryHits = 0;

beforeAll(async () => {
  ({ privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }));
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig', alg: 'RS256' };
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') {
      discoveryHits++;
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    } else if (req.url === '/jwks') {
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function config(overrides: Partial<OidcConfig> = {}): OidcConfig {
  return {
    issuer,
    audience: 'guide-engine-api',
    tenantClaim: 'tenantId',
    userClaim: 'sub',
    rolesClaim: 'roles',
    studioScope: 'openid',
    ...overrides,
  };
}

function idpToken(claims: Record<string, unknown>, options: jwt.SignOptions = {}): string {
  return jwt.sign(claims, privateKey, {
    algorithm: 'RS256',
    keyid: 'key-1',
    issuer,
    audience: 'guide-engine-api',
    expiresIn: '5m',
    ...options,
  });
}

describe('OIDC verifier', () => {
  it('accepts a provider-signed token and maps tenant, user and roles', async () => {
    const verify = createOidcVerifier(config());
    expect(await verify(idpToken({ sub: 'alice@corp', tenantId: TENANT, roles: ['guide_admin'] }))).toEqual({
      tenantId: TENANT,
      userId: 'alice@corp',
      roles: ['guide_admin'],
    });
  });

  it('supports custom and nested claim names, and space-separated roles', async () => {
    const verify = createOidcVerifier(
      config({ tenantClaim: 'https://guides/tenant', userClaim: 'email', rolesClaim: 'realm_access.roles' }),
    );
    const claims = await verify(
      idpToken({
        email: 'a@b.c',
        'https://guides/tenant': TENANT,
        realm_access: { roles: 'guide_admin platform_admin' },
      }),
    );
    expect(claims).toEqual({ tenantId: TENANT, userId: 'a@b.c', roles: ['guide_admin', 'platform_admin'] });
  });

  it.each<[string, () => string]>([
    ['wrong issuer', () => idpToken({ sub: 'a', tenantId: TENANT }, { issuer: 'https://evil.example' })],
    ['wrong audience', () => idpToken({ sub: 'a', tenantId: TENANT }, { audience: 'some-other-app' })],
    ['expired', () => idpToken({ sub: 'a', tenantId: TENANT }, { expiresIn: -60 })],
    ['missing tenant claim', () => idpToken({ sub: 'a' })],
    ['non-uuid tenant', () => idpToken({ sub: 'a', tenantId: 'acme' })],
    ['unknown signing key', () => idpToken({ sub: 'a', tenantId: TENANT }, { keyid: 'other-key' })],
    [
      'signed by a different key with the same kid',
      () => {
        const { privateKey: other } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        return jwt.sign({ sub: 'a', tenantId: TENANT }, other, {
          algorithm: 'RS256',
          keyid: 'key-1',
          issuer,
          audience: 'guide-engine-api',
          expiresIn: '5m',
        });
      },
    ],
  ])('rejects: %s', async (_name, makeToken) => {
    expect(await createOidcVerifier(config())(makeToken())).toBeNull();
  });

  it('rejects HS256 tokens forged with the public key as HMAC secret (algorithm confusion)', async () => {
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    // jsonwebtoken refuses to sign HS256 with a PEM, so build the token by hand.
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const { createHmac } = await import('crypto');
    const body = `${b64({ alg: 'HS256', typ: 'JWT', kid: 'key-1' })}.${b64({
      sub: 'a',
      tenantId: TENANT,
      iss: issuer,
      aud: 'guide-engine-api',
      exp: Math.floor(Date.now() / 1000) + 300,
    })}`;
    const forged = `${body}.${createHmac('sha256', pem).update(body).digest('base64url')}`;

    expect(await createOidcVerifier(config())(forged)).toBeNull();
    // And through the full dispatcher: HS256 goes to the JWT_SECRET path, which also rejects it.
    const authConfig = loadAuthConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(40),
      OIDC_ISSUER: 'https://idp.example',
      OIDC_AUDIENCE: 'a',
    });
    expect(await verifyAndDecodeToken(forged, authConfig, createOidcVerifier(config()))).toBeNull();
  });

  it('discovers the JWKS once and caches it', async () => {
    const verify = createOidcVerifier(config());
    const before = discoveryHits;
    for (let i = 0; i < 3; i++) await verify(idpToken({ sub: `u${i}`, tenantId: TENANT }));
    expect(discoveryHits - before).toBe(1);
  });

  it('fails closed when the provider is unreachable', async () => {
    const verify = createOidcVerifier(config({ issuer: 'http://127.0.0.1:1', jwksUri: undefined }));
    expect(await verify(idpToken({ sub: 'a', tenantId: TENANT }))).toBeNull();
  });
});

describe('token routing (HS256 vs OIDC)', () => {
  it('sends asymmetric tokens to the OIDC verifier and HS256 tokens to JWT_SECRET', async () => {
    const authConfig = loadAuthConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40) });
    const oidc = createOidcVerifier(config());
    const fromIdp = idpToken({ sub: 'alice', tenantId: TENANT, roles: ['guide_admin'] });
    const ours = jwt.sign({ tenantId: TENANT, userId: 'bob' }, 'x'.repeat(40), { expiresIn: '5m' });

    expect(await verifyAndDecodeToken(fromIdp, authConfig, oidc)).toMatchObject({ userId: 'alice' });
    expect(await verifyAndDecodeToken(ours, authConfig, oidc)).toMatchObject({ userId: 'bob' });
    // With OIDC not configured, provider tokens are simply not accepted.
    expect(await verifyAndDecodeToken(fromIdp, authConfig, null)).toBeNull();
  });
});

describe('OIDC config validation', () => {
  it('requires an audience', () => {
    expect(() => loadAuthConfig({ NODE_ENV: 'production', OIDC_ISSUER: 'https://idp.example' })).toThrow(
      /OIDC_AUDIENCE/,
    );
  });

  it('requires https outside local development', () => {
    expect(() =>
      loadAuthConfig({ NODE_ENV: 'production', OIDC_ISSUER: 'http://localhost:8080', OIDC_AUDIENCE: 'a' }),
    ).toThrow(/https/);
    expect(
      loadAuthConfig({
        NODE_ENV: 'development',
        OIDC_ISSUER: 'http://localhost:8080/default',
        OIDC_AUDIENCE: 'a',
      }).oidc,
    ).toMatchObject({ issuer: 'http://localhost:8080/default' });
  });

  it('allows OIDC-only deployments (no JWT_SECRET)', () => {
    const cfg = loadAuthConfig({
      NODE_ENV: 'production',
      OIDC_ISSUER: 'https://idp.example',
      OIDC_AUDIENCE: 'api',
    });
    expect(cfg.jwtSecret).toBeUndefined();
    expect(cfg.oidc?.audience).toBe('api');
  });
});
