/* eslint-disable no-console */
import 'dotenv/config';
import { createPool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';
import { hashPassword } from '../src/modules/auth/auth.service';
import { toMajorString } from '../src/domain/money';

/**
 * Demo data.
 *
 * Note that funding is NOT a magic balance insert -- there is no balance column
 * to insert into. The treasury is a `system` wallet permitted to go negative,
 * and every demo dollar reaches a customer through a real transfer that writes
 * a matched debit/credit pair. That keeps SUM(debits) = SUM(credits) true even
 * in seeded data, so the invariant tests are meaningful from the first row.
 */
const DEMO_PASSWORD = 'demo-password-123';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_PROD_SEED) {
    console.error('Refusing to seed a production database. Set ALLOW_PROD_SEED=1 to override.');
    process.exit(1);
  }

  const pool = createPool(url, { max: 4 });

  try {
    await migrate(pool);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM users WHERE email LIKE '%@demo.ledger'`,
      );
      if (Number(existing.rows[0]!.count) > 0) {
        console.log('Demo data already present; nothing to do.');
        await client.query('ROLLBACK');
        return;
      }

      const passwordHash = await hashPassword(DEMO_PASSWORD);

      const insertUser = async (email: string, role: 'customer' | 'admin') => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id`,
          [email, passwordHash, role],
        );
        return rows[0]!.id;
      };

      const insertWallet = async (
        userId: string,
        label: string,
        kind: 'user' | 'system' = 'user',
      ) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO wallets (user_id, label, kind, allow_negative)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [userId, label, kind, kind === 'system'],
        );
        return rows[0]!.id;
      };

      const transfer = async (
        from: string,
        to: string,
        amount: bigint,
        reference: string,
        initiatedBy: string,
      ) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO transfers (source_wallet_id, dest_wallet_id, amount, reference, initiated_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [from, to, amount.toString(), reference, initiatedBy],
        );
        const transferId = rows[0]!.id;
        await client.query(
          `INSERT INTO ledger_entries (transfer_id, wallet_id, direction, amount)
           VALUES ($1, $2, 'debit', $4), ($1, $3, 'credit', $4)`,
          [transferId, from, to, amount.toString()],
        );
        return transferId;
      };

      const adminId = await insertUser('admin@demo.ledger', 'admin');
      const aliceId = await insertUser('alice@demo.ledger', 'customer');
      const bobId = await insertUser('bob@demo.ledger', 'customer');

      const treasury = await insertWallet(adminId, 'Treasury', 'system');
      const aliceMain = await insertWallet(aliceId, 'Alice Main');
      const aliceSavings = await insertWallet(aliceId, 'Alice Savings');
      const bobMain = await insertWallet(bobId, 'Bob Main');

      await transfer(treasury, aliceMain, 500_00n, 'initial funding', adminId);
      await transfer(treasury, bobMain, 250_00n, 'initial funding', adminId);
      await transfer(aliceMain, aliceSavings, 100_00n, 'move to savings', aliceId);
      await transfer(aliceMain, bobMain, 25_00n, 'dinner split', aliceId);

      await client.query('COMMIT');

      const balances = await pool.query<{ label: string; balance: string }>(
        `SELECT w.label, COALESCE(SUM(le.signed_amount), 0)::text AS balance
           FROM wallets w LEFT JOIN ledger_entries le ON le.wallet_id = w.id
          GROUP BY w.id, w.label ORDER BY w.created_at`,
      );

      console.log('\nSeeded demo data.\n');
      console.log(`  Login password for every demo user: ${DEMO_PASSWORD}`);
      console.log('  admin@demo.ledger (admin), alice@demo.ledger, bob@demo.ledger\n');
      console.log('  Derived balances:');
      for (const row of balances.rows) {
        console.log(`    ${row.label.padEnd(16)} ${toMajorString(BigInt(row.balance)).padStart(12)}`);
      }

      const invariant = await pool.query<{ drift: string }>(
        `SELECT COALESCE(SUM(signed_amount), 0)::text AS drift FROM ledger_entries`,
      );
      console.log(`\n  Global invariant SUM(debits) - SUM(credits) = ${invariant.rows[0]!.drift}\n`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
