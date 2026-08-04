import { gql } from '@apollo/client';
import { useApolloClient, useMutation, useQuery, useSubscription } from '@apollo/client/react';
import {
  formatPrice,
  instrumentBySymbol,
  MAX_ORDER_QTY_K,
  pairIdOf,
  type EnrichedExecutionReport,
  type Instrument,
} from '@fx/domain';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { Boundary } from '../components/Boundary';
import type { DepthPick } from '../lib/depth';
import type { FeedStore } from '../stream/store';
import { OrdersBlotter } from './Blotter';
import { createOrdersStore, type OrdersStore, type OrderStateData } from './orders';
import { midOf, unrealisedPnl } from './pnl';

// The trading section (T-0.4.5): a ticket that acks instantly, a blotter that
// assembles order state from subscription events, and positions with the
// §7.3 P&L split — realised from the server, unrealised multiplied against
// the hot mid on every render the feed causes. The blotter itself is AG Grid
// since T-0.4.6 — see Blotter.tsx.

export const SUBMIT_ORDER = gql`
  mutation Submit($input: OrderInput!) {
    submitOrder(input: $input) {
      clOrdId
      receivedAt
    }
  }
`;

export const REPORTS_SUBSCRIPTION = gql`
  subscription Reports {
    executionReports {
      clOrdId
      pair
      side
      orderQtyK
      tif
      eventSeq
      execType
      ordStatus
      lastPx
      lastQty
      cumQty
      leavesQty
      rejectReason
      transactTime
    }
  }
`;

export const ORDERS_QUERY = gql`
  query Orders {
    orders {
      clOrdId
      pair
      side
      orderQtyK
      tif
      ordStatus
      cumQty
      leavesQty
      lastPx
      rejectReason
      eventSeq
      updatedAt
    }
  }
`;

export const POSITIONS_QUERY = gql`
  query Positions {
    positions {
      pair
      netQtyK
      avgPx
      realisedPnl
    }
  }
`;

export interface PositionData {
  pair: string;
  netQtyK: number;
  avgPx: number;
  realisedPnl: number;
}

// Shapes the four operations above return, named so the hook call sites read
// as the operation rather than as its payload.

export interface SubmitOrderAck {
  clOrdId: string;
}

export interface SubmitOrderData {
  submitOrder: SubmitOrderAck;
}

export interface ReportsData {
  executionReports: EnrichedExecutionReport;
}

export interface PositionsData {
  positions: PositionData[];
}

export interface OrdersData {
  orders: OrderStateData[];
}

export interface PositionsViewProps {
  feedStore: FeedStore;
  positions: readonly PositionData[];
}

export interface TicketProps {
  instruments: readonly Instrument[];
  /** The depth ladder's last click (FR-07); a fresh object each time. */
  prefill?: DepthPick | null;
  onSubmitted?: (clOrdId: string) => void;
}

export interface NewDayNoteProps {
  orders: OrdersStore;
}

export interface TradingSectionProps {
  feedStore: FeedStore;
  instruments: readonly Instrument[];
  /** The depth ladder's last click, on its way to the ticket (FR-07). */
  prefill?: DepthPick | null;
  /** The warm socket's post-drop hook; resubscription itself is graphql-ws's. */
  onReconnect?: (listener: () => void) => () => void;
}

interface PositionsViewComponent {
  (props: PositionsViewProps): React.JSX.Element;
}

interface TicketComponent {
  (props: TicketProps): React.JSX.Element;
}

interface NewDayNoteComponent {
  (props: NewDayNoteProps): React.JSX.Element | null;
}

interface TradingSectionComponent {
  (props: TradingSectionProps): React.JSX.Element;
}

const cell: React.CSSProperties = { padding: '0.1rem 0.75rem 0.1rem 0', textAlign: 'right' };
const cellLeft: React.CSSProperties = { ...cell, textAlign: 'left' };

/**
 * Positions with the split asserted by test: `realisedPnl` re-renders only
 * when the query data changes (trade events → refetch), `unrealised` is
 * computed inline from the hot mid on every feed-driven render.
 */
