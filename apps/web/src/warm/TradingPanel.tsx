import { gql } from '@apollo/client';
import { useMutation, useQuery, useSubscription } from '@apollo/client/react';
import {
  formatPrice,
  instrumentBySymbol,
  pairIdOf,
  type EnrichedExecutionReport,
  type Instrument,
} from '@fx/domain';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { FeedStore } from '../stream/store';
import { createOrdersStore, type OrdersStore } from './orders';
import { midOf, unrealisedPnl } from './pnl';

// The trading section (T-0.4.5): a ticket that acks instantly, a blotter that
// assembles order state from subscription events, and positions with the
// §7.3 P&L split — realised from the server, unrealised multiplied against
// the hot mid on every render the feed causes.

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

const cell: React.CSSProperties = { padding: '0.1rem 0.75rem 0.1rem 0', textAlign: 'right' };
const cellLeft: React.CSSProperties = { ...cell, textAlign: 'left' };

/** Presentational blotter — a plain table until AG Grid lands in T-0.4.6. */
export function OrdersBlotter({ orders }: { orders: OrdersStore }): React.JSX.Element {
  useSyncExternalStore(orders.subscribe, () => orders.version());
  const rows = orders.rows();
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: '0.9em' }} data-testid="blotter">
      <thead>
        <tr style={{ color: '#586e75' }}>
          <th style={cellLeft}>clOrdId</th>
          <th style={cellLeft}>pair</th>
          <th style={cellLeft}>side</th>
          <th style={cell}>qty</th>
          <th style={cellLeft}>status</th>
          <th style={cell}>cum</th>
          <th style={cell}>leaves</th>
          <th style={cell}>last px</th>
          <th style={cellLeft}>reason</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.clOrdId} data-testid={`order-${row.clOrdId}`}>
            <td style={cellLeft}>{row.clOrdId}</td>
            <td style={cellLeft}>{row.pair}</td>
            <td style={{ ...cellLeft, color: row.side === 'buy' ? '#2aa198' : '#dc322f' }}>{row.side}</td>
            <td style={cell}>{row.orderQtyK}K</td>
            <td style={cellLeft} data-testid={`status-${row.clOrdId}`}>
              {row.status}
            </td>
            <td style={cell}>{row.cumQty}</td>
            <td style={cell}>{row.leavesQty}</td>
            <td style={cell}>
              {row.lastPx === null
                ? '—'
                : formatPrice(row.lastPx, instrumentBySymbol(row.pair)?.precision ?? 5)}
            </td>
            <td style={cellLeft}>{row.rejectReason ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Positions with the split asserted by test: `realisedPnl` re-renders only
 * when the query data changes (trade events → refetch), `unrealised` is
 * computed inline from the hot mid on every feed-driven render.
 */
export function PositionsView({
  feedStore,
  positions,
}: {
  feedStore: FeedStore;
  positions: readonly PositionData[];
}): React.JSX.Element {
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
}

interface OrderInputState {
  pair: string;
  side: 'buy' | 'sell';
  qtyK: number;
  ioc: boolean;
}

export function Ticket({
  instruments,
  onSubmitted,
}: {
  instruments: readonly Instrument[];
  onSubmitted?: (clOrdId: string) => void;
}): React.JSX.Element {
  const [form, setForm] = useState<OrderInputState>({ pair: 'EURUSD', side: 'buy', qtyK: 500, ioc: false });
  const [submit, { loading, error }] = useMutation<{ submitOrder: { clOrdId: string } }>(SUBMIT_ORDER);
  const [lastAck, setLastAck] = useState<string | null>(null);

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
      {lastAck === null ? null : (
        <small data-testid="ticket-ack">
          ack <code>{lastAck}</code>
        </small>
      )}
      {error === undefined ? null : <small style={{ color: '#dc322f' }}>{error.message}</small>}
    </div>
  );
}

/** Bridges the subscription into the orders store and refetches positions on trades. */
export function TradingSection({
  feedStore,
  instruments,
}: {
  feedStore: FeedStore;
  instruments: readonly Instrument[];
}): React.JSX.Element {
  const [orders] = useState(() => createOrdersStore());
  useSubscription<{ executionReports: EnrichedExecutionReport }>(REPORTS_SUBSCRIPTION, {
    onData: ({ data }) => {
      if (data.data) orders.ingest(data.data.executionReports);
    },
  });
  const { data: positionsData, refetch } = useQuery<{ positions: PositionData[] }>(POSITIONS_QUERY, {
    fetchPolicy: 'cache-and-network',
  });
  // Realised P&L changes only on trade events (§7.3): refetch exactly then.
  useEffect(() => orders.onTrade(() => void refetch()), [orders, refetch]);

  return (
    <section style={{ marginTop: '1rem' }}>
      <h2 style={{ fontSize: '1em', marginBottom: '0.5rem' }}>trade</h2>
      <Ticket instruments={instruments} />
      <div style={{ display: 'flex', gap: '3rem', marginTop: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <OrdersBlotter orders={orders} />
        <PositionsView feedStore={feedStore} positions={positionsData?.positions ?? []} />
      </div>
    </section>
  );
}
