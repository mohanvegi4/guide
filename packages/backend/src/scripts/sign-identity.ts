import { parseArgs } from 'util';
import jwt from 'jsonwebtoken';

/**
 * Signs a visitor identity the way a customer's BACKEND would when their app
 * has "Require signed identity" switched on. For testing the agent locally.
 *
 *   npm run sign-identity -- --secret ge_sk_... --visitor user-123 [--account acme] [--ttl 1h]
 *
 * Pass the result as guideEngine.initialize({ jwt }).
 */
function main(): void {
  const { values } = parseArgs({
    options: {
      secret: { type: 'string' },
      visitor: { type: 'string' },
      account: { type: 'string' },
      ttl: { type: 'string', default: '1h' },
    },
  });
  if (!values.secret || !values.visitor) {
    console.error(
      'usage: npm run sign-identity -- --secret <app signing secret> --visitor <id> [--account <id>] [--ttl 1h]',
    );
    process.exit(1);
  }
  const claims: Record<string, unknown> = { visitor: { id: values.visitor } };
  if (values.account) claims.account = { id: values.account };
  console.log(
    jwt.sign(claims, values.secret, {
      algorithm: 'HS256',
      expiresIn: values.ttl as jwt.SignOptions['expiresIn'],
    }),
  );
}

main();
