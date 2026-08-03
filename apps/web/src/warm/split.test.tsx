// @vitest-environment jsdom
import normalJson from '@fx/protocol/fixtures/normal-stream.json';
import { assembleFrame, encodeFrame, type Frame } from '@fx/protocol';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { FeedStreamHandle } from '../stream/connect';
import { createStreamCore } from '../stream/core';
import { createFeedStore } from '../stream/store';
import { PositionsView, type PositionData } from './TradingPanel';

// The done-when of T-0.4.5, asserted at the component: unrealised P&L ticks
// with the feed between execution events while realised changes only when
// the (server-owned) positions data changes — the §7.3 split on screen.

const normal = normalJson as unknown as Frame[];
const SNAPSHOT = normal[0]!;

function makeFeedHarness() {
  const core = createStreamCore();
  let notify: () => void = () => undefined;
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
    { scheduleFrame: (cb) => cb(), nowFn: () => 0 },
  );
  const feed = (frame: Frame): void => {
    core.onMessage(encodeFrame(frame), frame.serverTs);
    notify();
  };
  return { store, feed };
}

afterEach(cleanup);

describe('the §7.3 P&L split (done-when of T-0.4.5)', () => {
  it('unrealised ticks with the feed; realised moves only with new positions data', () => {
    const { store, feed } = makeFeedHarness();
    const positions: PositionData[] = [{ pair: 'EURUSD', netQtyK: 500, avgPx: 108_500, realisedPnl: 1234 }];

    const view = render(<PositionsView feedStore={store} positions={positions} />);
    act(() => feed(SNAPSHOT)); // seed-42 top: 108497/108503 → mid 108500

    const unrealised = () => screen.getByTestId('unrealised-EURUSD').textContent;
    const realised = () => screen.getByTestId('realised-EURUSD').textContent;
    expect(unrealised()).toBe('0.0'); // mid equals the average entry
    expect(realised()).toBe('1234.0');

    // A hot-plane delta moves EURUSD's top by +20 pipettes: unrealised must
    // tick, realised must not — no execution event happened.
    let seq = SNAPSHOT.firstSeq + SNAPSHOT.count;
    const bump = (price: number, ts: number): void => {
      const { frame } = assembleFrame(
        'DELTA',
        [
          { pairId: 0, side: 'bid', level: 0, price: price - 3, size: 900 },
          { pairId: 0, side: 'ask', level: 0, price: price + 3, size: 900 },
        ],
        seq,
        ts,
      );
      seq += 2;
      act(() => feed(frame));
    };

    bump(108_520, 100);
    expect(unrealised()).toBe((500 * 20).toFixed(1));
    expect(realised()).toBe('1234.0'); // untouched between events

    bump(108_460, 200);
    expect(unrealised()).toBe((500 * -40).toFixed(1));
    expect(realised()).toBe('1234.0'); // still untouched

    // An execution event arrives → the server's positions change → rerender
    // with new data: realised moves exactly then, unrealised keeps tracking.
    const afterTrade: PositionData[] = [{ pair: 'EURUSD', netQtyK: 200, avgPx: 108_500, realisedPnl: 5678 }];
    view.rerender(<PositionsView feedStore={store} positions={afterTrade} />);
    expect(realised()).toBe('5678.0');
    expect(unrealised()).toBe((200 * -40).toFixed(1));

    bump(108_500, 300);
    expect(unrealised()).toBe('0.0'); // ticking again with the feed
    expect(realised()).toBe('5678.0');
  });
});
