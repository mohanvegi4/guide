import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';
import jwt from 'jsonwebtoken';
import { loadAuthConfig } from '../auth/config';
import { DEV_TOKEN_ISSUER, provisionStudioUser } from '../auth/studio';
import { pool, withStudioSession } from '../db';
import { createOrgWithApp } from '../services/orgs';
import { seedWelcomeTour } from './welcome-tour';

/**
 * DEVELOPMENT ONLY: one-command local setup.
 *  - a dev Studio user (sub "dev-admin") who owns org "Demo Org"
 *  - app "Demo site" allowed on http://localhost:5174 (apps/demo), with a
 *    published five-step "Welcome tour" on its dashboard (welcome-tour.ts)
 *  - writes apps/demo/.env.local so the demo page's snippet uses that app key
 *  - prints a Studio sign-in token for that user
 *
 *   npm run seed [-- --website http://localhost:5174]
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { website: { type: 'string', default: 'http://localhost:5174' } },
  });
  const config = loadAuthConfig();
  if (!config.devTokenSecret)
    throw new Error('seed is for development: needs NODE_ENV=development and JWT_SECRET.');

  const identity = {
    issuer: DEV_TOKEN_ISSUER,
    sub: 'dev-admin',
    email: 'dev-admin@example.com',
    emailVerified: true,
    name: 'Dev Admin',
  };
  const userId = await provisionStudioUser(identity);
  const { org, app } = await withStudioSession(userId, async (client, ctx) => {
    const created = await createOrgWithApp(client, ctx, {
      name: 'Demo Org',
      app: { name: 'Demo site', websites: [new URL(values.website!).origin] },
    });
    await seedWelcomeTour(client, ctx, created.app.id);
    return created;
  });

  const apiBase = process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  const envPath = join(__dirname, '..', '..', '..', '..', 'apps', 'demo', '.env.local');
  writeFileSync(envPath, `VITE_GE_APP_KEY=${app.public_key}\nVITE_GE_API=${apiBase}\n`);

  const token = jwt.sign({ email: identity.email, name: identity.name }, config.devTokenSecret, {
    algorithm: 'HS256',
    subject: identity.sub,
    issuer: DEV_TOKEN_ISSUER,
    expiresIn: '8h',
  });
  console.log(`org      ${org.name} (${org.id})`);
  console.log(`app      ${app.name} — key ${app.public_key}`);
  console.log(`guide    "Welcome tour" (5 steps) published on /dashboard, listed in the help center`);
  console.log(`demo     wrote ${envPath}`);
  console.log(`studio   paste this token to sign in as Dev Admin (8h):\n${token}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
