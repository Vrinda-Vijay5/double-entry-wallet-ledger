import type { Pool, PoolClient } from 'pg';
import { logger } from '../logger';
import { getPool } from './pool';

export type IsolationLevel =
  | 'READ COMMITTED'
  | 'REPEATABLE READ'
  | 'SERIALIZABLE';

/** Postgres SQLSTATEs that indicate a transaction is safe to retry verbatim. */
const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';

/**
 * Observability hook for the test suite. The deadlock test asserts that
 * `deadlocks` stays at zero -- if the retry loop below were allowed to paper
 * over a lock-ordering bug, that test would pass while the design was broken.
 * Counting retries separately keeps the retry safety net honest.
 */
export const txStats = {
  deadlocks: 0,
  serializationFailures: 0,
  retries: 0,
  reset(): void {
    this.deadlocks = 0;
    this.serializationFailures = 0;
    this.retries = 0;
  },
};

function sqlState(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export interface TransactionOptions {
  /**
   * ISOLATION LEVEL CHOICE -- READ COMMITTED (Postgres' default), chosen
   * deliberately rather than inherited.
   *
   * The anomaly that matters here is a LOST UPDATE on a derived balance -- more
   * precisely a read-write conflict over a *phantom* set. Two concurrent
   * transfers each run `SELECT SUM(signed_amount) ... WHERE wallet_id = X`, both
   * observe 100, both conclude a withdrawal of 100 is affordable, and both
   * append a debit. The wallet ends at -100. READ COMMITTED does NOT prevent
   * this on its own: the balance is an aggregate over rows that do not exist yet
   * at read time, so there is no row for the database to detect a conflict on.
   * Raising the isolation level to REPEATABLE READ does not fix it either --
   * snapshot isolation in Postgres does not detect this write skew, because the
   * two transactions insert *different* rows and never touch a common tuple.
   *
   * We close the hole explicitly instead, with `SELECT ... FOR UPDATE` on the
   * wallet rows (see transfers.service.ts). The wallet row is the designated
   * mutex for its slice of the ledger: every writer that intends to append
   * entries for a wallet must first hold that wallet's row lock, so the
   * balance read and the subsequent insert become one critical section.
   *
   * Why not SERIALIZABLE, which would also prevent the anomaly? Because it
   * prevents it *optimistically* -- by aborting one of the transactions with
   * 40001 and requiring the caller to retry. Under the workload this project is
   * explicitly built to survive (200 parallel transfers against a single
   * wallet) every one of those transactions conflicts on the same predicate, so
   * the abort rate approaches 100% and throughput collapses into a retry storm.
   * Pessimistic row locking gives the identical correctness guarantee for this
   * access pattern with bounded, retry-free latency: contenders queue instead of
   * failing. The cost is that we must get lock *ordering* right by hand, which
   * is exactly what the deterministic ascending-UUID ordering addresses.
   */
  isolation?: IsolationLevel;
  /** Retries are a safety net for genuine contention, not a substitute for correct lock ordering. */
  maxAttempts?: number;
  readOnly?: boolean;
}

/**
 * Runs `fn` inside a single database transaction on a single pooled client.
 *
 * Everything the callback does -- including the idempotency claim -- shares one
 * transaction, which is what makes "both ledger entries commit or neither does"
 * true by construction rather than by convention.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
  poolOverride?: Pool,
): Promise<T> {
  const {
    isolation = 'READ COMMITTED',
    maxAttempts = 3,
    readOnly = false,
  } = options;

  const pool = poolOverride ?? getPool();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(
        `BEGIN ISOLATION LEVEL ${isolation}${readOnly ? ' READ ONLY' : ''}`,
      );
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // ROLLBACK can itself fail if the connection died; the original error is
      // the interesting one, so swallow this.
      await client.query('ROLLBACK').catch(() => undefined);

      const state = sqlState(err);
      const retryable =
        state === SERIALIZATION_FAILURE || state === DEADLOCK_DETECTED;

      if (state === DEADLOCK_DETECTED) txStats.deadlocks += 1;
      if (state === SERIALIZATION_FAILURE) txStats.serializationFailures += 1;

      if (retryable && attempt < maxAttempts) {
        txStats.retries += 1;
        logger.warn(
          { sqlState: state, attempt },
          'retryable transaction conflict; retrying',
        );
        lastError = err;
        // Small jittered backoff so retried contenders do not re-collide in lockstep.
        await new Promise((r) => setTimeout(r, 5 * attempt + Math.random() * 10));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  throw lastError;
}
