import { type Minor, formatMinor } from './money';

/**
 * Pure double-entry arithmetic. No database, no I/O -- this file is what the
 * unit tests pin down, so the rules stay true independently of SQL.
 */

export type Direction = 'debit' | 'credit';

export interface LedgerEntry {
  walletId: string;
  direction: Direction;
  amount: Minor;
}

/** A credit adds to a wallet; a debit subtracts. */
export function signedAmount(entry: Pick<LedgerEntry, 'direction' | 'amount'>): Minor {
  return entry.direction === 'credit' ? entry.amount : -entry.amount;
}

/**
 * Derives a wallet balance by summing entries. This is THE balance definition;
 * the SQL in wallets.service.ts is a translation of exactly this expression, and
 * a test asserts the two agree.
 */
export function deriveBalance(
  entries: readonly LedgerEntry[],
  walletId: string,
): Minor {
  let total = 0n;
  for (const entry of entries) {
    if (entry.walletId === walletId) total += signedAmount(entry);
  }
  return total;
}

/** Sum of every debit across the supplied entries. */
export function totalDebits(entries: readonly LedgerEntry[]): Minor {
  return entries.reduce((acc, e) => (e.direction === 'debit' ? acc + e.amount : acc), 0n);
}

/** Sum of every credit across the supplied entries. */
export function totalCredits(entries: readonly LedgerEntry[]): Minor {
  return entries.reduce((acc, e) => (e.direction === 'credit' ? acc + e.amount : acc), 0n);
}

/** The global invariant: the books balance iff every credit has a matching debit. */
export function isBalanced(entries: readonly LedgerEntry[]): boolean {
  return totalDebits(entries) === totalCredits(entries);
}

/**
 * Builds the matched pair for a transfer. Returning both entries from one
 * function makes it structurally impossible to write a debit and "forget" the
 * credit at the call site -- the caller receives them together or not at all.
 */
export function buildTransferEntries(params: {
  sourceWalletId: string;
  destWalletId: string;
  amount: Minor;
}): [LedgerEntry, LedgerEntry] {
  const { sourceWalletId, destWalletId, amount } = params;

  if (amount <= 0n) {
    throw new Error('transfer amount must be positive');
  }
  if (sourceWalletId === destWalletId) {
    // A self-transfer nets to zero but would still write two rows, making the
    // ledger noisier without moving value. Reject it as a client error.
    throw new Error('source and destination wallets must differ');
  }

  return [
    { walletId: sourceWalletId, direction: 'debit', amount },
    { walletId: destWalletId, direction: 'credit', amount },
  ];
}

/**
 * DETERMINISTIC GLOBAL LOCK ORDER.
 *
 * Returns the wallet ids a transfer must lock, sorted ascending by id. Both
 * legs of an A->B / B->A pair produce the SAME sequence, which is what makes a
 * lock-ordering deadlock impossible. See transfers.service.ts for the full
 * argument; it lives here as a pure function so it can be unit tested without
 * a database.
 *
 * Sorting is byte-wise on the canonical lowercase UUID text, which is a total
 * order -- the property the proof actually needs. It does not need to match
 * Postgres' internal uuid collation, only to be consistent across callers.
 */
export function lockOrder(walletIds: readonly string[]): string[] {
  const unique = Array.from(new Set(walletIds.map((id) => id.toLowerCase())));
  return unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Convenience for API responses. */
export function serializeEntry(entry: LedgerEntry): {
  walletId: string;
  direction: Direction;
  amount: string;
} {
  return {
    walletId: entry.walletId,
    direction: entry.direction,
    amount: formatMinor(entry.amount),
  };
}
