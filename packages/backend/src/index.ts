import 'dotenv/config';
import { createApp } from './app';
import { assertRlsEnforceable, pool } from './db';
import { initErrorTracking } from './errorTracking';
import { logger } from './logging';
import { assertMigrationsApplied } from './migrate';
import { assertProductionConfig } from './production';
import { scheduleRetention } from './retention';

async function main(): Promise<void> {
  // Fail closed at boot: a production deployment missing its secrets, a DB
  // role that would bypass RLS, or a schema behind the code (RUN_MIGRATIONS=false
  // and a release step that forgot to migrate) doesn't serve traffic.
  assertProductionConfig();
  await assertRlsEnforceable();
  await assertMigrationsApplied(pool);

  // Only when SENTRY_DSN is set; otherwise 5xx errors are logged and nothing more.
  const reportError = initErrorTracking();
  const app = createApp({ reportError });
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  app.listen(port, () => {
    logger.info({ port, errorTracking: reportError !== null }, `guide-engine backend listening on :${port}`);
    scheduleRetention();
  });
}

main().catch((err) => {
  logger.fatal({ err }, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
