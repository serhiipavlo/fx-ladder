import { describe, expect, it } from 'vitest';

import { INSTRUMENTS, instrumentByPairId, instrumentBySymbol, pairIdOf } from './instruments';

describe('instrument catalogue', () => {
  it('holds the five majors with unique symbols', () => {
    expect(INSTRUMENTS.map((i) => i.symbol)).toEqual(['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD']);
    expect(new Set(INSTRUMENTS.map((i) => i.symbol)).size).toBe(INSTRUMENTS.length);
  });

  it('quotes JPY pairs at precision 3 with the pip on the 2nd digit, others 5/4', () => {
    for (const i of INSTRUMENTS) {
      if (i.quote === 'JPY') {
        expect([i.precision, i.pipDigit]).toEqual([3, 2]);
      } else {
        expect([i.precision, i.pipDigit]).toEqual([5, 4]);
      }
    }
  });

  it('symbol always equals base + quote', () => {
    for (const i of INSTRUMENTS) expect(i.symbol).toBe(`${i.base}${i.quote}`);
  });

  it('pairId is the catalogue index, consistent across lookups', () => {
    INSTRUMENTS.forEach((instrument, pairId) => {
      expect(pairIdOf(instrument.symbol)).toBe(pairId);
      expect(instrumentByPairId(pairId)).toBe(instrument);
      expect(instrumentBySymbol(instrument.symbol)).toBe(instrument);
    });
  });

  it('unknown lookups return undefined / -1, never throw', () => {
    expect(instrumentBySymbol('XXXYYY')).toBeUndefined();
    expect(instrumentByPairId(999)).toBeUndefined();
    expect(pairIdOf('XXXYYY')).toBe(-1);
  });
});
