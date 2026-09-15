import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { txStats } from '../../src/db/tx';
import {
  balanceOf,
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
  type TestUser,
} from '../setup/helpers';

/**
 * DEADLOCK TESTS
 *
 * A transfer locks two wallet rows. If it locked them in the order they appear
 * in the request -- source then destination -- then A->B would take (A, B) while
 * a simultaneous B->A took (B, A), each holding what the other needs. Postgres
 * would detect the cycle and kill one with SQLSTATE 40P01.
 *
 * The fix is a deterministic global order: sort the wallet ids and lock
 * ascending regardless of direction. Both transfers then request A first, so one
 * simply waits. No cycle can form.
 *
 * Crucially these tests assert on txStats.deadlocks, not merely on HTTP status.
 * withTransaction retries 40P01 up to three times, so a lock-ordering bug could
 * hide behind the retry and still return 201. Counting the deadlocks makes the
 * retry safety net unable to disguise a broken design.
 */
describe('deadlock avoidance', () => {
  let alice: TestUser;
  let bob: TestUser;
  let walletA: string;
  let walletB: string;

  beforeEach(async () => {
    await resetDatabase();
    txStats.reset();

    alice = await registerUser();
    bob = await registerUser();
    walletA = await createWallet(alice, 'Wallet A');
    walletB = await createWallet(bob, 'Wallet B');

    const treasury = await createSystemWallet(alice.id);
    await fundWallet(treasury, walletA, 100_000n, alice.id);
    await fundWallet(treasury, walletB, 100_000n, alice.id);
  });

  afterAll(async () => {
    await shutdownTestResources();
  });

  function transfer(user: TestUser, from: string, to: string, amount: bigint, ref: string) {
    return request(testApp())
      .post('/v1/transfers')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send({
        sourceWalletId: from,
        destWalletId: to,
        amount: amount.toString(),
        reference: ref,
      });
  }

  it('survives many simultaneous A->B and B->A transfers with no deadlock', async () => {
    const PAIRS = 60;
    const AMOUNT = 10n;

    // Interleave the two directions so opposing transfers genuinely overlap in
    // time; issuing all of one direction first would not exercise the cycle.
    const requests = Array.from({ length: PAIRS * 2 }, (_, i) =>
      i % 2 === 0
        ? transfer(alice, walletA, walletB, AMOUNT, `ab-${i}`)
        : transfer(bob, walletB, walletA, AMOUNT, `ba-${i}`),
    );

    const responses = await Promise.all(requests);

    const failed = responses.filter((r) => r.status !== 201);
    expect(failed.map((r) => ({ status: r.status, body: r.body }))).toEqual([]);

    // THE ASSERTION THAT MATTERS: zero deadlocks, not "deadlocks that were
    // successfully retried".
    expect(txStats.deadlocks).toBe(0);
    expect(txStats.serializationFailures).toBe(0);
    expect(txStats.retries).toBe(0);

    // Equal traffic both ways, so both wallets return to their starting balance.
    expect(await balanceOf(walletA)).toBe(100_000n);
    expect(await balanceOf(walletB)).toBe(100_000n);

    const totals = await ledgerTotals();
    expect(totals.drift).toBe(0n);
    expect(totals.debits).toBe(totals.credits);
  });

  it('survives a three-wallet cycle A->B, B->C, C->A run in parallel', async () => {
    // A cycle across three wallets is the classic case a naive "lock source
    // then destination" scheme deadlocks on even when no two transfers are
    // exact opposites.
    const carol = await registerUser();
    const walletC = await createWallet(carol, 'Wallet C');
    const treasury = await createSystemWallet(alice.id);
    await fundWallet(treasury, walletC, 100_000n, alice.id);

    const ROUNDS = 40;
    const requests = Array.from({ length: ROUNDS * 3 }, (_, i) => {
      const leg = i % 3;
      if (leg === 0) return transfer(alice, walletA, walletB, 5n, `abc-a-${i}`);
      if (leg === 1) return transfer(bob, walletB, walletC, 5n, `abc-b-${i}`);
      return transfer(carol, walletC, walletA, 5n, `abc-c-${i}`);
    });

    const responses = await Promise.all(requests);
    const failed = responses.filter((r) => r.status !== 201);

    expect(failed.map((r) => ({ status: r.status, body: r.body }))).toEqual([]);
    expect(txStats.deadlocks).toBe(0);
    expect(txStats.retries).toBe(0);

    // Each wallet sent and received the same number of units.
    expect(await balanceOf(walletA)).toBe(100_000n);
    expect(await balanceOf(walletB)).toBe(100_000n);
    expect(await balanceOf(walletC)).toBe(100_000n);

    const totals = await ledgerTotals();
    expect(totals.drift).toBe(0n);
  });

  it('stays deadlock-free when opposing transfers also contend for scarce funds', async () => {
    // Combines the two hard cases: bidirectional traffic AND a balance tight
    // enough that some transfers must be rejected mid-burst.
    await resetDatabase();
    txStats.reset();

    alice = await registerUser();
    bob = await registerUser();
    walletA = await createWallet(alice, 'Wallet A');
    walletB = await createWallet(bob, 'Wallet B');
    const treasury = await createSystemWallet(alice.id);
    await fundWallet(treasury, walletA, 500n, alice.id);
    await fundWallet(treasury, walletB, 500n, alice.id);

    const requests = Array.from({ length: 120 }, (_, i) =>
      i % 2 === 0
        ? transfer(alice, walletA, walletB, 100n, `tight-ab-${i}`)
        : transfer(bob, walletB, walletA, 100n, `tight-ba-${i}`),
    );

    const responses = await Promise.all(requests);
    const unexpected = responses.filter((r) => r.status !== 201 && r.status !== 422);

    expect(unexpected.map((r) => ({ status: r.status, body: r.body }))).toEqual([]);
    expect(txStats.deadlocks).toBe(0);

    // Neither wallet may go negative, and no value may be created or destroyed.
    const a = await balanceOf(walletA);
    const b = await balanceOf(walletB);
    expect(a).toBeGreaterThanOrEqual(0n);
    expect(b).toBeGreaterThanOrEqual(0n);
    expect(a + b).toBe(1_000n);

    const totals = await ledgerTotals();
    expect(totals.drift).toBe(0n);
  });
});
