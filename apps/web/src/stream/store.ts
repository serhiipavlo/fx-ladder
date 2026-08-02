import type { FeedStreamHandle, SocketState } from './connect';
import type { StreamCore, StreamEvent } from './core';

// React-facing wrapper over the stream: one subscription list, primitive
// version snapshots. Rows subscribe to their pair's counter, the status
// panel to the global one — that split is what keeps a single pair's update
// from re-rendering the rest (NFR-03).

export interface FeedStore {
  subscribe(listener: () => void): () => void;
  core: StreamCore;
  socketState(): SocketState;
  lastResync(): StreamEvent | null;
  version(): number;
  pairVersion(pairId: number): number;
  close(): void;
}

/**
 * `connect` receives the store's notifier and returns the transport handle —
 * production passes `connectFeedStream`, tests pass a handle around a bare
 * core and keep the notifier to drive renders by hand.
 */
export function createFeedStore(connect: (onChange: () => void) => FeedStreamHandle): FeedStore {
  const listeners = new Set<() => void>();
  const handle = connect(() => {
    for (const listener of listeners) listener();
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    core: handle.core,
    socketState: () => handle.socketState(),
    lastResync: () => handle.lastResync(),
    version: () => handle.core.version(),
    pairVersion: (pairId) => handle.core.pairVersions().get(pairId) ?? 0,
    close: () => handle.close(),
  };
}
