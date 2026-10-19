import 'dotenv/config';
import { createApp } from './app';
import { assertRlsEnforceable } from './db';
import { assertProductionConfig } from './production';
import { scheduleRetention } from './retention';

async function main(): Promise<void> {
  // Fail closed at boot: a production deployment missing its secrets, or a
  // DB role that would bypass RLS, doesn't serve traffic.
  assertProductionConfig();
  await assertRlsEnforceable();

  const app = createApp();
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  app.listen(port, () => {
    console.log(`guide-engine backend listening on :${port}`);
    scheduleRetention();
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
