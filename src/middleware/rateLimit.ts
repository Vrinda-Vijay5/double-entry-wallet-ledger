import type { RequestHandler } from 'express';
import { TooManyRequestsError } from '../errors';

/**
 * Minimal fixed-window limiter, applied ONLY to auth endpoints (per scope) to
 * blunt credential stuffing and brute force.
 *
 * In-process and therefore per-instance: behind multiple replicas the effective
 * limit multiplies by the replica count. That is an accepted limitation for
 * this scope; a real deployment would move this to Redis or the edge. Stated
 * here so nobody mistakes it for a distributed guarantee.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

export function createAuthRateLimiter(options: {
  windowMs: number;
  max: number;
}): RequestHandler & { reset(): void } {
  const buckets = new Map<string, Bucket>();

  // Bounded sweep so the map cannot grow without limit under a spray of IPs.
  function sweep(now: number): void {
    if (buckets.size < 10_000) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  const handler: RequestHandler = (req, res, next) => {
    const now = Date.now();
    sweep(now);

    // Key on IP + submitted email so one attacker cannot lock out an entire
    // NAT's worth of legitimate users by exhausting a shared IP bucket.
    const email =
      typeof req.body === 'object' && req.body && 'email' in req.body
        ? String((req.body as { email?: unknown }).email ?? '').toLowerCase()
        : '';
    const key = `${req.ip ?? 'unknown'}|${email}`;

    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    existing.count += 1;
    if (existing.count > options.max) {
      const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
      res.setHeader('retry-after', String(retryAfter));
      next(new TooManyRequestsError(retryAfter));
      return;
    }
    next();
  };

  return Object.assign(handler, {
    reset(): void {
      buckets.clear();
    },
  });
}
