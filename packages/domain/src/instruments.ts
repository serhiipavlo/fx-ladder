export type Tier = 'major' | 'cross' | 'exotic';

export interface Instrument {
  /** Concatenated pair name, e.g. "EURUSD". */
  symbol: string;
  base: string;
  quote: string;
  /** Decimal places of a quoted price (5 for most pairs, 3 for JPY quotes). */
  precision: number;
  /** 1-based decimal position of one pip (4 for most pairs, 2 for JPY quotes). */
  pipDigit: number;
  /** Standard lot in thousands of base currency. */
  lotSizeK: number;
  /** Minimum order quantity in thousands of base currency. */
  minQtyK: number;
  tier: Tier;
}

/**
 * The instrument catalogue. Order is contractual: `pairId` on the wire is the
 * index into this array (architecture §6.1), and the cold plane serves it
 * verbatim (§7.2). Crosses and exotics arrive with v0.2.0.
 */
export const INSTRUMENTS: readonly Instrument[] = [
  { symbol: 'EURUSD', base: 'EUR', quote: 'USD', precision: 5, pipDigit: 4, lotSizeK: 100, minQtyK: 1, tier: 'major' },
  { symbol: 'GBPUSD', base: 'GBP', quote: 'USD', precision: 5, pipDigit: 4, lotSizeK: 100, minQtyK: 1, tier: 'major' },
  { symbol: 'USDJPY', base: 'USD', quote: 'JPY', precision: 3, pipDigit: 2, lotSizeK: 100, minQtyK: 1, tier: 'major' },
  { symbol: 'USDCHF', base: 'USD', quote: 'CHF', precision: 5, pipDigit: 4, lotSizeK: 100, minQtyK: 1, tier: 'major' },
  { symbol: 'AUDUSD', base: 'AUD', quote: 'USD', precision: 5, pipDigit: 4, lotSizeK: 100, minQtyK: 1, tier: 'major' },
];

const bySymbol: ReadonlyMap<string, Instrument> = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

export function instrumentBySymbol(symbol: string): Instrument | undefined {
  return bySymbol.get(symbol);
}

export function instrumentByPairId(pairId: number): Instrument | undefined {
  return INSTRUMENTS[pairId];
}

export function pairIdOf(symbol: string): number {
  return INSTRUMENTS.findIndex((i) => i.symbol === symbol);
}
