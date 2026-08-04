import { formatPrice, type Instrument } from '@fx/domain';
import { memo, useSyncExternalStore } from 'react';

import type { Level } from '../stream/core';
import type { FeedStore } from '../stream/store';

// Top-of-book watchlist across every pair. Rendering is driven only by the
// stream layer's state: each row subscribes to its pair's version counter, so
// one pair's update re-renders exactly one row (NFR-03's first checkpoint,
// asserted by test).
//
// A row is also the pair selector for the depth ladder below (T-1.3.1): it is
// a real `<button>`, so choosing what to look at costs no extra widget and
// works from the keyboard by construction (AC-13). Selection changes on a
// click and never on a tick, so it cannot disturb the per-pair isolation the
// row exists to prove.

/**
 * No update for one pair for this long while the channel is alive = the pair
 * is stale, not the connection (AC-06): frozen ≠ disconnected. A display
 * threshold, judged here against `pairUpdatedAt` — the core has no opinion.
 */
export const STALE_AFTER_MS = 2500;

const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '6rem 5rem 7rem 7rem 5rem',
  gap: '0 1rem',
  alignItems: 'baseline',
  // The selected row is marked by colouring a border every row already has,
  // so selection never moves anything on screen.
  borderLeft: '2px solid transparent',
  paddingLeft: '0.4rem',
};

/** A row is a button; none of the browser's button chrome is wanted. */
const rowButton: React.CSSProperties = {
  ...grid,
  width: '100%',
  font: 'inherit',
  color: 'inherit',
  background: 'none',
  border: 'none',
  borderLeft: '2px solid transparent',
  textAlign: 'left',
  cursor: 'pointer',
};

/** Renders one level's price, or the placeholder when the side is empty. */
interface PriceFormatter {
  (level: Level | null, precision: number): string;
}

/** Renders one level's size; an empty side contributes nothing to the row. */
interface SizeFormatter {
  (level: Level | null): string;
}

// Pure formatting, so it lives at module scope: the row exists to keep a tick
// cheap (NFR-03), and rebuilding two closures per row per tick is work it does
// not need to do. Precision is an argument rather than a captured instrument.

const price: PriceFormatter = (level, precision) => {
  if (level === null) return '—';
  return formatPrice(level.price, precision);
};

const size: SizeFormatter = (level) => {
  if (level === null) return '';
  return `${level.size}K`;
};

interface RowProps {
  store: FeedStore;
  instrument: Instrument;
  pairId: number;
  live: boolean;
  /** The pair went quiet while the channel stayed alive (AC-06). */
  stale: boolean;
  /** This row's pair is the one the depth ladder is showing. */
  selected: boolean;
  onSelect?: (pairId: number) => void;
  /** Test hook for the render counter; unused in production. */
  onRender?: (symbol: string) => void;
}

interface PairRowRender {
  (props: RowProps): React.JSX.Element;
}

const renderPairRow: PairRowRender = ({ store, instrument, pairId, live, stale, selected, onSelect, onRender }) => {
  useSyncExternalStore(store.subscribe, () => store.pairVersion(pairId));
  onRender?.(instrument.symbol);

  const book = store.core.books().get(pairId);
  const bid = book?.bids[0] ?? null;
  const ask = book?.asks[0] ?? null;

  // Three states, three strengths: a dead channel dims the row hardest, a
  // pair that went quiet under a live channel dims a little (AC-06), and a
  // ticking pair is full strength.
  let opacity = 1;
  if (!live) {
    opacity = 0.4;
  } else if (stale) {
    opacity = 0.55;
  }

  return (
    <button
      type="button"
      style={{ ...rowButton, opacity, borderLeftColor: selected ? '#2aa198' : 'transparent' }}
      onClick={() => onSelect?.(pairId)}
      aria-pressed={selected}
      title={`show ${instrument.symbol} depth`}
      data-testid={`row-${instrument.symbol}`}
    >
      <strong>
        {instrument.symbol}
        {stale && (
          <small style={{ color: '#b58900' }} data-testid={`stale-${instrument.symbol}`}>
            {' '}
            · stale
          </small>
        )}
      </strong>
      <span style={{ textAlign: 'right', color: '#586e75' }}>{size(bid)}</span>
      <span style={{ textAlign: 'right', color: '#2aa198' }}>{price(bid, instrument.precision)}</span>
      <span style={{ textAlign: 'right', color: '#dc322f' }}>{price(ask, instrument.precision)}</span>
      <span style={{ textAlign: 'right', color: '#586e75' }}>{size(ask)}</span>
    </button>
  );
};

const PairRow = memo(renderPairRow);
// memo() takes the name of what it wraps, and the row is the thing you watch
// re-render — so it says PairRow in DevTools, not renderPairRow.
PairRow.displayName = 'PairRow';

export interface LadderProps {
  store: FeedStore;
  /** The catalogue as served by the cold plane; pairId = index (§6.1). */
  instruments: readonly Instrument[];
  /** The pair the depth ladder is showing; its row is marked. */
  selectedPairId?: number;
  onSelect?: (pairId: number) => void;
  onRowRender?: (symbol: string) => void;
  /** Clock used for staleness; injectable for tests. Same domain as the core's now. */
  nowFn?: () => number;
}

interface LadderComponent {
  (props: LadderProps): React.JSX.Element;
}

export const Ladder: LadderComponent = ({ store, instruments, selectedPairId, onSelect, onRowRender, nowFn }) => {
  // The header subscribes to the global counter — it re-renders with the
  // stream, which is also what keeps the staleness computation fresh; the
  // rows stay gated by their own per-pair counters (plus the stale flag,
  // which flips rarely).
  useSyncExternalStore(store.subscribe, () => store.version());
  const live = store.core.status() === 'live' && store.socketState() === 'open';
  const nowMs = (nowFn ?? (() => performance.now()))();

  return (
    <section>
      <div style={{ ...grid, color: '#586e75', fontSize: '0.85em' }}>
        <span>pair</span>
        <span style={{ textAlign: 'right' }}>bid size</span>
        <span style={{ textAlign: 'right' }}>bid</span>
        <span style={{ textAlign: 'right' }}>ask</span>
        <span style={{ textAlign: 'right' }}>ask size</span>
      </div>
      {instruments.map((instrument, pairId) => {
        const updatedAt = store.core.pairUpdatedAt(pairId);
        const stale = live && updatedAt !== null && nowMs - updatedAt > STALE_AFTER_MS;
        return (
          <PairRow
            key={instrument.symbol}
            store={store}
            instrument={instrument}
            pairId={pairId}
            live={live}
            stale={stale}
            selected={pairId === selectedPairId}
            onSelect={onSelect}
            onRender={onRowRender}
          />
        );
      })}
    </section>
  );
};
