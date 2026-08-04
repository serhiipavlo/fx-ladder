import {
  applyReport,
  MAX_ORDER_QTY_K,
  type ExecutionReport,
  type OrderInput,
  type OrderProgress,
  type RejectReason,
} from '@fx/domain';

import type { Prng } from './prng';

// Scripted executions (architecture §5.5, per withdrawn ADR-04): an order does
// not walk the book — it expands into a defined sequence of events. The client
// cannot tell the difference, and everything it needs is the event GRAMMAR,
// which the engine enforces on itself: every emitted report is folded through
// the domain validator, so an inconsistent sequence cannot leave this module.
// What stays real and steerable: how many fills, in what parts, at what pace,
// and how it all ends.

export interface TopOfBook {
  bid: number;
  ask: number;
}

export interface ExecutionConfig {
  /** The last-look window: nothing answers before this passes (§5.5). */
  holdMs: number;
  /** Probability the held order bounces with LAST_LOOK. */
  rejectRate: number;
  /** Fill price offset from the top in pipettes — scripted slippage, named honestly. */
  fillOffsetPipettes: number;
  /** An order fills in at most this many TRADEs. */
  maxPartials: number;
  /** Pause between scripted events of one order. */
  eventGapMs: number;
}

export interface ExecutionStats {
  submitted: number;
  trades: number;
  /** TRADEs that left the order alive (LeavesQty > 0). */
  partials: number;
  filled: number;
  canceled: number;
  rejected: number;
}

export interface SubmitContext {
  /** The server's truth about the pair's freshness at processing time (§7.3). */
  stale: boolean;
}

export interface ExecutionEngine {
  /** Returns any immediately-due reports (validation rejects); the rest ride advance(now). */
  submit(order: OrderInput, now: number, context?: SubmitContext): ExecutionReport[];
  /** Emits every scheduled report that came due by `now`, in order. */
  advance(now: number): ExecutionReport[];
  setLastLook(holdMs: number, rejectRate: number): void;
  stats(): Readonly<ExecutionStats>;
}

const DEFAULT_CONFIG: ExecutionConfig = {
  holdMs: 40,
  rejectRate: 0,
  fillOffsetPipettes: 2,
  maxPartials: 3,
  eventGapMs: 120,
};

interface PendingEvent {
  dueAt: number;
  order: number; // submission index — stable tie-break
  kind: 'NEW' | 'TRADE' | 'CANCELED' | 'REJECTED';
  clOrdId: string;
  pairId: number;
  side: OrderInput['side'];
  orderQty: number;
  lastQty: number | null;
  rejectReason: RejectReason | null;
}

