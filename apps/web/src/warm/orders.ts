import {
  applyReport,
  isTerminalStatus,
  type EnrichedExecutionReport,
  type OrderProgress,
  type OrdStatus,
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

export interface OrderRow {
  clOrdId: string;
  pair: string;
  side: 'buy' | 'sell';
  orderQtyK: number;
  status: OrdStatus;
  cumQty: number;
  leavesQty: number;
  /** Price of the latest fill, pipettes. */
  lastPx: number | null;
  rejectReason: string | null;
  events: number;
  updatedAt: number;
}

export interface OrdersStore {
  subscribe(listener: () => void): () => void;
  version(): number;
  /** Folds one wire report; throws on any grammar violation. */
  ingest(report: EnrichedExecutionReport): void;
  /** Rows, most recently updated first; referentially stable per version. */
  rows(): readonly OrderRow[];
  /** Fired with the flush that contained any TRADE — positions changed server-side (§7.3). */
  onTrade(listener: () => void): () => void;
}

export interface OrdersStoreOptions {
  /** Notification scheduler; requestAnimationFrame in production, injectable for tests. */
  scheduleNotify?: (callback: () => void) => void;
}

export function createOrdersStore(options: OrdersStoreOptions = {}): OrdersStore {
  const scheduleNotify =
    options.scheduleNotify ?? ((callback: () => void) => window.requestAnimationFrame(() => callback()));

  const listeners = new Set<() => void>();
  const tradeListeners = new Set<() => void>();
  const progress = new Map<string, OrderProgress>();
  const rows = new Map<string, OrderRow>();
  let version = 0;
  let notifyPending = false;
  let tradesPending = false;
  let cachedRows: readonly OrderRow[] = [];
  let cachedVersion = -1;

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onTrade(listener) {
      tradeListeners.add(listener);
      return () => tradeListeners.delete(listener);
    },
    version: () => version,

    ingest(report) {
      const next = applyReport(progress.get(report.clOrdId) ?? null, report, report.orderQtyK);
      progress.set(report.clOrdId, next);
      const existing = rows.get(report.clOrdId);
      rows.set(report.clOrdId, {
        clOrdId: report.clOrdId,
        pair: report.pair,
        side: report.side,
        orderQtyK: report.orderQtyK,
        status: next.status,
        cumQty: next.cumQty,
        leavesQty: next.leavesQty,
        lastPx: report.execType === 'TRADE' ? report.lastPx : (existing?.lastPx ?? null),
        rejectReason: report.rejectReason,
        events: (existing?.events ?? 0) + 1,
        updatedAt: report.transactTime,
      });
      version += 1;
      if (report.execType === 'TRADE') tradesPending = true;
      if (notifyPending) return;
      notifyPending = true;
      scheduleNotify(() => {
        notifyPending = false;
        const hadTrades = tradesPending;
        tradesPending = false;
        for (const listener of listeners) listener();
        if (hadTrades) {
          for (const listener of tradeListeners) listener();
        }
      });
    },

    rows() {
      if (cachedVersion !== version) {
        cachedRows = [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.clOrdId.localeCompare(b.clOrdId));
        cachedVersion = version;
      }
      return cachedRows;
    },
  };
}

export function isDone(row: OrderRow): boolean {
  return isTerminalStatus(row.status);
}
