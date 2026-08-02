import type { EnrichedExecutionReport } from '@fx/domain';
import { describe, expect, it } from 'vitest';

import { createOrdersStore, type OrderStateData } from './orders';

function report(partial: Partial<EnrichedExecutionReport>): EnrichedExecutionReport {
  return {
    clOrdId: 'A',
    pair: 'EURUSD',
    side: 'buy',
    orderQtyK: 300,
    eventSeq: 1,
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

function state(partial: Partial<OrderStateData>): OrderStateData {
  return {
    clOrdId: 'A',
    pair: 'EURUSD',
    side: 'buy',
    orderQtyK: 300,
    ordStatus: 'FILLED',
    cumQty: 300,
    leavesQty: 0,
    lastPx: 108_510,
    rejectReason: null,
    eventSeq: 3,
    updatedAt: 9,
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
      report({ eventSeq: 2, execType: 'TRADE', ordStatus: 'PARTIALLY_FILLED', lastPx: 108_500, lastQty: 100, cumQty: 100, leavesQty: 200, transactTime: 2 }),
    );
    store.ingest(
      report({ eventSeq: 3, execType: 'TRADE', ordStatus: 'FILLED', lastPx: 108_510, lastQty: 200, cumQty: 300, leavesQty: 0, transactTime: 3 }),
    );

    const [row] = store.rows();
    expect(row).toMatchObject({
      clOrdId: 'A',
      pair: 'EURUSD',
      status: 'FILLED',
      cumQty: 300,
      leavesQty: 0,
      lastPx: 108_510,
      eventSeq: 3,
    });
    expect(notified).toBe(3);
    expect(trades).toBe(2); // positions refetch fires exactly on TRADEs
  });

  it('a lying sequence throws instead of rendering wrong money', () => {
    const store = createOrdersStore(sync);
    store.ingest(report({}));
    expect(() =>
      store.ingest(
        report({ eventSeq: 2, execType: 'TRADE', ordStatus: 'FILLED', lastPx: 1, lastQty: 100, cumQty: 100, leavesQty: 200 }),
      ),
    ).toThrow(/contradicts/);
  });

  it('orders sort by recency and keep independent lifecycles', () => {
    const store = createOrdersStore(sync);
    store.ingest(report({ clOrdId: 'A', transactTime: 1 }));
    store.ingest(report({ clOrdId: 'B', pair: 'GBPUSD', side: 'sell', transactTime: 5 }));
    store.ingest(
      report({ clOrdId: 'A', eventSeq: 2, execType: 'TRADE', ordStatus: 'FILLED', lastPx: 1, lastQty: 300, cumQty: 300, leavesQty: 0, transactTime: 9 }),
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
      report({ clOrdId: 'B-0', eventSeq: 2, execType: 'TRADE', ordStatus: 'FILLED', lastPx: 1, lastQty: 300, cumQty: 300, leavesQty: 0, transactTime: 200 }),
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

describe('reconnect reconciliation (done-when of T-0.4.8, client algebra)', () => {
  it('a repeated eventSeq is provably a duplicate: dropped, folding nothing', () => {
    const store = createOrdersStore(sync);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.ingest(report({}));
    store.ingest(report({})); // the same event again — a re-delivery, not a lie
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0]!.status).toBe('NEW');
    expect(notified).toBe(1);
  });

  it('a seq hole proves loss: events queue, the resync signal fires once', () => {
    const store = createOrdersStore(sync);
    let resyncs = 0;
    store.onResyncNeeded(() => (resyncs += 1));

    store.ingest(report({}));
    // Event 2 died with the socket; event 3 arrives on the fresh one.
    store.ingest(
      report({ eventSeq: 3, execType: 'TRADE', ordStatus: 'FILLED', lastPx: 108_510, lastQty: 200, cumQty: 300, leavesQty: 0, transactTime: 9 }),
    );
    expect(resyncs).toBe(1);
    expect(store.syncing()).toBe(true);
    expect(store.rows()[0]!.status).toBe('NEW'); // nothing folded on a hole

    // The snapshot arrives already containing events 1..3; the queued event 3
    // is inside it — the drain drops it by arithmetic, not by guesswork.
    store.reconcile([state({})]);
    expect(store.syncing()).toBe(false);
    const [row] = store.rows();
    expect(row).toMatchObject({ clOrdId: 'A', status: 'FILLED', cumQty: 300, leavesQty: 0, eventSeq: 3 });
    expect(resyncs).toBe(1); // and no second alarm
  });

  it('reconcile replaces state wholesale and live events continue where the snapshot ends', () => {
    const store = createOrdersStore(sync);
    let trades = 0;
    store.onTrade(() => (trades += 1));

    store.beginResync();
    // While the snapshot is in flight, the resumed stream already delivers.
    store.ingest(
      report({ eventSeq: 2, execType: 'TRADE', ordStatus: 'PARTIALLY_FILLED', lastPx: 108_500, lastQty: 100, cumQty: 100, leavesQty: 200, transactTime: 5 }),
    );
    store.ingest(
      report({ eventSeq: 3, execType: 'TRADE', ordStatus: 'FILLED', lastPx: 108_510, lastQty: 200, cumQty: 300, leavesQty: 0, transactTime: 6 }),
    );

    // The snapshot caught the order mid-life at event 2: the queued event 2
    // is a duplicate, the queued event 3 folds on top.
    store.reconcile([
      state({ ordStatus: 'PARTIALLY_FILLED', cumQty: 100, leavesQty: 200, lastPx: 108_500, eventSeq: 2, updatedAt: 5 }),
    ]);
    const [row] = store.rows();
    expect(row).toMatchObject({ status: 'FILLED', cumQty: 300, leavesQty: 0, eventSeq: 3, lastPx: 108_510 });
    expect(trades).toBe(1); // the drained fold announced its TRADE exactly once

    // Late re-deliveries of pre-snapshot events change nothing.
    store.ingest(
      report({ eventSeq: 2, execType: 'TRADE', ordStatus: 'PARTIALLY_FILLED', lastPx: 108_500, lastQty: 100, cumQty: 100, leavesQty: 200, transactTime: 5 }),
    );
    expect(store.rows()[0]!.status).toBe('FILLED');
    expect(trades).toBe(1);
  });

  it('orders unknown to the snapshot assemble fresh from their queued events', () => {
    const store = createOrdersStore(sync);
    store.beginResync();
    store.ingest(report({ clOrdId: 'FRESH', transactTime: 20 }));
    store.reconcile([state({})]); // the snapshot predates FRESH
    expect(store.rows().map((r) => r.clOrdId)).toEqual(['FRESH', 'A']);
    expect(store.rows()[0]!.status).toBe('NEW');
  });
});
