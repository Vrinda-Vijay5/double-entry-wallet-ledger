import { describe, expect, it } from '@jest/globals';
import {
  type LedgerEntry,
  buildTransferEntries,
  deriveBalance,
  isBalanced,
  lockOrder,
  signedAmount,
  totalCredits,
  totalDebits,
} from '../../src/domain/ledger';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

describe('signedAmount', () => {
  it('credits add and debits subtract', () => {
    expect(signedAmount({ direction: 'credit', amount: 100n })).toBe(100n);
    expect(signedAmount({ direction: 'debit', amount: 100n })).toBe(-100n);
  });
});

describe('buildTransferEntries', () => {
  it('always returns a matched debit/credit pair of equal magnitude', () => {
    const [debit, credit] = buildTransferEntries({
      sourceWalletId: A,
      destWalletId: B,
      amount: 250n,
    });

    expect(debit).toEqual({ walletId: A, direction: 'debit', amount: 250n });
    expect(credit).toEqual({ walletId: B, direction: 'credit', amount: 250n });
    expect(signedAmount(debit) + signedAmount(credit)).toBe(0n);
  });

  it('rejects non-positive amounts', () => {
    expect(() =>
      buildTransferEntries({ sourceWalletId: A, destWalletId: B, amount: 0n }),
    ).toThrow(/positive/);
    expect(() =>
      buildTransferEntries({ sourceWalletId: A, destWalletId: B, amount: -1n }),
    ).toThrow(/positive/);
  });

  it('rejects self-transfers', () => {
    expect(() =>
      buildTransferEntries({ sourceWalletId: A, destWalletId: A, amount: 10n }),
    ).toThrow(/must differ/);
  });
});

describe('deriveBalance', () => {
  it('returns zero for a wallet with no entries', () => {
    expect(deriveBalance([], A)).toBe(0n);
  });

  it('sums only the entries belonging to the requested wallet', () => {
    const entries: LedgerEntry[] = [
      { walletId: A, direction: 'credit', amount: 1000n },
      { walletId: B, direction: 'debit', amount: 1000n },
      { walletId: A, direction: 'debit', amount: 250n },
      { walletId: C, direction: 'credit', amount: 999n },
    ];

    expect(deriveBalance(entries, A)).toBe(750n);
    expect(deriveBalance(entries, B)).toBe(-1000n);
    expect(deriveBalance(entries, C)).toBe(999n);
  });

  it('is order independent -- the balance is a pure sum, not a replay', () => {
    const entries: LedgerEntry[] = [
      { walletId: A, direction: 'credit', amount: 500n },
      { walletId: A, direction: 'debit', amount: 200n },
      { walletId: A, direction: 'credit', amount: 75n },
    ];
    const reversed = [...entries].reverse();

    expect(deriveBalance(entries, A)).toBe(375n);
    expect(deriveBalance(reversed, A)).toBe(375n);
  });

  it('stays exact across many entries where float accumulation would drift', () => {
    // 10_000 entries of 1 minor unit each. In float64 cents this is fine, but
    // the same pattern in major-unit floats (0.01) accumulates visible error.
    const entries: LedgerEntry[] = Array.from({ length: 10_000 }, () => ({
      walletId: A,
      direction: 'credit' as const,
      amount: 1n,
    }));

    expect(deriveBalance(entries, A)).toBe(10_000n);

    const floatSum = entries.reduce((acc) => acc + 0.01, 0);
    expect(floatSum).not.toBe(100);
  });

  it('handles values beyond Number.MAX_SAFE_INTEGER', () => {
    const big = 9_007_199_254_740_993n;
    const entries: LedgerEntry[] = [
      { walletId: A, direction: 'credit', amount: big },
      { walletId: A, direction: 'credit', amount: 1n },
    ];
    expect(deriveBalance(entries, A)).toBe(big + 1n);
  });
});

describe('the global double-entry invariant', () => {
  it('holds for any set of transfer pairs', () => {
    const entries = [
      ...buildTransferEntries({ sourceWalletId: A, destWalletId: B, amount: 100n }),
      ...buildTransferEntries({ sourceWalletId: B, destWalletId: C, amount: 40n }),
      ...buildTransferEntries({ sourceWalletId: C, destWalletId: A, amount: 7n }),
    ];

    expect(totalDebits(entries)).toBe(147n);
    expect(totalCredits(entries)).toBe(147n);
    expect(isBalanced(entries)).toBe(true);

    // Every wallet's balance summed together must be zero: value only moves.
    const net =
      deriveBalance(entries, A) + deriveBalance(entries, B) + deriveBalance(entries, C);
    expect(net).toBe(0n);
  });

  it('detects an unmatched entry', () => {
    const entries: LedgerEntry[] = [
      { walletId: A, direction: 'debit', amount: 100n },
      { walletId: B, direction: 'credit', amount: 99n },
    ];
    expect(isBalanced(entries)).toBe(false);
  });
});

describe('lockOrder', () => {
  it('produces the same sequence regardless of transfer direction', () => {
    // This property is the deadlock proof: A->B and B->A lock identically.
    expect(lockOrder([A, B])).toEqual(lockOrder([B, A]));
    expect(lockOrder([A, B])).toEqual([A, B]);
  });

  it('sorts ascending and is total across any input order', () => {
    expect(lockOrder([C, A, B])).toEqual([A, B, C]);
    expect(lockOrder([B, C, A])).toEqual([A, B, C]);
  });

  it('deduplicates so a wallet is never locked twice in one transaction', () => {
    expect(lockOrder([A, A, B])).toEqual([A, B]);
  });

  it('normalises case so mixed-case ids cannot yield two different orders', () => {
    expect(lockOrder([A.toUpperCase(), B])).toEqual([A, B]);
    expect(lockOrder([B, A.toUpperCase()])).toEqual([A, B]);
  });
});
