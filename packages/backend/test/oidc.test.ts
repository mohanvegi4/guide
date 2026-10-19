import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { generateKeyPairSync, KeyObject } from 'crypto';
import jwt from 'jsonwebtoken';
import { loadAuthConfig, OidcConfig } from '../src/auth/config';
import { createOidcVerifier } from '../src/auth/oidc';
import { DEV_TOKEN_ISSUER, verifyStudioToken } from '../src/auth/studio';

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
  return { issuer, audience: 'guide-engine-api', studioScope: 'openid', ...overrides };
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

describe('OIDC verifier (identity only)', () => {
  it('maps a provider-signed token to an identity', async () => {
    const verify = createOidcVerifier(config());
    expect(
      await verify(idpToken({ sub: 'u-1', email: 'a@corp.com', email_verified: true, name: 'Alice' })),
    ).toEqual({
      issuer,
      sub: 'u-1',
      email: 'a@corp.com',
      emailVerified: true,
      name: 'Alice',
    });
  });

  it('treats email as unverified unless the provider says so, and falls back to preferred_username', async () => {
    const verify = createOidcVerifier(config());
    expect(await verify(idpToken({ sub: 'u-2', email: 'b@corp.com', preferred_username: 'bee' }))).toEqual({
      issuer,
      sub: 'u-2',
      email: 'b@corp.com',
      emailVerified: false,
      name: 'bee',
    });
  });

  it.each<[string, () => string]>([
    ['wrong issuer', () => idpToken({ sub: 'a' }, { issuer: 'https://evil.example' })],
    ['wrong audience', () => idpToken({ sub: 'a' }, { audience: 'some-other-app' })],
    ['expired', () => idpToken({ sub: 'a' }, { expiresIn: -60 })],
    ['missing sub', () => idpToken({ email: 'x@y.z' })],
    ['unknown signing key', () => idpToken({ sub: 'a' }, { keyid: 'other-key' })],
    [
      'signed by a different key with the same kid',
      () => {
        const { privateKey: other } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        return jwt.sign({ sub: 'a' }, other, {
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
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const { createHmac } = await import('crypto');
    const body = `${b64({ alg: 'HS256', typ: 'JWT', kid: 'key-1' })}.${b64({
      sub: 'a',
      iss: issuer,
      aud: 'guide-engine-api',
      exp: Math.floor(Date.now() / 1000) + 300,
    })}`;
    const forged = `${body}.${createHmac('sha256', pem).update(body).digest('base64url')}`;

    expect(await createOidcVerifier(config())(forged)).toBeNull();
    // Through the full dispatcher: HS256 goes to the dev-token path, which rejects it too.
    const devConfig = loadAuthConfig({ NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40) });
    expect(await verifyStudioToken(forged, devConfig, createOidcVerifier(config()))).toBeNull();
  });

  it('discovers the JWKS once and caches it', async () => {
    const verify = createOidcVerifier(config());
    const before = discoveryHits;
    for (let i = 0; i < 3; i++) await verify(idpToken({ sub: `u${i}` }));
    expect(discoveryHits - before).toBe(1);
  });

  it('fails closed when the provider is unreachable', async () => {
    const verify = createOidcVerifier(config({ issuer: 'http://127.0.0.1:1', jwksUri: undefined }));
    expect(await verify(idpToken({ sub: 'a' }))).toBeNull();
  });
});

describe('token routing (dev HS256 vs OIDC)', () => {
  it('sends asymmetric tokens to the OIDC verifier and HS256 tokens to the dev secret', async () => {
    const devConfig = loadAuthConfig({ NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40) });
    const oidc = createOidcVerifier(config());
    const fromIdp = idpToken({ sub: 'alice' });
    const dev = jwt.sign({}, 'x'.repeat(40), { subject: 'bob', issuer: DEV_TOKEN_ISSUER, expiresIn: '5m' });

    expect(await verifyStudioToken(fromIdp, devConfig, oidc)).toMatchObject({ sub: 'alice', issuer });
    expect(await verifyStudioToken(dev, devConfig, oidc)).toMatchObject({
      sub: 'bob',
      issuer: DEV_TOKEN_ISSUER,
    });
    // With OIDC not configured, provider tokens are simply not accepted.
    expect(await verifyStudioToken(fromIdp, devConfig, null)).toBeNull();
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

  it('allows OIDC-only production deployments', () => {
    const cfg = loadAuthConfig({
      NODE_ENV: 'production',
      OIDC_ISSUER: 'https://idp.example',
      OIDC_AUDIENCE: 'api',
    });
    expect(cfg.devTokenSecret).toBeUndefined();
    expect(cfg.oidc?.audience).toBe('api');
  });
});
