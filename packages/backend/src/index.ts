import 'dotenv/config';
import { createApp } from './app';
import { assertRlsEnforceable } from './db';

async function main(): Promise<void> {
  // Fail closed at boot: if the DB role would bypass RLS, don't serve traffic.
  await assertRlsEnforceable();

  const app = createApp();
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  app.listen(port, () => {
    console.log(`guide-engine backend listening on :${port}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
