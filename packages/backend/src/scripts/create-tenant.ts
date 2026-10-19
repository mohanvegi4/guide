import 'dotenv/config';
import { parseArgs } from 'util';
import { pool, withoutTenant } from '../db';

/**
 * Dev helper: inserts a tenant row and prints its id.
 *
 *   npm run create-tenant -- --name Acme
 *
 * The tenant table itself isn't tenant-scoped, so withoutTenant() is correct here.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { name: { type: 'string' } } });
  if (!values.name) {
    console.error('usage: npm run create-tenant -- --name <tenant name>');
    process.exit(1);
  }
  const result = await withoutTenant((client) =>
    client.query<{ id: string }>(`INSERT INTO tenant (name) VALUES ($1) RETURNING id`, [values.name]),
  );
  console.log(result.rows[0].id);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
