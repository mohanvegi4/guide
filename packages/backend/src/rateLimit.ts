/**
 * Fixed-window, in-memory rate limiter. The agent API is public (its key ships
 * in web pages), so each key+client gets a request budget per minute. This is
 * per process: fine for the single-instance v1 target; a multi-instance
 * deployment needs a shared store (documented as a scaling follow-up).
 */
export function createRateLimiter(limit: number, windowMs = 60_000) {
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
