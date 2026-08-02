import { formatPrice, INSTRUMENTS, type Instrument } from '@fx/domain';
import { memo, useSyncExternalStore } from 'react';

import type { FeedStore } from './stream/store';

// Top-of-book ladder. Rendering is driven only by the stream layer's state:
// each row subscribes to its pair's version counter, so one pair's update
// re-renders exactly one row (NFR-03's first checkpoint, asserted by test).

const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '6rem 5rem 7rem 7rem 5rem',
  gap: '0 1rem',
  alignItems: 'baseline',
};

interface RowProps {
  store: FeedStore;
  instrument: Instrument;
  pairId: number;
  live: boolean;
  /** Test hook for the render counter; unused in production. */
  onRender?: (symbol: string) => void;
}

const PairRow = memo(function PairRow({ store, instrument, pairId, live, onRender }: RowProps) {
  useSyncExternalStore(store.subscribe, () => store.pairVersion(pairId));
  onRender?.(instrument.symbol);

  const book = store.core.books().get(pairId);
  const bid = book?.bids[0] ?? null;
  const ask = book?.asks[0] ?? null;
  const price = (level: { price: number } | null): string =>
    level === null ? '—' : formatPrice(level.price, instrument.precision);
  const size = (level: { size: number } | null): string => (level === null ? '' : `${level.size}K`);

  return (
    <div style={{ ...grid, opacity: live ? 1 : 0.4 }} data-testid={`row-${instrument.symbol}`}>
      <strong>{instrument.symbol}</strong>
      <span style={{ textAlign: 'right', color: '#586e75' }}>{size(bid)}</span>
      <span style={{ textAlign: 'right', color: '#2aa198' }}>{price(bid)}</span>
      <span style={{ textAlign: 'right', color: '#dc322f' }}>{price(ask)}</span>
      <span style={{ textAlign: 'right', color: '#586e75' }}>{size(ask)}</span>
    </div>
  );
});

export interface LadderProps {
  store: FeedStore;
  onRowRender?: (symbol: string) => void;
}

export function Ladder({ store, onRowRender }: LadderProps): React.JSX.Element {
  // The header subscribes to the global counter — it may re-render often;
  // the rows below it stay gated by their own per-pair counters.
  useSyncExternalStore(store.subscribe, () => store.version());
  const live = store.core.status() === 'live' && store.socketState() === 'open';

  return (
    <section>
      <div style={{ ...grid, color: '#586e75', fontSize: '0.85em' }}>
        <span>pair</span>
        <span style={{ textAlign: 'right' }}>bid size</span>
        <span style={{ textAlign: 'right' }}>bid</span>
        <span style={{ textAlign: 'right' }}>ask</span>
        <span style={{ textAlign: 'right' }}>ask size</span>
      </div>
      {INSTRUMENTS.map((instrument, pairId) => (
        <PairRow
          key={instrument.symbol}
          store={store}
          instrument={instrument}
          pairId={pairId}
          live={live}
          onRender={onRowRender}
        />
      ))}
    </section>
  );
}
