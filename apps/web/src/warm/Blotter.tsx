import { formatPrice, instrumentBySymbol } from '@fx/domain';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useSyncExternalStore } from 'react';

import type { OrderRow, OrdersStore } from './orders';

// The blotter on AG Grid (T-0.4.6): 5000 live rows are the grid's home turf.
// DOM virtualisation renders only the visible slice; row updates are deltas
// keyed by clOrdId, which leaves the user's sort model and scroll position
// alone while a burst streams in (AC-10, AC-11). The store hands the grid a
// new rows array at most once per frame — and the SAME array while nothing
// changed, so React passes and grid diffs stay cheap between events.

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
];

export function OrdersBlotter({ orders }: { orders: OrdersStore }): React.JSX.Element {
  useSyncExternalStore(orders.subscribe, () => orders.version());
  const rows = orders.rows();
  return (
    <div
      data-testid="blotter"
      style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: '1 1 560px', minWidth: 480 }}
    >
      <div style={{ height: 320 }}>
        <AgGridReact<OrderRow>
          theme={blotterTheme}
          rowData={rows as OrderRow[]}
          columnDefs={COLUMNS}
          getRowId={({ data }) => data.clOrdId}
          headerHeight={26}
          rowHeight={24}
          suppressScrollOnNewData
        />
      </div>
      <small style={{ color: '#586e75' }}>
        <span data-testid="blotter-count">{rows.length}</span> orders
      </small>
    </div>
  );
}
