import type { EnrichedExecutionReport } from '@fx/domain';
import { describe, expect, it } from 'vitest';

import { createOrdersStore } from './orders';

function report(partial: Partial<EnrichedExecutionReport>): EnrichedExecutionReport {
  return {
    clOrdId: 'A',
    pair: 'EURUSD',
    side: 'buy',
    orderQtyK: 300,
    execType: 'NEW',
    ordStatus: 'NEW',
    lastPx: null,
    lastQty: null,
    cumQty: 0,
    leavesQty: 300,
    rejectReason: null,
    transactTime: 1,
    ...partial,
  };
}

/** Synchronous scheduler: every ingest flushes immediately, as pre-T-0.4.6. */
const sync = { scheduleNotify: (cb: () => void) => cb() };

describe('orders store', () => {
  it('assembles order state from the event stream, not from any final object', () => {
    const store = createOrdersStore(sync);
    let notified = 0;
    let trades = 0;
    store.subscribe(() => (notified += 1));
    store.onTrade(() => (trades += 1));

    store.ingest(report({}));
    store.ingest(
      report({ execType: 'TRADE', ordStatus: 'PARTIALLY_FILLED', lastPx: 108_500, lastQty: 100, cumQty: 100, leavesQty: 200, transactTime: 2 }),
    );
    store.ingest(
      report({ execType: 'TRADE', ordStatus: 'FILLED', lastPx: 108_510, lastQty: 200, cumQty: 300, leavesQty: 0, transactTime: 3 }),
    );

    const [row] = store.rows();
    expect(row).toMatchObject({
      clOrdId: 'A',
      pair: 'EURUSD',
      status: 'FILLED',
      cumQty: 300,
      leavesQty: 0,
      lastPx: 108_510,
      events: 3,
    });
    expect(notified).toBe(3);
    expect(trades).toBe(2); // positions refetch fires exactly on TRADEs
  });

  it('a lying sequence throws instead of rendering wrong money', () => {
    const store = createOrdersStore(sync);
    store.ingest(report({}));
    expect(() =>
      store.ingest(
        report({ execType: 'TRADE', ordStatus: 'FILLED', lastPx: 1, lastQty: 100, cumQty: 100, leavesQty: 200 }),
      ),
    ).toThrow(/contradicts/);
  });

  it('orders sort by recency and keep independent lifecycles', () => {
    const store = createOrdersStore(sync);
    store.ingest(report({ clOrdId: 'A', transactTime: 1 }));
    store.ingest(report({ clOrdId: 'B', pair: 'GBPUSD', side: 'sell', transactTime: 5 }));
    store.ingest(
      report({ clOrdId: 'A', execType: 'TRADE', ordStatus: 'FILLED', lastPx: 1, lastQty: 300, cumQty: 300, leavesQty: 0, transactTime: 9 }),
    );
    const rows = store.rows();
    expect(rows.map((r) => r.clOrdId)).toEqual(['A', 'B']);
    expect(rows[1]!.status).toBe('NEW');
  });

  it('a burst coalesces into one flush; the fold itself never lags the wire', () => {
    const queue: Array<() => void> = [];
    const store = createOrdersStore({ scheduleNotify: (cb) => queue.push(cb) });
    let notified = 0;
    let trades = 0;
    store.subscribe(() => (notified += 1));
    store.onTrade(() => (trades += 1));

    for (let i = 0; i < 100; i += 1) {
      store.ingest(report({ clOrdId: `B-${i}`, transactTime: i }));
    }
    store.ingest(
      report({ clOrdId: 'B-0', execType: 'TRADE', ordStatus: 'FILLED', lastPx: 1, lastQty: 300, cumQty: 300, leavesQty: 0, transactTime: 200 }),
    );

    // State applied message by message — rows and version never lag…
    expect(store.rows()).toHaveLength(100);
    expect(store.rows()[0]!.status).toBe('FILLED');
    expect(notified).toBe(0); // …but nobody rendered mid-burst
    expect(queue).toHaveLength(1);

    queue.shift()!();
    expect(notified).toBe(1); // one render pass for the whole burst
    expect(trades).toBe(1); // one positions refetch, only because a TRADE was inside
    expect(queue).toHaveLength(0); // quiet after the flush
  });

  it('rows are referentially stable per version — the grid diffs deltas, not rebuilds', () => {
    const store = createOrdersStore(sync);
    store.ingest(report({}));
    const first = store.rows();
    expect(store.rows()).toBe(first);
    store.ingest(report({ clOrdId: 'B', transactTime: 2 }));
    expect(store.rows()).not.toBe(first);
    expect(store.rows()).toBe(store.rows());
  });
});
