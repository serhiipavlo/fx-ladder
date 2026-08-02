import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  applyReport,
  isTerminalStatus,
  nextOrdStatus,
  type ExecutionReport,
  type OrderProgress,
} from './orders';

function report(partial: Partial<ExecutionReport> & Pick<ExecutionReport, 'execType' | 'ordStatus'>): ExecutionReport {
  return {
    clOrdId: 'X-1',
    lastPx: null,
    lastQty: null,
    cumQty: 0,
    leavesQty: 0,
    rejectReason: null,
    transactTime: 0,
    ...partial,
  };
}

/** Builds the legal report sequence for a lifecycle: NEW, fills, optional cancel. */
function legalSequence(orderQty: number, fills: number[], cancelLeftover: boolean): ExecutionReport[] {
  const reports: ExecutionReport[] = [report({ execType: 'NEW', ordStatus: 'NEW', leavesQty: orderQty })];
  let cum = 0;
  for (const fill of fills) {
    cum += fill;
    reports.push(
      report({
        execType: 'TRADE',
        ordStatus: cum === orderQty ? 'FILLED' : 'PARTIALLY_FILLED',
        lastPx: 108_500,
        lastQty: fill,
        cumQty: cum,
        leavesQty: orderQty - cum,
      }),
    );
  }
  if (cancelLeftover && cum < orderQty) {
    reports.push(report({ execType: 'CANCELED', ordStatus: 'CANCELED', cumQty: cum, leavesQty: 0 }));
  }
  return reports;
}

/** Random split of qty into 1..5 positive fills covering `fraction` of it. */
const lifecycleArb = fc
  .record({
    orderQty: fc.integer({ min: 1, max: 10_000 }),
    cuts: fc.array(fc.integer({ min: 1, max: 99 }), { minLength: 0, maxLength: 4 }),
    full: fc.boolean(),
  })
  .map(({ orderQty, cuts, full }) => {
    const points = [...new Set(cuts.map((c) => Math.max(1, Math.floor((orderQty * c) / 100))))].sort((a, b) => a - b);
    const targets = full ? [...points.filter((p) => p < orderQty), orderQty] : points.filter((p) => p < orderQty);
    const fills: number[] = [];
    let prev = 0;
    for (const target of targets) {
      if (target > prev) fills.push(target - prev);
      prev = target;
    }
    return { orderQty, fills, full: prev === orderQty };
  });

describe('the §5.6 machine (done-when of T-0.3.1)', () => {
  it('legal lifecycles fold cleanly with the quantity identity at every TRADE, one terminal at most', () => {
    fc.assert(
      fc.property(lifecycleArb, fc.boolean(), ({ orderQty, fills, full }, cancel) => {
        const reports = legalSequence(orderQty, fills, cancel);
        let progress: OrderProgress | null = null;
        let terminals = 0;
        for (const r of reports) {
          progress = applyReport(progress, r, orderQty); // throws on any violation
          if (isTerminalStatus(progress.status)) terminals += 1;
        }
        expect(terminals).toBeLessThanOrEqual(1);
        if (full) expect(progress!.status).toBe('FILLED');
        if (cancel && !full && fills.length >= 0) expect(isTerminalStatus(progress!.status) || progress!.status === 'NEW' || progress!.status === 'PARTIALLY_FILLED').toBe(true);
      }),
    );
  });

  it('an immediate rejection is a complete lifecycle of its own', () => {
    const rejected = applyReport(
      null,
      report({ execType: 'REJECTED', ordStatus: 'REJECTED', rejectReason: 'LAST_LOOK' }),
      1000,
    );
    expect(rejected.status).toBe('REJECTED');
    expect(isTerminalStatus(rejected.status)).toBe(true);
  });

  it('no event escapes a terminal state', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'FILLED' | 'REJECTED' | 'CANCELED' | 'EXPIRED'>('FILLED', 'REJECTED', 'CANCELED', 'EXPIRED'),
        fc.constantFrom<'NEW' | 'TRADE' | 'REJECTED' | 'CANCELED' | 'EXPIRED'>(
          'NEW',
          'TRADE',
          'REJECTED',
          'CANCELED',
          'EXPIRED',
        ),
        (terminal, execType) => {
          expect(() => nextOrdStatus(terminal, execType, 0)).toThrow(/terminal/);
        },
      ),
    );
  });

  it('undeclared transitions throw exactly as the diagram says', () => {
    expect(() => nextOrdStatus('NEW', 'NEW', 0)).toThrow(/first event/);
    expect(() => nextOrdStatus('NEW', 'REJECTED', 0)).toThrow(/instead of acceptance/);
    expect(() => nextOrdStatus(null, 'TRADE', 0)).toThrow(/live order/);
    expect(() => nextOrdStatus(null, 'CANCELED', 0)).toThrow(/live order/);
    expect(nextOrdStatus('NEW', 'TRADE', 5)).toBe('PARTIALLY_FILLED');
    expect(nextOrdStatus('PARTIALLY_FILLED', 'TRADE', 0)).toBe('FILLED');
    expect(nextOrdStatus('PARTIALLY_FILLED', 'CANCELED', 0)).toBe('CANCELED');
    expect(nextOrdStatus('NEW', 'EXPIRED', 0)).toBe('EXPIRED');
  });

  it('quantity violations are loud', () => {
    const start = applyReport(null, report({ execType: 'NEW', ordStatus: 'NEW', leavesQty: 100 }), 100);

    // cum does not add up
    expect(() =>
      applyReport(
        start,
        report({ execType: 'TRADE', ordStatus: 'PARTIALLY_FILLED', lastPx: 1, lastQty: 10, cumQty: 20, leavesQty: 80 }),
        100,
      ),
    ).toThrow(/cumQty/);

    // identity broken
    expect(() =>
      applyReport(
        start,
        report({ execType: 'TRADE', ordStatus: 'PARTIALLY_FILLED', lastPx: 1, lastQty: 10, cumQty: 10, leavesQty: 80 }),
        100,
      ),
    ).toThrow(/OrderQty/);

    // TRADE without fill fields
    expect(() =>
      applyReport(start, report({ execType: 'TRADE', ordStatus: 'PARTIALLY_FILLED', cumQty: 10, leavesQty: 90 }), 100),
    ).toThrow(/lastPx/);

    // ordStatus lying about the machine
    expect(() =>
      applyReport(
        start,
        report({ execType: 'TRADE', ordStatus: 'FILLED', lastPx: 1, lastQty: 10, cumQty: 10, leavesQty: 90 }),
        100,
      ),
    ).toThrow(/contradicts/);

    // cancel must zero leaves and keep cum
    expect(() =>
      applyReport(start, report({ execType: 'CANCELED', ordStatus: 'CANCELED', cumQty: 0, leavesQty: 5 }), 100),
    ).toThrow(/zero leavesQty/);

    // rejection must name a reason
    expect(() => applyReport(null, report({ execType: 'REJECTED', ordStatus: 'REJECTED' }), 100)).toThrow(/reason/);
  });
});
