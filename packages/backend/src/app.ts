import express from 'express';
import { authRouter } from './routes/auth';
import { agentApiRouter, agentScriptRouter } from './routes/agent';
import { studioRouter } from './routes/studio';
import { getAuthConfig } from './auth/config';
import { previewSecret } from './preview';
import { HttpError } from './httpError';

/**
 * Builds the Express app without binding a port, so integration tests can
 * drive it with supertest and index.ts owns process-level concerns (env,
 * boot checks, listen).
 */
export function createApp(): express.Express {
  // Validate config up front: missing or weak auth settings must stop the
  // process at boot, not fail per request.
  getAuthConfig();
  previewSecret(); // throws on a weak or reused preview secret; unset = preview off

  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY === 'true'); // real client IPs for rate limiting behind a proxy
  app.use(express.json({ limit: '256kb' })); // guides + event batches are small; cap defensively

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/auth', authRouter);

  // Public agent: the install snippet's script and API (per-app CORS inside).
  app.use('/agent/v1', agentScriptRouter);
  app.use('/v1/agent/:key', agentApiRouter);

  // Studio API: same-origin via the Studio's /api proxy, so no CORS here.
  app.use('/v1', studioRouter);

  // Centralized error handler — never leak stack traces or let an unhandled
  // rejection crash the process for a single bad request.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json(err.details ? { error: err.code, details: err.details } : { error: err.code });
      return;
    }
    if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
