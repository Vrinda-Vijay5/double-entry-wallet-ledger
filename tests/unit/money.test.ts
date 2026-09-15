import { describe, expect, it } from '@jest/globals';
import {
  MAX_TRANSFER_MINOR,
  MoneyError,
  assertPositiveTransferAmount,
  formatMinor,
  parseMinor,
  toMajorString,
} from '../../src/domain/money';

describe('parseMinor', () => {
  it('accepts integers and integer strings', () => {
    expect(parseMinor(100)).toBe(100n);
    expect(parseMinor('100')).toBe(100n);
    expect(parseMinor(' 100 ')).toBe(100n);
    expect(parseMinor(0)).toBe(0n);
    expect(parseMinor(-5)).toBe(-5n);
    expect(parseMinor(42n)).toBe(42n);
  });

  it('preserves values beyond Number.MAX_SAFE_INTEGER when given as a string', () => {
    // 2^53 + 1 -- the canonical value a float64 cannot represent.
    const beyond = '9007199254740993';
    expect(parseMinor(beyond)).toBe(9007199254740993n);
    expect(formatMinor(parseMinor(beyond))).toBe(beyond);
  });

  it('rejects floats rather than guessing the client meant major units', () => {
    expect(() => parseMinor(10.5)).toThrow(MoneyError);
    expect(() => parseMinor('10.50')).toThrow(MoneyError);
    expect(() => parseMinor(0.1)).toThrow(MoneyError);
  });

  it('rejects unsafe integer numbers and directs the caller to strings', () => {
    expect(() => parseMinor(2 ** 53 + 2)).toThrow(/send it as a string/);
  });

  it('rejects non-numeric input', () => {
    expect(() => parseMinor('abc')).toThrow(MoneyError);
    expect(() => parseMinor('')).toThrow(MoneyError);
    expect(() => parseMinor('1e3')).toThrow(MoneyError);
    expect(() => parseMinor(null)).toThrow(MoneyError);
    expect(() => parseMinor(undefined)).toThrow(MoneyError);
    expect(() => parseMinor({})).toThrow(MoneyError);
    expect(() => parseMinor(Number.NaN)).toThrow(MoneyError);
    expect(() => parseMinor(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });
});

describe('assertPositiveTransferAmount', () => {
  it('requires a strictly positive amount', () => {
    expect(() => assertPositiveTransferAmount(0n)).toThrow(/greater than zero/);
    expect(() => assertPositiveTransferAmount(-1n)).toThrow(/greater than zero/);
    expect(() => assertPositiveTransferAmount(1n)).not.toThrow();
  });

  it('enforces the upper bound', () => {
    expect(() => assertPositiveTransferAmount(MAX_TRANSFER_MINOR)).not.toThrow();
    expect(() => assertPositiveTransferAmount(MAX_TRANSFER_MINOR + 1n)).toThrow(/maximum/);
  });
});

describe('toMajorString', () => {
  it('formats minor units without floating point', () => {
    expect(toMajorString(0n)).toBe('0.00');
    expect(toMajorString(5n)).toBe('0.05');
    expect(toMajorString(50n)).toBe('0.50');
    expect(toMajorString(100n)).toBe('1.00');
    expect(toMajorString(123456n)).toBe('1234.56');
    expect(toMajorString(-1n)).toBe('-0.01');
    expect(toMajorString(-123456n)).toBe('-1234.56');
  });

  it('stays exact where a float would not', () => {
    // 0.1 + 0.2 !== 0.3 in float64; in minor units it is just integer addition.
    expect(toMajorString(10n + 20n)).toBe('0.30');
  });
});

describe('formatMinor', () => {
  it('always yields a string so JSON cannot lose precision', () => {
    expect(formatMinor(0n)).toBe('0');
    expect(formatMinor(-1n)).toBe('-1');
    expect(formatMinor(9007199254740993n)).toBe('9007199254740993');
  });
});
