import { z } from 'zod';

export const CreateWalletSchema = z.object({
  label: z.string().min(1).max(100).trim(),
});

export const WalletIdParam = z.object({
  id: z.string().uuid('wallet id must be a UUID'),
});

export const LedgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
