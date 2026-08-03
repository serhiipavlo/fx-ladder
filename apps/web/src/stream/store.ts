import { percentile } from '@fx/domain';
import { FX_SUBPROTOCOL, PREFERRED_SUBPROTOCOLS } from '@fx/protocol';

import type { CloseInfo, FeedStreamHandle, SocketState } from './connect';
import type { StreamCore, StreamEvent } from './core';

// React-facing wrapper over the stream — and the home of the release's
// centrepiece (architecture §6.4): HOW state changes reach React is a mode.
//
//   naive     — notify listeners synchronously on every wire message; with
//               the server in batch:false that is a render per update, the
//               honest first implementation of every realtime dashboard.
//   coalesced — apply state immediately (the protocol core never lags), but
//               fold all notifications between animation frames into ONE
//               flush per frame: rendering happens at screen pace no matter
//               what the wire does.
//
// The instrumentation measures both sides of that story: per-message handling
// (decode + apply + any synchronous render) and per-flush render cost.

export type RenderMode = 'naive' | 'coalesced';

export interface RenderStats {
  mode: RenderMode;
  /** Wire messages processed. */
  messages: number;
  /** Listener flushes (≈ React render passes) triggered by the stream. */
  renders: number;
  /** p95 of per-message handling, ms — includes the sync render in naive mode. */
  messageP95: number;
  /** p95 of a coalesced flush, ms. */
  flushP95: number;
}

export interface FeedStore {
  subscribe(listener: () => void): () => void;
  core: StreamCore;
  socketState(): SocketState;
  lastResync(): StreamEvent | null;
  lastClose(): CloseInfo | null;
  terminal(): boolean;
  resume(): void;
  version(): number;
  pairVersion(pairId: number): number;
  renderMode(): RenderMode;
  setRenderMode(mode: RenderMode): void;
  renderStats(): RenderStats;
  /** The negotiated /feed subprotocol; null before the first open. */
  wire(): string | null;
  /** The demo's live wire contrast (ADR-12): force fx.v1 or return to fx.v2. */
  setWire(next: 'fx.v2' | 'fx.v1'): void;
  close(): void;
}

export interface FeedStoreOptions {
  /** Frame scheduler; requestAnimationFrame in production, injectable for tests. */
  scheduleFrame?: (callback: () => void) => void;
  /** Clock for the instrumentation; performance.now in production. */
  nowFn?: () => number;
}

const SAMPLE_RING = 512;

function pushSample(ring: number[], cursor: { at: number }, value: number): void {
  if (ring.length < SAMPLE_RING) {
    ring.push(value);
  } else {
    ring[cursor.at] = value;
    cursor.at = (cursor.at + 1) % SAMPLE_RING;
  }
}

/**
 * `connect` receives the store's notifier and returns the transport handle —
 * production passes `connectFeedStream`, tests pass a handle around a bare
 * core and keep the notifier to drive renders by hand.
 */
export function createFeedStore(
  connect: (onChange: () => void) => FeedStreamHandle,
  options: FeedStoreOptions = {},
): FeedStore {
  const scheduleFrame =
    options.scheduleFrame ?? ((callback: () => void) => window.requestAnimationFrame(() => callback()));
  const now = options.nowFn ?? ((): number => performance.now());

  const listeners = new Set<() => void>();
  let mode: RenderMode = 'coalesced';
  let framePending = false;
  /** Store-local changes (mode flips) must move the snapshot too. */
  let localVersion = 0;

  let messages = 0;
  let renders = 0;
  const messageSamples: number[] = [];
  const messageCursor = { at: 0 };
  const flushSamples: number[] = [];
  const flushCursor = { at: 0 };

  function notifyNow(): void {
    renders += 1;
    for (const listener of listeners) listener();
  }

  function onChange(): void {
    const started = now();
    messages += 1;
    if (mode === 'naive') {
      // The whole cost lands here, synchronously — this is the number that
      // explodes when the wire is unbatched (§6.4).
      notifyNow();
      pushSample(messageSamples, messageCursor, now() - started);
      return;
    }
    pushSample(messageSamples, messageCursor, now() - started);
    if (framePending) return;
    framePending = true;
    scheduleFrame(() => {
      framePending = false;
      const flushStarted = now();
      notifyNow();
      pushSample(flushSamples, flushCursor, now() - flushStarted);
    });
  }

  const handle = connect(onChange);

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    core: handle.core,
    socketState: () => handle.socketState(),
    lastResync: () => handle.lastResync(),
    lastClose: () => handle.lastClose(),
    terminal: () => handle.terminal(),
    resume: () => handle.resume(),
    version: () => handle.core.version() + localVersion,
    pairVersion: (pairId) => handle.core.pairVersions().get(pairId) ?? 0,
    renderMode: () => mode,
    setRenderMode(next) {
      mode = next;
      localVersion += 1;
      notifyNow(); // the toggle itself must be visible immediately
    },
    renderStats: () => ({
      mode,
      messages,
      renders,
      messageP95: percentile(messageSamples, 95),
      flushP95: percentile(flushSamples, 95),
    }),
    wire: () => handle.wire(),
    setWire(next) {
      handle.setProtocols(next === 'fx.v1' ? [FX_SUBPROTOCOL] : PREFERRED_SUBPROTOCOLS);
      localVersion += 1;
      notifyNow(); // the switch is visible immediately, like the render toggle
    },
    close: () => handle.close(),
  };
}
