import { Router } from 'express';
import { withTransaction } from '../../db/tx';
import { requireAuth } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/error';
import { idempotencyKeyOf, requireIdempotencyKey } from '../../middleware/idempotency';
import { runIdempotent } from '../idempotency/idempotency';
import { formatMinor } from '../../domain/money';
import {
  CreateWalletSchema,
  LedgerQuerySchema,
  WalletIdParam,
} from './wallets.schemas';
import {
  createWallet,
  deriveBalanceFromDb,
  getOwnedWallet,
  listWalletsForUser,
  serializeWallet,
} from './wallets.service';

export function walletRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  router.post(
    '/',
    requireIdempotencyKey,
    asyncHandler(async (req, res) => {
      const input = CreateWalletSchema.parse(req.body);
      const user = req.user!;

      const outcome = await withTransaction((client) =>
        runIdempotent<Record<string, unknown>>(
          client,
          {
            userId: user.id,
            idempotencyKey: idempotencyKeyOf(req),
            endpoint: 'POST /v1/wallets',
            requestBody: input,
          },
          async () => {
            const wallet = await createWallet(client, {
              userId: user.id,
              label: input.label,
            });
            return { status: 201, body: serializeWallet(wallet, 0n) };
          },
        ),
      );

      res.status(outcome.status).json(outcome.body);
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const wallets = await withTransaction(
        (client) => listWalletsForUser(client, req.user!.id),
        { readOnly: true },
      );
      res.json({
        wallets: wallets.map((w) => serializeWallet(w, w.balance)),
      });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = WalletIdParam.parse(req.params);
      const user = req.user!;

      const payload = await withTransaction(
        async (client) => {
          const wallet = await getOwnedWallet(client, {
            walletId: id,
            userId: user.id,
            role: user.role,
          });
          const balance = await deriveBalanceFromDb(client, wallet.id);
          return serializeWallet(wallet, balance);
        },
        { readOnly: true },
      );

      res.json(payload);
    }),
  );

  /** The balance endpoint. Always computed, never read from a stored column. */
  router.get(
    '/:id/balance',
    asyncHandler(async (req, res) => {
      const { id } = WalletIdParam.parse(req.params);
      const user = req.user!;

      const payload = await withTransaction(
        async (client) => {
          const wallet = await getOwnedWallet(client, {
            walletId: id,
            userId: user.id,
            role: user.role,
          });
          const balance = await deriveBalanceFromDb(client, wallet.id);
          return {
            walletId: wallet.id,
            currency: wallet.currency,
            balance: formatMinor(balance),
            derivedAt: new Date().toISOString(),
          };
        },
        { readOnly: true },
      );

      res.json(payload);
    }),
  );

  router.get(
    '/:id/ledger',
    asyncHandler(async (req, res) => {
      const { id } = WalletIdParam.parse(req.params);
      const { limit, offset } = LedgerQuerySchema.parse(req.query);
      const user = req.user!;

      const payload = await withTransaction(
        async (client) => {
          const wallet = await getOwnedWallet(client, {
            walletId: id,
            userId: user.id,
            role: user.role,
          });

          const { rows } = await client.query<{
            id: string;
            transfer_id: string;
            direction: 'debit' | 'credit';
            amount: string;
            created_at: Date;
          }>(
            `SELECT id::text, transfer_id, direction, amount::text, created_at
               FROM ledger_entries
              WHERE wallet_id = $1
              ORDER BY id DESC
              LIMIT $2 OFFSET $3`,
            [wallet.id, limit, offset],
          );

          return {
            walletId: wallet.id,
            entries: rows.map((r) => ({
              id: r.id,
              transferId: r.transfer_id,
              direction: r.direction,
              amount: r.amount,
              createdAt: r.created_at.toISOString(),
            })),
            limit,
            offset,
          };
        },
        { readOnly: true },
      );

      res.json(payload);
    }),
  );

  return router;
}
