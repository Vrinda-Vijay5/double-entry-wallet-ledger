import type { PoolClient } from 'pg';
import { InsufficientFundsError, NotFoundError, ValidationError } from '../../errors';
import { buildTransferEntries, lockOrder } from '../../domain/ledger';
import { type Minor, formatMinor } from '../../domain/money';
import { withTransaction } from '../../db/tx';
import { runIdempotent } from '../idempotency/idempotency';
import { deriveBalanceFromDb, type WalletRow } from '../wallets/wallets.service';

export interface TransferInput {
  sourceWalletId: string;
  destWalletId: string;
  amount: Minor;
  reference?: string;
}

export interface TransferResult {
  id: string;
  sourceWalletId: string;
  destWalletId: string;
  amount: string;
  reference: string | null;
  createdAt: string;
  sourceBalance: string;
  destBalance: string;
}

/**
 * Locks the wallets a transfer will touch, in a deterministic global order.
 *
 * ## THE LOCK-ORDERING RULE (this is the deadlock proof)
 *
 * A transfer touches two wallet rows. If we locked them in REQUEST order --
 * source first, then destination -- then a simultaneous A->B and B->A would
 * acquire (A, B) and (B, A) respectively. Each would hold precisely what the
 * other is waiting for: a textbook lock cycle, which Postgres breaks by killing
 * one transaction with SQLSTATE 40P01 (deadlock_detected).
 *
 * Instead we impose a TOTAL ORDER on wallet ids and always acquire locks in
 * ascending order, regardless of which wallet is sending. Both directions then
 * request the lower id first, so one transaction simply waits for the other.
 *
 * Why that is airtight: a deadlock requires T1 to hold X while wanting Y, and
 * T2 to hold Y while wanting X. Under a global ordering, whichever of X and Y
 * sorts lower is acquired first by BOTH transactions, so no transaction can ever
 * hold the higher id while waiting for the lower one. The wait-for graph is
 * therefore acyclic by construction, and the argument extends unchanged to
 * transfers spanning three or more wallets.
 *
 * ## Why locks are acquired one statement at a time
 *
 * A single `WHERE id = ANY($1) ORDER BY id FOR UPDATE` would very likely lock in
 * sorted order too, since the LockRows node normally sits above Sort. But
 * "very likely" rests on a planner detail, not on a documented guarantee, and
 * the ordering here is load-bearing. An explicit loop makes acquisition order a
 * property of THIS CODE, verifiable by reading it. The extra round trip is
 * irrelevant next to the lock wait it is protecting.
 *
 * ## The invariant this establishes
 *
 * The wallet row is the designated MUTEX for that wallet's slice of the ledger.
 * Any code path that appends ledger entries for a wallet must first hold that
 * wallet's row lock. That is what turns "read the balance, then decide, then
 * append" into a single critical section -- without it the overdraft check is a
 * race, because the balance is an aggregate over rows that do not exist yet and
 * so gives the database nothing to detect a conflict on.
 */
async function lockWalletsInOrder(
  client: PoolClient,
  walletIds: readonly string[],
): Promise<Map<string, WalletRow>> {
  const ordered = lockOrder(walletIds);
  const locked = new Map<string, WalletRow>();

  for (const walletId of ordered) {
    const { rows } = await client.query<WalletRow>(
      `SELECT id, user_id, kind, label, currency, allow_negative, created_at
         FROM wallets
        WHERE id = $1
          FOR UPDATE`,
      [walletId],
    );
    const row = rows[0];
    if (row) locked.set(row.id, row);
  }

  return locked;
}

