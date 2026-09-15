import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError, ConflictError } from '../../errors';

/**
 * Canonical JSON: object keys sorted recursively, so `{a:1,b:2}` and `{b:2,a:1}`
 * fingerprint identically. Without this, a client whose JSON serialiser emits
 * keys in a different order on retry would be told its key was "reused with a
 * different payload" -- a maddening, intermittent bug.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

export function fingerprint(body: unknown): string {
  return createHash('sha256').update(canonicalize(body)).digest('hex');
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  /** Optional FK recorded alongside the response for auditability. */
  transferId?: string;
}

export interface IdempotencyOutcome<T> extends IdempotentResult<T> {
  /** True when this response came from a previously committed identical request. */
  replayed: boolean;
}

/**
 * Executes `produce` at most once per (userId, idempotencyKey), even when
 * duplicate requests arrive SIMULTANEOUSLY on different connections.
 *
 * ## How the mutual exclusion actually works
 *
 * `client` must already be inside a transaction, and `produce` must do all of
 * its work on that same `client`. That single-transaction requirement is not a
 * style preference -- it is the entire mechanism:
 *
 *   1. We claim the key with `INSERT ... ON CONFLICT DO NOTHING RETURNING id`.
 *      The unique index on (user_id, idempotency_key) admits exactly one winner.
 *
 *   2. A LOSER does not get an error and does not get a row. Postgres makes its
 *      INSERT *wait* on the winner's uncommitted tuple. So by the time the
 *      loser's INSERT returns zero rows, the winner has already COMMITTED or
 *      ABORTED -- there is no window where the loser proceeds concurrently.
 *
 *   3. If the winner committed, the loser's *next* statement sees the finished
 *      row (READ COMMITTED takes a fresh snapshot per statement) and replays the
 *      stored response. Exactly one transfer exists.
 *
 *   4. If the winner ABORTED, its tuple is dead, so the loser's own INSERT
 *      succeeds instead and the loser becomes the new winner. A failed attempt
 *      therefore releases the key rather than poisoning it -- which is what you
 *      want: a transfer rejected for insufficient funds should be retryable with
 *      the same key once the wallet is funded.
 *
 * ## Why this REQUIRES READ COMMITTED
 *
 * Step 3 depends on a per-statement snapshot. Under REPEATABLE READ the
 * transaction's snapshot predates the winner's commit, so the follow-up SELECT
 * would find nothing and `ON CONFLICT` would instead raise 40001. The assertion
 * below turns that subtle misconfiguration into an immediate, explicit failure.
 */
export async function runIdempotent<T>(
  client: PoolClient,
  params: {
    userId: string;
    idempotencyKey: string;
    endpoint: string;
    requestBody: unknown;
  },
  produce: () => Promise<IdempotentResult<T>>,
): Promise<IdempotencyOutcome<T>> {
  const { userId, idempotencyKey, endpoint, requestBody } = params;
  const fp = fingerprint(requestBody);

  await assertReadCommitted(client);

  const claim = await client.query<{ id: string }>(
    `INSERT INTO idempotency_keys (user_id, idempotency_key, endpoint, request_fingerprint)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [userId, idempotencyKey, endpoint, fp],
  );

  // ---- We won the race: we own this key and must do the work exactly once. ----
  if (claim.rowCount === 1) {
    const claimId = claim.rows[0]!.id;
    const result = await produce();

    await client.query(
      `UPDATE idempotency_keys
          SET response_status = $2, response_body = $3, transfer_id = $4
        WHERE id = $1`,
      [claimId, result.status, JSON.stringify(result.body), result.transferId ?? null],
    );

    return { ...result, replayed: false };
  }

  // ---- We lost the race. The winner has already resolved (see step 2). ----
  const existing = await client.query<{
    endpoint: string;
    request_fingerprint: string;
    response_status: number | null;
    response_body: T | null;
    transfer_id: string | null;
  }>(
    `SELECT endpoint, request_fingerprint, response_status, response_body, transfer_id
       FROM idempotency_keys
      WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey],
  );

  const row = existing.rows[0];
  if (!row) {
    // Unreachable given steps 2-4: a zero-row INSERT means a committed conflict.
    // Surfacing it as a retryable conflict beats pretending it cannot happen.
    throw new ConflictError(
      'idempotency key claim resolved inconsistently; retry the request',
      'idempotency_conflict',
    );
  }

  if (row.request_fingerprint !== fp || row.endpoint !== endpoint) {
    throw new ConflictError(
      'this Idempotency-Key was already used with a different request payload',
      'idempotency_key_reuse',
      { endpoint: row.endpoint },
    );
  }

  if (row.response_status === null || row.response_body === null) {
    throw new ConflictError(
      'the original request for this Idempotency-Key is still in flight; retry shortly',
      'idempotency_in_flight',
    );
  }

  return {
    status: row.response_status,
    body: row.response_body,
    transferId: row.transfer_id ?? undefined,
    replayed: true,
  };
}

async function assertReadCommitted(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ transaction_isolation: string }>(
    'SHOW transaction_isolation',
  );
  const level = rows[0]?.transaction_isolation;
  if (level !== 'read committed') {
    throw new AppError(
      500,
      'internal_error',
      `runIdempotent requires READ COMMITTED (per-statement snapshots); got "${level}"`,
    );
  }
}
