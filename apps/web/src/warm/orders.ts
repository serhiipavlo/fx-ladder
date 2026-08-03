import {
  applyReport,
  isTerminalStatus,
  type EnrichedExecutionReport,
  type OrderProgress,
  type OrdStatus,
  type TimeInForce,
} from '@fx/domain';

// The client-side order book: subscription events fold into rows through the
// SAME domain validator the server enforces — the blotter's state is
// recovered from events, and a lying sequence throws instead of rendering
// wrong money (§5.6, §7.3).
//
// Notifications are coalesced (the §6.4 lesson, applied to the warm side):
// every report folds synchronously — the state never lags the wire, and a
// grammar violation still throws at the message, not at a frame later — but
// listeners hear ONE flush per animation frame. A /sim/blotter burst is
// thousands of subscription messages in under a second; rendering rides the
// screen's pace regardless.
//
// Reconnects are ADR-08 retold (T-0.4.8): every report carries a dense
// per-order eventSeq, so a repeat is provably a duplicate (dropped) and a
// hole is provably loss — recovered by taking the server's state snapshot
// wholesale and resuming events. While a snapshot is in flight, incoming
// reports queue; the drain dedups them against what the snapshot already
// contains. Loss and duplication are impossible by arithmetic, not by luck.

export interface OrderRow {
  clOrdId: string;
  pair: string;
  side: 'buy' | 'sell';
  orderQtyK: number;
  /** DAY or IOC — the reason a CANCELED row is CANCELED (§5.5). */
  tif: TimeInForce;
  status: OrdStatus;
  cumQty: number;
  leavesQty: number;
  /** Price of the latest fill, pipettes. */
  lastPx: number | null;
  rejectReason: string | null;
  /** Events contained in this row — the server's dense per-order counter. */
  eventSeq: number;
  updatedAt: number;
}

/** One row of the reconnect snapshot, as the orders query returns it. */
export interface OrderStateData {
  clOrdId: string;
  pair: string;
  side: 'buy' | 'sell';
  orderQtyK: number;
  tif: TimeInForce;
  ordStatus: OrdStatus;
  cumQty: number;
  leavesQty: number;
  lastPx: number | null;
  rejectReason: string | null;
  eventSeq: number;
  updatedAt: number;
}

export interface OrdersStore {
  subscribe(listener: () => void): () => void;
  version(): number;
  /** Folds one wire report; throws on any grammar violation. */
  ingest(report: EnrichedExecutionReport): void;
  /** Rows, most recently updated first; referentially stable per version. */
  rows(): readonly OrderRow[];
  /** How many orders the book holds — cheap, no sorting. */
  size(): number;
  /**
   * What changed since the last call, and nothing else. The grid applies
   * these as transactions: a flush then costs what MOVED, not what the book
   * holds — the difference between a burst that streams and one that
   * freezes (measured: a full-book diff per frame blocked the main thread
   * for seconds).
   */
  takeChanged(): { changed: OrderRow[]; removed: string[] };
  /** Fired with the flush that contained any TRADE — positions changed server-side (§7.3). */
  onTrade(listener: () => void): () => void;
  /** Queue incoming reports until reconcile() lands the snapshot. */
  beginResync(): void;
  /** Replaces state wholesale with the snapshot, then drains the queue through dedup. */
  reconcile(snapshot: readonly OrderStateData[]): void;
  /** Fired when a seq hole proves loss and a snapshot is needed. */
  onResyncNeeded(listener: () => void): () => void;
  syncing(): boolean;
  /**
   * True after a resync wiped a non-empty book: the server answered with an
   * empty snapshot, i.e. it restarted — a new trading day (ADR-10). Cleared
   * by the next folded event: the new day has begun being written.
   */
  newDay(): boolean;
}

export interface OrdersStoreOptions {
  /** Notification scheduler; requestAnimationFrame in production, injectable for tests. */
  scheduleNotify?: (callback: () => void) => void;
  /**
   * How many orders the book keeps. A blotter that grows without bound makes
   * every frame cost more than the last: the whole book is re-sorted and
   * re-diffed on each flush, so unbounded history times 60 fps is a freeze
   * waiting for enough bursts (measured: three 5000-order bursts took the
   * main thread from 138 ms blocked to 2016 ms). The default is the AC-11
   * number — the load the grid is required to stay responsive under.
   */
  capacity?: number;
}

