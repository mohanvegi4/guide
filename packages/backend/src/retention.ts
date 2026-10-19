import { withRetentionSession, withoutScope } from './db';
import { logger } from './logging';
import { retentionDeletedTotal } from './metrics';

/** Default sink for the job's progress lines: the structured log (scripts pass console.log). */
const logInfo = (msg: string) => logger.info(msg);

/**
 * Keeps the database from growing forever:
 *  - guide_event rows older than EVENT_RETENTION_DAYS are deleted in batches
 *    (the only code path allowed to delete events — migration 010);
 *  - spent agent_rate_limit windows are swept.
 * Runs daily inside the backend (scheduleRetention) and on demand
 * (`npm run retention -- --days 400`). Several replicas may run it at once:
 * deleting the same old rows twice is harmless.
 */
export interface RetentionResult {
  events: number;
  rateLimitRows: number;
}

const BATCH = 10_000;

export async function runRetention(
  days: number,
  log: (msg: string) => void = logInfo,
): Promise<RetentionResult> {
  if (!Number.isInteger(days) || days < 1) throw new Error('retention: days must be a positive integer');
  let events = 0;
  for (;;) {
    const deleted = await withRetentionSession(async (client) => {
      const result = await client.query(
        `DELETE FROM guide_event WHERE id IN (
           SELECT id FROM guide_event WHERE occurred_at < now() - make_interval(days => $1)
           ORDER BY occurred_at LIMIT $2)`,
        [days, BATCH],
      );
      return result.rowCount ?? 0;
    });
    events += deleted;
    if (deleted < BATCH) break;
  }
  const swept = await withoutScope((client) =>
    client.query(`DELETE FROM agent_rate_limit WHERE window_start < now() - interval '1 hour'`),
  );
  const rateLimitRows = swept.rowCount ?? 0;
  // Counters only ever grow; a scrape that stops seeing them grow is the alert for a stuck job.
  retentionDeletedTotal.inc({ table: 'guide_event' }, events);
  retentionDeletedTotal.inc({ table: 'agent_rate_limit' }, rateLimitRows);
  log(
    `retention: deleted ${events} events older than ${days} days, ${rateLimitRows} spent rate-limit windows`,
  );
  return { events, rateLimitRows };
}

/** EVENT_RETENTION_DAYS: a positive number of days; 0 disables; unset = 400 in production, off elsewhere. */
export function retentionDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.EVENT_RETENTION_DAYS;
  if (raw === undefined || raw === '') return env.NODE_ENV === 'production' ? 400 : null;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0)
    throw new Error('EVENT_RETENTION_DAYS must be a whole number of days (0 = off).');
  return days === 0 ? null : days;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Starts the daily job (first run a minute after boot). Returns the timer, or null when retention is off. */
export function scheduleRetention(
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = logInfo,
): NodeJS.Timeout | null {
  const days = retentionDaysFromEnv(env);
  if (!days) return null;
  const run = () =>
    runRetention(days, log).catch((err) => log(`retention failed: ${(err as Error).message}`));
  setTimeout(run, 60_000).unref();
  const timer = setInterval(run, DAY_MS);
  timer.unref();
  log(`retention: events kept for ${days} days (daily job)`);
  return timer;
}
