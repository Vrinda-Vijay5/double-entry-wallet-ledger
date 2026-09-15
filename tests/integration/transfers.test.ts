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

describe('transfers', () => {
  let alice: TestUser;
  let bob: TestUser;
  let aliceWallet: string;
  let bobWallet: string;
  let treasury: string;

  beforeEach(async () => {
    await resetDatabase();
    alice = await registerUser();
    bob = await registerUser();
    aliceWallet = await createWallet(alice, 'Alice Main');
    bobWallet = await createWallet(bob, 'Bob Main');
    treasury = await createSystemWallet(alice.id);
    await fundWallet(treasury, aliceWallet, 10_000n, alice.id);
  });

  afterAll(async () => {
    await shutdownTestResources();
  });

  const post = (body: unknown, user: TestUser = alice, key = idempotencyKey()) =>
    request(testApp())
      .post('/v1/transfers')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .set('Idempotency-Key', key)
      .send(body as object);

  describe('happy path', () => {
    it('writes exactly one debit and one credit and moves the derived balances', async () => {
      const res = await post({
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: '2500',
        reference: 'rent',
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: '2500',
        reference: 'rent',
        sourceBalance: '7500',
        destBalance: '2500',
      });

      // Verify the ledger rows themselves, not just the API's summary.
      const { rows } = await testPool().query<{
        wallet_id: string;
        direction: string;
        amount: string;
        signed_amount: string;
      }>(
        `SELECT wallet_id, direction, amount::text, signed_amount::text
           FROM ledger_entries WHERE transfer_id = $1 ORDER BY direction`,
        [res.body.id],
      );

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        wallet_id: aliceWallet,
        direction: 'debit',
        amount: '2500',
        signed_amount: '-2500',
      });
      expect(rows[1]).toMatchObject({
        wallet_id: bobWallet,
        direction: 'credit',
        amount: '2500',
        signed_amount: '2500',
      });

      expect(await balanceOf(aliceWallet)).toBe(7_500n);
      expect(await balanceOf(bobWallet)).toBe(2_500n);

      const totals = await ledgerTotals();
      expect(totals.debits).toBe(totals.credits);
      expect(totals.drift).toBe(0n);
    });

    it('exposes the derived balance through the balance endpoint', async () => {
      await post({ sourceWalletId: aliceWallet, destWalletId: bobWallet, amount: 1000 });

      const res = await request(testApp())
        .get(`/v1/wallets/${aliceWallet}/balance`)
        .set('Authorization', `Bearer ${alice.accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.balance).toBe('9000');
      expect(res.body.walletId).toBe(aliceWallet);
    });

    it('accepts an amount as an integer or a string identically', async () => {
      const a = await post({
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: 100,
      });
      const b = await post({
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: '100',
      });

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(a.body.amount).toBe('100');
      expect(b.body.amount).toBe('100');
    });
  });

  describe('overdraft', () => {
    it('rejects a transfer larger than the balance and writes NOTHING', async () => {
      const before = await countLedgerEntries();

      const res = await post({
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: '10001',
      });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('insufficient_funds');
      expect(res.body.error.details).toMatchObject({
        walletId: aliceWallet,
        balance: '10000',
        requested: '10001',
      });

      // No partial write: not the transfer row, not a lone debit.
      expect(await countLedgerEntries()).toBe(before);
      expect(await countTransfers()).toBe(1); // only the funding transfer
      expect(await balanceOf(aliceWallet)).toBe(10_000n);
      expect(await balanceOf(bobWallet)).toBe(0n);
    });

    it('allows a transfer of exactly the full balance', async () => {
      const res = await post({
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: '10000',
      });

      expect(res.status).toBe(201);
      expect(await balanceOf(aliceWallet)).toBe(0n);
    });

    it('rejects a second transfer once the wallet is drained', async () => {
      await post({ sourceWalletId: aliceWallet, destWalletId: bobWallet, amount: '10000' });
      const res = await post({
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: '1',
      });
      expect(res.status).toBe(422);
      expect(await balanceOf(aliceWallet)).toBe(0n);
    });

    it('permits a system wallet to go negative -- that is how money is issued', async () => {
      // The treasury is already at -10000 from funding Alice.
      expect(await balanceOf(treasury)).toBe(-10_000n);
      const totals = await ledgerTotals();
      expect(totals.drift).toBe(0n);
    });
  });

  describe('validation', () => {
    it('rejects a self-transfer', async () => {
      const res = await post({
        sourceWalletId: aliceWallet,
        destWalletId: aliceWallet,
        amount: '10',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });

    it.each([
      ['zero', 0],
      ['negative', -100],
      ['fractional', 10.5],
      ['non-numeric string', 'abc'],
    ])('rejects a %s amount', async (_label, amount) => {
      const res = await post({
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount,
      });
      expect(res.status).toBe(400);
    });

    it('rejects a malformed wallet id', async () => {
      const res = await post({
        sourceWalletId: 'not-a-uuid',
        destWalletId: bobWallet,
        amount: '10',
      });
      expect(res.status).toBe(400);
    });

    it('404s on a nonexistent destination wallet', async () => {
      const res = await post({
        sourceWalletId: aliceWallet,
        destWalletId: '00000000-0000-4000-8000-000000000999',
        amount: '10',
      });
      expect(res.status).toBe(404);
    });

    it('requires an Idempotency-Key header', async () => {
      const res = await request(testApp())
        .post('/v1/transfers')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({ sourceWalletId: aliceWallet, destWalletId: bobWallet, amount: '10' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Idempotency-Key/);
    });

    it('rejects a too-short Idempotency-Key', async () => {
      const res = await post(
        { sourceWalletId: aliceWallet, destWalletId: bobWallet, amount: '10' },
        alice,
        'short',
      );
      expect(res.status).toBe(400);
    });
  });

  describe('retrieval', () => {
    it('returns a transfer with both of its entries to either counterparty', async () => {
      const created = await post({
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: '750',
      });

      for (const user of [alice, bob]) {
        const res = await request(testApp())
          .get(`/v1/transfers/${created.body.id}`)
          .set('Authorization', `Bearer ${user.accessToken}`);

        expect(res.status).toBe(200);
        expect(res.body.entries).toHaveLength(2);
        expect(res.body.amount).toBe('750');
      }
    });

    it('hides a transfer from an unrelated user', async () => {
      const created = await post({
        sourceWalletId: aliceWallet,
        destWalletId: bobWallet,
        amount: '750',
      });
      const carol = await registerUser();

      const res = await request(testApp())
        .get(`/v1/transfers/${created.body.id}`)
        .set('Authorization', `Bearer ${carol.accessToken}`);

      expect(res.status).toBe(404);
    });
  });
});
