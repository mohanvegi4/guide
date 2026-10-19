import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { agent, app, as, closePools, liveGuide, resetData, signUp, SITE, visitor } from './helpers';
import { createApp } from '../src/app';
import { metricsHandler } from '../src/metrics';
import { backendVersion, initErrorTracking } from '../src/errorTracking';
import { runRetention } from '../src/retention';
import { createLogger, requestIdFrom } from '../src/logging';
import type { IncomingMessage } from 'http';

// One Studio call can be made to fail like a database outage would, to drive
// the 500 path of the error handler through a real request.
let failStudioSessions = false;
vi.mock('../src/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db')>();
  return {
    ...actual,
    withStudioSession: (...args: Parameters<typeof actual.withStudioSession>) =>
      failStudioSessions
        ? Promise.reject(new Error('connection terminated'))
        : actual.withStudioSession(...args),
  };
});

afterAll(closePools);
beforeEach(resetData);
afterEach(() => {
  failStudioSessions = false;
});

/** A logger writing JSON lines into memory, and the parsed lines so far. */
function capturedLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(
    { NODE_ENV: 'test', LOG_LEVEL: 'info' },
    { write: (line) => void lines.push(JSON.parse(line)) },
  );
  return { logger, lines };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('request ids', () => {
  it('generates one per request and echoes it in X-Request-Id', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toMatch(UUID);
    const again = await request(app).get('/health');
    expect(again.headers['x-request-id']).not.toBe(res.headers['x-request-id']);
  });

  it('honours an incoming X-Request-Id, including on errors and unknown paths', async () => {
    const ok = await request(app).get('/health').set('X-Request-Id', 'proxy-abc.123:7');
    expect(ok.headers['x-request-id']).toBe('proxy-abc.123:7');
    const notFound = await request(app).get('/nowhere').set('X-Request-Id', 'proxy-404');
    expect(notFound.status).toBe(404);
    expect(notFound.headers['x-request-id']).toBe('proxy-404');
    const unauthorized = await request(app).get('/v1/orgs').set('X-Request-Id', 'proxy-401');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers['x-request-id']).toBe('proxy-401');
  });

  it('replaces an id that could not be logged safely', () => {
    const idFor = (value: string | string[] | undefined) =>
      requestIdFrom({ headers: { 'x-request-id': value } } as unknown as IncomingMessage);
    expect(idFor('ok-id_1.2:3')).toBe('ok-id_1.2:3');
    expect(idFor('has space')).toMatch(UUID);
    expect(idFor('new\nline')).toMatch(UUID);
    expect(idFor('x'.repeat(129))).toMatch(UUID);
    expect(idFor(['a', 'b'])).toMatch(UUID);
    expect(idFor(undefined)).toMatch(UUID);
  });
});

