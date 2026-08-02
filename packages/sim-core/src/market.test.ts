import { INSTRUMENTS, pairIdOf } from '@fx/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BOOK_LEVELS, createMarket, type LevelRecord, type Market } from './market';

const seedArb = fc.integer({ min: 0, max: 0xffff_ffff });

/** Sequences of (dtMs, rate?) steps — the full external input of the model. */
const stepsArb = fc.array(
  fc.record({
    dtMs: fc.integer({ min: 1, max: 200 }),
    rate: fc.option(fc.integer({ min: 1, max: 5000 }), { nil: undefined }),
  }),
  { minLength: 1, maxLength: 30 },
);

type Step = { dtMs: number; rate: number | undefined };

function run(market: Market, steps: readonly Step[]): LevelRecord[][] {
  let now = 0;
  market.advance(now);
  return steps.map((step) => {
    if (step.rate !== undefined) market.setRate(step.rate);
    now += step.dtMs;
    return market.advance(now);
  });
}

function bookFromSnapshot(records: LevelRecord[]): Map<number, { bids: number[]; asks: number[] }> {
  const book = new Map<number, { bids: number[]; asks: number[] }>();
  for (const r of records) {
    let pair = book.get(r.pairId);
    if (pair === undefined) {
      pair = { bids: [], asks: [] };
      book.set(r.pairId, pair);
    }
    (r.side === 'bid' ? pair.bids : pair.asks)[r.level] = r.price;
  }
  return book;
}

describe('invariants (done-when of T-0.1.3)', () => {
  it('best bid < best ask, always, for every pair after any input sequence', () => {
    fc.assert(
      fc.property(seedArb, stepsArb, (seed, steps) => {
        const market = createMarket(seed);
        run(market, steps);
        for (const [, { bids, asks }] of bookFromSnapshot(market.snapshot())) {
          expect(bids[0]!).toBeLessThan(asks[0]!);
        }
      }),
    );
  });

  it('book levels stay strictly ordered away from the top', () => {
    fc.assert(
      fc.property(seedArb, stepsArb, (seed, steps) => {
        const market = createMarket(seed);
        run(market, steps);
        for (const [, { bids, asks }] of bookFromSnapshot(market.snapshot())) {
          for (let i = 1; i < BOOK_LEVELS; i += 1) {
            expect(bids[i]!).toBeLessThan(bids[i - 1]!);
            expect(asks[i]!).toBeGreaterThan(asks[i - 1]!);
          }
        }
      }),
    );
  });

  it('every emitted price sits on the pipette grid and every record is well-formed', () => {
    fc.assert(
      fc.property(seedArb, stepsArb, (seed, steps) => {
        const market = createMarket(seed);
        for (const batch of [...run(market, steps), market.snapshot()]) {
          for (const r of batch) {
            expect(Number.isSafeInteger(r.price) && r.price > 0).toBe(true);
            expect(Number.isSafeInteger(r.size) && r.size > 0).toBe(true);
            expect(INSTRUMENTS[r.pairId]).toBeDefined();
            expect(r.level >= 0 && r.level < BOOK_LEVELS).toBe(true);
            expect(r.side === 'bid' || r.side === 'ask').toBe(true);
          }
        }
      }),
    );
  });

  it('identical (seed, rate commands, now sequence) → bit-identical event streams', () => {
    fc.assert(
      fc.property(seedArb, stepsArb, (seed, steps) => {
        const a = run(createMarket(seed), steps);
        const b = run(createMarket(seed), steps);
        expect(a).toEqual(b);
      }),
    );
  });

  it('distinct seeds produce distinct streams', () => {
    const steps: Step[] = [{ dtMs: 100, rate: undefined }];
    expect(run(createMarket(1), steps)).not.toEqual(run(createMarket(2), steps));
  });
});

describe('rate contract', () => {
  it('emits records at the configured rate within one mid-move of tolerance', () => {
    const market = createMarket(42, 5000);
    market.advance(0);
    const records = market.advance(1000).length;
    // 5000/s over 1 s; granularity is the 2×BOOK_LEVELS cost of one mid move.
    expect(Math.abs(records - 5000)).toBeLessThanOrEqual(2 * BOOK_LEVELS);
  });

  it('carries fractional budget across advances instead of dropping it', () => {
    const market = createMarket(7, 1000);
    market.advance(0);
    // 0.5 records per advance: exactly one record every two advances on average.
    let total = 0;
    for (let now = 1; now <= 2000; now += 1) total += market.advance(now * 0.5).length;
    expect(Math.abs(total - 1000)).toBeLessThanOrEqual(2 * BOOK_LEVELS);
  });

  it('small budgets still make progress without mid-moves overdrawing them', () => {
    const market = createMarket(9, 1000);
    market.advance(0);
    const batch = market.advance(2); // budget of 2 records — below the mid-move cost
    expect(batch.length).toBe(2);
  });
});

describe('clock and input validation', () => {
  it('the first advance only anchors the clock', () => {
    const market = createMarket(1);
    expect(market.advance(12345)).toEqual([]);
  });

  it('rejects a non-monotonic now', () => {
    const market = createMarket(1);
    market.advance(100);
    expect(() => market.advance(99)).toThrow(/monotonic/);
  });

  it('rejects invalid rates at construction and via setRate', () => {
    expect(() => createMarket(1, 0)).toThrow();
    expect(() => createMarket(1, 1.5)).toThrow();
    expect(() => createMarket(1).setRate(-5)).toThrow();
  });
});

describe('model alignment', () => {
  it('simulates exactly the catalogued instruments', () => {
    const snapshotPairs = new Set(createMarket(1).snapshot().map((r) => r.pairId));
    expect([...snapshotPairs].sort((x, y) => x - y)).toEqual(INSTRUMENTS.map((_, i) => i));
    expect(pairIdOf('EURUSD')).toBe(0);
  });

  it('snapshot covers every pair × side × level exactly once', () => {
    const keys = createMarket(1)
      .snapshot()
      .map((r) => `${r.pairId}:${r.side}:${r.level}`);
    expect(new Set(keys).size).toBe(INSTRUMENTS.length * 2 * BOOK_LEVELS);
    expect(keys.length).toBe(INSTRUMENTS.length * 2 * BOOK_LEVELS);
  });
});
