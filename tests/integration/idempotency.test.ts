import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  balanceOf,
  countLedgerEntries,
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

describe('idempotency', () => {
  let alice: TestUser;
  let bob: TestUser;
  let aliceWallet: string;
  let bobWallet: string;

  beforeEach(async () => {
    await resetDatabase();
    alice = await registerUser();
    bob = await registerUser();
    aliceWallet = await createWallet(alice, 'Alice Main');
    bobWallet = await createWallet(bob, 'Bob Main');
    const treasury = await createSystemWallet(alice.id);
    await fundWallet(treasury, aliceWallet, 100_000n, alice.id);
  });

  afterAll(async () => {
    await shutdownTestResources();
  });

  const post = (key: string, body: unknown, user: TestUser = alice) =>
    request(testApp())
      .post('/v1/transfers')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .set('Idempotency-Key', key)
      .send(body as object);

  describe('sequential retries', () => {
    it('returns the original result without creating a second transfer', async () => {
      const key = idempotencyKey();
      const body = {
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: '5000',
      };

      const first = await post(key, body);
      expect(first.status).toBe(201);

      const second = await post(key, body);
      expect(second.status).toBe(201);

      // Byte-identical replay, including the transfer id.
      expect(second.body).toEqual(first.body);
      expect(second.headers['idempotent-replay']).toBe('true');
      expect(first.headers['idempotent-replay']).toBeUndefined();

      expect(await countTransfers()).toBe(2); // funding + one transfer
      expect(await countLedgerEntries()).toBe(4);
      expect(await balanceOf(aliceWallet)).toBe(95_000n);
      expect(await balanceOf(bobWallet)).toBe(5_000n);
    });

    it('survives many sequential retries', async () => {
      const key = idempotencyKey();
      const body = { sourceWalletId: aliceWallet, destWalletId: bobWallet, amount: '10' };

      const first = await post(key, body);
      for (let i = 0; i < 10; i++) {
        const retry = await post(key, body);
        expect(retry.body.id).toBe(first.body.id);
      }

      expect(await countTransfers()).toBe(2);
      expect(await balanceOf(bobWallet)).toBe(10n);
    });

    it('is insensitive to JSON key ordering on retry', async () => {
      const key = idempotencyKey();

      const first = await post(key, {
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: '77',
      });
      // Same payload, different serialisation order -- must still replay.
      const second = await post(key, {
        amount: '77',
        destWalletId: bobWallet,
        sourceWalletId: aliceWallet,
      });

      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
      expect(await countTransfers()).toBe(2);
    });

    it('rejects the same key used with a different payload', async () => {
      const key = idempotencyKey();
      await post(key, {
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: '100',
      });

      const conflicting = await post(key, {
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: '200',
      });

      expect(conflicting.status).toBe(409);
      expect(conflicting.body.error.code).toBe('idempotency_key_reuse');
      expect(await countTransfers()).toBe(2);
    });

    it('scopes keys per user -- two users may reuse the same key string', async () => {
      const key = 'shared-key-value-12345';
      const bobTreasury = await createSystemWallet(bob.id);
      await fundWallet(bobTreasury, bobWallet, 5_000n, bob.id);

      const a = await post(key, {
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: '100',
      });
      const b = await post(
        key,
        { sourceWalletId: bobWallet, destWalletId: aliceWallet, amount: '200' },
        bob,
      );

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(a.body.id).not.toBe(b.body.id);
    });

    it('releases the key when the operation failed, so a retry can succeed', async () => {
      const key = idempotencyKey();
      const body = {
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: '500000', // more than the 100000 balance
      };

      const failed = await post(key, body);
      expect(failed.status).toBe(422);

      // Nothing was recorded, so the key is free. This is deliberate: a
      // transfer rejected for insufficient funds should be retryable with the
      // same key once the wallet is funded.
      const treasury = await createSystemWallet(alice.id);
      await fundWallet(treasury, aliceWallet, 500_000n, alice.id);

      const retried = await post(key, body);
      expect(retried.status).toBe(201);
    });
  });

  describe('CONCURRENT duplicates', () => {
    it('produces exactly one transfer from N simultaneous identical requests', async () => {
      const key = idempotencyKey();
      const body = {
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: '3000',
      };

      const N = 40;
      const responses = await Promise.all(
        Array.from({ length: N }, () => post(key, body)),
      );

      const created = responses.filter((r) => r.status === 201);
      const other = responses.filter((r) => r.status !== 201);

      expect(other.map((r) => ({ status: r.status, body: r.body }))).toEqual([]);
      expect(created).toHaveLength(N);

      // Every response describes the SAME transfer.
      const ids = new Set(created.map((r) => r.body.id));
      expect(ids.size).toBe(1);

      // And exactly one transfer actually exists.
      expect(await countTransfers()).toBe(2); // funding + one
      expect(await countLedgerEntries()).toBe(4);

      // Exactly one replay winner; everyone else replayed.
      const replays = responses.filter(
        (r) => r.headers['idempotent-replay'] === 'true',
      );
      expect(replays).toHaveLength(N - 1);

      expect(await balanceOf(aliceWallet)).toBe(97_000n);
      expect(await balanceOf(bobWallet)).toBe(3_000n);

      const totals = await ledgerTotals();
      expect(totals.drift).toBe(0n);
    });

    it('holds when many distinct keys race alongside many duplicates', async () => {
      // 10 distinct keys x 10 duplicates each = 100 requests, 10 transfers.
      const keys = Array.from({ length: 10 }, () => idempotencyKey());
      const requests = keys.flatMap((key, i) =>
        Array.from({ length: 10 }, () =>
          post(key, {
            sourceWalletId: aliceWallet,
            destWalletId: bobWallet,
            amount: '100',
            reference: `batch-${i}`,
          }),
        ),
      );

      const responses = await Promise.all(requests);
      expect(responses.every((r) => r.status === 201)).toBe(true);

      const distinctTransferIds = new Set(responses.map((r) => r.body.id));
      expect(distinctTransferIds.size).toBe(10);

      expect(await countTransfers()).toBe(11); // funding + 10
      expect(await balanceOf(bobWallet)).toBe(1_000n);

      const totals = await ledgerTotals();
      expect(totals.drift).toBe(0n);
    });

    it('records exactly one idempotency row per key under a concurrent burst', async () => {
      const key = idempotencyKey();
      await Promise.all(
        Array.from({ length: 25 }, () =>
          post(key, {
            sourceWalletId: aliceWallet,
            destWalletId: bobWallet,
            amount: '11',
          }),
        ),
      );

      const { rows } = await testPool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM idempotency_keys WHERE idempotency_key = $1`,
        [key],
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });
  });
});
