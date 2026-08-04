import { formatPrice, type Instrument } from '@fx/domain';
import { useSyncExternalStore } from 'react';

import { depthRows, pickOf, type BookSide, type DepthPick, type DepthRow } from '../lib/depth';
import type { FeedStore } from '../stream/store';

// The depth ladder for one pair (FR-05/06/07) — the half of §5.4 that had
// been streaming since v0.1 and never reached a screen. The wire carries four
// levels a side and the core has always stored every one of them; until this
// component existed the render read index 0 and dropped the rest, so roughly
// two thirds of the feed described prices nobody drew.
//
// It subscribes to ONE pair's version counter, exactly like a ladder row: the
// panel re-renders when its own pair moves and stays still for the other
// eleven (NFR-03, asserted by test).
//
// Clicking a level is FR-07: the ticket takes the side, the pair and the
// volume the walk to that level would need. The price rides along as a
// reference and is deliberately NOT sent as a limit — orders here are market
// orders against scripted fills (§5.5, withdrawn ADR-04), so promising the
// clicked price would be the one lie this panel could tell.

const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '7rem 5rem 5rem 7rem',
  gap: '0 1rem',
  alignItems: 'baseline',
  width: '100%',
  font: 'inherit',
  background: 'none',
  border: 'none',
  padding: '0 0.25rem',
  textAlign: 'right',
};

const rowButton: React.CSSProperties = { ...grid, cursor: 'pointer', borderRadius: 2 };

export interface DepthProps {
  store: FeedStore;
  /** The pair being shown; `undefined` while the catalogue is still arriving. */
  instrument: Instrument | undefined;
  pairId: number;
  /** FR-07: a clicked level becomes a ticket request. */
  onPick?: (pick: DepthPick) => void;
  /** Test hook for the render counter; unused in production. */
  onRender?: () => void;
}

interface DepthComponent {
  (props: DepthProps): React.JSX.Element;
}

interface LevelRowProps {
  row: DepthRow;
  side: BookSide;
  precision: number;
  symbol: string;
  onPick?: (pick: DepthPick) => void;
}

interface LevelRowComponent {
  (props: LevelRowProps): React.JSX.Element;
}

const colourOf = (side: BookSide): string => (side === 'bid' ? '#2aa198' : '#dc322f');

/**
 * One clickable level. A real `<button>` rather than a div with a handler:
 * the whole panel is then reachable and actionable from the keyboard for
 * free, which is AC-13's requirement and not a nicety.
 */
const LevelRow: LevelRowComponent = ({ row, side, precision, symbol, onPick }) => (
  <button
    type="button"
    style={{ ...rowButton, color: colourOf(side) }}
    onClick={() => onPick?.(pickOf(symbol, side, row))}
    title={`${side === 'ask' ? 'buy' : 'sell'} ${row.cumSize}K — walk to level ${row.level}`}
    data-testid={`depth-${side}-${row.level}`}
  >
    <span data-testid={`depth-${side}-${row.level}-price`}>{formatPrice(row.price, precision)}</span>
    <span style={{ color: '#586e75' }}>{row.size}K</span>
    <span style={{ color: '#93a1a1' }} data-testid={`depth-${side}-${row.level}-cum`}>
      {row.cumSize}K
    </span>
    <span style={{ color: '#586e75' }} data-testid={`depth-${side}-${row.level}-avg`}>
      {formatPrice(row.avgPx, precision)}
    </span>
  </button>
);

export const Depth: DepthComponent = ({ store, instrument, pairId, onPick, onRender }) => {
  useSyncExternalStore(store.subscribe, () => store.pairVersion(pairId));
  onRender?.();

  const book = store.core.books().get(pairId);
  const bids = depthRows(book, 'bid');
  const asks = depthRows(book, 'ask');
  const precision = instrument?.precision ?? 5;
  const symbol = instrument?.symbol ?? '';

  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const spread = bestBid === null || bestAsk === null ? null : bestAsk - bestBid;

  return (
    <section data-testid="depth" style={{ marginTop: '1rem', maxWidth: '26rem' }}>
      <h2 style={{ fontSize: '1em', marginBottom: '0.25rem' }}>
        depth — <span data-testid="depth-pair">{symbol || '—'}</span>
      </h2>
      <div style={{ ...grid, color: '#586e75', fontSize: '0.85em' }}>
        <span>price</span>
        <span>size</span>
        <span>cum</span>
        <span>avg</span>
      </div>

      {/* Offers descend to the best one, so the spread sits in the middle of
          the panel where a trader expects to read it. */}
      {[...asks].reverse().map((row) => (
        <LevelRow
          key={`ask-${row.level}`}
          row={row}
          side="ask"
          precision={precision}
          symbol={symbol}
          onPick={onPick}
        />
      ))}

      <div
        style={{ ...grid, color: '#b58900', fontSize: '0.85em', padding: '0.15rem 0.25rem' }}
        data-testid="depth-spread"
      >
        <span>{spread === null ? '—' : `${spread} pip.`}</span>
        <span />
        <span />
        <span>spread</span>
      </div>

      {bids.map((row) => (
        <LevelRow
          key={`bid-${row.level}`}
          row={row}
          side="bid"
          precision={precision}
          symbol={symbol}
          onPick={onPick}
        />
      ))}

      <small style={{ color: '#586e75', display: 'block', marginTop: '0.35rem' }}>
        click a level to load the ticket · <code>avg</code> is the cost of walking that volume —{' '}
        <strong>indicative</strong>: fills are scripted (§5.5), so an execution price does not derive from this
        depth
      </small>
    </section>
  );
};
