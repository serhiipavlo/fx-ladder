// The FIX vocabulary without the FIX engine (architecture §5.6): the industry
// reads code speaking ClOrdID and LeavesQty as its own. The load-bearing pair
// is event vs state — ExecType says what just HAPPENED, OrdStatus what the
// order IS afterwards; state is recoverable from events, never the reverse.

/** What just happened. */
export type ExecType = 'NEW' | 'TRADE' | 'REJECTED' | 'CANCELED' | 'EXPIRED';

/** What the order is after the event — including the terminal states the §5.6 consistency note demands. */
export type OrdStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'REJECTED' | 'CANCELED' | 'EXPIRED';

export type RejectReason = 'LAST_LOOK' | 'STALE_PRICE' | 'INVALID_QTY' | 'CREDIT';

export type OrderSide = 'buy' | 'sell';

/** IOC closes any unfilled leftover with CANCELED; DAY fills fully in this scripted world. */
export type TimeInForce = 'DAY' | 'IOC';

/**
 * Largest order the engine accepts, thousands of base. Lives here — not in
 * the engine and not in the Zod body — because three places need to agree on
 * it: the control-plane schema that rejects an oversized body, the engine
 * that answers `INVALID_QTY`, and the client, which sizes a depth-walk
 * request against it before asking (FR-07). One number, one copy — the same
 * discipline `INSTRUMENTS_MAX_AGE_S` keeps for the cold plane's freshness.
 */
export const MAX_ORDER_QTY_K = 10_000;

export interface OrderInput {
  clOrdId: string;
  pairId: number;
  side: OrderSide;
  /** Thousands of base currency, like every size on the wire. */
  qtyK: number;
  tif: TimeInForce;
}

/**
 * A report stamped with its dense per-order number at publish time — the
 * §6.2 idea on the warm plane: a hole is provable loss, a repeat a provable
 * duplicate, and reconnect reconciliation becomes arithmetic.
 */
export interface SequencedExecutionReport extends ExecutionReport {
  eventSeq: number;
}

/** The wire shape of a report: enriched with the order's registration data. */
export interface EnrichedExecutionReport extends SequencedExecutionReport {
  pair: string;
  side: OrderSide;
  orderQtyK: number;
  /** DAY or IOC — what makes a CANCELED row explain itself (§5.5). */
  tif: TimeInForce;
}

export interface ExecutionReport {
  clOrdId: string;
  execType: ExecType;
  ordStatus: OrdStatus;
  /** Fill price in pipettes; TRADE only. */
  lastPx: number | null;
  /** Fill size in K; TRADE only. */
  lastQty: number | null;
  cumQty: number;
  leavesQty: number;
  rejectReason: RejectReason | null;
  /** Milliseconds on the simulation clock. */
  transactTime: number;
}

const TERMINAL: ReadonlySet<OrdStatus> = new Set(['FILLED', 'REJECTED', 'CANCELED', 'EXPIRED']);

export function isTerminalStatus(status: OrdStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * The §5.6 state machine as a total function: returns the status after an
 * event or throws on a transition the diagram does not declare. `prev` is
 * null before the first event; REJECTED is only reachable from there — a
 * rejection (last look, stale, validation) happens instead of acceptance,
 * never after it.
 */
export function nextOrdStatus(prev: OrdStatus | null, execType: ExecType, leavesQty: number): OrdStatus {
  if (prev !== null && TERMINAL.has(prev)) {
    throw new Error(`no transitions out of terminal ${prev}`);
  }
  switch (execType) {
    case 'NEW':
      if (prev !== null) throw new Error(`NEW is only the first event, got it after ${prev}`);
      return 'NEW';
    case 'REJECTED':
      if (prev !== null) throw new Error(`REJECTED happens instead of acceptance, not after ${prev}`);
      return 'REJECTED';
    case 'TRADE':
      if (prev !== 'NEW' && prev !== 'PARTIALLY_FILLED') {
        throw new Error(`TRADE requires a live order, got ${prev ?? 'nothing'}`);
      }
      return leavesQty === 0 ? 'FILLED' : 'PARTIALLY_FILLED';
    case 'CANCELED':
    case 'EXPIRED':
      if (prev !== 'NEW' && prev !== 'PARTIALLY_FILLED') {
        throw new Error(`${execType} requires a live order, got ${prev ?? 'nothing'}`);
      }
      return execType === 'CANCELED' ? 'CANCELED' : 'EXPIRED';
  }
}

export interface OrderProgress {
  status: OrdStatus;
  cumQty: number;
  leavesQty: number;
}

/**
 * Folds one report into an order's progress, enforcing the machine AND the
 * quantity algebra: CumQty + LeavesQty = OrderQty at every TRADE of a live
 * order; a terminal CANCELED/EXPIRED zeroes LeavesQty, after which only
 * CumQty ≤ OrderQty holds (§5.6). The client's blotter and the engine's
 * property suite share this single validator.
 */
export function applyReport(prev: OrderProgress | null, report: ExecutionReport, orderQty: number): OrderProgress {
  const status = nextOrdStatus(prev?.status ?? null, report.execType, report.leavesQty);
  if (report.ordStatus !== status) {
    throw new Error(`ordStatus ${report.ordStatus} contradicts the machine (${status})`);
  }
  const prevCum = prev?.cumQty ?? 0;

  switch (report.execType) {
    case 'NEW':
      if (report.cumQty !== 0 || report.leavesQty !== orderQty) {
        throw new Error('NEW must carry cumQty 0 and leavesQty = OrderQty');
      }
      if (report.lastPx !== null || report.lastQty !== null) throw new Error('NEW carries no fill fields');
      break;
    case 'TRADE': {
      if (report.lastQty === null || report.lastPx === null) throw new Error('TRADE must carry lastPx and lastQty');
      if (!Number.isInteger(report.lastQty) || report.lastQty <= 0) {
        throw new Error(`lastQty must be a positive integer, got ${report.lastQty}`);
      }
      if (report.cumQty !== prevCum + report.lastQty) {
        throw new Error(`cumQty ${report.cumQty} ≠ previous ${prevCum} + lastQty ${report.lastQty}`);
      }
      if (report.cumQty + report.leavesQty !== orderQty) {
        throw new Error(`CumQty + LeavesQty = OrderQty violated: ${report.cumQty} + ${report.leavesQty} ≠ ${orderQty}`);
      }
      break;
    }
    case 'REJECTED':
      if (report.cumQty !== 0 || report.leavesQty !== 0) throw new Error('REJECTED carries no quantities');
      if (report.rejectReason === null) throw new Error('REJECTED must name its reason');
      break;
    case 'CANCELED':
    case 'EXPIRED':
      // The unfilled leftover is taken off the market: LeavesQty zeroes and
      // the identity honestly becomes an inequality (§5.6).
      if (report.leavesQty !== 0) throw new Error(`${report.execType} must zero leavesQty`);
      if (report.cumQty !== prevCum) throw new Error(`${report.execType} must not change cumQty`);
      if (report.cumQty > orderQty) throw new Error('cumQty above OrderQty');
      break;
  }

  return { status, cumQty: report.cumQty, leavesQty: report.leavesQty };
}
