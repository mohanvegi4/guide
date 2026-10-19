import { readFileSync } from 'fs';
import { join } from 'path';

/** Where the error handler sends 5xx failures. Nothing is sent when no tracker is configured. */
export type ErrorReporter = (
  err: unknown,
  context: { requestId: string; route: string; status: number },
) => void;

/** The backend's package version, read at runtime so it works from src/ and dist/ alike. */
export function backendVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Optional Sentry: initialised only when SENTRY_DSN is set, so a deployment
 * without an error tracker (and every test run) never loads the SDK. Loaded
 * lazily for the same reason — @sentry/node pulls in OpenTelemetry, which
 * is a noticeable cost at boot for something most installs won't configure.
 */
export function initErrorTracking(env: NodeJS.ProcessEnv = process.env): ErrorReporter | null {
  if (!env.SENTRY_DSN) return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Sentry: typeof import('@sentry/node') = require('@sentry/node');
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV || 'development',
    release: `guide-engine-backend@${backendVersion()}`,
  });
  return (err, { requestId, route, status }) => {
    Sentry.captureException(err, { tags: { request_id: requestId, route, status: String(status) } });
  };
}
