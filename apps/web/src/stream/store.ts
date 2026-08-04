import { percentile } from '@fx/domain';
import { FX_SUBPROTOCOL, PREFERRED_SUBPROTOCOLS } from '@fx/protocol';

import type { FeedStreamHandle, FeedTransportView } from './connect';

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

export interface FeedStore extends FeedTransportView {
  subscribe(listener: () => void): () => void;
  version(): number;
  pairVersion(pairId: number): number;
  renderMode(): RenderMode;
  setRenderMode(mode: RenderMode): void;
  renderStats(): RenderStats;
  /** The demo's live wire contrast (ADR-12): force fx.v1 or return to fx.v2. */
  setWire(next: 'fx.v2' | 'fx.v1'): void;
}

export interface FeedStoreOptions {
  /** Frame scheduler; requestAnimationFrame in production, injectable for tests. */
  scheduleFrame?: (callback: () => void) => void;
  /** Clock for the instrumentation; performance.now in production. */
  nowFn?: () => number;
}

/** How many timings each ring keeps — the window p95 is computed over. */
export const SAMPLE_RING = 512;

/** A bounded window of timings that answers the only question we ask of it. */
interface SampleRing {
  push(value: number): void;
  p95(): number;
}

/** Builds an empty sample ring. */
interface SampleRingFactory {
  (): SampleRing;
}

/**
 * Counts and times the two costs §6.4 is about, and nothing else — the store
 * next door is then free to be only about how changes reach React.
 */
interface RenderMeter {
  /** One wire message handled, in `ms` — whatever the mode did with it. */
  message(ms: number): void;
  /** One coalesced flush, in `ms`. */
  flush(ms: number): void;
  /** One listener pass happened. */
  render(): void;
  /** The mode is the store's to know, so it comes in rather than living here. */
  stats(mode: RenderMode): RenderStats;
}

/** Builds a meter with both rings empty. */
interface RenderMeterFactory {
  (): RenderMeter;
}

/** Wraps a transport in the React-facing store. */
interface FeedStoreFactory {
  (connect: (onChange: () => void) => FeedStreamHandle, options?: FeedStoreOptions): FeedStore;
}

/** The ring owns its own write head — a full one overwrites the oldest sample. */
const createSampleRing: SampleRingFactory = () => {
  const values: number[] = [];
  let head = 0;
  return {
    push(value) {
      if (values.length < SAMPLE_RING) {
        values.push(value);
        return;
      }
      values[head] = value;
      head = (head + 1) % SAMPLE_RING;
    },
    p95: () => percentile(values, 95),
  };
};

const createRenderMeter: RenderMeterFactory = () => {
  let messages = 0;
  let renders = 0;
  const messageSamples = createSampleRing();
  const flushSamples = createSampleRing();

  return {
    message(ms) {
      messages += 1;
      messageSamples.push(ms);
    },
    flush: (ms) => flushSamples.push(ms),
    render: () => {
      renders += 1;
    },
    stats: (mode) => ({
      mode,
      messages,
      renders,
      messageP95: messageSamples.p95(),
      flushP95: flushSamples.p95(),
    }),
  };
};

/**
 * `connect` receives the store's notifier and returns the transport handle —
 * production passes `connectFeedStream`, tests pass a handle around a bare
 * core and keep the notifier to drive renders by hand.
 */
export const createFeedStore: FeedStoreFactory = (connect, options = {}) => {
  const scheduleFrame =
    options.scheduleFrame ?? ((callback: () => void) => window.requestAnimationFrame(() => callback()));
  const now = options.nowFn ?? ((): number => performance.now());

  const listeners = new Set<() => void>();
  const meter = createRenderMeter();
  let mode: RenderMode = 'coalesced';
  let framePending = false;
  /** Store-local changes (mode flips) must move the snapshot too. */
  let localVersion = 0;

  const notifyNow = (): void => {
    meter.render();
    for (const listener of listeners) listener();
  };

  /** At most one frame is ever in flight; everything since the last one rides it. */
  const scheduleFlush = (): void => {
    if (framePending) return;
    framePending = true;
    scheduleFrame(() => {
      framePending = false;
      const started = now();
      notifyNow();
      meter.flush(now() - started);
    });
  };

  const onChange = (): void => {
    const started = now();
    if (mode === 'naive') {
      // The whole cost lands here, synchronously — this is the number that
      // explodes when the wire is unbatched (§6.4).
      notifyNow();
      meter.message(now() - started);
      return;
    }
    // Coalesced charges the message only for its own bookkeeping; the render
    // it will eventually cause is flushP95, billed to the frame that ran it.
    meter.message(now() - started);
    scheduleFlush();
  };

  const handle = connect(onChange);

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
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
    renderStats: () => meter.stats(mode),
    wire: () => handle.wire(),
    setWire(next) {
      handle.setProtocols(next === 'fx.v1' ? [FX_SUBPROTOCOL] : PREFERRED_SUBPROTOCOLS);
      localVersion += 1;
      notifyNow(); // the switch is visible immediately, like the render toggle
    },
    close: () => handle.close(),
  };
};
