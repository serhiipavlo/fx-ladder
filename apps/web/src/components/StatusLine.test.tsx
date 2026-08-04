// @vitest-environment jsdom
import normalJson from '@fx/protocol/fixtures/normal-stream.json';
import { encodeFrame, type Frame } from '@fx/protocol';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { feedLabel, formatWireRate, labelColor, StatusLine } from './StatusLine';
import type { CloseInfo, FeedStreamHandle, SocketState } from '../stream/connect';
import { createStreamCore } from '../stream/core';
import { reconnectDecision } from '../stream/reconnect';
import { createFeedStore } from '../stream/store';

const normal = normalJson as unknown as Frame[];
const SNAPSHOT = normal[0]!;

interface HarnessOptions {
  socket?: SocketState;
  terminal?: boolean;
  close?: CloseInfo | null;
  wire?: string | null;
}

const makeHarness = ({ socket = 'open', terminal = false, close = null, wire = null }: HarnessOptions = {}) => {
  const core = createStreamCore();
  let notify: () => void = () => undefined;
  const handle: FeedStreamHandle = {
    core,
    socketState: () => socket,
    lastResync: () => null,
    lastClose: () => close,
    terminal: () => terminal,
    resume: () => undefined,
    wire: () => wire,
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
  const feed = (frame: Frame, at = 0): void => {
    core.onMessage(encodeFrame(frame), at);
    notify();
  };
  return { core, store, feed };
};

afterEach(cleanup);

describe('feedLabel', () => {
  it('reads the protocol status while the socket is open', () => {
    expect(feedLabel('open', 'live', null)).toBe('live');
    expect(feedLabel('open', 'resync', null)).toBe('resyncing');
    expect(feedLabel('open', 'awaiting-snapshot', null)).toBe('connecting');
  });

  it('a dead socket outranks a stale live status', () => {
    // The core still says "live" — it has no way to know the wire went away.
    expect(feedLabel('closed', 'live', null)).toBe('disconnected — retrying');
    expect(feedLabel('connecting', 'live', null)).toBe('connecting');
  });

  it('prefers the reaction table\'s word about the ending (§7.1)', () => {
    const decision = reconnectDecision(4001, 0, 0.5);
    expect(feedLabel('closed', 'live', { code: 4001, reason: '', decision })).toBe(decision.label);
  });
});

describe('labelColor', () => {
  it('is green only for live', () => {
    expect(labelColor('live', false)).toBe('#2aa198');
    expect(labelColor('resyncing', false)).toBe('#b58900');
  });

  it('turns red for a terminal ending or for lost data', () => {
    expect(labelColor('resyncing', true)).toBe('#dc322f');
    expect(labelColor('data lost — resyncing', false)).toBe('#dc322f');
  });
});

describe('formatWireRate', () => {
  it('reads in KiB/s below a mebibyte and in MiB/s above it', () => {
    expect(formatWireRate(0)).toBe('0.0 KiB/s');
    expect(formatWireRate(1536)).toBe('1.5 KiB/s');
    expect(formatWireRate(1024 * 1024)).toBe('1.00 MiB/s');
    expect(formatWireRate(3 * 1024 * 1024)).toBe('3.00 MiB/s');
  });
});

describe('status line (rendered)', () => {
  it('reports the snapshot the core actually took', () => {
    const { store, feed } = makeHarness({ wire: 'fx.v2' });
    render(<StatusLine store={store} nowFn={() => 0} />);
    expect(screen.getByTestId('feed-status').textContent).toBe('connecting');

    act(() => feed(SNAPSHOT));
    expect(screen.getByTestId('feed-status').textContent).toBe('live');
    expect(screen.getByTestId('feed-status').style.color).toBe('rgb(42, 161, 152)');
    expect(screen.getByTestId('wire').textContent).toBe('fx.v2');
    expect(screen.getByTestId('gaps').textContent).toBe('0');
  });

  it('shows the wire cost of the trailing second only', () => {
    const { store, feed } = makeHarness();
    const bytes = encodeFrame(SNAPSHOT).length;
    const { rerender } = render(<StatusLine store={store} nowFn={() => 0} />);
    act(() => feed(SNAPSHOT, 0));
    expect(screen.getByTestId('wire-rate').textContent).toBe(formatWireRate(bytes));

    // Two seconds on, that frame has fallen out of the window.
    rerender(<StatusLine store={store} nowFn={() => 2000} />);
    expect(screen.getByTestId('wire-rate').textContent).toBe('0.0 KiB/s');
  });

  it('names a terminal ending in red', () => {
    const decision = reconnectDecision(4002, 0, 0.5);
    const { store } = makeHarness({
      socket: 'closed',
      terminal: true,
      close: { code: 4002, reason: 'bad frame', decision },
    });
    render(<StatusLine store={store} nowFn={() => 0} />);
    expect(screen.getByTestId('feed-status').textContent).toBe(decision.label);
    expect(screen.getByTestId('feed-status').style.color).toBe('rgb(220, 50, 47)');
    expect(screen.getByTestId('wire').textContent).toBe('…');
  });
});