export async function executeTransfer(
  client: PoolClient,
  params: TransferInput & { initiatedBy: string; initiatorRole: 'customer' | 'admin' },
): Promise<TransferResult> {
  const { sourceWalletId, destWalletId, amount, reference, initiatedBy } = params;

  if (amount <= 0n) {
    throw new ValidationError('amount must be greater than zero');
  }
  if (sourceWalletId === destWalletId) {
    throw new ValidationError('source and destination wallets must differ');
  }

  // Everything below runs while holding both wallet row locks.
  const locked = await lockWalletsInOrder(client, [sourceWalletId, destWalletId]);

  const source = locked.get(sourceWalletId);
  const dest = locked.get(destWalletId);
  if (!source) throw new NotFoundError('source wallet not found');
  if (!dest) throw new NotFoundError('destination wallet not found');

  // AUTHORIZATION: you may only move money OUT of a wallet you own. Anyone may
  // be the destination -- that is what makes a transfer useful. 404 rather than
  // 403 so wallet ids cannot be probed for existence.
  if (params.initiatorRole !== 'admin' && source.user_id !== initiatedBy) {
    throw new NotFoundError('source wallet not found');
  }

  if (source.currency !== dest.currency) {
    throw new ValidationError('cannot transfer between wallets of different currencies');
  }

  // OVERDRAFT CHECK. Sound only because we hold source's row lock: no other
  // transaction can append entries for this wallet between this read and the
  // insert below, so the balance we are deciding on cannot go stale.
  const sourceBalance = await deriveBalanceFromDb(client, sourceWalletId);
  if (!source.allow_negative && sourceBalance < amount) {
    throw new InsufficientFundsError({
      walletId: sourceWalletId,
      balance: formatMinor(sourceBalance),
      requested: formatMinor(amount),
    });
  }

  const { rows } = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO transfers (source_wallet_id, dest_wallet_id, amount, reference, initiated_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [sourceWalletId, destWalletId, amount.toString(), reference ?? null, initiatedBy],
  );
  const transfer = rows[0]!;

  // Both entries in ONE statement. Not a style choice: a single INSERT cannot
  // partially succeed, so the matched pair is atomic even before the deferred
  // balance trigger gets a chance to check it at COMMIT.
  const [debit, credit] = buildTransferEntries({ sourceWalletId, destWalletId, amount });
  await client.query(
    `INSERT INTO ledger_entries (transfer_id, wallet_id, direction, amount)
     VALUES ($1, $2, 'debit', $4), ($1, $3, 'credit', $4)`,
    [transfer.id, debit.walletId, credit.walletId, amount.toString()],
  );

  return {
    id: transfer.id,
    sourceWalletId,
    destWalletId,
    amount: formatMinor(amount),
    reference: reference ?? null,
    createdAt: transfer.created_at.toISOString(),
    // Read back rather than computed in JS: this is the ledger's own answer,
    // and it is consistent because we still hold both locks.
    sourceBalance: formatMinor(await deriveBalanceFromDb(client, sourceWalletId)),
    destBalance: formatMinor(await deriveBalanceFromDb(client, destWalletId)),
  };
}

/**
 * Route entry point.
 *
 * ONE transaction wraps the idempotency claim AND the transfer. That is what
 * makes concurrent duplicate requests safe: the claim's unique-index conflict
 * and the money movement commit or roll back together, so a committed
 * idempotency row always has a committed transfer behind it and a failed
 * attempt leaves no trace of either.
 *
 * LOCK ORDER ACROSS RESOURCE TYPES: the idempotency key row is always acquired
 * BEFORE any wallet row, on every path. Mixing the two orderings -- some callers
 * taking wallets first -- would reintroduce exactly the cycle the wallet
 * ordering eliminates.
 */
export async function createTransfer(params: {
  userId: string;
  userRole: 'customer' | 'admin';
  idempotencyKey: string;
  input: TransferInput & { initiatedBy: string };
  requestBody: unknown;
}): Promise<{ status: number; body: TransferResult; replayed: boolean }> {
  return withTransaction(
    async (client) => {
      const outcome = await runIdempotent<TransferResult>(
        client,
        {
          userId: params.userId,
          idempotencyKey: params.idempotencyKey,
          endpoint: 'POST /v1/transfers',
          requestBody: params.requestBody,
        },
        async () => {
          const result = await executeTransfer(client, {
            ...params.input,
            initiatorRole: params.userRole,
          });
          return { status: 201, body: result, transferId: result.id };
        },
      );
      return { status: outcome.status, body: outcome.body, replayed: outcome.replayed };
    },
    // See TransactionOptions in db/tx.ts for the full justification of this
    // isolation level and why SERIALIZABLE is the wrong trade here.
    { isolation: 'READ COMMITTED' },
  );
}
