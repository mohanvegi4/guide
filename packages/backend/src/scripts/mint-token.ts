import 'dotenv/config';
import { parseArgs } from 'util';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { loadAuthConfig } from '../auth/config';

/**
 * Dev/ops helper: mints an HS256 bearer token signed with JWT_SECRET.
 *
 *   npm run mint-token -- --tenant <uuid> --user <id> [--role guide_admin[,platform_admin]] [--ttl 8h]
 *
 * Use --role guide_admin for an Authoring Studio token (add platform_admin to
 * also manage global guides); omit it for an end-user SDK token. In production, tokens come from your real login flow —
 * this script exists so the Studio and demo app are usable before that's wired.
 */
function main(): void {
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      user: { type: 'string' },
      role: { type: 'string' },
      ttl: { type: 'string', default: '8h' },
    },
  });

  if (!values.tenant || !z.string().uuid().safeParse(values.tenant).success || !values.user) {
    console.error(
      'usage: npm run mint-token -- --tenant <tenant-uuid> --user <user-id> [--role guide_admin] [--ttl 8h]',
    );
    process.exit(1);
  }

  const config = loadAuthConfig();
  if (!config.jwtSecret) {
    console.error('JWT_SECRET is not set — cannot mint a signed token.');
    process.exit(1);
  }

  const claims: Record<string, unknown> = { tenantId: values.tenant, userId: values.user };
  // --role guide_admin            -> "role": "guide_admin"
  // --role guide_admin,platform_admin -> "roles": [...]
  if (values.role) {
    const roles = values.role.split(',').map((r) => r.trim()).filter(Boolean);
    if (roles.length === 1) claims.role = roles[0];
    else claims.roles = roles;
  }

  const token = jwt.sign(claims, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: values.ttl as jwt.SignOptions['expiresIn'],
    ...(config.issuer ? { issuer: config.issuer } : {}),
    ...(config.audience ? { audience: config.audience } : {}),
  });
  console.log(token);
}

main();
