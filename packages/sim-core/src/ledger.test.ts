import type { ExecutionReport } from '@fx/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createLedger } from './ledger';

function trade(clOrdId: string, lastQty: number, lastPx: number, cumQty = lastQty, leavesQty = 0): ExecutionReport {
  return {
    clOrdId,
    execType: 'TRADE',
    ordStatus: leavesQty === 0 ? 'FILLED' : 'PARTIALLY_FILLED',
    lastPx,
    lastQty,
    cumQty,
    leavesQty,
    rejectReason: null,
    transactTime: 0,
  };
}

describe('ledger (done-when of T-0.4.4)', () => {
  it('a buy-then-sell yields the arithmetically expected realised P&L and a flat position', () => {
    const ledger = createLedger();
    ledger.open('B', 0, 'buy', 500);
    ledger.open('S', 0, 'sell', 500);

    ledger.record(trade('B', 500, 108_500));
    let [position] = ledger.positions();
    expect(position).toEqual({ pairId: 0, netQtyK: 500, avgPx: 108_500, realisedPnl: 0 });

    ledger.record(trade('S', 500, 108_600));
    [position] = ledger.positions();
    // 500K closed at +100 pipettes = 50 000 pipette·K, and the book is flat.
    expect(position).toEqual({ pairId: 0, netQtyK: 0, avgPx: 0, realisedPnl: 50_000 });
    expect(ledger.trades()).toHaveLength(2);
  });

  it('extending averages the entry; partial reduction realises only the closed quantity', () => {
    const ledger = createLedger();
    ledger.open('B1', 1, 'buy', 100);
    ledger.open('B2', 1, 'buy', 300);
    ledger.open('S1', 1, 'sell', 200);

    ledger.record(trade('B1', 100, 127_000));
    ledger.record(trade('B2', 300, 127_400));
    let position = ledger.positions()[0]!;
    expect(position.netQtyK).toBe(400);
    expect(position.avgPx).toBe(127_300); // (100·127000 + 300·127400) / 400
    expect(position.realisedPnl).toBe(0); // extending never realises

    ledger.record(trade('S1', 200, 127_500));
    position = ledger.positions()[0]!;
    expect(position.netQtyK).toBe(200);
    expect(position.avgPx).toBe(127_300); // the remainder keeps its average
    expect(position.realisedPnl).toBe(200 * (127_500 - 127_300));
  });

  it('crossing through flat opens the residual at the fill price', () => {
    const ledger = createLedger();
    ledger.open('B', 2, 'buy', 100);
    ledger.open('S', 2, 'sell', 300);

    ledger.record(trade('B', 100, 157_000));
    ledger.record(trade('S', 300, 157_200));
    const position = ledger.positions()[0]!;
    expect(position.realisedPnl).toBe(100 * 200); // only the closed 100K realises
    expect(position.netQtyK).toBe(-200); // now short the residual
    expect(position.avgPx).toBe(157_200); // opened at the crossing fill
  });

  it('short positions realise with the sign flipped', () => {
    const ledger = createLedger();
    ledger.open('S', 3, 'sell', 400);
    ledger.open('B', 3, 'buy', 400);

    ledger.record(trade('S', 400, 90_500));
    ledger.record(trade('B', 400, 90_400)); // covered cheaper: profit
    const [position] = ledger.positions();
    expect(position).toEqual({ pairId: 3, netQtyK: 0, avgPx: 0, realisedPnl: 400 * 100 });
  });

  it('pairs are isolated and non-TRADE events move nothing', () => {
    const ledger = createLedger();
    ledger.open('A', 0, 'buy', 100);
    ledger.open('B', 5, 'sell', 100);
    ledger.record({
      clOrdId: 'A',
      execType: 'NEW',
      ordStatus: 'NEW',
      lastPx: null,
      lastQty: null,
      cumQty: 0,
      leavesQty: 100,
      rejectReason: null,
      transactTime: 0,
    });
    expect(ledger.positions()).toHaveLength(0);

    ledger.record(trade('A', 100, 108_500));
    ledger.record(trade('B', 100, 61_200));
    expect(ledger.positions()).toHaveLength(2);
    expect(ledger.trades(0)).toHaveLength(1);
    expect(ledger.trades(5)).toHaveLength(1);
    expect(ledger.trades()).toHaveLength(2);
  });

  it('guards its inputs loudly', () => {
    const ledger = createLedger();
    ledger.open('A', 0, 'buy', 100);
    expect(() => ledger.open('A', 1, 'sell', 50)).toThrow(/duplicate/);
    expect(() => ledger.open('bad', 0, 'buy', 1.5)).toThrow(/qtyK/);
    expect(() => ledger.open('neg', 0, 'buy', -5)).toThrow(/qtyK/);
    expect(() => ledger.record(trade('ghost', 10, 1))).toThrow(/unregistered/);
    expect(() =>
      ledger.record({ ...trade('A', 10, 1), lastPx: null }),
    ).toThrow(/fill fields/);
  });

  it('property: realised changes only when reducing, and a fully closed book is flat', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            side: fc.constantFrom<'buy' | 'sell'>('buy', 'sell'),
            qtyK: fc.integer({ min: 1, max: 500 }),
            priceP: fc.integer({ min: 100_000, max: 110_000 }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (fills) => {
          const ledger = createLedger();
          let net = 0;
          let lastRealised = 0;
          fills.forEach((fill, i) => {
            ledger.open(`P-${i}`, 0, fill.side, fill.qtyK);
            ledger.record(trade(`P-${i}`, fill.qtyK, fill.priceP));
            const signed = fill.side === 'buy' ? fill.qtyK : -fill.qtyK;
            const [position] = ledger.positions();
            const realised = position!.realisedPnl;
            const wasExtending = net === 0 || Math.sign(net) === Math.sign(signed);
            if (wasExtending) expect(realised).toBe(lastRealised);
            net += signed;
            lastRealised = realised;
            expect(position!.netQtyK).toBe(net);
            if (net === 0) expect(position!.avgPx).toBe(0);
          });
        },
      ),
      { numRuns: 60 },
    );
  });
});
