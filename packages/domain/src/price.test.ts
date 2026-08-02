import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { INSTRUMENTS } from './instruments';
import { formatPrice, pipettesPerPip, toPipettes } from './price';

describe('pipette roundtrip (done-when of T-0.1.1)', () => {
  it('format(toPipettes(x)) === x across generated valid prices for every instrument', () => {
    for (const instrument of INSTRUMENTS) {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 99_999_999 }), (pipettes) => {
          const text = formatPrice(pipettes, instrument.precision);
          expect(toPipettes(text, instrument.precision)).toBe(pipettes);
          expect(formatPrice(toPipettes(text, instrument.precision), instrument.precision)).toBe(text);
        }),
      );
    }
  });

  it('parses spec examples exactly (architecture §5.2)', () => {
    expect(toPipettes('1.08512', 5)).toBe(108512);
    expect(formatPrice(108512, 5)).toBe('1.08512');
    expect(toPipettes('157.123', 3)).toBe(157123);
    expect(formatPrice(157123, 3)).toBe('157.123');
  });

  it('zero-pads short fractions instead of guessing', () => {
    expect(toPipettes('1.08', 5)).toBe(108000);
    expect(toPipettes('157', 3)).toBe(157000);
  });
});

describe('loud rejection of malformed prices', () => {
  it.each(['', 'abc', '-1.2', '1.', '.5', '1,08', '1e5', ' 1.08512', '1.085120000'])(
    'rejects %j at precision 5',
    (bad) => {
      expect(() => toPipettes(bad, 5)).toThrow();
    },
  );

  it('rejects more fraction digits than the instrument precision', () => {
    expect(() => toPipettes('157.1234', 3)).toThrow();
  });

  it('rejects negative and non-integer pipettes when formatting', () => {
    expect(() => formatPrice(-1, 5)).toThrow();
    expect(() => formatPrice(1.5, 5)).toThrow();
  });

  it('rejects unsupported precisions', () => {
    expect(() => toPipettes('1.0', 0)).toThrow();
    expect(() => formatPrice(1, 9)).toThrow();
  });
});

describe('pip geometry', () => {
  it('one pip is ten pipettes for every catalogued instrument', () => {
    for (const instrument of INSTRUMENTS) {
      expect(pipettesPerPip(instrument)).toBe(10);
    }
  });
});
