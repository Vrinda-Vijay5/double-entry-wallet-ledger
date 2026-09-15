import type { PoolClient } from 'pg';
import { ForbiddenError, NotFoundError } from '../../errors';
import { type Minor, formatMinor } from '../../domain/money';

export interface WalletRow {
  id: string;
  user_id: string;
  kind: 'user' | 'system';
  label: string;
  currency: string;
  allow_negative: boolean;
  created_at: Date;
}

/**
 * THE balance definition, in SQL.
 *
 * This is a direct translation of `deriveBalance` in domain/ledger.ts, and
 * tests/unit/balance.test.ts asserts the two agree on the same inputs. There is
 * no balance column to drift from: if this query is right, the balance is right.
 *
 * COALESCE handles a wallet with no entries yet, where SUM() returns NULL.
 */
export const BALANCE_SQL = `
  SELECT COALESCE(SUM(signed_amount), 0)::text AS balance
    FROM ledger_entries
   WHERE wallet_id = $1
`;

export async function deriveBalanceFromDb(
  client: PoolClient,
  walletId: string,
): Promise<Minor> {
  const { rows } = await client.query<{ balance: string }>(BALANCE_SQL, [walletId]);
  return BigInt(rows[0]?.balance ?? '0');
}

export async function getWalletById(
  client: PoolClient,
  walletId: string,
): Promise<WalletRow | null> {
  const { rows } = await client.query<WalletRow>(
    `SELECT id, user_id, kind, label, currency, allow_negative, created_at
       FROM wallets WHERE id = $1`,
    [walletId],
  );
  return rows[0] ?? null;
}

/**
 * Fetches a wallet and enforces row-level ownership.
 *
 * Deliberately returns 404 (not 403) when the wallet exists but belongs to
 * someone else: a 403 confirms the id is real, letting an attacker enumerate
 * valid wallet ids. Admins bypass the ownership check but still get a 404 for
 * ids that genuinely do not exist.
 */
export async function getOwnedWallet(
  client: PoolClient,
  params: { walletId: string; userId: string; role: 'customer' | 'admin' },
): Promise<WalletRow> {
  const wallet = await getWalletById(client, params.walletId);
  if (!wallet) throw new NotFoundError('wallet not found');
  if (params.role !== 'admin' && wallet.user_id !== params.userId) {
    throw new NotFoundError('wallet not found');
  }
  return wallet;
}

/** Used where an explicit 403 is correct because the resource is already known. */
export function assertOwnership(
  wallet: WalletRow,
  user: { id: string; role: 'customer' | 'admin' },
): void {
  if (user.role !== 'admin' && wallet.user_id !== user.id) {
    throw new ForbiddenError('you do not own this wallet');
  }
}

export async function listWalletsForUser(
  client: PoolClient,
  userId: string,
): Promise<Array<WalletRow & { balance: Minor }>> {
  const { rows } = await client.query<WalletRow & { balance: string }>(
    `SELECT w.id, w.user_id, w.kind, w.label, w.currency, w.allow_negative, w.created_at,
            COALESCE(SUM(le.signed_amount), 0)::text AS balance
       FROM wallets w
       LEFT JOIN ledger_entries le ON le.wallet_id = w.id
      WHERE w.user_id = $1
      GROUP BY w.id
      ORDER BY w.created_at ASC`,
    [userId],
  );
  return rows.map((r) => ({ ...r, balance: BigInt(r.balance) }));
}

export async function createWallet(
  client: PoolClient,
  params: { userId: string; label: string },
): Promise<WalletRow> {
  const { rows } = await client.query<WalletRow>(
    `INSERT INTO wallets (user_id, label) VALUES ($1, $2)
     RETURNING id, user_id, kind, label, currency, allow_negative, created_at`,
    [params.userId, params.label],
  );
  return rows[0]!;
}

export function serializeWallet(
  wallet: WalletRow,
  balance?: Minor,
): Record<string, unknown> {
  return {
    id: wallet.id,
    userId: wallet.user_id,
    kind: wallet.kind,
    label: wallet.label,
    currency: wallet.currency,
    createdAt: wallet.created_at.toISOString(),
    ...(balance !== undefined ? { balance: formatMinor(balance) } : {}),
  };
}
