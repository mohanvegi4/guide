import express from 'express';
import cors from 'cors';
import { guidesRouter, platformGuidesRouter } from './routes/guides';
import { eventsRouter } from './routes/events';
import { systemRouter } from './routes/system';
import { previewRouter } from './routes/preview';
import { authRouter } from './routes/auth';
import { getAuthConfig } from './auth/config';
import { previewSecret } from './preview';

/**
 * Builds the Express app without binding a port, so integration tests can
 * drive it with supertest and index.ts owns process-level concerns (env,
 * boot checks, listen).
 */
export function createApp(): express.Express {
  // Validate auth config up front: a missing/weak JWT_SECRET or a disallowed
  // dev-auth flag must stop the process at boot, not fail per request.
  getAuthConfig();
  previewSecret(); // throws on a weak or JWT-reused preview secret; unset = preview off

  const app = express();
  app.use(express.json({ limit: '256kb' })); // guides + event batches are small; cap defensively

  // The SDK runs inside host apps on other origins, so it needs CORS. Only
  // origins explicitly listed in CORS_ORIGINS are allowed; with the variable
  // unset no CORS headers are sent at all (same-origin only — fail closed).
  // The Authoring Studio goes through its dev-server proxy and doesn't need this.
  const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (allowedOrigins.length > 0) {
    app.use(
      cors({
        origin: allowedOrigins,
        allowedHeaders: ['Authorization', 'Content-Type', 'X-Guide-Preview'],
        maxAge: 600,
      })
    );
  }

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/auth', authRouter);
  app.use('/guides', guidesRouter);
  app.use('/platform/guides', platformGuidesRouter);
  app.use('/events', eventsRouter);
  app.use('/system', systemRouter);
  app.use('/preview', previewRouter);

  // Centralized error handler — never leak stack traces or let an unhandled
  // rejection crash the process for a single bad request.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
