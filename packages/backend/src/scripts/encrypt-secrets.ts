import 'dotenv/config';
import { pool, withMaintenanceSession } from '../db';
import { encryptSecret, getSecretsKey, isEncrypted } from '../secrets';

/**
 * One-off after turning on SECRETS_KEY: re-writes every app signing secret
 * that is still stored in plaintext as an encrypted value. Safe to re-run;
 * already-encrypted rows are skipped. New secrets are encrypted on creation.
 *   npm run encrypt-secrets
 */
async function main(): Promise<void> {
  const key = getSecretsKey();
  if (!key) throw new Error('SECRETS_KEY is not set.');
  const { total, rewritten } = await withMaintenanceSession(async (client) => {
    const rows = await client.query<{ id: string; signing_secret: string }>(
      `SELECT id, signing_secret FROM application WHERE signing_secret IS NOT NULL`,
    );
    let rewritten = 0;
    for (const row of rows.rows) {
      if (isEncrypted(row.signing_secret)) continue;
      await client.query(`UPDATE application SET signing_secret = $2 WHERE id = $1`, [
        row.id,
        encryptSecret(row.signing_secret, key),
      ]);
      rewritten += 1;
    }
    return { total: rows.rows.length, rewritten };
  });
  console.log(`encrypt-secrets: ${rewritten} of ${total} signing secrets encrypted (the rest already were)`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