export function createOrdersStore(options: OrdersStoreOptions = {}): OrdersStore {
  const scheduleNotify =
    options.scheduleNotify ?? ((callback: () => void) => window.requestAnimationFrame(() => callback()));
  const capacity = options.capacity ?? 5000;

  const listeners = new Set<() => void>();
  const tradeListeners = new Set<() => void>();
  const resyncListeners = new Set<() => void>();
  const progress = new Map<string, OrderProgress>();
  const rows = new Map<string, OrderRow>();
  const pendingReports: EnrichedExecutionReport[] = [];
  /** Ids touched since the last takeChanged(); the grid's delta feed. */
  const dirty = new Set<string>();
  const removed = new Set<string>();
  let syncing = false;
  let newDay = false;
  let version = 0;
  let notifyPending = false;
  let tradesPending = false;
  let cachedRows: readonly OrderRow[] = [];
  let cachedVersion = -1;

  /**
   * Ages the book down to `capacity` — oldest first, and only orders that
   * are already terminal: a live order still owes events, and dropping it
   * would leave the next one with no history to fold onto. Runs at flush
   * time, once per frame, so a burst pays for it once and not per message.
   */
  function prune(): void {
    if (rows.size <= capacity) return;
    const retired = [...rows.values()]
      .filter((row) => isTerminalStatus(row.status))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    let excess = rows.size - capacity;
    for (const row of retired) {
      if (excess === 0) break;
      rows.delete(row.clOrdId);
      progress.delete(row.clOrdId);
      dirty.delete(row.clOrdId);
      removed.add(row.clOrdId);
      excess -= 1;
    }
    version += 1;
  }

  function markDirty(trade: boolean): void {
    version += 1;
    if (trade) tradesPending = true;
    if (notifyPending) return;
    notifyPending = true;
    scheduleNotify(() => {
      notifyPending = false;
      const hadTrades = tradesPending;
      tradesPending = false;
      prune();
      for (const listener of listeners) listener();
      if (hadTrades) {
        for (const listener of tradeListeners) listener();
      }
    });
  }

  function fold(report: EnrichedExecutionReport): void {
    const next = applyReport(progress.get(report.clOrdId) ?? null, report, report.orderQtyK);
    newDay = false; // an event landed: the new day is being written
    progress.set(report.clOrdId, next);
    const existing = rows.get(report.clOrdId);
    rows.set(report.clOrdId, {
      clOrdId: report.clOrdId,
      pair: report.pair,
      side: report.side,
      orderQtyK: report.orderQtyK,
      tif: report.tif,
      status: next.status,
      cumQty: next.cumQty,
      leavesQty: next.leavesQty,
      lastPx: report.execType === 'TRADE' ? report.lastPx : (existing?.lastPx ?? null),
      rejectReason: report.rejectReason,
      eventSeq: report.eventSeq,
      updatedAt: report.transactTime,
    });
    dirty.add(report.clOrdId);
    markDirty(report.execType === 'TRADE');
  }

  function ingestNow(report: EnrichedExecutionReport): void {
    const known = rows.get(report.clOrdId)?.eventSeq ?? 0;
    if (report.eventSeq <= known) return; // provably a duplicate of state we hold
    if (report.eventSeq !== known + 1) {
      // A hole proves loss: queue this report, take state wholesale (ADR-08).
      syncing = true;
      pendingReports.push(report);
      for (const listener of resyncListeners) listener();
      return;
    }
    fold(report);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onTrade(listener) {
      tradeListeners.add(listener);
      return () => tradeListeners.delete(listener);
    },
    onResyncNeeded(listener) {
      resyncListeners.add(listener);
      return () => resyncListeners.delete(listener);
    },
    version: () => version,
    syncing: () => syncing,
    newDay: () => newDay,

    ingest(report) {
      if (syncing) {
        pendingReports.push(report);
        return;
      }
      ingestNow(report);
    },

    beginResync() {
      syncing = true;
    },

    reconcile(snapshot) {
      // A non-empty book answered by an empty snapshot means the server
      // holds no memory of it: a restart — a new trading day (ADR-10).
      newDay = rows.size > 0 && snapshot.length === 0;
      // Wholesale replacement is still a delta to whoever draws it: orders
      // the snapshot does not mention are gone from the screen too.
      const arriving = new Set(snapshot.map((state) => state.clOrdId));
      for (const id of rows.keys()) {
        if (!arriving.has(id)) removed.add(id);
      }
      for (const id of arriving) {
        dirty.add(id);
        removed.delete(id);
      }
      rows.clear();
      progress.clear();
      for (const state of snapshot) {
        progress.set(state.clOrdId, { status: state.ordStatus, cumQty: state.cumQty, leavesQty: state.leavesQty });
        rows.set(state.clOrdId, {
          clOrdId: state.clOrdId,
          pair: state.pair,
          side: state.side,
          orderQtyK: state.orderQtyK,
          tif: state.tif,
          status: state.ordStatus,
          cumQty: state.cumQty,
          leavesQty: state.leavesQty,
          lastPx: state.lastPx,
          rejectReason: state.rejectReason,
          eventSeq: state.eventSeq,
          updatedAt: state.updatedAt,
        });
      }
      syncing = false;
      // Drain whatever arrived while the snapshot was in flight: the seq
      // arithmetic drops what the snapshot already contains and folds the
      // rest. A hole here re-arms the resync — but on a live wire the queue
      // continues exactly where the snapshot ends.
      const queued = pendingReports.splice(0);
      for (const report of queued) {
        if (syncing) {
          pendingReports.push(report);
          continue;
        }
        ingestNow(report);
      }
      // The caller owns the positions refetch during a resync; drained TRADE
      // folds above fired the trade listeners themselves.
      markDirty(false);
    },

    rows() {
      if (cachedVersion !== version) {
        cachedRows = [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.clOrdId.localeCompare(b.clOrdId));
        cachedVersion = version;
      }
      return cachedRows;
    },

    size: () => rows.size,

    takeChanged() {
      const changed: OrderRow[] = [];
      for (const id of dirty) {
        const row = rows.get(id);
        if (row !== undefined) changed.push(row);
      }
      const gone = [...removed];
      dirty.clear();
      removed.clear();
      return { changed, removed: gone };
    },
  };
}

export function isDone(row: OrderRow): boolean {
  return isTerminalStatus(row.status);
}
