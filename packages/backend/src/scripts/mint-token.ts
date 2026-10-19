import 'dotenv/config';
import { parseArgs } from 'util';
import jwt from 'jsonwebtoken';
import { loadAuthConfig } from '../auth/config';
import { DEV_TOKEN_ISSUER } from '../auth/studio';

/**
 * DEVELOPMENT ONLY: mints a Studio sign-in token for a local identity.
 *
 *   npm run mint-token -- --sub dev-alice [--email alice@example.com] [--name Alice] [--ttl 8h]
 *
 * The backend accepts these only when NODE_ENV is development or test. The
 * first sign-in creates the Studio user; organizations and roles come from
 * the database (create an org in the Studio, or run `npm run seed`).
 */
function main(): void {
  const { values } = parseArgs({
    options: {
      sub: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      ttl: { type: 'string', default: '8h' },
    },
  });
  if (!values.sub) {
    console.error('usage: npm run mint-token -- --sub <id> [--email <email>] [--name <name>] [--ttl 8h]');
    process.exit(1);
  }
  const config = loadAuthConfig();
  if (!config.devTokenSecret) {
    console.error('Development tokens need NODE_ENV=development and JWT_SECRET (>= 32 chars) in .env.');
    process.exit(1);
  }
  const claims: Record<string, string> = {};
  if (values.email) claims.email = values.email;
  if (values.name) claims.name = values.name;
  console.log(
    jwt.sign(claims, config.devTokenSecret, {
      algorithm: 'HS256',
      subject: values.sub,
      issuer: DEV_TOKEN_ISSUER,
      expiresIn: values.ttl as jwt.SignOptions['expiresIn'],
    }),
  );
}

main();
