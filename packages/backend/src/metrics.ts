import { createHash, timingSafeEqual } from 'crypto';
import type { Pool } from 'pg';
import type { RequestHandler } from 'express';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { pool } from './db';
import { agentEndpoint, routeLabel } from './routeLabel';

/**
 * Prometheus metrics for the backend, exposed at GET /metrics.
 *
 * Every label is drawn from a bounded set: the Express route pattern (see
 * routeLabel.ts), the method, the status code, the agent endpoint name, the
 * table a retention job cleaned. Never a public key, an app or an org — the
 * agent API is public, so a label from the URL would let anyone create time
 * series until the scraper falls over.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests served, by route pattern, method and status code.',
  labelNames: ['route', 'method', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds, by route pattern and method.',
  labelNames: ['route', 'method'] as const,
  // Agent calls should sit in the low tens of milliseconds; the tail buckets catch a slow database.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const agentRequestsTotal = new Counter({
  name: 'agent_requests_total',
  help: 'Public agent API requests (install snippets), by endpoint and status code.',
  labelNames: ['endpoint', 'status'] as const,
  registers: [registry],
});

export const retentionDeletedTotal = new Counter({
  name: 'retention_deleted_total',
  help: 'Rows deleted by the retention job, by table.',
  labelNames: ['table'] as const,
  registers: [registry],
});

/** pg Pool gauges, read when scraped so they cost nothing between scrapes. */
export function registerPoolGauges(dbPool: Pool, register: Registry = registry): void {
  new Gauge({
    name: 'db_pool_total',
    help: 'Clients in the Postgres pool (idle and checked out).',
    registers: [register],
    collect() {
      this.set(dbPool.totalCount);
    },
  });
  new Gauge({
    name: 'db_pool_idle',
    help: 'Idle clients in the Postgres pool.',
    registers: [register],
    collect() {
      this.set(dbPool.idleCount);
    },
  });
  new Gauge({
    name: 'db_pool_waiting',
    help: 'Requests waiting for a Postgres client; above zero means the pool is saturated.',
    registers: [register],
    collect() {
      this.set(dbPool.waitingCount);
    },
  });
}
registerPoolGauges(pool);

/** Counts and times every request once its response has finished. */
export function requestMetrics(): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const route = routeLabel(req, res);
      const status = String(res.statusCode);
      httpRequestsTotal.inc({ route, method: req.method, status });
      httpRequestDuration.observe(
        { route, method: req.method },
        Number(process.hrtime.bigint() - started) / 1e9,
      );
      const endpoint = agentEndpoint(req);
      if (endpoint) agentRequestsTotal.inc({ endpoint, status });
    });
    next();
  };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/**
 * GET /metrics. Served openly only in development and test without a token;
 * otherwise METRICS_TOKEN must be set and presented as a bearer token, and
 * without a token the endpoint doesn't exist (404, not 401: nothing to probe).
 * Metrics reveal traffic and error patterns, which is more than a public
 * endpoint should show.
 */
export function metricsHandler(
  env: NodeJS.ProcessEnv = process.env,
  register: Registry = registry,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const token = env.METRICS_TOKEN;
      if (token) {
        const header = req.header('authorization') ?? '';
        const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
        // Hashing first makes the comparison constant-time regardless of length.
        if (!presented || !timingSafeEqual(sha256(presented), sha256(token))) {
          res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' });
          return;
        }
      } else if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.set('Content-Type', register.contentType).send(await register.metrics());
    } catch (err) {
      next(err);
    }
  };
}
