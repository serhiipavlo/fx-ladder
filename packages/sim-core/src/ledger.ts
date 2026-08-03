import type { ExecutionReport, OrderSide, TimeInForce } from '@fx/domain';

// The warm plane's bookkeeping (architecture §7.3): trades and positions are
// values that change ONLY on trade events — the server owns them; unrealised
// P&L is the client's multiplication against the hot mid and never lives
// here. Average-cost accounting: extending a position averages the entry,
// reducing realises against that average, crossing flips the residual at the
// fill price. P&L is kept in pipette·K units — the sim's honest integers-ish
// arithmetic, converted to anything prettier only at render time.

export interface TradeRow {
  clOrdId: string;
  pairId: number;
  side: OrderSide;
  qtyK: number;
  priceP: number;
  transactTime: number;
}

export interface PositionRow {
  pairId: number;
  /** Signed net quantity in K; positive = long base. */
  netQtyK: number;
  /** Average entry price of the open position, in pipettes; 0 when flat. */
  avgPx: number;
  /** Realised P&L in pipette·K units, accumulated from closed quantity. */
  realisedPnl: number;
}

export interface OrderMeta {
  pairId: number;
  side: OrderSide;
  qtyK: number;
  /**
   * DAY or IOC — the field that explains a CANCELED row. A cancel carries no
   * FIX reject reason (rejections and cancels are different events, §5.6), so
   * without the time in force a blotter shows "CANCELED" and no why.
   */
  tif: TimeInForce;
}

export interface Ledger {
  /**
   * Registers an order's metadata; reports carry only the clOrdId. `tif`
   * defaults to DAY, matching the control-plane schema's own default.
   */
  open(clOrdId: string, pairId: number, side: OrderSide, qtyK: number, tif?: TimeInForce): void;
  /** Folds one execution report; only TRADEs move money. */
  record(report: ExecutionReport): void;
  /** Registration data for wire enrichment (§7.3): pair, side, order size. */
  orderMeta(clOrdId: string): OrderMeta | undefined;
  trades(pairId?: number | null): readonly TradeRow[];
  positions(): readonly PositionRow[];
}

export function createLedger(): Ledger {
  const meta = new Map<string, OrderMeta>();
  const trades: TradeRow[] = [];
  const positions = new Map<number, PositionRow>();

  function positionOf(pairId: number): PositionRow {
    let position = positions.get(pairId);
    if (position === undefined) {
      position = { pairId, netQtyK: 0, avgPx: 0, realisedPnl: 0 };
      positions.set(pairId, position);
    }
    return position;
  }

  function applyFill(pairId: number, side: OrderSide, qtyK: number, priceP: number): void {
    const position = positionOf(pairId);
    const signed = side === 'buy' ? qtyK : -qtyK;

    if (position.netQtyK === 0 || Math.sign(position.netQtyK) === Math.sign(signed)) {
      // Extending (or opening): the entry price averages in.
      const absNet = Math.abs(position.netQtyK);
      position.avgPx = (position.avgPx * absNet + priceP * qtyK) / (absNet + qtyK);
      position.netQtyK += signed;
      return;
    }

    // Reducing or crossing: realise against the average entry.
    const closeQty = Math.min(qtyK, Math.abs(position.netQtyK));
    const direction = Math.sign(position.netQtyK); // +1 long being sold, −1 short being bought back
    position.realisedPnl += closeQty * (priceP - position.avgPx) * direction;
    position.netQtyK += signed;

    if (position.netQtyK === 0) {
      position.avgPx = 0;
    } else if (Math.sign(position.netQtyK) !== direction) {
      // Crossed through flat: the residual opens at the fill price.
      position.avgPx = priceP;
    }
  }

  return {
    open(clOrdId, pairId, side, qtyK, tif = 'DAY'): void {
      if (meta.has(clOrdId)) throw new Error(`duplicate clOrdId in ledger: ${clOrdId}`);
      if (!Number.isInteger(qtyK) || qtyK < 0) throw new Error(`qtyK must be a non-negative integer, got ${qtyK}`);
      meta.set(clOrdId, { pairId, side, qtyK, tif });
    },

    orderMeta(clOrdId): OrderMeta | undefined {
      return meta.get(clOrdId);
    },

    record(report): void {
      if (report.execType !== 'TRADE') return;
      const order = meta.get(report.clOrdId);
      if (order === undefined) throw new Error(`report for unregistered order: ${report.clOrdId}`);
      if (report.lastPx === null || report.lastQty === null) {
        throw new Error('TRADE without fill fields reached the ledger');
      }
      trades.push({
        clOrdId: report.clOrdId,
        pairId: order.pairId,
        side: order.side,
        qtyK: report.lastQty,
        priceP: report.lastPx,
        transactTime: report.transactTime,
      });
      applyFill(order.pairId, order.side, report.lastQty, report.lastPx);
    },

    trades(pairId = null): readonly TradeRow[] {
      if (pairId === null) return trades;
      return trades.filter((t) => t.pairId === pairId);
    },

    positions(): readonly PositionRow[] {
      return [...positions.values()];
    },
  };
}
