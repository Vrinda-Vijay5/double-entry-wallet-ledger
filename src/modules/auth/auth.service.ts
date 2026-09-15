import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { PoolClient } from 'pg';
import { ConflictError, UnauthorizedError } from '../../errors';
import { getPool } from '../../db/pool';
import { logger } from '../../logger';
import {
  type Role,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
  signAccessToken,
} from './tokens';

/**
 * Argon2id parameters.
 *
 * argon2id is the hybrid variant: it resists both GPU cracking (like argon2d)
 * and side-channel attacks (like argon2i), which is why it is the OWASP default
 * recommendation. 19 MiB / t=2 / p=1 is the current OWASP minimum-work profile.
 *
 * Tests override the cost downward via ARGON2_TEST_MODE. That is a test-speed
 * concession only -- if it were applied in any other environment, a database
 * leak would become trivially crackable, so the switch is pinned to NODE_ENV.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

// timeCost has a hard floor of 2 in argon2; memoryCost is the knob that
// actually buys back test runtime, so it takes the reduction.
const TEST_ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 1024,
  timeCost: 2,
  parallelism: 1,
};

function argonOptions(): argon2.Options {
  return process.env.NODE_ENV === 'test' ? TEST_ARGON2_OPTIONS : ARGON2_OPTIONS;
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, argonOptions());
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // Malformed stored hash -- treat as a failed login, never as a crash.
    return false;
  }
}

/**
 * Timing equaliser for logins against a nonexistent email.
 *
 * Returning early when no user row exists makes login measurably faster for
 * unknown addresses than for known ones, which is an account-enumeration oracle
 * an attacker can read off a stopwatch. Burning one real verify against a
 * throwaway hash keeps the two paths comparable.
 *
 * The decoy is derived from the SAME cost parameters as real hashes and
 * memoised, so it stays honest if those parameters change and costs one hash
 * per process rather than one per request.
 */
let decoyHashPromise: Promise<string> | null = null;

export async function burnVerifyForTiming(password: string): Promise<void> {
  decoyHashPromise ??= argon2.hash(
    'timing-decoy-never-a-real-password',
    argonOptions(),
  );
  await verifyPassword(await decoyHashPromise, password);
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  created_at: Date;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function registerUser(
  client: PoolClient,
  params: { email: string; password: string; role?: Role },
): Promise<UserRow> {
  const passwordHash = await hashPassword(params.password);
  try {
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id, email, password_hash, role, created_at`,
      [params.email, passwordHash, params.role ?? 'customer'],
    );
    return rows[0]!;
  } catch (err) {
    if (typeof err === 'object' && err && (err as { code?: string }).code === '23505') {
      throw new ConflictError('an account with that email already exists', 'email_taken');
    }
    throw err;
  }
}

export async function findUserByEmail(
  client: PoolClient,
  email: string,
): Promise<UserRow | null> {
  const { rows } = await client.query<UserRow>(
    `SELECT id, email, password_hash, role, created_at
       FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  return rows[0] ?? null;
}

/**
 * Issues a fresh token pair, starting a new rotation family.
 * `familyId` is threaded through on rotation so reuse detection can revoke the
 * whole lineage at once.
 */
export async function issueTokenPair(
  client: PoolClient,
  user: { id: string; role: Role },
  familyId: string = randomUUID(),
  replacesTokenId?: string,
): Promise<TokenPair> {
  const refreshToken = generateRefreshToken();
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [user.id, hashRefreshToken(refreshToken), familyId, refreshTokenExpiry()],
  );

  if (replacesTokenId) {
    await client.query(
      `UPDATE refresh_tokens SET replaced_by = $2 WHERE id = $1`,
      [replacesTokenId, rows[0]!.id],
    );
  }

  return {
    accessToken: signAccessToken(user.id, user.role),
    refreshToken,
    expiresIn: 15 * 60,
  };
}

interface RefreshTokenRow {
  id: string;
  user_id: string;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
  role: Role;
}

/**
 * Rotates a refresh token.
 *
 * REUSE DETECTION: presenting a token that was already rotated away (or
 * explicitly revoked) is not merely invalid -- it means the token leaked, since
 * the legitimate client would be holding its successor. The only safe response
 * is to assume the attacker may also hold the current token, so we revoke the
 * ENTIRE family and force a fresh login. Rejecting just the replayed token
 * would leave a thief holding a valid chain.
 *
 * The row is locked FOR UPDATE so two simultaneous refreshes with the same
 * token cannot both mint a successor.
 */
export async function rotateRefreshToken(
  client: PoolClient,
  presentedToken: string,
): Promise<TokenPair> {
  const tokenHash = hashRefreshToken(presentedToken);

  const { rows } = await client.query<RefreshTokenRow>(
    `SELECT rt.id, rt.user_id, rt.family_id, rt.expires_at, rt.revoked_at,
            rt.replaced_by, u.role
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1
        FOR UPDATE OF rt`,
    [tokenHash],
  );

  const row = rows[0];
  if (!row) throw new UnauthorizedError('invalid refresh token');

  const alreadyUsed = row.replaced_by !== null || row.revoked_at !== null;
  if (alreadyUsed) {
    // The revocation MUST NOT run on `client`. This function always throws on
    // this path, and the caller wraps it in a transaction that will therefore
    // ROLL BACK -- taking the revocation with it and silently discarding the
    // entire breach response. The family would stay live and the thief would
    // keep their working token chain.
    //
    // So the revocation is committed out-of-band on its own connection, before
    // the rejection propagates. Rolling back the *rejection* is fine; rolling
    // back the *containment* is not.
    await revokeTokenFamilyOutOfBand(row.family_id);
    logger.warn(
      { userId: row.user_id, familyId: row.family_id },
      'refresh token reuse detected; revoked token family',
    );
    throw new UnauthorizedError('refresh token has already been used');
  }

  if (row.expires_at.getTime() <= Date.now()) {
    throw new UnauthorizedError('refresh token has expired');
  }

  await client.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);

  return issueTokenPair(
    client,
    { id: row.user_id, role: row.role },
    row.family_id,
    row.id,
  );
}

/**
 * Revokes an entire token family on a connection of its own, outside any
 * caller-supplied transaction, so the write commits even though the request
 * that triggered it is about to fail. See the call site for why that matters.
 */
async function revokeTokenFamilyOutOfBand(familyId: string): Promise<void> {
  const client = await getPool().connect();
  try {
    // No BEGIN: this single statement autocommits immediately.
    await client.query(
      `UPDATE refresh_tokens
          SET revoked_at = now()
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId],
    );
  } finally {
    client.release();
  }
}

export async function revokeAllTokensForUser(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}
