import express from 'express';
import type { Logger } from 'pino';
import { authRouter } from './routes/auth';
import { agentApiRouter, agentScriptRouter } from './routes/agent';
import { studioRouter } from './routes/studio';
import { getAuthConfig } from './auth/config';
import { previewSecret } from './preview';
import { HttpError } from './httpError';
import { logger as rootLogger, requestLogger, requestLogging } from './logging';
import { metricsHandler, requestMetrics } from './metrics';
import { healthRoutes } from './health';
import { routeLabel } from './routeLabel';
import type { ErrorReporter } from './errorTracking';
import type { ReadinessProbe } from './health';

export interface AppOptions {
  /** Defaults to the process logger; tests pass one writing to a buffer. */
  logger?: Logger;
  /** Where 5xx failures are reported (Sentry in production); none by default. */
  reportError?: ErrorReporter | null;
  /** What GET /ready checks; defaults to the shared pg Pool. */
  readiness?: ReadinessProbe;
}

/**
 * Builds the Express app without binding a port, so integration tests can
 * drive it with supertest and index.ts owns process-level concerns (env,
 * boot checks, listen).
 */
export function createApp(options: AppOptions = {}): express.Express {
  // Validate config up front: missing or weak auth settings must stop the
  // process at boot, not fail per request.
  getAuthConfig();
  previewSecret(); // throws on a weak or reused preview secret; unset = preview off

  const log = options.logger ?? rootLogger;
  const reportError = options.reportError ?? null;

  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY === 'true'); // real client IPs for rate limiting behind a proxy
  // First, so every response (including errors and 404s) carries a request
  // id and is counted.
  app.use(requestLogging(log));
  app.use(requestMetrics());
  app.use(express.json({ limit: '256kb' })); // guides + event batches are small; cap defensively

  app.use(healthRoutes(options.readiness));
  app.get('/metrics', metricsHandler());
  app.use('/auth', authRouter);

  // Public agent: the install snippet's script and API (per-app CORS inside).
  app.use('/agent/v1', agentScriptRouter);
  app.use('/v1/agent/:key', agentApiRouter);

  // Studio API: same-origin via the Studio's /api proxy, so no CORS here.
  app.use('/v1', studioRouter);

  // Centralized error handler — never leak stack traces or let an unhandled
  // rejection crash the process for a single bad request.
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const reqLog = requestLogger(req);
    const requestId = String(req.id ?? '');
    const route = routeLabel(req, res);

    if (err instanceof HttpError) {
      if (err.status >= 500) {
        // Deliberate 5xx (e.g. preview not configured) still means an operator should look.
        reqLog.error({ err, status: err.status, code: err.code, route }, 'request failed');
        reportError?.(err, { requestId, route, status: err.status });
      } else {
        // Expected outcomes (404s, validation, rate limits): no stack, just the facts.
        reqLog.info({ status: err.status, code: err.code, route }, 'request rejected');
      }
      res
        .status(err.status)
        .json(err.details ? { error: err.code, details: err.details } : { error: err.code });
      return;
    }
    // body-parser failures are the client's fault, not an outage: answer 4xx
    // (and keep them out of the 5xx alerts).
    const bodyError = err && typeof err === 'object' && 'type' in err ? (err as { type: string }).type : null;
    if (bodyError === 'entity.too.large') {
      reqLog.info({ status: 413, code: 'payload_too_large', route }, 'request rejected');
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    if (bodyError === 'entity.parse.failed') {
      reqLog.info({ status: 400, code: 'invalid_body', route }, 'request rejected');
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    reqLog.error({ err, status: 500, route }, 'unhandled error');
    reportError?.(err, { requestId, route, status: 500 });
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
