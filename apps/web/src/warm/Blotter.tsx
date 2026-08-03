import { formatPrice, instrumentBySymbol } from '@fx/domain';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GridApi } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { OrderRow, OrdersStore } from './orders';

// The blotter on AG Grid (T-0.4.6): 5000 live rows are the grid's home turf.
// DOM virtualisation renders only the visible slice; the grid keeps the
// user's sort model and scroll position through the stream (AC-10, AC-11).
//
// Updates ride TRANSACTIONS, not a fresh rowData array (v1.2.1). Handing the
// grid a new 5000-row array each flush made every frame cost the whole book:
// our own sort plus the grid's full diff, sixty times a second, for a burst
// that only touched a few hundred rows. Measured, that was seconds of
// blocked main thread per burst. A transaction costs what moved — and the
// order comes from the grid's own sort model, so the component never sorts
// at all and the user's chosen column keeps winning.

ModuleRegistry.registerModules([AllCommunityModule]);

const blotterTheme = themeQuartz.withParams({
  fontFamily: 'ui-monospace, monospace',
  fontSize: '0.75rem',
  headerTextColor: '#586e75',
  accentColor: '#2aa198',
  spacing: 4,
});

const COLUMNS: ColDef<OrderRow>[] = [
  { field: 'clOrdId', headerName: 'clOrdId', minWidth: 100, flex: 1 },
  { field: 'pair', headerName: 'pair', width: 90 },
  {
    field: 'side',
    headerName: 'side',
    width: 70,
    cellStyle: ({ value }) => ({ color: value === 'buy' ? '#2aa198' : '#dc322f' }),
  },
  { field: 'orderQtyK', headerName: 'qty', width: 80, type: 'rightAligned', valueFormatter: ({ value }) => `${value}K` },
  { field: 'status', headerName: 'status', width: 140 },
  { field: 'cumQty', headerName: 'cum', width: 80, type: 'rightAligned' },
  { field: 'leavesQty', headerName: 'leaves', width: 80, type: 'rightAligned' },
  {
    field: 'lastPx',
    headerName: 'last px',
    width: 100,
    type: 'rightAligned',
    valueFormatter: ({ value, data }) =>
      value == null ? '—' : formatPrice(value, (data === undefined ? undefined : instrumentBySymbol(data.pair))?.precision ?? 5),
  },
  { field: 'rejectReason', headerName: 'reason', width: 110, valueFormatter: ({ value }) => value ?? '' },
  {
    // The blotter's clock — and the default sort, so newest-first is the
    // grid's own ordering rather than a sort we redo on every frame.
    field: 'updatedAt',
    headerName: 'updated',
    width: 90,
    type: 'rightAligned',
    sort: 'desc',
    valueFormatter: ({ value }) => `${(Number(value) / 1000).toFixed(1)}s`,
  },
];

export function OrdersBlotter({ orders }: { orders: OrdersStore }): React.JSX.Element {
  // Only the count re-renders with the store; the rows go to the grid
  // directly, so a flush never re-renders five thousand cells.
  useSyncExternalStore(orders.subscribe, () => orders.version());
  const [api, setApi] = useState<GridApi<OrderRow> | null>(null);
  const seeded = useRef(false);

  useEffect(() => {
    if (api === null) return;
    if (!seeded.current) {
      // A grid mounted mid-stream starts from whatever the book already
      // holds; takeChanged() then carries it forward from there.
      seeded.current = true;
      orders.takeChanged();
      api.applyTransaction({ add: [...orders.rows()] });
    }
    return orders.subscribe(() => {
      const { changed, removed } = orders.takeChanged();
      if (changed.length === 0 && removed.length === 0) return;
      const add: OrderRow[] = [];
      const update: OrderRow[] = [];
      for (const row of changed) {
        (api.getRowNode(row.clOrdId) === undefined ? add : update).push(row);
      }
      api.applyTransactionAsync({
        add,
        update,
        remove: removed.map((clOrdId) => ({ clOrdId }) as OrderRow),
      });
    });
  }, [api, orders]);

  return (
    <div
      data-testid="blotter"
      style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: '1 1 560px', minWidth: 480 }}
    >
      <div style={{ height: 320 }}>
        <AgGridReact<OrderRow>
          theme={blotterTheme}
          columnDefs={COLUMNS}
          getRowId={({ data }) => data.clOrdId}
          onGridReady={({ api: ready }) => setApi(ready)}
          headerHeight={26}
          rowHeight={24}
          suppressScrollOnNewData
          // Transactions are flushed on the grid's own frame budget rather
          // than one repaint per arriving batch.
          asyncTransactionWaitMillis={60}
        />
      </div>
      <small style={{ color: '#586e75' }}>
        <span data-testid="blotter-count">{orders.size()}</span> orders
      </small>
    </div>
  );
}