describe('GET /metrics', () => {
  it('is open in test/development when no METRICS_TOKEN is set, in Prometheus text format', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    for (const name of [
      'process_cpu_seconds_total',
      'nodejs_eventloop_lag_seconds',
      'http_requests_total',
      'http_request_duration_seconds',
      'agent_requests_total',
      'db_pool_total',
      'db_pool_idle',
      'db_pool_waiting',
      'retention_deleted_total',
    ]) {
      expect(res.text).toContain(`# TYPE ${name} `);
    }
  });

  it('requires the bearer token when METRICS_TOKEN is set, and does not exist otherwise', async () => {
    const protectedApp = express().get(
      '/metrics',
      metricsHandler({ NODE_ENV: 'production', METRICS_TOKEN: 'scrape-me-0123456789' }),
    );
    expect((await request(protectedApp).get('/metrics')).status).toBe(401);
    expect(
      (await request(protectedApp).get('/metrics').set('Authorization', 'Bearer scrape-me-wrong')).status,
    ).toBe(401);
    expect(
      (await request(protectedApp).get('/metrics').set('Authorization', 'scrape-me-0123456789')).status,
    ).toBe(401);
    const ok = await request(protectedApp)
      .get('/metrics')
      .set('Authorization', 'Bearer scrape-me-0123456789');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^text\/plain/);
    expect(ok.text).toContain('# TYPE http_requests_total counter');

    // The token is also required in development and test once it is configured.
    const devApp = express().get('/metrics', metricsHandler({ NODE_ENV: 'development', METRICS_TOKEN: 't' }));
    expect((await request(devApp).get('/metrics')).status).toBe(401);

    const hiddenApp = express().get('/metrics', metricsHandler({ NODE_ENV: 'production' }));
    expect((await request(hiddenApp).get('/metrics')).status).toBe(404);
  });

  it('labels requests by route pattern and agent endpoint, never by id or key', async () => {
    const { appId, key } = await signUp('alice');
    const { guideId } = await liveGuide('alice', appId);
    expect(
      (await request(app).get(`/v1/apps/${appId}/guides/${guideId}`).set('Authorization', as('alice')))
        .status,
    ).toBe(200);
    // A 404 thrown inside the route handler keeps its pattern.
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(
      (await request(app).get(`/v1/apps/${missing}/guides/${missing}`).set('Authorization', as('alice')))
        .status,
    ).toBe(404);
    expect((await agent(key, '/guides', visitor())).status).toBe(200);
    expect((await agent('ge_pk_' + 'f'.repeat(32), '/guides', visitor())).status).toBe(404); // rejected before any route
    expect((await agent(key, '/events', { ...visitor(), events: [] })).status).toBe(400);
    expect((await request(app).get(`/agent/v1/${key}/guides.js`)).status).toBe(200);
    await runRetention(400, () => undefined);

    const text = (await request(app).get('/metrics')).text;
    expect(text).toContain(
      'http_requests_total{route="/v1/apps/:appId/guides/:id",method="GET",status="200"}',
    );
    expect(text).toContain(
      'http_requests_total{route="/v1/apps/:appId/guides/:id",method="GET",status="404"}',
    );
    expect(text).toContain('http_requests_total{route="/v1/agent/:key/guides",method="POST",status="200"}');
    expect(text).toContain('http_requests_total{route="/v1/agent/:key/guides",method="POST",status="404"}');
    expect(text).toContain('http_requests_total{route="/agent/v1/:key/guides.js",method="GET",status="200"}');
    expect(text).toContain(
      'http_request_duration_seconds_bucket{le="+Inf",route="/v1/apps/:appId/guides/:id",method="GET"}',
    );
    expect(text).toContain('agent_requests_total{endpoint="guides",status="200"}');
    expect(text).toContain('agent_requests_total{endpoint="guides",status="404"}');
    expect(text).toContain('agent_requests_total{endpoint="events",status="400"}');
    expect(text).toContain('agent_requests_total{endpoint="script",status="200"}');
    expect(text).toContain('retention_deleted_total{table="guide_event"}');
    expect(text).toContain('retention_deleted_total{table="agent_rate_limit"}');
    expect(text).not.toContain(appId);
    expect(text).not.toContain(guideId);
    expect(text).not.toContain(key);
    expect(text).not.toContain('ge_pk_');
  });
});

describe('GET /health and /ready', () => {
  it('/health never touches the database; /ready answers 200 while it is reachable', async () => {
    expect((await request(app).get('/health')).body).toEqual({ ok: true });
    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ ok: true });
  });

  it('/ready answers 503 when the database cannot be queried', async () => {
    const down = createApp({ readiness: { query: () => Promise.reject(new Error('ECONNREFUSED')) } });
    const ready = await request(down).get('/ready');
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ ok: false });
    expect((await request(down).get('/health')).body).toEqual({ ok: true });
  });
});

