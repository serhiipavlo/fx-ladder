import {
  applyReport,
  isTerminalStatus,
  MAX_ORDER_QTY_K,
  type ExecutionReport,
  type OrderInput,
  type OrderProgress,
} from '@fx/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createExecutionEngine, type TopOfBook } from './execution';
import { createMarket } from './market';
import { xoshiro128 } from './prng';

const orderArb: fc.Arbitrary<Omit<OrderInput, 'clOrdId'>> = fc.record({
  pairId: fc.integer({ min: 0, max: 11 }),
  side: fc.constantFrom<'buy' | 'sell'>('buy', 'sell'),
  qtyK: fc.integer({ min: 1, max: 8000 }),
  tif: fc.constantFrom<'DAY' | 'IOC'>('DAY', 'IOC'),
});

function makeEngine(seed = 7, overrides = {}) {
  const market = createMarket(seed, 2000);
  market.advance(0);
  const priced: Array<{ pairId: number; top: TopOfBook }> = [];
  const engine = createExecutionEngine(
    xoshiro128(seed),
    (pairId) => {
      const top = market.topOfBook(pairId);
      priced.push({ pairId, top });
      return top;
    },
    overrides,
  );
  return { engine, market, priced };
}

function drain(engine: ReturnType<typeof makeEngine>['engine'], from: number, to: number): ExecutionReport[] {
  const out: ExecutionReport[] = [];
  for (let t = from; t <= to; t += 50) out.push(...engine.advance(t));
  return out;
}

describe('scripted executions (done-when of T-0.3.2)', () => {
  it('every generated order folds cleanly and reaches exactly one terminal state', () => {
    fc.assert(
      fc.property(fc.array(orderArb, { minLength: 1, maxLength: 25 }), fc.integer({ min: 0, max: 1000 }), (orders, seed) => {
        const { engine } = makeEngine(seed);
        const all: ExecutionReport[] = [];
        orders.forEach((order, i) => {
          all.push(...engine.submit({ ...order, clOrdId: `O-${i}` }, i * 10));
        });
        all.push(...drain(engine, 0, orders.length * 10 + 2000));

        const byOrder = new Map<string, ExecutionReport[]>();
        for (const r of all) {
          const list = byOrder.get(r.clOrdId) ?? [];
          list.push(r);
          byOrder.set(r.clOrdId, list);
        }
        expect(byOrder.size).toBe(orders.length);

        byOrder.forEach((reports, clOrdId) => {
          const index = Number(clOrdId.slice(2));
          const orderQty = orders[index]!.qtyK;
          let progress: OrderProgress | null = null;
          let terminals = 0;
          for (const r of reports) {
            progress = applyReport(progress, r, orderQty); // any grammar violation throws
            if (isTerminalStatus(progress.status)) terminals += 1;
          }
          expect(terminals).toBe(1); // exactly one terminal, always the last event
          expect(isTerminalStatus(progress!.status)).toBe(true);

          const tif = orders[index]!.tif;
          if (progress!.status === 'FILLED') expect(progress!.cumQty).toBe(orderQty);
          if (progress!.status === 'CANCELED') {
            expect(tif).toBe('IOC'); // only IOC leftovers cancel
            expect(progress!.cumQty).toBeLessThan(orderQty);
            expect(progress!.cumQty).toBeGreaterThan(0);
          }
        });
      }),
      { numRuns: 40 },
    );
  });

  it('fill prices come from the top of book at emission time, slipped against the taker', () => {
    const { engine, priced } = makeEngine(11, { fillOffsetPipettes: 3, holdMs: 10, eventGapMs: 20 });
    engine.submit({ clOrdId: 'B', pairId: 0, side: 'buy', qtyK: 100, tif: 'DAY' }, 0);
    const buys = drain(engine, 0, 500).filter((r) => r.execType === 'TRADE');
    expect(buys.length).toBeGreaterThan(0);

    // The provider log pairs each call with the top it returned; the first
    // call was submit-time validation, each later one priced one TRADE.
    const tops = priced.filter((c) => c.pairId === 0).slice(1);
    buys.forEach((r, i) => {
      expect(r.lastPx).toBe(tops[i]!.top.ask + 3);
    });

    const { engine: sellEngine, priced: sellLog } = makeEngine(11, { fillOffsetPipettes: 3, holdMs: 10, eventGapMs: 20 });
    sellEngine.submit({ clOrdId: 'S', pairId: 2, side: 'sell', qtyK: 100, tif: 'DAY' }, 0);
    const sells = drain(sellEngine, 0, 500).filter((r) => r.execType === 'TRADE');
    const sellTops = sellLog.filter((c) => c.pairId === 2).slice(1);
    sells.forEach((r, i) => {
      expect(r.lastPx).toBe(sellTops[i]!.top.bid - 3);
    });
  });

  it('same seed and command timeline → bit-identical report streams', () => {
    function run(): ExecutionReport[] {
      const { engine } = makeEngine(99);
      engine.submit({ clOrdId: 'A', pairId: 1, side: 'buy', qtyK: 500, tif: 'IOC' }, 5);
      engine.submit({ clOrdId: 'B', pairId: 3, side: 'sell', qtyK: 900, tif: 'DAY' }, 25);
      return drain(engine, 0, 1500);
    }
    expect(run()).toEqual(run());
  });

  it('invalid quantities reject immediately with INVALID_QTY and no NEW', () => {
    const { engine } = makeEngine();
    for (const qtyK of [0, -5, 2.5, MAX_ORDER_QTY_K + 1]) {
      const reports = engine.submit({ clOrdId: `bad-${qtyK}`, pairId: 0, side: 'buy', qtyK, tif: 'DAY' }, 0);
      expect(reports).toHaveLength(1);
      expect(reports[0]!.execType).toBe('REJECTED');
      expect(reports[0]!.rejectReason).toBe('INVALID_QTY');
    }
    expect(drain(engine, 0, 1000)).toHaveLength(0); // nothing was scheduled
  });

  it('a stale pair rejects at processing time with STALE_PRICE (the §7.3 hook)', () => {
    const { engine } = makeEngine();
    const reports = engine.submit({ clOrdId: 'ST', pairId: 0, side: 'buy', qtyK: 100, tif: 'DAY' }, 0, { stale: true });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.rejectReason).toBe('STALE_PRICE');
  });

  it('duplicate clOrdId and unknown pairId are transport bugs — thrown, not rejected', () => {
    const { engine } = makeEngine();
    engine.submit({ clOrdId: 'D', pairId: 0, side: 'buy', qtyK: 10, tif: 'DAY' }, 0);
    expect(() => engine.submit({ clOrdId: 'D', pairId: 1, side: 'sell', qtyK: 10, tif: 'DAY' }, 1)).toThrow(/duplicate/);
    expect(() => engine.submit({ clOrdId: 'E', pairId: 999, side: 'buy', qtyK: 10, tif: 'DAY' }, 2)).toThrow(/pairId/);
  });

  it('advance demands a monotonic clock and setLastLook validates its inputs', () => {
    const { engine } = makeEngine();
    engine.advance(100);
    expect(() => engine.advance(99)).toThrow(/monotonic/);
    expect(() => engine.setLastLook(-1, 0)).toThrow(/holdMs/);
    expect(() => engine.setLastLook(50, 1.5)).toThrow(/rejectRate/);
  });

  it('stats mirror the mix: fills, partials and rejects all move', () => {
    const { engine } = makeEngine(3, { maxPartials: 3, holdMs: 10, eventGapMs: 10 });
    for (let i = 0; i < 30; i += 1) {
      engine.submit({ clOrdId: `M-${i}`, pairId: i % 12, side: i % 2 ? 'buy' : 'sell', qtyK: 200, tif: 'IOC' }, i);
    }
    drain(engine, 0, 2000);
    const stats = engine.stats();
    expect(stats.submitted).toBe(30);
    expect(stats.trades).toBeGreaterThan(0);
    expect(stats.partials).toBeGreaterThan(0);
    expect(stats.filled + stats.canceled).toBe(30);
  });
});

