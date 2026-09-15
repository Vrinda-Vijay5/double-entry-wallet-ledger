import type { PoolClient } from 'pg';
import { InsufficientFundsError, NotFoundError, ValidationError } from '../../errors';
import { buildTransferEntries } from '../../domain/ledger';
import { type Minor, formatMinor } from '../../domain/money';
import { withTransaction } from '../../db/tx';
import { runIdempotent } from '../idempotency/idempotency';
import { deriveBalanceFromDb, getWalletById } from '../wallets/wallets.service';

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
 * FIRST IMPLEMENTATION -- INTENTIONALLY UNSAFE UNDER CONCURRENCY.
 *
 * This reads each balance and then writes, with nothing serialising the two
 * steps. It is correct sequentially and wrong in parallel. It exists so the
 * concurrency stress test can be shown failing before the locking design is
 * introduced. The next commit replaces it.
 */
export async function executeTransfer(
  client: PoolClient,
  params: TransferInput & { initiatedBy: string; initiatorRole: 'customer' | 'admin' },
): Promise<TransferResult> {
  const { sourceWalletId, destWalletId, amount, reference, initiatedBy } = params;

  const source = await getWalletById(client, sourceWalletId);
  const dest = await getWalletById(client, destWalletId);
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

  const entries = buildTransferEntries({ sourceWalletId, destWalletId, amount });
  for (const entry of entries) {
    await client.query(
      `INSERT INTO ledger_entries (transfer_id, wallet_id, direction, amount)
       VALUES ($1, $2, $3, $4)`,
      [transfer.id, entry.walletId, entry.direction, entry.amount.toString()],
    );
  }

  return {
    id: transfer.id,
    sourceWalletId,
    destWalletId,
    amount: formatMinor(amount),
    reference: reference ?? null,
    createdAt: transfer.created_at.toISOString(),
    sourceBalance: formatMinor(await deriveBalanceFromDb(client, sourceWalletId)),
    destBalance: formatMinor(await deriveBalanceFromDb(client, destWalletId)),
  };
}

/** Entry point used by the route: one transaction wrapping idempotency + effect. */
export async function createTransfer(params: {
  userId: string;
  userRole: 'customer' | 'admin';
  idempotencyKey: string;
  input: TransferInput & { initiatedBy: string };
  requestBody: unknown;
}): Promise<{ status: number; body: TransferResult; replayed: boolean }> {
  return withTransaction(async (client) => {
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
  });
}