export function createExecutionEngine(
  prng: Prng,
  topOfBook: (pairId: number) => TopOfBook,
  overrides: Partial<ExecutionConfig> = {},
): ExecutionEngine {
  const config: ExecutionConfig = { ...DEFAULT_CONFIG, ...overrides };
  const pending: PendingEvent[] = [];
  const known = new Set<string>();
  const progress = new Map<string, { state: OrderProgress | null; orderQty: number }>();
  const stats: ExecutionStats = { submitted: 0, trades: 0, partials: 0, filled: 0, canceled: 0, rejected: 0 };
  let submissions = 0;
  let lastNow: number | null = null;

  function reject(order: OrderInput, reason: RejectReason, at: number): ExecutionReport {
    return emit({
      dueAt: at,
      order: submissions,
      kind: 'REJECTED',
      clOrdId: order.clOrdId,
      pairId: order.pairId,
      side: order.side,
      orderQty: order.qtyK,
      lastQty: null,
      rejectReason: reason,
    });
  }

  /** Materialises one scheduled event into a validated report. */
  function emit(event: PendingEvent): ExecutionReport {
    const tracked = progress.get(event.clOrdId) ?? { state: null, orderQty: event.orderQty };
    const prevCum = tracked.state?.cumQty ?? 0;
    let report: ExecutionReport;
    switch (event.kind) {
      case 'NEW':
        report = {
          clOrdId: event.clOrdId,
          execType: 'NEW',
          ordStatus: 'NEW',
          lastPx: null,
          lastQty: null,
          cumQty: 0,
          leavesQty: event.orderQty,
          rejectReason: null,
          transactTime: event.dueAt,
        };
        break;
      case 'TRADE': {
        const top = topOfBook(event.pairId);
        // Slippage against the taker, from the CURRENT top (§5.5): the market
        // kept moving between partials, so each fill prices at its own moment.
        const lastPx =
          event.side === 'buy' ? top.ask + config.fillOffsetPipettes : top.bid - config.fillOffsetPipettes;
        const cumQty = prevCum + event.lastQty!;
        report = {
          clOrdId: event.clOrdId,
          execType: 'TRADE',
          ordStatus: cumQty === event.orderQty ? 'FILLED' : 'PARTIALLY_FILLED',
          lastPx,
          lastQty: event.lastQty,
          cumQty,
          leavesQty: event.orderQty - cumQty,
          rejectReason: null,
          transactTime: event.dueAt,
        };
        break;
      }
      case 'CANCELED':
        report = {
          clOrdId: event.clOrdId,
          execType: 'CANCELED',
          ordStatus: 'CANCELED',
          lastPx: null,
          lastQty: null,
          cumQty: prevCum,
          leavesQty: 0,
          rejectReason: null,
          transactTime: event.dueAt,
        };
        break;
      case 'REJECTED':
        report = {
          clOrdId: event.clOrdId,
          execType: 'REJECTED',
          ordStatus: 'REJECTED',
          lastPx: null,
          lastQty: null,
          cumQty: 0,
          leavesQty: 0,
          rejectReason: event.rejectReason,
          transactTime: event.dueAt,
        };
        break;
    }
    // The grammar is enforced at the source: an inconsistent report throws
    // here and never reaches a wire.
    tracked.state = applyReport(tracked.state, report, tracked.orderQty);
    progress.set(event.clOrdId, tracked);

    if (report.execType === 'TRADE') {
      stats.trades += 1;
      if (report.leavesQty > 0) stats.partials += 1;
      else stats.filled += 1;
    }
    if (report.execType === 'CANCELED') stats.canceled += 1;
    if (report.execType === 'REJECTED') stats.rejected += 1;
    return report;
  }

  return {
    submit(order, now, context = { stale: false }): ExecutionReport[] {
      if (known.has(order.clOrdId)) throw new Error(`duplicate clOrdId: ${order.clOrdId}`);
      known.add(order.clOrdId);
      topOfBook(order.pairId); // throws on an unknown pair — a transport bug, not a rejection
      stats.submitted += 1;
      submissions += 1;

      if (!Number.isInteger(order.qtyK) || order.qtyK < 1 || order.qtyK > MAX_ORDER_QTY_K) {
        return [reject(order, 'INVALID_QTY', now)];
      }
      if (context.stale) {
        // The server is the truth: the client may have believed the price
        // fresh, the pair is frozen NOW, at processing time (§7.3).
        return [reject(order, 'STALE_PRICE', now)];
      }
      if (prng.nextFloat() < config.rejectRate) {
        // Held for the last-look window, then bounced (§5.5).
        pending.push({
          dueAt: now + config.holdMs,
          order: submissions,
          kind: 'REJECTED',
          clOrdId: order.clOrdId,
          pairId: order.pairId,
          side: order.side,
          orderQty: order.qtyK,
          lastQty: null,
          rejectReason: 'LAST_LOOK',
        });
        return [];
      }

      // Script the life: NEW after the hold, 1..maxPartials fills, an IOC
      // leftover (if any) closed with CANCELED.
      const fills = 1 + (prng.nextUint32() % config.maxPartials);
      let fillableQty = order.qtyK;
      if (order.tif === 'IOC' && prng.nextFloat() < 0.5) {
        // The market had less than asked: 30–90 % of the order fills.
        fillableQty = Math.max(1, Math.floor(order.qtyK * (0.3 + 0.6 * prng.nextFloat())));
      }
      const splits: number[] = [];
      let remaining = fillableQty;
      for (let i = fills - 1; i >= 1 && remaining > 1; i -= 1) {
        const part = 1 + (prng.nextUint32() % (remaining - 1));
        splits.push(part);
        remaining -= part;
      }
      splits.push(remaining);

      const t0 = now + config.holdMs;
      pending.push({
        dueAt: t0,
        order: submissions,
        kind: 'NEW',
        clOrdId: order.clOrdId,
        pairId: order.pairId,
        side: order.side,
        orderQty: order.qtyK,
        lastQty: null,
        rejectReason: null,
      });
      splits.forEach((lastQty, i) => {
        pending.push({
          dueAt: t0 + (i + 1) * config.eventGapMs,
          order: submissions,
          kind: 'TRADE',
          clOrdId: order.clOrdId,
          pairId: order.pairId,
          side: order.side,
          orderQty: order.qtyK,
          lastQty,
          rejectReason: null,
        });
      });
      if (fillableQty < order.qtyK) {
        pending.push({
          dueAt: t0 + (splits.length + 1) * config.eventGapMs,
          order: submissions,
          kind: 'CANCELED',
          clOrdId: order.clOrdId,
          pairId: order.pairId,
          side: order.side,
          orderQty: order.qtyK,
          lastQty: null,
          rejectReason: null,
        });
      }
      return [];
    },

    advance(now): ExecutionReport[] {
      if (lastNow !== null && now < lastNow) throw new Error(`now must be monotonic: ${now} < ${lastNow}`);
      lastNow = now;
      const due = pending.filter((e) => e.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt || a.order - b.order);
      if (due.length === 0) return [];
      const dueSet = new Set(due);
      let write = 0;
      for (const event of pending) {
        if (!dueSet.has(event)) pending[write++] = event;
      }
      pending.length = write;
      return due.map(emit);
    },

    setLastLook(holdMs, rejectRate): void {
      if (!Number.isInteger(holdMs) || holdMs < 0 || holdMs > 10_000) {
        throw new Error(`holdMs must be an integer in [0, 10000], got ${holdMs}`);
      }
      if (!(rejectRate >= 0 && rejectRate <= 1)) {
        throw new Error(`rejectRate must be in [0, 1], got ${rejectRate}`);
      }
      config.holdMs = holdMs;
      config.rejectRate = rejectRate;
    },

    stats: () => stats,
  };
}
