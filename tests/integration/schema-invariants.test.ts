import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  createSystemWallet,
  createWallet,
  fundWallet,
  ledgerTotals,
  registerUser,
  resetDatabase,
  shutdownTestResources,
  testPool,
  type TestUser,
} from '../setup/helpers';

/**
 * DATABASE-LEVEL CORRECTNESS GUARANTEES
 *
 * Every other test in this suite goes through the API, so they all prove
 * statements about the application code. These go straight to SQL and prove
 * statements about the DATABASE -- that the invariants hold even against a
 * caller that bypasses the service layer entirely.
 *
 * That distinction matters. "The service layer always writes both entries" is a
 * claim about today's code. "The database cannot hold a single-sided entry" is
 * a claim about every future version of it, including a buggy one.
 */
describe('schema invariants', () => {
  let alice: TestUser;
  let walletA: string;
  let walletB: string;

  beforeEach(async () => {
    await resetDatabase();
    alice = await registerUser();
    walletA = await createWallet(alice, 'A');
    walletB = await createWallet(alice, 'B');
    const treasury = await createSystemWallet(alice.id);
    await fundWallet(treasury, walletA, 10_000n, alice.id);
  });

  afterAll(async () => {
    await shutdownTestResources();
  });

  describe('the ledger is append-only', () => {
    it('refuses UPDATE on a ledger entry', async () => {
      await expect(
        testPool().query(
          `UPDATE ledger_entries SET amount = 999999
            WHERE id = (SELECT min(id) FROM ledger_entries)`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('refuses DELETE on a ledger entry', async () => {
      await expect(
        testPool().query(
          `DELETE FROM ledger_entries WHERE id = (SELECT min(id) FROM ledger_entries)`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('refuses UPDATE and DELETE on a transfer', async () => {
      await expect(
        testPool().query(`UPDATE transfers SET amount = 1`),
      ).rejects.toThrow(/append-only/);
      await expect(testPool().query(`DELETE FROM transfers`)).rejects.toThrow(
        /append-only/,
      );
    });

    it('leaves the balance untouched after a rejected mutation', async () => {
      await testPool()
        .query(`UPDATE ledger_entries SET amount = 999999`)
        .catch(() => undefined);

      const totals = await ledgerTotals();
      expect(totals.drift).toBe(0n);
    });
  });

  describe('double-entry is enforced at COMMIT', () => {
    /** Runs `body` in a transaction and returns the error COMMIT raised, if any. */
    async function commitAttempt(
      body: (q: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<void>,
    ): Promise<Error | null> {
      const client = await testPool().connect();
      try {
        await client.query('BEGIN');
        await body((sql, params) => client.query(sql, params as never));
        await client.query('COMMIT');
        return null;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        return err as Error;
      } finally {
        client.release();
      }
    }

    it('rejects a transfer with only a debit', async () => {
      const err = await commitAttempt(async (q) => {
        const res = (await q(
          `INSERT INTO transfers (source_wallet_id, dest_wallet_id, amount, initiated_by)
           VALUES ($1, $2, 100, $3) RETURNING id`,
          [walletA, walletB, alice.id],
        )) as { rows: Array<{ id: string }> };

        // Deliberately write ONLY the debit. Note this INSERT itself succeeds --
        // the constraint is deferred, so the failure lands at COMMIT.
        await q(
          `INSERT INTO ledger_entries (transfer_id, wallet_id, direction, amount)
           VALUES ($1, $2, 'debit', 100)`,
          [res.rows[0]!.id, walletA],
        );
      });

      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/has 1 ledger entries, expected exactly 2/);

      // Nothing survived the failed commit.
      const totals = await ledgerTotals();
      expect(totals.drift).toBe(0n);
    });

    it('rejects a transfer with only a credit', async () => {
      const err = await commitAttempt(async (q) => {
        const res = (await q(
          `INSERT INTO transfers (source_wallet_id, dest_wallet_id, amount, initiated_by)
           VALUES ($1, $2, 100, $3) RETURNING id`,
          [walletA, walletB, alice.id],
        )) as { rows: Array<{ id: string }> };

        await q(
          `INSERT INTO ledger_entries (transfer_id, wallet_id, direction, amount)
           VALUES ($1, $2, 'credit', 100)`,
          [res.rows[0]!.id, walletB],
        );
      });

      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/expected exactly 2/);
    });

    it('rejects a pair whose amounts do not match', async () => {
      const err = await commitAttempt(async (q) => {
        const res = (await q(
          `INSERT INTO transfers (source_wallet_id, dest_wallet_id, amount, initiated_by)
           VALUES ($1, $2, 100, $3) RETURNING id`,
          [walletA, walletB, alice.id],
        )) as { rows: Array<{ id: string }> };

        await q(
          `INSERT INTO ledger_entries (transfer_id, wallet_id, direction, amount)
           VALUES ($1, $2, 'debit', 100), ($1, $3, 'credit', 99)`,
          [res.rows[0]!.id, walletA, walletB],
        );
      });

      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/unbalanced: debits=100 credits=99/);
    });

    it('accepts a correctly matched pair', async () => {
      const err = await commitAttempt(async (q) => {
        const res = (await q(
          `INSERT INTO transfers (source_wallet_id, dest_wallet_id, amount, initiated_by)
           VALUES ($1, $2, 100, $3) RETURNING id`,
          [walletA, walletB, alice.id],
        )) as { rows: Array<{ id: string }> };

        await q(
          `INSERT INTO ledger_entries (transfer_id, wallet_id, direction, amount)
           VALUES ($1, $2, 'debit', 100), ($1, $3, 'credit', 100)`,
          [res.rows[0]!.id, walletA, walletB],
        );
      });

      expect(err).toBeNull();
    });
  });

  describe('column-level constraints', () => {
    it('rejects a non-positive ledger amount', async () => {
      await expect(
        testPool().query(
          `INSERT INTO ledger_entries (transfer_id, wallet_id, direction, amount)
           VALUES (gen_random_uuid(), $1, 'debit', 0)`,
          [walletA],
        ),
      ).rejects.toThrow();
    });

    it('rejects a transfer whose source and destination are the same wallet', async () => {
      await expect(
        testPool().query(
          `INSERT INTO transfers (source_wallet_id, dest_wallet_id, amount, initiated_by)
           VALUES ($1, $1, 100, $2)`,
          [walletA, alice.id],
        ),
      ).rejects.toThrow(/transfers_distinct_wallets/);
    });

    it('rejects two entries of the same direction on one transfer', async () => {
      const { rows } = await testPool().query<{ id: string }>(
        `INSERT INTO transfers (source_wallet_id, dest_wallet_id, amount, initiated_by)
         VALUES ($1, $2, 100, $3) RETURNING id`,
        [walletA, walletB, alice.id],
      );

      await expect(
        testPool().query(
          `INSERT INTO ledger_entries (transfer_id, wallet_id, direction, amount)
           VALUES ($1, $2, 'debit', 100), ($1, $3, 'debit', 100)`,
          [rows[0]!.id, walletA, walletB],
        ),
      ).rejects.toThrow(/ledger_entries_one_per_side_idx/);
    });

    it('forbids a non-system wallet from being marked allow_negative', async () => {
      await expect(
        testPool().query(
          `INSERT INTO wallets (user_id, label, kind, allow_negative)
           VALUES ($1, 'sneaky', 'user', true)`,
          [alice.id],
        ),
      ).rejects.toThrow(/wallets_only_system_may_go_negative/);
    });
  });

  describe('signed_amount is generated, not supplied', () => {
    it('always derives from direction and amount', async () => {
      const { rows } = await testPool().query<{
        direction: string;
        amount: string;
        signed_amount: string;
      }>(
        `SELECT direction, amount::text, signed_amount::text
           FROM ledger_entries ORDER BY id`,
      );

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const expected =
          row.direction === 'credit' ? row.amount : `-${row.amount}`;
        expect(row.signed_amount).toBe(expected);
      }
    });
  });
});