export const PositionsView: PositionsViewComponent = ({ feedStore, positions }) => {
  useSyncExternalStore(feedStore.subscribe, () => feedStore.version());
  const books = feedStore.core.books();
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: '0.9em' }} data-testid="positions">
      <thead>
        <tr style={{ color: '#586e75' }}>
          <th style={cellLeft}>pair</th>
          <th style={cell}>net</th>
          <th style={cell}>avg px</th>
          <th style={cell}>realised</th>
          <th style={cell}>unrealised</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((position) => {
          const pairId = pairIdOf(position.pair);
          const mid = pairId < 0 ? null : midOf(books.get(pairId));
          const unrealised = mid === null ? null : unrealisedPnl(position.netQtyK, position.avgPx, mid);
          return (
            <tr key={position.pair} data-testid={`position-${position.pair}`}>
              <td style={cellLeft}>{position.pair}</td>
              <td style={cell}>{position.netQtyK}K</td>
              <td style={cell}>{position.avgPx === 0 ? '—' : position.avgPx.toFixed(1)}</td>
              <td style={cell} data-testid={`realised-${position.pair}`}>
                {position.realisedPnl.toFixed(1)}
              </td>
              <td style={cell} data-testid={`unrealised-${position.pair}`}>
                {unrealised === null ? '—' : unrealised.toFixed(1)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

interface OrderInputState {
  pair: string;
  side: 'buy' | 'sell';
  qtyK: number;
  ioc: boolean;
}

export const Ticket: TicketComponent = ({ instruments, prefill, onSubmitted }) => {
  const [form, setForm] = useState<OrderInputState>({ pair: 'EURUSD', side: 'buy', qtyK: 500, ioc: false });
  const [submit, { loading, error }] = useMutation<SubmitOrderData>(SUBMIT_ORDER);
  const [lastAck, setLastAck] = useState<string | null>(null);

  // FR-07: a click on a depth level fills pair, side and the volume the walk
  // to that level takes. The prices ride along for display only — this ticket
  // sends no limit, because in this model an execution's price comes from the
  // script, not from the depth (§5.5). Every click is a new object, so
  // clicking the same level twice loads it twice; the IOC flag is the user's
  // and survives.
  useEffect(() => {
    if (prefill == null) return;
    setForm((current) => ({ ...current, pair: prefill.pair, side: prefill.side, qtyK: prefill.qtyK }));
  }, [prefill]);

  const send = async (): Promise<void> => {
    const { data } = await submit({
      variables: {
        input: { pair: form.pair, side: form.side, qtyK: form.qtyK, tif: form.ioc ? 'IOC' : 'DAY' },
      },
    });
    if (data) {
      setLastAck(data.submitOrder.clOrdId);
      onSubmitted?.(data.submitOrder.clOrdId);
    }
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' }} data-testid="ticket">
      <select
        value={form.pair}
        onChange={(e) => setForm({ ...form, pair: e.target.value })}
        style={{ font: 'inherit' }}
        data-testid="ticket-pair"
      >
        {instruments.map((i) => (
          <option key={i.symbol}>{i.symbol}</option>
        ))}
      </select>
      <button
        style={{ font: 'inherit', padding: '0.15rem 0.6rem', cursor: 'pointer', color: form.side === 'buy' ? '#2aa198' : '#dc322f' }}
        onClick={() => setForm({ ...form, side: form.side === 'buy' ? 'sell' : 'buy' })}
        data-testid="ticket-side"
      >
        {form.side}
      </button>
      <input
        type="number"
        value={form.qtyK}
        min={1}
        onChange={(e) => setForm({ ...form, qtyK: Number(e.target.value) })}
        style={{ font: 'inherit', width: '6rem' }}
        data-testid="ticket-qty"
      />
      <label>
        <input type="checkbox" checked={form.ioc} onChange={(e) => setForm({ ...form, ioc: e.target.checked })} /> IOC
      </label>
      <button
        style={{ font: 'inherit', padding: '0.15rem 0.9rem', cursor: 'pointer' }}
        disabled={loading}
        onClick={() => void send()}
        data-testid="ticket-submit"
      >
        submit
      </button>
      {prefill != null && (
        <small
          style={{ color: '#586e75' }}
          title="the level you clicked and the average of walking to it — not a limit price"
          data-testid="ticket-from-depth"
        >
          from depth <code>{formatPrice(prefill.priceP, instrumentBySymbol(prefill.pair)?.precision ?? 5)}</code>{' '}
          · avg <code>{formatPrice(prefill.avgPxP, instrumentBySymbol(prefill.pair)?.precision ?? 5)}</code>{' '}
          (indicative)
          {prefill.capped && (
            <span style={{ color: '#b58900' }} data-testid="ticket-capped">
              {' '}
              · capped at {MAX_ORDER_QTY_K}K
            </span>
          )}
        </small>
      )}
      {lastAck !== null && (
        <small data-testid="ticket-ack">
          ack <code>{lastAck}</code>
        </small>
      )}
      {error !== undefined && <small style={{ color: '#dc322f' }}>{error.message}</small>}
    </div>
  );
};

/**
 * The ADR-10 sentence, written where a viewer sees it (T-1.0.1): after a
 * server restart the resync comes back empty-handed — state lives in memory
 * and a restart is a new trading day. Without this line an emptied blotter
 * reads as a bug; with it, as a documented property of the system.
 */
export const NewDayNote: NewDayNoteComponent = ({ orders }) => {
  useSyncExternalStore(orders.subscribe, () => orders.version());
  if (!orders.newDay()) return null;
  return (
    <p style={{ color: '#b58900', margin: '0.25rem 0' }} data-testid="new-day">
      server restarted — a new trading day (ADR-10): state lives in memory, so orders and positions start clean
    </p>
  );
};

/** Bridges the subscription into the orders store and refetches positions on trades. */
export const TradingSection: TradingSectionComponent = ({ feedStore, instruments, prefill, onReconnect }) => {
  const [orders] = useState(() => createOrdersStore());
  useSubscription<ReportsData>(REPORTS_SUBSCRIPTION, {
    onData: ({ data }) => {
      if (data.data) orders.ingest(data.data.executionReports);
    },
    // The §6.4 principle on the warm side: events route past React state into
    // the coalescing store. Without this, every report re-renders the whole
    // section — a /sim/blotter burst caps the client at a few hundred
    // messages a second.
    ignoreResults: true,
  });
  const { data: positionsData, refetch } = useQuery<PositionsData>(POSITIONS_QUERY, {
    fetchPolicy: 'cache-and-network',
  });
  // Realised P&L changes only on trade events (§7.3): refetch exactly then.
  useEffect(() => orders.onTrade(() => void refetch()), [orders, refetch]);

  // Reconciliation (T-0.4.8, ADR-08 retold): on a reconnect — or on a seq
  // hole proving loss — queue incoming events, take the server's order state
  // wholesale, drain the queue through the seq arithmetic, and refetch the
  // positions the outage may have moved. Retries ride the next reconnect or
  // the timer if the snapshot itself failed mid-flap.
  const apollo = useApolloClient();
  const resyncRef = useRef<() => void>(() => undefined);
  resyncRef.current = () => {
    orders.beginResync();
    apollo
      .query<OrdersData>({ query: ORDERS_QUERY, fetchPolicy: 'network-only' })
      .then(({ data }) => {
        if (data === undefined) throw new Error('empty snapshot response');
        orders.reconcile(data.orders);
        void refetch();
      })
      .catch(() => {
        window.setTimeout(() => resyncRef.current(), 1000);
      });
  };
  useEffect(() => onReconnect?.(() => resyncRef.current()), [onReconnect]);
  useEffect(() => orders.onResyncNeeded(() => resyncRef.current()), [orders]);

  return (
    <section style={{ marginTop: '1rem' }}>
      <h2 style={{ fontSize: '1em', marginBottom: '0.5rem' }}>trade</h2>
      <Ticket instruments={instruments} prefill={prefill} />
      <NewDayNote orders={orders} />
      <div style={{ display: 'flex', gap: '3rem', marginTop: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* The money widgets fail alone (AC-12): a broken grid must not take the ticket with it. */}
        <Boundary name="blotter">
          <OrdersBlotter orders={orders} />
        </Boundary>
        <Boundary name="positions">
          <PositionsView feedStore={feedStore} positions={positionsData?.positions ?? []} />
        </Boundary>
      </div>
    </section>
  );
};
