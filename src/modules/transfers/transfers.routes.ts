import { Router } from 'express';
import { withTransaction } from '../../db/tx';
import { NotFoundError } from '../../errors';
import { requireAuth } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/error';
import { idempotencyKeyOf, requireIdempotencyKey } from '../../middleware/idempotency';
import { getOwnedWallet } from '../wallets/wallets.service';
import { CreateTransferSchema, TransferIdParam } from './transfers.schemas';
import { createTransfer } from './transfers.service';

export function transferRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  router.post(
    '/',
    requireIdempotencyKey,
    asyncHandler(async (req, res) => {
      const input = CreateTransferSchema.parse(req.body);
      const user = req.user!;

      const result = await createTransfer({
        userId: user.id,
        userRole: user.role,
        idempotencyKey: idempotencyKeyOf(req),
        input: {
          sourceWalletId: input.sourceWalletId,
          destWalletId: input.destWalletId,
          amount: input.amount,
          reference: input.reference,
          initiatedBy: user.id,
        },
        // Fingerprint the RAW body, not the parsed one: bigint does not survive
        // JSON.stringify, and the raw body is what the client actually sent.
        requestBody: req.body,
      });

      if (result.replayed) res.setHeader('idempotent-replay', 'true');
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = TransferIdParam.parse(req.params);
      const user = req.user!;

      const payload = await withTransaction(
        async (client) => {
          const { rows } = await client.query<{
            id: string;
            source_wallet_id: string;
            dest_wallet_id: string;
            amount: string;
            reference: string | null;
            created_at: Date;
          }>(
            `SELECT id, source_wallet_id, dest_wallet_id, amount::text, reference, created_at
               FROM transfers WHERE id = $1`,
            [id],
          );
          const transfer = rows[0];
          if (!transfer) throw new NotFoundError('transfer not found');

          // A transfer is visible to anyone who owns either side of it.
          // getOwnedWallet throws 404 for wallets the caller cannot see, so try
          // both legs and only fail if neither belongs to the caller.
          const visible = await Promise.all(
            [transfer.source_wallet_id, transfer.dest_wallet_id].map(async (walletId) => {
              try {
                await getOwnedWallet(client, {
                  walletId,
                  userId: user.id,
                  role: user.role,
                });
                return true;
              } catch {
                return false;
              }
            }),
          );
          if (!visible.some(Boolean)) throw new NotFoundError('transfer not found');

          const entries = await client.query<{
            wallet_id: string;
            direction: 'debit' | 'credit';
            amount: string;
          }>(
            `SELECT wallet_id, direction, amount::text
               FROM ledger_entries WHERE transfer_id = $1 ORDER BY direction`,
            [id],
          );

          return {
            id: transfer.id,
            sourceWalletId: transfer.source_wallet_id,
            destWalletId: transfer.dest_wallet_id,
            amount: transfer.amount,
            reference: transfer.reference,
            createdAt: transfer.created_at.toISOString(),
            entries: entries.rows.map((e) => ({
              walletId: e.wallet_id,
              direction: e.direction,
              amount: e.amount,
            })),
          };
        },
        { readOnly: true },
      );

      res.json(payload);
    }),
  );

  return router;
}
