import { z } from 'zod';
import { MAX_TRANSFER_MINOR, MoneyError, parseMinor } from '../../domain/money';

/**
 * Amount accepts an integer or an integer string, both in MINOR units, and is
 * normalised to bigint here so no downstream code has to think about the wire
 * representation. Strings are accepted so clients can exceed 2^53 safely.
 */
const amountMinor = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    try {
      return parseMinor(value);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof MoneyError ? err.message : 'invalid amount',
      });
      return z.NEVER;
    }
  })
  .refine((v) => v > 0n, { message: 'amount must be greater than zero' })
  .refine((v) => v <= MAX_TRANSFER_MINOR, {
    message: `amount exceeds maximum of ${MAX_TRANSFER_MINOR} minor units`,
  });

export const CreateTransferSchema = z
  .object({
    sourceWalletId: z.string().uuid(),
    destWalletId: z.string().uuid(),
    amount: amountMinor,
    reference: z.string().max(200).optional(),
  })
  .refine((v) => v.sourceWalletId !== v.destWalletId, {
    message: 'source and destination wallets must differ',
    path: ['destWalletId'],
  });

export const TransferIdParam = z.object({
  id: z.string().uuid(),
});

export type CreateTransferInput = z.infer<typeof CreateTransferSchema>;
