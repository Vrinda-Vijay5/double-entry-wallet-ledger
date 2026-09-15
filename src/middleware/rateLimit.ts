import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { TooManyRequestsError } from '../errors';

/**
 * Derives the bucket subject from the request body.
 *
 * Bucketing on IP alone would let one attacker behind a shared NAT lock out
 * every legitimate user on that address. So each credential gets its own
 * bucket: the email on login/register, and the presented token on refresh.
 *
 * Refresh deliberately buckets per token rather than per IP. Brute-forcing a
 * 256-bit random token is not a threat the limiter needs to address, whereas
 * starving a whole office of token refreshes very much is.
 */
function subjectOf(body: unknown): string {
  if (typeof body !== 'object' || body === null) return 'anonymous';

  const email = (body as { email?: unknown }).email;
  if (typeof email === 'string' && email.length > 0) {
    return `email:${email.trim().toLowerCase()}`;
  }

  const refreshToken = (body as { refreshToken?: unknown }).refreshToken;
  if (typeof refreshToken === 'string' && refreshToken.length > 0) {
    // Hashed so a raw token can never end up in a heap dump of the bucket map.
    return `token:${createHash('sha256').update(refreshToken).digest('hex').slice(0, 32)}`;
  }

  return 'anonymous';
}

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

    const key = `${req.ip ?? 'unknown'}|${req.path}|${subjectOf(req.body)}`;

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
