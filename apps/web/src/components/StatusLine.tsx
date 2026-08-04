import { useSyncExternalStore } from 'react';

import type { CloseInfo, SocketState } from '../stream/connect';
import type { StreamStatus } from '../stream/core';
import type { FeedStore } from '../stream/store';

// The page's one-line answer to "is the feed alive, and what is it costing?".
// Everything it shows is a projection of the stream layer's snapshot, so the
// three decisions it makes — label, colour, rate unit — are pure functions
// over that snapshot and get tested without a socket or a render.

/**
 * What the connection is doing, in the demo's words. The socket outranks the
 * protocol: a live status on a dead socket is a stale reading, and a close
 * that carried a reaction (§7.1) says more than "disconnected".
 */
/** Names what the connection is doing, in the demo's words. */
interface FeedLabeller {
  (socket: SocketState, status: StreamStatus, close: CloseInfo | null): string;
}

/** Picks the colour a status label is drawn in. */
interface LabelColourPicker {
  (label: string, terminal: boolean): string;
}

/** Renders a byte rate in the unit that keeps it readable. */
interface WireRateFormatter {
  (bytesPerSec: number): string;
}

interface StatusLineComponent {
  (props: StatusLineProps): React.JSX.Element;
}

export const feedLabel: FeedLabeller = (socket, status, close) => {
  if (socket === 'open') {
    if (status === 'live') return 'live';
    if (status === 'resync') return 'resyncing';
    return 'connecting';
  }
  if (socket === 'connecting') return 'connecting';
  return close?.decision.label ?? 'disconnected — retrying';
};

/** Green only for live; red once the ending is terminal or data was lost. */
export const labelColor: LabelColourPicker = (label, terminal) => {
  if (label === 'live') return '#2aa198';
  if (terminal || label.includes('lost')) return '#dc322f';
  return '#b58900';
};

/** Wire cost in the unit that keeps the number readable at demo rates. */
export const formatWireRate: WireRateFormatter = (bytesPerSec) => {
  const kib = bytesPerSec / 1024;
  if (kib >= 1024) return `${(kib / 1024).toFixed(2)} MiB/s`;
  return `${kib.toFixed(1)} KiB/s`;
};

export interface StatusLineProps {
  store: FeedStore;
  /** Clock for the trailing-second rate window; injectable for tests. */
  nowFn?: () => number;
}

export const StatusLine: StatusLineComponent = ({ store, nowFn }) => {
  useSyncExternalStore(store.subscribe, () => store.version());
  const stats = store.core.stats();
  const label = feedLabel(store.socketState(), store.core.status(), store.lastClose());
  const color = labelColor(label, store.terminal());

  const render = store.renderStats();
  const nowMs = (nowFn ?? ((): number => performance.now()))();

  return (
    <>
      <p>
        feed:{' '}
        <strong style={{ color }} data-testid="feed-status">
          {label}
        </strong>{' '}
        (<span data-testid="wire">{store.wire() ?? '…'}</span>,{' '}
        <span data-testid="wire-rate">{formatWireRate(store.core.bytesPerSec(nowMs))}</span>) — frames {stats.frames},
        records {stats.records}, heartbeats {stats.heartbeats}, gaps <span data-testid="gaps">{stats.gaps}</span>, last
        seq {stats.lastSeq ?? '—'}
      </p>
      <p>
        render: <strong>{render.mode}</strong> — renders {render.renders} (switch lives in the demo panel)
      </p>
    </>
  );
};