describe('last look (the T-0.3.3 core)', () => {
  it('rejectRate 1 → every order bounces with LAST_LOOK after at least holdMs', () => {
    const { engine } = makeEngine(5, { holdMs: 80, rejectRate: 1 });
    for (let i = 0; i < 10; i += 1) {
      expect(engine.submit({ clOrdId: `L-${i}`, pairId: 0, side: 'buy', qtyK: 50, tif: 'DAY' }, i * 10)).toHaveLength(0);
    }
    const reports = drain(engine, 0, 2000);
    expect(reports).toHaveLength(10);
    reports.forEach((r, i) => {
      expect(r.execType).toBe('REJECTED');
      expect(r.rejectReason).toBe('LAST_LOOK');
      // The hold is observable in the timestamps (§5.5).
      expect(r.transactTime - i * 10).toBeGreaterThanOrEqual(80);
    });
  });

  it('rejectRate 0 → nobody bounces', () => {
    const { engine } = makeEngine(5, { rejectRate: 0 });
    for (let i = 0; i < 10; i += 1) {
      engine.submit({ clOrdId: `Z-${i}`, pairId: 0, side: 'buy', qtyK: 50, tif: 'DAY' }, i * 10);
    }
    const rejects = drain(engine, 0, 2000).filter((r) => r.execType === 'REJECTED');
    expect(rejects).toHaveLength(0);
  });

  it('setLastLook re-arms the running engine', () => {
    const { engine } = makeEngine(5, { rejectRate: 0, holdMs: 10 });
    engine.setLastLook(30, 1);
    engine.submit({ clOrdId: 'RR', pairId: 0, side: 'sell', qtyK: 10, tif: 'DAY' }, 0);
    const reports = drain(engine, 0, 500);
    expect(reports[0]!.rejectReason).toBe('LAST_LOOK');
    expect(reports[0]!.transactTime).toBeGreaterThanOrEqual(30);
  });
});
