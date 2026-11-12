import { withoutScope } from './db';

/** Answers whether one more request from `key` fits in the current window. */
export type RateLimiter = (key: string) => boolean | Promise<boolean>;

/**
 * Fixed-window, in-memory rate limiter. The agent API is public (its key ships
 * in web pages), so each key+client gets a request budget per minute. This is
 * per process: right for development and tests, and for a single instance.
 */
export function createRateLimiter(limit: number, windowMs = 60_000): (key: string, now?: number) => boolean {
  const windows = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = Date.now();

  return function allow(key: string, now = Date.now()): boolean {
    if (now - lastSweep > windowMs) {
      for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
      lastSweep = now;
    }
    const w = windows.get(key);
    if (!w || w.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    w.count += 1;
    return w.count <= limit;
  };
}

/**
 * The same fixed window, counted in Postgres (agent_rate_limit, migration
 * 010) so every backend replica shares one budget. One upsert per request;
 * old windows are swept by the retention job. A database error propagates:
 * the request would have failed on its next query anyway.
 */
export function createPostgresRateLimiter(limit: number, windowMs = 60_000): RateLimiter {
  const windowSeconds = Math.max(1, Math.round(windowMs / 1000));
  return async (key: string) => {
    const result = await withoutScope((client) =>
      client.query<{ count: number }>(
        `INSERT INTO agent_rate_limit (bucket, window_start, count)
         VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), 1)
         ON CONFLICT (bucket, window_start) DO UPDATE SET count = agent_rate_limit.count + 1
         RETURNING count`,
        [key, windowSeconds],
      ),
    );
    return result.rows[0].count <= limit;
  };
}

/**
 * RATE_LIMIT_STORE: `memory` (default in development/test) or `postgres`
 * (default — and required, see production.ts — in production).
 */
export function rateLimiterFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimiter {
  const limit = Number(env.AGENT_RATE_LIMIT_PER_MIN ?? 600);
  if (!Number.isFinite(limit) || limit <= 0)
    throw new Error('AGENT_RATE_LIMIT_PER_MIN must be a positive number.');
  const store = env.RATE_LIMIT_STORE || (env.NODE_ENV === 'production' ? 'postgres' : 'memory');
  if (store === 'postgres') return createPostgresRateLimiter(limit);
  if (store === 'memory') return createRateLimiter(limit);
  throw new Error(`RATE_LIMIT_STORE must be "memory" or "postgres" (got "${store}").`);
}
