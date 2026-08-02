import { describe, expect, it } from 'vitest';

import { INSTRUMENTS, instrumentByPairId, instrumentBySymbol, pairIdOf } from './instruments';

describe('instrument catalogue', () => {
  it('keeps the v0.1 wire ids stable and appends the rest with unique symbols', () => {
    // pairId = index is a wire contract (§6.1): the first five may never move.
    expect(INSTRUMENTS.slice(0, 5).map((i) => i.symbol)).toEqual([
      'EURUSD',
      'GBPUSD',
      'USDJPY',
      'USDCHF',
      'AUDUSD',
    ]);
    expect(INSTRUMENTS.length).toBe(12);
    expect(new Set(INSTRUMENTS.map((i) => i.symbol)).size).toBe(INSTRUMENTS.length);
  });

  it('covers all three tiers', () => {
    const tiers = new Set(INSTRUMENTS.map((i) => i.tier));
    expect(tiers).toEqual(new Set(['major', 'cross', 'exotic']));
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
