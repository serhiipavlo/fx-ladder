// @vitest-environment jsdom
import { INSTRUMENTS } from '@fx/domain';
import normalJson from '@fx/protocol/fixtures/normal-stream.json';
import { assembleFrame, encodeFrame, type Frame } from '@fx/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Depth } from './Depth';
import type { FeedStreamHandle } from '../stream/connect';
import { createStreamCore } from '../stream/core';
import { createFeedStore } from '../stream/store';

// The done-when of T-1.3.1, render half: the depth the wire has always
// carried is on screen, cumulative volume reads as a walk, and a click on a
// level becomes a ticket request (FR-05/06/07).

const normal = normalJson as unknown as Frame[];
const SNAPSHOT = normal[0]!;
const EURUSD = INSTRUMENTS[0]!;

const makeHarness = () => {
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
};

afterEach(cleanup);

describe('the depth ladder (done-when of T-1.3.1)', () => {
  it('draws every level the wire carries, not only the top (FR-05)', () => {
    const { store, feed } = makeHarness();
    render(<Depth store={store} instrument={EURUSD} pairId={0} />);
    act(() => feed(SNAPSHOT));

    // Four levels a side is what the model streams (§5.4, BOOK_LEVELS).
    expect(screen.getAllByTestId(/^depth-bid-\d$/)).toHaveLength(4);
    expect(screen.getAllByTestId(/^depth-ask-\d$/)).toHaveLength(4);

    // Top of book is the pair the ladder already showed — same numbers, and
    // now with three more levels behind each of them.
    expect(screen.getByTestId('depth-bid-0').textContent).toContain('1.08497');
    expect(screen.getByTestId('depth-ask-0').textContent).toContain('1.08503');
    expect(screen.getByTestId('depth-spread').textContent).toContain('6 pip.');
  });

  it('reads the cumulative volume and the cost of walking it (FR-06)', () => {
    const { store, feed } = makeHarness();
    render(<Depth store={store} instrument={EURUSD} pairId={0} />);
    act(() => feed(SNAPSHOT));

    const cum = (level: number): number =>
      Number(screen.getByTestId(`depth-ask-${level}-cum`).textContent!.replace('K', ''));

    // Volume only accumulates going deeper.
    expect(cum(1)).toBeGreaterThan(cum(0));
    expect(cum(2)).toBeGreaterThan(cum(1));
    expect(cum(3)).toBeGreaterThan(cum(2));

    // And walking an offer book deeper only costs more: the average leaves
    // the best price and never comes back to it.
    const avg = (level: number): string => screen.getByTestId(`depth-ask-${level}-avg`).textContent!;
    expect(avg(0)).toBe('1.08503'); // one level: the average IS the price
    expect(Number(avg(3))).toBeGreaterThan(Number(avg(0)));
  });

  it('turns a clicked level into a ticket request for the walk (FR-07)', () => {
    const { store, feed } = makeHarness();
    const onPick = vi.fn();
    render(<Depth store={store} instrument={EURUSD} pairId={0} onPick={onPick} />);
    act(() => feed(SNAPSHOT));

    const cumOfAsk1 = Number(screen.getByTestId('depth-ask-1-cum').textContent!.replace('K', ''));
    fireEvent.click(screen.getByTestId('depth-ask-1'));

    // You buy from the offers, and you ask for what the walk takes — not for
    // that one level's own size.
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toMatchObject({ pair: 'EURUSD', side: 'buy', qtyK: cumOfAsk1 });

    fireEvent.click(screen.getByTestId('depth-bid-0'));
    expect(onPick.mock.calls[1]![0]).toMatchObject({ pair: 'EURUSD', side: 'sell' });
  });

  it('re-renders for its own pair and stays still for the others (NFR-03)', () => {
    const { store, feed } = makeHarness();
    const onRender = vi.fn();
    render(<Depth store={store} instrument={EURUSD} pairId={0} onRender={onRender} />);
    act(() => feed(SNAPSHOT));

    const baseline = onRender.mock.calls.length;
    let seq = SNAPSHOT.firstSeq + SNAPSHOT.count;

    // A delta for GBPUSD — a pair this panel is not showing.
    const other = assembleFrame(
      'DELTA',
      [{ pairId: 1, side: 'bid', level: 0, price: 126_991, size: 800 }],
      seq,
      SNAPSHOT.serverTs + 10,
    );
    seq += 1;
    act(() => feed(other.frame));
    expect(onRender.mock.calls.length, 'another pair must not re-render the panel').toBe(baseline);

    // Its own pair, and it moves.
    const mine = assembleFrame(
      'DELTA',
      [{ pairId: 0, side: 'bid', level: 0, price: 108_491, size: 700 }],
      seq,
      SNAPSHOT.serverTs + 20,
    );
    act(() => feed(mine.frame));
    expect(onRender.mock.calls.length).toBeGreaterThan(baseline);
    expect(screen.getByTestId('depth-bid-0').textContent).toContain('1.08491');
  });

  it('renders an empty panel before any book arrives', () => {
    const { store } = makeHarness();
    render(<Depth store={store} instrument={EURUSD} pairId={0} />);
    expect(screen.queryAllByTestId(/^depth-bid-\d$/)).toHaveLength(0);
    expect(screen.getByTestId('depth-spread').textContent).toContain('—');
  });
});
