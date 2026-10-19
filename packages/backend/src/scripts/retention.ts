import 'dotenv/config';
import { parseArgs } from 'util';
import { pool } from '../db';
import { retentionDaysFromEnv, runRetention } from '../retention';

/**
 * Runs the retention job once (the backend also runs it daily):
 *   npm run retention -- [--days 400]
 * --days defaults to EVENT_RETENTION_DAYS.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { days: { type: 'string' } } });
  const days = values.days !== undefined ? Number(values.days) : retentionDaysFromEnv();
  if (!days) throw new Error('No retention period: pass --days or set EVENT_RETENTION_DAYS.');
  await runRetention(days, console.log); // a script talks to the terminal, not the log stream
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
