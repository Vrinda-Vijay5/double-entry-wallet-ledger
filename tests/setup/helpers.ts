import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { Pool } from 'pg';
import request from 'supertest';
import { applyTestEnv, TEST_DATABASE_URL } from './env';

applyTestEnv();

// Imported AFTER applyTestEnv so config() and the pool read the test env.
// eslint-disable-next-line import/first
import { createApp } from '../../src/app';
// eslint-disable-next-line import/first
import { closePool, createPool, setPool } from '../../src/db/pool';

let pool: Pool | null = null;
let app: Express | null = null;

/**
 * Shared pool for both the application under test and the assertions.
 *
 * `max` is generous because the stress tests intentionally hold many
 * connections in lock waits at once. If the pool were smaller than the burst,
 * requests would queue in the Node driver rather than in Postgres, and the test
 * would be measuring the pool instead of the locking design.
 */
export function testPool(): Pool {
  if (!pool) {
    pool = createPool(TEST_DATABASE_URL, { max: 60 });
    setPool(pool);
  }
  return pool;
}

export function testApp(): Express {
  testPool();
  if (!app) app = createApp();
  return app;
}

export async function shutdownTestResources(): Promise<void> {
  app = null;
  if (pool) {
    await closePool();
    pool = null;
  }
}

/**
 * Wipes all data between test files while keeping the schema.
 *
 * TRUNCATE ... CASCADE rather than DELETE: it resets the identity sequence on
 * ledger_entries too, so entry ids are comparable across test files. The
 * immutability trigger fires on DELETE but not on TRUNCATE, which is the only
 * reason this is possible at all -- and is why the ledger is append-only for
 * the application yet still resettable for tests.
 */
export async function resetDatabase(): Promise<void> {
  await testPool().query(
    `TRUNCATE ledger_entries, transfers, idempotency_keys, refresh_tokens, wallets, users
     RESTART IDENTITY CASCADE`,
  );
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID()}@test.ledger`;
}

export function idempotencyKey(): string {
  return `test-${randomUUID()}`;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  role: 'customer' | 'admin';
}

export async function registerUser(
  overrides: { email?: string; password?: string } = {},
): Promise<TestUser> {
  const email = overrides.email ?? uniqueEmail();
  const password = overrides.password ?? 'correct-horse-battery-staple';

  const res = await request(testApp())
    .post('/v1/auth/register')
    .set('Idempotency-Key', idempotencyKey())
    .send({ email, password });

  if (res.status !== 201) {
    throw new Error(`register failed (${res.status}): ${JSON.stringify(res.body)}`);
  }

  return {
    id: res.body.user.id,
    email,
    password,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    role: res.body.user.role,
  };
}

/** Promotes a user to admin directly in the database (no self-service endpoint). */
export async function promoteToAdmin(userId: string): Promise<void> {
  await testPool().query(`UPDATE users SET role = 'admin' WHERE id = $1`, [userId]);
}

export async function createWallet(user: TestUser, label = 'Main'): Promise<string> {
  const res = await request(testApp())
    .post('/v1/wallets')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .set('Idempotency-Key', idempotencyKey())
    .send({ label });

  if (res.status !== 201) {
    throw new Error(`createWallet failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.id;
}

/**
 * Creates the system wallet used to fund test wallets.
 *
 * Funding goes through a real double-entry transfer rather than an INSERT of a
 * balance, so even test fixtures preserve SUM(debits) = SUM(credits). A helper
 * that cheated here would invalidate every invariant assertion in the suite.
 */
export async function createSystemWallet(ownerUserId: string): Promise<string> {
  const { rows } = await testPool().query<{ id: string }>(
    `INSERT INTO wallets (user_id, label, kind, allow_negative)
     VALUES ($1, 'Test Treasury', 'system', true) RETURNING id`,
    [ownerUserId],
  );
  return rows[0]!.id;
}

/** Funds a wallet by writing a matched pair straight to the ledger, in one transaction. */
export async function fundWallet(
  systemWalletId: string,
  walletId: string,
  amount: bigint,
  initiatedBy: string,
): Promise<string> {
  const client = await testPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO transfers (source_wallet_id, dest_wallet_id, amount, reference, initiated_by)
       VALUES ($1, $2, $3, 'test funding', $4) RETURNING id`,
      [systemWalletId, walletId, amount.toString(), initiatedBy],
    );
    const transferId = rows[0]!.id;
    await client.query(
      `INSERT INTO ledger_entries (transfer_id, wallet_id, direction, amount)
       VALUES ($1, $2, 'debit', $4), ($1, $3, 'credit', $4)`,
      [transferId, systemWalletId, walletId, amount.toString()],
    );
    await client.query('COMMIT');
    return transferId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** Derived balance, read straight from the ledger -- never from an API cache. */
export async function balanceOf(walletId: string): Promise<bigint> {
  const { rows } = await testPool().query<{ balance: string }>(
    `SELECT COALESCE(SUM(signed_amount), 0)::text AS balance
       FROM ledger_entries WHERE wallet_id = $1`,
    [walletId],
  );
  return BigInt(rows[0]!.balance);
}

/**
 * The global double-entry invariant.
 *
 * Returns { debits, credits, drift }. `drift` is SUM(signed_amount) over the
 * entire table and must be exactly 0n: every credit matched by a debit.
 */
export async function ledgerTotals(): Promise<{
  debits: bigint;
  credits: bigint;
  drift: bigint;
}> {
  const { rows } = await testPool().query<{
    debits: string;
    credits: string;
    drift: string;
  }>(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0)::text  AS debits,
            COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)::text AS credits,
            COALESCE(SUM(signed_amount), 0)::text                              AS drift
       FROM ledger_entries`,
  );
  const row = rows[0]!;
  return {
    debits: BigInt(row.debits),
    credits: BigInt(row.credits),
    drift: BigInt(row.drift),
  };
}

export async function countTransfers(filter?: { reference?: string }): Promise<number> {
  const { rows } = filter?.reference
    ? await testPool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM transfers WHERE reference = $1`,
        [filter.reference],
      )
    : await testPool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM transfers`,
      );
  return Number(rows[0]!.count);
}

export async function countLedgerEntries(transferId?: string): Promise<number> {
  const { rows } = transferId
    ? await testPool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ledger_entries WHERE transfer_id = $1`,
        [transferId],
      )
    : await testPool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ledger_entries`,
      );
  return Number(rows[0]!.count);
}

export { request };
