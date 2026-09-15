import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { createAuthRateLimiter } from '../../src/middleware/rateLimit';
import { TooManyRequestsError } from '../../src/errors';

/**
 * The integration suite runs with rate limiting effectively disabled, because
 * it performs far more logins than a human would. So the limiter's behaviour is
 * pinned here instead, where the limits can be set to something testable.
 */
function fakeReq(body: unknown, ip = '203.0.113.7', path = '/login'): Request {
  return { body, ip, path } as unknown as Request;
}

function fakeRes(): Response {
  return { setHeader: jest.fn() } as unknown as Response;
}

function run(
  limiter: ReturnType<typeof createAuthRateLimiter>,
  req: Request,
): unknown {
  let captured: unknown;
  const next: NextFunction = (err?: unknown) => {
    captured = err;
  };
  limiter(req, fakeRes(), next);
  return captured;
}

describe('auth rate limiter', () => {
  it('allows requests up to the limit and rejects the next one', () => {
    const limiter = createAuthRateLimiter({ windowMs: 60_000, max: 3 });
    const req = fakeReq({ email: 'a@example.com' });

    expect(run(limiter, req)).toBeUndefined();
    expect(run(limiter, req)).toBeUndefined();
    expect(run(limiter, req)).toBeUndefined();

    const rejected = run(limiter, req);
    expect(rejected).toBeInstanceOf(TooManyRequestsError);
  });

  it('gives each email its own bucket so one account cannot starve another', () => {
    const limiter = createAuthRateLimiter({ windowMs: 60_000, max: 2 });
    const attacker = fakeReq({ email: 'attacker@example.com' });
    const victim = fakeReq({ email: 'victim@example.com' });

    run(limiter, attacker);
    run(limiter, attacker);
    expect(run(limiter, attacker)).toBeInstanceOf(TooManyRequestsError);

    // Same IP, different account -- must still be served.
    expect(run(limiter, victim)).toBeUndefined();
  });

  it('buckets refresh requests per token rather than per IP', () => {
    const limiter = createAuthRateLimiter({ windowMs: 60_000, max: 1 });
    const a = fakeReq({ refreshToken: 'token-aaa' }, '203.0.113.7', '/refresh');
    const b = fakeReq({ refreshToken: 'token-bbb' }, '203.0.113.7', '/refresh');

    expect(run(limiter, a)).toBeUndefined();
    expect(run(limiter, a)).toBeInstanceOf(TooManyRequestsError);

    // A different user behind the same NAT is unaffected.
    expect(run(limiter, b)).toBeUndefined();
  });

  it('separates buckets per route', () => {
    const limiter = createAuthRateLimiter({ windowMs: 60_000, max: 1 });
    const login = fakeReq({ email: 'a@example.com' }, '203.0.113.7', '/login');
    const register = fakeReq({ email: 'a@example.com' }, '203.0.113.7', '/register');

    expect(run(limiter, login)).toBeUndefined();
    expect(run(limiter, login)).toBeInstanceOf(TooManyRequestsError);
    expect(run(limiter, register)).toBeUndefined();
  });

  it('reports a retry-after hint on rejection', () => {
    const limiter = createAuthRateLimiter({ windowMs: 60_000, max: 1 });
    const req = fakeReq({ email: 'a@example.com' });

    run(limiter, req);
    const rejected = run(limiter, req) as TooManyRequestsError;

    expect(rejected.status).toBe(429);
    expect(rejected.details).toMatchObject({ retryAfterSeconds: expect.any(Number) });
  });

  it('starts a fresh window once the old one lapses', () => {
    const limiter = createAuthRateLimiter({ windowMs: 10, max: 1 });
    const req = fakeReq({ email: 'a@example.com' });

    expect(run(limiter, req)).toBeUndefined();
    expect(run(limiter, req)).toBeInstanceOf(TooManyRequestsError);

    // Advance past the window without sleeping.
    const realNow = Date.now;
    Date.now = () => realNow() + 1000;
    try {
      expect(run(limiter, req)).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });
});
