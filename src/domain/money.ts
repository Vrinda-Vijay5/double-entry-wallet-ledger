/**
 * Money is represented as an integer count of MINOR UNITS (cents) in a
 * `bigint`. There is no floating point anywhere in this codebase's money path.
 *
 * Why bigint and not number: JS numbers are exact only to 2^53. That is a large
 * number of cents, but "large enough" is not an argument you get to make in a
 * ledger -- and pg returns int8 as a string anyway, so the parse has to happen
 * regardless. bigint makes the arithmetic exact by construction.
 */

export type Minor = bigint;

/** Largest amount a single transfer may move: 2^63-1 would overflow int8 on sum. */
export const MAX_TRANSFER_MINOR = 1_000_000_000_000n; // 10 billion major units

export class MoneyError extends Error {}

/**
 * Parses an untrusted amount into minor units.
 *
 * Accepts an integer `number` or a decimal-free numeric `string`. Rejects
 * floats outright: a client sending `10.5` is expressing an amount in major
 * units and has misread the API, and guessing which they meant is how ledgers
 * end up off by a factor of 100.
 */
export function parseMinor(input: unknown): Minor {
  let value: bigint;

  if (typeof input === 'bigint') {
    value = input;
  } else if (typeof input === 'number') {
    if (!Number.isInteger(input)) {
      throw new MoneyError('amount must be an integer number of minor units');
    }
    if (!Number.isSafeInteger(input)) {
      throw new MoneyError('amount exceeds safe integer range; send it as a string');
    }
    value = BigInt(input);
  } else if (typeof input === 'string') {
    if (!/^-?\d+$/.test(input.trim())) {
      throw new MoneyError('amount must be an integer string of minor units');
    }
    value = BigInt(input.trim());
  } else {
    throw new MoneyError('amount must be an integer or integer string');
  }

  return value;
}

export function assertPositiveTransferAmount(amount: Minor): void {
  if (amount <= 0n) {
    throw new MoneyError('amount must be greater than zero');
  }
  if (amount > MAX_TRANSFER_MINOR) {
    throw new MoneyError(`amount exceeds maximum of ${MAX_TRANSFER_MINOR} minor units`);
  }
}

/** Serialises for JSON. Always a string -- JSON numbers cannot hold int8 safely. */
export function formatMinor(amount: Minor): string {
  return amount.toString();
}

/** Human-readable major units, for logs and the seed script. Never for arithmetic. */
export function toMajorString(amount: Minor, fractionDigits = 2): string {
  const divisor = 10n ** BigInt(fractionDigits);
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac.toString().padStart(fractionDigits, '0');
  return `${negative ? '-' : ''}${whole}.${fracStr}`;
}
