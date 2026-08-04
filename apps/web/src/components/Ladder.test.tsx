// @vitest-environment jsdom
import { INSTRUMENTS } from '@fx/domain';
import normalJson from '@fx/protocol/fixtures/normal-stream.json';
import { assembleFrame, encodeFrame, type Frame } from '@fx/protocol';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Ladder } from './Ladder';
import type { FeedStreamHandle, SocketState } from '../stream/connect';
import { createStreamCore } from '../stream/core';
import { createFeedStore } from '../stream/store';

const normal = normalJson as unknown as Frame[];
const SNAPSHOT = normal[0]!;

const makeHarness = (socket: SocketState = 'open') => {
  const core = createStreamCore();
  let notify: () => void = () => undefined;
  const handle: FeedStreamHandle = {
    core,
    socketState: () => socket,
    lastResync: () => null,
    lastClose: () => null,
    terminal: () => false,
    resume: () => undefined,
    wire: () => null,
    setProtocols: () => undefined,
    close: () => undefined,
  };
  // Synchronous frame scheduler: coalesced flushes run inline under act().
  const store = createFeedStore(
    (onChange) => {
      notify = onChange;
      return handle;
    },
    { scheduleFrame: (cb) => cb(), nowFn: () => 0 },
  );
  const feed = (frame: Frame): void => {
    core.onMessage(encodeFrame(frame), frame.serverTs);
    notify();
  };
  return { core, store, feed };
};

afterEach(cleanup);

describe('ladder (done-when of T-0.1.8)', () => {
  it('renders all five pairs from the snapshot with per-instrument precision', () => {
    const { store, feed } = makeHarness();
    render(<Ladder store={store} instruments={INSTRUMENTS} />);
    act(() => feed(SNAPSHOT));

    // Seed-42 anchors through the real formatter: 5 decimals for EURUSD,
    // 3 for the JPY quote — the formatter is the only place float exists.
    expect(screen.getByTestId('row-EURUSD').textContent).toContain('1.08497');
    expect(screen.getByTestId('row-EURUSD').textContent).toContain('1.08503');
    expect(screen.getByTestId('row-USDJPY').textContent).toContain('156.996');
    expect(screen.getByTestId('row-USDJPY').textContent).toContain('157.004');
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(INSTRUMENTS.length);
  });

  it("a single pair's update does not re-render the other rows", () => {
    const { store, feed } = makeHarness();
    const counts = new Map<string, number>();
    const collect = (symbol: string): void => {
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    };

    render(<Ladder store={store} instruments={INSTRUMENTS} onRowRender={collect} />);
    act(() => feed(SNAPSHOT));
    const baseline = new Map(counts);

    // A delta touching only EURUSD, seq continuing the snapshot.
    const { frame } = assembleFrame(
      'DELTA',
      [{ pairId: 0, side: 'bid', level: 0, price: 108489, size: 900 }],
      SNAPSHOT.firstSeq + SNAPSHOT.count,
      SNAPSHOT.serverTs + 10,
    );
    act(() => feed(frame));

    expect(counts.get('EURUSD')).toBe(baseline.get('EURUSD')! + 1);
    for (const symbol of ['GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD']) {
      expect(counts.get(symbol), `${symbol} must not re-render`).toBe(baseline.get(symbol));
    }
    expect(screen.getByTestId('row-EURUSD').textContent).toContain('1.08489');
  });

  it('shows rows dimmed while the stream is not live', () => {
    const { store } = makeHarness('closed');
    render(<Ladder store={store} instruments={INSTRUMENTS} />);
    expect(screen.getByTestId('row-EURUSD').style.opacity).toBe('0.4');
  });

  it('lights rows back up once a snapshot lands on an open socket', () => {
    const { store, feed } = makeHarness();
    render(<Ladder store={store} instruments={INSTRUMENTS} />);
    expect(screen.getByTestId('row-EURUSD').style.opacity).toBe('0.4');
    act(() => feed(SNAPSHOT));
    expect(screen.getByTestId('row-EURUSD').style.opacity).toBe('1');
  });

  it('marks a quiet pair stale while the channel stays alive (AC-06)', () => {
    const { store, feed } = makeHarness();
    let clock = SNAPSHOT.serverTs;
    render(<Ladder store={store} instruments={INSTRUMENTS} nowFn={() => clock} />);
    act(() => feed(SNAPSHOT));
    expect(screen.queryByTestId('stale-USDJPY')).toBeNull();

    // Everything but USDJPY keeps updating past the staleness threshold.
    let seq = SNAPSHOT.firstSeq + SNAPSHOT.count;
    for (const dt of [1000, 2000, 3000]) {
      clock = SNAPSHOT.serverTs + dt;
      const { frame } = assembleFrame(
        'DELTA',
        [{ pairId: 0, side: 'bid', level: 0, price: 108490, size: 700 }],
        seq,
        clock,
      );
      seq += 1;
      act(() => feed(frame));
    }

    expect(screen.getByTestId('stale-USDJPY')).toBeTruthy();
    expect(screen.queryByTestId('stale-EURUSD')).toBeNull();
    // Stale ≠ disconnected: the connection itself still reads as live.
    expect(screen.getByTestId('row-USDJPY').style.opacity).not.toBe('0.4');
  });
});
