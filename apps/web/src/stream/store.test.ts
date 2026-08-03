import { assembleFrame, encodeFrame, type Frame } from '@fx/protocol';
import normalJson from '@fx/protocol/fixtures/normal-stream.json';
import { describe, expect, it } from 'vitest';

import type { FeedStreamHandle } from './connect';
import { createStreamCore } from './core';
import { createFeedStore } from './store';

const normal = normalJson as unknown as Frame[];
const SNAPSHOT = normal[0]!;

// Sans-I/O again: the frame scheduler and the clock are injected, so the
// coalescing contract is provable without a browser or timers.

function makeHarness() {
  const core = createStreamCore();
  let notify: () => void = () => undefined;
  const pendingFrames: Array<() => void> = [];
  let clock = 0;
  const handle: FeedStreamHandle = {
    core,
    socketState: () => 'open',
    lastResync: () => null,
    lastClose: () => null,
    terminal: () => false,
    resume: () => undefined,
    wire: () => null,
    setProtocols: () => undefined,
    close: () => undefined,
  };
  const store = createFeedStore(
    (onChange) => {
      notify = onChange;
      return handle;
    },
    {
      scheduleFrame: (cb) => pendingFrames.push(cb),
      nowFn: () => (clock += 0.1),
    },
  );
  const feed = (frame: Frame): void => {
    core.onMessage(encodeFrame(frame), frame.serverTs);
    notify();
  };
  const flushFrame = (): void => {
    for (const cb of pendingFrames.splice(0)) cb();
  };
  return { core, store, feed, flushFrame };
}

function delta(seq: number, price: number): Frame {
  return assembleFrame('DELTA', [{ pairId: 0, side: 'bid', level: 0, price, size: 500 }], seq, 100).frame;
}

describe('render switch (done-when of T-0.2.5)', () => {
  it('coalesced: many messages between animation frames produce exactly one render', () => {
    const { store, feed, flushFrame } = makeHarness();
    let renders = 0;
    store.subscribe(() => {
      renders += 1;
    });

    feed(SNAPSHOT);
    let seq = SNAPSHOT.firstSeq + SNAPSHOT.count;
    for (let i = 0; i < 10; i += 1) {
      feed(delta(seq, 108500 + i));
      seq += 1;
    }
    expect(renders).toBe(0); // nothing rendered yet — the frame has not arrived

    flushFrame();
    expect(renders).toBe(1); // eleven messages, one render pass

    expect(store.renderStats().messages).toBe(11);
    expect(store.renderStats().renders).toBe(1);
    expect(store.core.stats().records).toBeGreaterThan(SNAPSHOT.count); // state never lagged
  });

  it('naive: every message renders synchronously', () => {
    const { store, feed } = makeHarness();
    store.setRenderMode('naive');
    let renders = 0;
    store.subscribe(() => {
      renders += 1;
    });

    feed(SNAPSHOT);
    let seq = SNAPSHOT.firstSeq + SNAPSHOT.count;
    for (let i = 0; i < 5; i += 1) {
      feed(delta(seq, 108600 + i));
      seq += 1;
    }
    expect(renders).toBe(6);
    expect(store.renderStats().renders).toBeGreaterThanOrEqual(6);
  });

  it('the mode can flip at runtime and reports itself', () => {
    const { store, feed, flushFrame } = makeHarness();
    expect(store.renderMode()).toBe('coalesced');
    store.setRenderMode('naive');
    expect(store.renderMode()).toBe('naive');

    let renders = 0;
    store.subscribe(() => {
      renders += 1;
    });
    feed(SNAPSHOT);
    expect(renders).toBe(1); // naive: synchronous

    store.setRenderMode('coalesced');
    renders = 0;
    feed(delta(SNAPSHOT.firstSeq + SNAPSHOT.count, 108700));
    expect(renders).toBe(0);
    flushFrame();
    expect(renders).toBe(1);
  });

  it('exports both instrumentation numbers for the gate', () => {
    const { store, feed, flushFrame } = makeHarness();
    feed(SNAPSHOT);
    flushFrame();
    store.setRenderMode('naive');
    feed(delta(SNAPSHOT.firstSeq + SNAPSHOT.count, 108800));

    const stats = store.renderStats();
    expect(stats.messageP95).toBeGreaterThan(0);
    expect(stats.flushP95).toBeGreaterThan(0);
  });

  it('only one animation frame is ever pending', () => {
    const { store, feed, flushFrame } = makeHarness();
    const scheduled: number[] = [];
    store.subscribe(() => scheduled.push(store.renderStats().renders));

    feed(SNAPSHOT);
    let seq = SNAPSHOT.firstSeq + SNAPSHOT.count;
    for (let i = 0; i < 3; i += 1) {
      feed(delta(seq, 108900 + i));
      seq += 1;
    }
    flushFrame();
    flushFrame(); // an empty second frame must not double-render
    expect(scheduled.length).toBe(1);
  });
});
