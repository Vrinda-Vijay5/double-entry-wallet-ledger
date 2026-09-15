import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { txStats } from '../../src/db/tx';
import {
  balanceOf,
  countTransfers,
  createSystemWallet,
  createWallet,
  fundWallet,
  idempotencyKey,
  ledgerTotals,
  registerUser,
  request,
  resetDatabase,
  shutdownTestResources,
  testApp,
  testPool,
  type TestUser,
} from '../setup/helpers';

/**
 * CONCURRENCY STRESS TESTS
 *
 * These are the tests the whole design exists to satisfy. Read this note before
 * changing any of them, because the obvious version of this test does not
 * actually test anything.
 *
 * ## Why a naive stress test is worthless here
 *
 * "Fire 200 parallel transfers, assert the balance is exact" sounds like a
 * concurrency test. It is not -- not for THIS architecture. Because balances are
 * derived by SUM() over append-only rows, there is no mutable balance to lose an
 * update on. Two transactions appending entries never overwrite each other, so
 * the sum comes out exact even with zero locking. A fully unsynchronised
 * implementation passes that assertion every time.
 *
 * What concurrency actually breaks in a derived-balance ledger is the
 * READ-THEN-WRITE DECISION: the overdraft check. Each transfer reads the balance
 * to decide whether it may proceed, then appends. Without serialisation, N
 * transactions all read the same pre-spend balance, all conclude they can
 * afford it, and all append -- driving the wallet negative. The money is still
 * conserved (drift stays 0), but the wallet is overdrawn, which is the bug.
 *
 * So the discriminating test funds the wallet with LESS than the total being
 * attempted, and asserts that exactly the affordable number of transfers
 * succeed. That fails loudly against an unlocked implementation.
 */

const CONCURRENCY = 200;
const AMOUNT = 50n;

interface Fixture {
  alice: TestUser;
  bob: TestUser;
  source: string;
  dest: string;
  treasury: string;
}

async function setupFixture(fundAmount: bigint): Promise<Fixture> {
  const alice = await registerUser();
  const bob = await registerUser();
  const source = await createWallet(alice, 'Alice Source');
  const dest = await createWallet(bob, 'Bob Dest');
  const treasury = await createSystemWallet(alice.id);
  if (fundAmount > 0n) {
    await fundWallet(treasury, source, fundAmount, alice.id);
  }
  return { alice, bob, source, dest, treasury };
}

function fireTransfer(fx: Fixture, amount: bigint, reference: string) {
  return request(testApp())
    .post('/v1/transfers')
    .set('Authorization', `Bearer ${fx.alice.accessToken}`)
    .set('Idempotency-Key', idempotencyKey())
    .send({
      sourceWalletId: fx.source,
      destWalletId: fx.dest,
      amount: amount.toString(),
      reference,
    });
}

describe('concurrency stress', () => {
  beforeEach(async () => {
    await resetDatabase();
    txStats.reset();
  });

  afterAll(async () => {
    await shutdownTestResources();
  });

  it(`keeps the derived balance exact under ${CONCURRENCY} fully-funded parallel transfers`, async () => {
    const total = AMOUNT * BigInt(CONCURRENCY);
    const fx = await setupFixture(total);

    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        fireTransfer(fx, AMOUNT, `stress-${i}`),
      ),
    );

    const succeeded = responses.filter((r) => r.status === 201);
    const failed = responses.filter((r) => r.status !== 201);

    expect(failed.map((r) => ({ status: r.status, body: r.body }))).toEqual([]);
    expect(succeeded).toHaveLength(CONCURRENCY);

    // EXACTLY correct -- not "close", not "within tolerance". Zero drift.
    expect(await balanceOf(fx.source)).toBe(0n);
    expect(await balanceOf(fx.dest)).toBe(total);
    expect(await countTransfers()).toBe(CONCURRENCY + 1); // +1 funding transfer

    const totals = await ledgerTotals();
    expect(totals.drift).toBe(0n);
    expect(totals.debits).toBe(totals.credits);
  });

  it(
    'permits exactly as many concurrent transfers as the wallet can afford ' +
      '(the test that actually detects a missing lock)',
    async () => {
      // Fund only half of what the burst will attempt to spend.
      const affordable = CONCURRENCY / 2;
      const funded = AMOUNT * BigInt(affordable);
      const fx = await setupFixture(funded);

      const responses = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          fireTransfer(fx, AMOUNT, `contended-${i}`),
        ),
      );

      const succeeded = responses.filter((r) => r.status === 201);
      const rejected = responses.filter((r) => r.status === 422);
      const unexpected = responses.filter(
        (r) => r.status !== 201 && r.status !== 422,
      );

      expect(unexpected.map((r) => ({ status: r.status, body: r.body }))).toEqual([]);

      const sourceBalance = await balanceOf(fx.source);
      const destBalance = await balanceOf(fx.dest);

      // THE OVERDRAFT ASSERTION. An unlocked implementation drives this negative.
      expect(sourceBalance).toBeGreaterThanOrEqual(0n);

      // Exactly the affordable number committed -- no more, no fewer.
      expect(succeeded).toHaveLength(affordable);
      expect(rejected).toHaveLength(CONCURRENCY - affordable);

      expect(sourceBalance).toBe(0n);
      expect(destBalance).toBe(funded);

      const totals = await ledgerTotals();
      expect(totals.drift).toBe(0n);
      expect(totals.debits).toBe(totals.credits);
    },
  );

  it('never lets a wallet go negative when every request races for the last unit', async () => {
    // One unit of value, many claimants. Exactly one may win.
    const fx = await setupFixture(AMOUNT);

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) => fireTransfer(fx, AMOUNT, `last-unit-${i}`)),
    );

    const succeeded = responses.filter((r) => r.status === 201);
    expect(succeeded).toHaveLength(1);
    expect(await balanceOf(fx.source)).toBe(0n);
    expect(await balanceOf(fx.dest)).toBe(AMOUNT);

    const totals = await ledgerTotals();
    expect(totals.drift).toBe(0n);
  });

  it('records no partial ledger writes under load', async () => {
    const fx = await setupFixture(AMOUNT * 40n);

    await Promise.all(
      Array.from({ length: 100 }, (_, i) => fireTransfer(fx, AMOUNT, `partial-${i}`)),
    );

    // Every transfer that exists must have exactly two entries that sum to zero.
    const { rows } = await testPool().query<{
      transfer_id: string;
      entry_count: string;
      net: string;
    }>(
      `SELECT transfer_id,
              count(*)::text AS entry_count,
              COALESCE(SUM(signed_amount), 0)::text AS net
         FROM ledger_entries
        GROUP BY transfer_id
       HAVING count(*) <> 2 OR COALESCE(SUM(signed_amount), 0) <> 0`,
    );
    expect(rows).toEqual([]);
  });
});
