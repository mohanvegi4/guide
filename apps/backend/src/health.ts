import { Router } from 'express';
import { pool } from './db';

/** The one database call readiness needs. `pg.Pool` satisfies it; tests pass a failing stand-in. */
export interface ReadinessProbe {
  query(sql: string): Promise<unknown>;
}

// Orchestrators poll readiness every few seconds; a probe that waits on a
// saturated pool forever would never report the problem. Past this, the
// instance is not ready, whatever the database eventually answers.
const READY_TIMEOUT_MS = 2_000;

/**
 * Liveness and readiness, kept apart on purpose:
 *   GET /health  "the process is up" — never touches the database, so a
 *                database outage doesn't make orchestrators restart the
 *                backend (which wouldn't help).
 *   GET /ready   "this instance can serve traffic" — one round trip to
 *                Postgres; 503 pulls the instance out of the load balancer.
 */
export function healthRoutes(db: ReadinessProbe = pool): Router {
  const router = Router();
  router.get('/health', (_req, res) => res.json({ ok: true }));
  router.get('/ready', async (_req, res) => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('readiness probe timed out')), READY_TIMEOUT_MS);
    });
    try {
      await Promise.race([db.query('SELECT 1'), timeout]);
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    } finally {
      clearTimeout(timer);
    }
  });
  return router;
}
