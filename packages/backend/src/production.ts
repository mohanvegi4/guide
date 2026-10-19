import { logger } from './logging';

/**
 * Settings a production deployment must get right, checked once at boot so
 * the process refuses to start rather than running weakened (fail closed):
 *  - SECRETS_KEY        apps' signing secrets are encrypted at rest
 *  - PREVIEW_TOKEN_SECRET  preview links work (and are signed with their own key)
 *  - RATE_LIMIT_STORE   postgres, so replicas share one agent-API budget
 *  - PUBLIC_API_URL     https — it's what every customer's snippet loads from
 * Only applies when NODE_ENV=production; development and test are unaffected.
 */
export function assertProductionConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = (msg) => logger.warn(msg),
): void {
  if (env.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  if (!env.SECRETS_KEY) {
    problems.push(
      "SECRETS_KEY is not set: apps' signing secrets would be stored in plaintext. Generate: openssl rand -hex 32",
    );
  }
  if (!env.PREVIEW_TOKEN_SECRET) {
    problems.push('PREVIEW_TOKEN_SECRET is not set. Generate: openssl rand -hex 32');
  }
  if ((env.RATE_LIMIT_STORE || 'postgres') !== 'postgres') {
    problems.push(
      'RATE_LIMIT_STORE must be "postgres" in production: per-process limits do not hold across replicas.',
    );
  }
  if (!env.PUBLIC_API_URL?.startsWith('https://')) {
    problems.push(
      'PUBLIC_API_URL must be an https URL: it is where every install snippet loads the agent from.',
    );
  }
  if (problems.length > 0) {
    throw new Error(`Refusing to start in production:\n - ${problems.join('\n - ')}`);
  }
  if (env.TRUST_PROXY !== 'true') {
    warn(
      'TRUST_PROXY is not "true": behind a reverse proxy, rate limiting would see the proxy address instead of clients.',
    );
  }
}
