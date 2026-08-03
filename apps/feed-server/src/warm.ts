import {
  GRAPHQL_SCHEMA_SDL,
  INSTRUMENTS,
  pairIdOf,
  type EnrichedExecutionReport,
  type ExecutionReport,
  type OrdStatus,
  type OrderSide,
  type RejectReason,
  type SequencedExecutionReport,
  type SimOrderBody,
  type TimeInForce,
} from '@fx/domain';
import type { OrderMeta, PositionRow, TradeRow } from '@fx/sim-core';
import { buildSchema, GraphQLError } from 'graphql';
import { useServer } from 'graphql-ws/use/ws';
import { WebSocketServer } from 'ws';

// The warm plane (architecture §7.3, ADR-05): graphql-ws over its own WSS on
// the same process and port, routed by path. Semantics are the opposite of
// the hot plane's: every execution report reaches every subscriber exactly
// once, in order — merged or dropped events would be lied-about money.

/** The reconnect snapshot's row shape — resolved by the server's own fold. */
export interface OrderStateOut {
  clOrdId: string;
  pair: string;
  side: OrderSide;
  orderQtyK: number;
  tif: TimeInForce;
  ordStatus: OrdStatus;
  cumQty: number;
  leavesQty: number;
  lastPx: number | null;
  rejectReason: RejectReason | null;
  eventSeq: number;
  updatedAt: number;
}

export interface WarmDeps {
  submitOrder(input: SimOrderBody & { pairId: number }): { clOrdId: string; immediate: ExecutionReport[] };
  serverTs(): number;
  trades(pairId: number | null): readonly TradeRow[];
  positions(): readonly PositionRow[];
  orderMeta(clOrdId: string): OrderMeta | undefined;
  orders(): OrderStateOut[];
}

interface OrderInputGql {
  clOrdId?: string | null;
  pair: string;
  side: 'buy' | 'sell';
  qtyK: number;
  tif: 'DAY' | 'IOC';
}

/**
 * Fan-out bus with an unbounded FIFO per subscriber: publish never blocks the
 * tick, subscribers never miss or reorder (§7.3). The queue is the honest
 * price of "exactly once" — the warm plane has no legal thinning.
 */
export class ReportBus {
  private readonly queues = new Set<{
    filter: string | null;
    buffer: SequencedExecutionReport[];
    wake: (() => void) | null;
    done: boolean;
  }>();

  publish(report: SequencedExecutionReport): void {
    for (const queue of this.queues) {
      if (queue.filter !== null && queue.filter !== report.clOrdId) continue;
      queue.buffer.push(report);
      queue.wake?.();
      queue.wake = null;
    }
  }

  subscriberCount(): number {
    return this.queues.size;
  }

  iterate(filter: string | null): AsyncGenerator<{ executionReports: SequencedExecutionReport }> {
    const state = { filter, buffer: [] as SequencedExecutionReport[], wake: null as (() => void) | null, done: false };
    this.queues.add(state);
    const queues = this.queues;

    async function* generate(): AsyncGenerator<{ executionReports: SequencedExecutionReport }> {
      try {
        while (!state.done) {
          if (state.buffer.length === 0) {
            await new Promise<void>((resolve) => {
              state.wake = resolve;
            });
            continue;
          }
          const report = state.buffer.shift()!;
          yield { executionReports: report };
        }
      } finally {
        queues.delete(state);
      }
    }
    return generate();
  }

  close(): void {
    for (const queue of this.queues) {
      queue.done = true;
      queue.wake?.();
      queue.wake = null;
    }
  }
}

export interface WarmPlane {
  wss: WebSocketServer;
  bus: ReportBus;
  close(): Promise<void>;
}

export function createWarmPlane(deps: WarmDeps): WarmPlane {
  const schema = buildSchema(GRAPHQL_SCHEMA_SDL);
  const bus = new ReportBus();

  const roots = {
    query: {
      trades: (args: { pair?: string | null }) => {
        let pairId: number | null = null;
        if (args.pair != null) {
          pairId = pairIdOf(args.pair);
          if (pairId < 0) throw new GraphQLError(`unknown pair: ${args.pair}`);
        }
        return deps.trades(pairId).map((t) => ({
          clOrdId: t.clOrdId,
          pair: INSTRUMENTS[t.pairId]!.symbol,
          side: t.side,
          qtyK: t.qtyK,
          priceP: t.priceP,
          transactTime: t.transactTime,
        }));
      },
      positions: () =>
        deps.positions().map((p) => ({
          pair: INSTRUMENTS[p.pairId]!.symbol,
          netQtyK: p.netQtyK,
          avgPx: p.avgPx,
          realisedPnl: p.realisedPnl,
        })),
      orders: () => deps.orders(),
    },
    mutation: {
      submitOrder: ({ input }: { input: OrderInputGql }) => {
        const pairId = pairIdOf(input.pair);
        if (pairId < 0) throw new GraphQLError(`unknown pair: ${input.pair}`);
        let submitted: { clOrdId: string; immediate: ExecutionReport[] };
        try {
          submitted = deps.submitOrder({
            clOrdId: input.clOrdId ?? undefined,
            pair: input.pair,
            side: input.side,
            qtyK: input.qtyK,
            tif: input.tif,
            pairId,
          });
        } catch (err) {
          throw new GraphQLError(err instanceof Error ? err.message : String(err));
        }
        // The ack answers first: the shared submit path defers even immediate
        // rejections onto the next macrotask, so every outcome — including a
        // freshness reject — arrives as a subscription EVENT (§7.3, T-0.4.2).
        return { clOrdId: submitted.clOrdId, receivedAt: deps.serverTs() };
      },
    },
    subscription: {
      executionReports: (args: { clOrdId?: string | null }) => {
        const source = bus.iterate(args.clOrdId ?? null);
        // Enrich on the way out (§7.3): the report carries only clOrdId, the
        // registration knows the rest — a blotter needs no local registry.
        async function* enrich(): AsyncGenerator<{ executionReports: EnrichedExecutionReport }> {
          for await (const { executionReports: report } of source) {
            const meta = deps.orderMeta(report.clOrdId);
            if (meta === undefined) throw new Error(`report for unregistered order: ${report.clOrdId}`);
            yield {
              executionReports: {
                ...report,
                pair: INSTRUMENTS[meta.pairId]!.symbol,
                side: meta.side,
                orderQtyK: meta.qtyK,
                tif: meta.tif,
              },
            };
          }
        }
        return enrich();
      },
    },
  };

  const wss = new WebSocketServer({ noServer: true });
  useServer({ schema, roots }, wss);

  return {
    wss,
    bus,
    close() {
      bus.close();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