describe('request logging and the error handler', () => {
  it('logs one structured line per request with the route pattern and a key prefix, never the key', async () => {
    const { logger, lines } = capturedLogger();
    const logged = createApp({ logger });
    const { appId, key } = await signUp('alice');
    await liveGuide('alice', appId);
    await request(logged)
      .get(`/v1/apps/${appId}/guides`)
      .set('Authorization', as('alice'))
      .set('X-Request-Id', 'r-1');
    await request(logged)
      .post(`/v1/agent/${key}/guides`)
      .set('Content-Type', 'text/plain')
      .set('Origin', SITE)
      .send(JSON.stringify(visitor()));
    await request(logged).get('/health'); // probes are not logged

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      level: 'info',
      msg: 'request completed',
      requestId: 'r-1',
      method: 'GET',
      route: '/v1/apps/:appId/guides',
      status: 200,
    });
    expect(typeof lines[0].durationMs).toBe('number');
    expect(lines[1]).toMatchObject({
      method: 'POST',
      route: '/v1/agent/:key/guides',
      status: 200,
      keyPrefix: key.slice(0, 14),
    });
    const all = JSON.stringify(lines);
    expect(all).not.toContain(appId);
    expect(all).not.toContain(key);
    expect(all).not.toContain('Bearer');
    expect(all).not.toContain('"headers"');
  });

  it('logs 4xx at info without a stack, and 5xx at error with the stack, request id and route', async () => {
    const { logger, lines } = capturedLogger();
    const reported: unknown[] = [];
    const observed = createApp({ logger, reportError: (err, context) => reported.push({ err, context }) });
    await signUp('alice');

    const missing = await request(observed)
      .get('/v1/orgs/00000000-0000-4000-8000-000000000000')
      .set('Authorization', as('alice'))
      .set('X-Request-Id', 'r-404');
    expect(missing.status).toBe(404);
    const rejected = lines.find((l) => l.msg === 'request rejected');
    expect(rejected).toMatchObject({ level: 'info', requestId: 'r-404', status: 404, code: 'not_found' });
    expect(rejected).not.toHaveProperty('err');
    expect(reported).toHaveLength(0);

    failStudioSessions = true;
    const failed = await request(observed)
      .get('/v1/me')
      .set('Authorization', as('alice'))
      .set('X-Request-Id', 'r-500');
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'internal_error' });
    const errored = lines.find((l) => l.msg === 'unhandled error');
    expect(errored).toMatchObject({ level: 'error', requestId: 'r-500', status: 500, route: '/v1/me' });
    expect((errored?.err as { stack?: string }).stack).toContain('connection terminated');
    expect(reported).toEqual([
      {
        err: expect.objectContaining({ message: 'connection terminated' }),
        context: { requestId: 'r-500', route: '/v1/me', status: 500 },
      },
    ]);
    // The request line for a 5xx is at error level too.
    expect(lines.find((l) => l.msg === 'request completed' && l.requestId === 'r-500')).toMatchObject({
      level: 'error',
      status: 500,
    });
  });

  it('reports a deliberate 5xx (HttpError) too, and answers malformed JSON with 400', async () => {
    const { logger, lines } = capturedLogger();
    const reported: unknown[] = [];
    const observed = createApp({ logger, reportError: (err, context) => reported.push({ err, context }) });
    const { key } = await signUp('alice');

    const secret = process.env.PREVIEW_TOKEN_SECRET;
    delete process.env.PREVIEW_TOKEN_SECRET;
    try {
      const res = await request(observed)
        .post(`/v1/agent/${key}/preview`)
        .set('Content-Type', 'text/plain')
        .set('Origin', SITE)
        .send(JSON.stringify({ token: 'x' }));
      expect(res.status).toBe(503);
    } finally {
      process.env.PREVIEW_TOKEN_SECRET = secret;
    }
    expect(lines.find((l) => l.msg === 'request failed')).toMatchObject({
      level: 'error',
      status: 503,
      code: 'preview_not_configured',
      route: '/v1/agent/:key/preview',
    });
    expect(reported).toHaveLength(1);

    const bad = await request(observed)
      .post('/v1/orgs')
      .set('Authorization', as('alice'))
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid_body' });
    expect(reported).toHaveLength(1);
  });
});

describe('error tracking', () => {
  it('is off without SENTRY_DSN', () => {
    expect(initErrorTracking({})).toBeNull();
    expect(initErrorTracking({ NODE_ENV: 'production', SENTRY_DSN: '' })).toBeNull();
  });

  it('knows the backend version for the release tag', () => {
    expect(backendVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
