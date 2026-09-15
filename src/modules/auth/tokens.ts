import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../config';
import { UnauthorizedError } from '../../errors';

export type Role = 'customer' | 'admin';

export interface AccessTokenClaims {
  sub: string;
  role: Role;
  typ: 'access';
}

const ISSUER = 'ledger-api';
const AUDIENCE = 'ledger-clients';

export function signAccessToken(userId: string, role: Role): string {
  const cfg = config();
  return jwt.sign({ role, typ: 'access' } satisfies Omit<AccessTokenClaims, 'sub'>, cfg.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: cfg.ACCESS_TOKEN_TTL,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'HS256',
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const cfg = config();
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, cfg.JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
      // Pin the algorithm. Without this, a token with alg:"none" -- or one
      // signed with a key the verifier can be tricked into using -- is accepted.
      algorithms: ['HS256'],
    });
  } catch {
    throw new UnauthorizedError('invalid or expired access token');
  }

  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    (decoded as { typ?: unknown }).typ !== 'access' ||
    typeof (decoded as { sub?: unknown }).sub !== 'string'
  ) {
    throw new UnauthorizedError('malformed access token');
  }

  const claims = decoded as { sub: string; role?: unknown; typ: 'access' };
  const role: Role = claims.role === 'admin' ? 'admin' : 'customer';
  return { sub: claims.sub, role, typ: 'access' };
}

/**
 * Refresh tokens are OPAQUE random strings, not JWTs.
 *
 * A JWT refresh token is self-validating, which is precisely what you do not
 * want from a long-lived credential: it cannot be revoked before expiry without
 * a server-side denylist, at which point you have the database lookup you were
 * trying to avoid. An opaque token is a pointer to a row we control, so
 * rotation, reuse detection, and family revocation are all just row updates.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Stored form of a refresh token: HMAC-SHA256 keyed with JWT_REFRESH_SECRET.
 *
 * Keyed rather than a bare SHA-256 so that stealing a database dump is not
 * enough -- an attacker also needs the application secret before they can look
 * up or forge the stored value.
 */
export function hashRefreshToken(token: string): string {
  return createHmac('sha256', config().JWT_REFRESH_SECRET).update(token).digest('hex');
}

/** Constant-time compare, for anywhere a token digest is checked in app code. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function refreshTokenExpiry(now = new Date()): Date {
  const days = config().REFRESH_TOKEN_TTL_DAYS;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}
