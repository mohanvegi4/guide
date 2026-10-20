import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { agent, app, as, closePools, resetData, signUp, SITE, visitor } from './helpers';
import { isAgentSurface } from '../src/securityHeaders';

/**
 * The response headers every reply carries (securityHeaders.ts): nosniff
 * everywhere, framing denied and no referrer on our own endpoints, and
 * nothing on the agent surface that could get in the way of customers'
 * pages loading the script and calling the API cross-origin.
 */

afterAll(closePools);
beforeEach(resetData);

const DOCUMENT_HEADERS = {
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
};

describe('the Studio API and other first-party responses', () => {
  it('deny framing, send no referrer, and never advertise the framework', async () => {
    const res = await request(app).get('/v1/me').set('Authorization', as('alice'));
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers).toMatchObject(DOCUMENT_HEADERS);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('carry the headers on error responses too', async () => {
    const unauthorized = await request(app).get('/v1/orgs');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers['x-content-type-options']).toBe('nosniff');
    expect(unauthorized.headers).toMatchObject(DOCUMENT_HEADERS);
    expect(unauthorized.headers['x-powered-by']).toBeUndefined();

    const invalid = await request(app).post('/v1/orgs').set('Authorization', as('alice')).send({});
    expect(invalid.status).toBe(400);
    expect(invalid.headers).toMatchObject(DOCUMENT_HEADERS);
  });

  it('cover the public auth config and health too', async () => {
    for (const path of ['/auth/config', '/health']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers['x-content-type-options'], path).toBe('nosniff');
      expect(res.headers['x-frame-options'], path).toBe('DENY');
    }
  });
});

describe('the agent script', () => {
  it('gets nosniff only, keeping its cross-origin, caching and ETag behaviour', async () => {
    const { key } = await signUp('alice');
    const res = await request(app).get(`/agent/v1/${key}/guides.js`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/javascript/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    // Loaded by <script src> from any customer origin: nothing may restrict that.
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['cross-origin-embedder-policy']).toBeUndefined();
    expect(res.headers['cross-origin-opener-policy']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['referrer-policy']).toBeUndefined();
    expect(res.headers['cache-control']).toBe(
      'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
    );
    expect(res.headers['etag']).toMatch(/^"[0-9a-f]{16}"$/);
  });

  it('answers an unknown key the same way (no header tells the two apart)', async () => {
    const res = await request(app).get('/agent/v1/not-a-key/guides.js');
    expect(res.status).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['x-frame-options']).toBeUndefined();
  });
});

describe('the agent API', () => {
  it('keeps its per-app CORS answer and gets no framing or referrer headers', async () => {
    const { key } = await signUp('alice');
    const res = await agent(key, '/guides', visitor());
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(SITE);
    expect(res.headers['vary']).toContain('Origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['referrer-policy']).toBeUndefined();
    expect(res.headers['cross-origin-resource-policy']).toBeUndefined();

    const preflight = await request(app).options(`/v1/agent/${key}/guides`).set('Origin', SITE);
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(SITE);
    expect(preflight.headers['access-control-allow-methods']).toBe('POST');
    expect(preflight.headers['x-frame-options']).toBeUndefined();
  });

  it('classifies paths the way the routers are mounted', () => {
    expect(isAgentSurface('/agent/v1/ge_pk_0123/guides.js')).toBe(true);
    expect(isAgentSurface('/agent/v1/version')).toBe(true);
    expect(isAgentSurface('/v1/agent/ge_pk_0123/guides')).toBe(true);
    expect(isAgentSurface('/v1/agents')).toBe(false);
    expect(isAgentSurface('/v1/me')).toBe(false);
    expect(isAgentSurface('/auth/config')).toBe(false);
  });
});
