export type Tier = 'major' | 'cross' | 'exotic';

/**
 * Freshness window of the instrument catalogue, in seconds. The cold plane's
 * `Cache-Control: max-age` and the client's React Query `staleTime` both read
 * THIS number — the alignment §7.2 demands exists in one copy.
 */
export const INSTRUMENTS_MAX_AGE_S = 3600;

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
 * verbatim (§7.2). Appending is safe; reordering the first five would break
 * the wire ids shipped with v0.1.0. Crosses are simulated independently —
 * triangular coherence is backlog (architecture §5.2).
 */
export const INSTRUMENTS: readonly Instrument[] = [
  { symbol: 'EURUSD', base: 'EUR', quote: 'USD', precision: 5, pipDigit: 4, lotSizeK: 100, minQtyK: 1, tier: 'major' },
  { symbol: 'GBPUSD', base: 'GBP', quote: 'USD', precision: 5, pipDigit: 4, lotSizeK: 100, minQtyK: 1, tier: 'major' },
  { symbol: 'USDJPY', base: 'USD', quote: 'JPY', precision: 3, pipDigit: 2, lotSizeK: 100, minQtyK: 1, tier: 'major' },
  { symbol: 'USDCHF', base: 'USD', quote: 'CHF', precision: 5, pipDigit: 4, lotSizeK: 100, minQtyK: 1, tier: 'major' },
  { symbol: 'AUDUSD', base: 'AUD', quote: 'USD', precision: 5, pipDigit: 4, lotSizeK: 100, minQtyK: 1, tier: 'major' },
  { symbol: 'NZDUSD', base: 'NZD', quote: 'USD', precision: 5, pipDigit: 4, lotSizeK: 100, minQtyK: 1, tier: 'major' },
  { symbol: 'USDCAD', base: 'USD', quote: 'CAD', precision: 5, pipDigit: 4, lotSizeK: 100, minQtyK: 1, tier: 'major' },
  { symbol: 'EURGBP', base: 'EUR', quote: 'GBP', precision: 5, pipDigit: 4, lotSizeK: 100, minQtyK: 1, tier: 'cross' },
  { symbol: 'EURJPY', base: 'EUR', quote: 'JPY', precision: 3, pipDigit: 2, lotSizeK: 100, minQtyK: 1, tier: 'cross' },
  { symbol: 'GBPJPY', base: 'GBP', quote: 'JPY', precision: 3, pipDigit: 2, lotSizeK: 100, minQtyK: 1, tier: 'cross' },
  { symbol: 'USDTRY', base: 'USD', quote: 'TRY', precision: 5, pipDigit: 4, lotSizeK: 100, minQtyK: 1, tier: 'exotic' },
  { symbol: 'USDMXN', base: 'USD', quote: 'MXN', precision: 5, pipDigit: 4, lotSizeK: 100, minQtyK: 1, tier: 'exotic' },
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
