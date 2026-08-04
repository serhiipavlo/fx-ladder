// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CloseInfo, FeedStreamHandle, SocketState } from '../stream/connect';
import { createStreamCore } from '../stream/core';
import { reconnectDecision } from '../stream/reconnect';
import { createFeedStore, type FeedStore } from '../stream/store';
import { wakeHint, WakePanel } from './WakePanel';

const COLD_START = 'free instance sleeps after ~15 min idle; waking takes up to a minute';

interface HarnessOptions {
  socket?: SocketState;
  terminal?: boolean;
  close?: CloseInfo | null;
}

const makeStore = ({ socket = 'closed', terminal = false, close = null }: HarnessOptions = {}): FeedStore => {
  const core = createStreamCore();
  const handle: FeedStreamHandle = {
    core,
    socketState: () => socket,
    lastResync: () => null,
    lastClose: () => close,
    terminal: () => terminal,
    resume: () => undefined,
    wire: () => null,
    setProtocols: () => undefined,
    close: () => undefined,
  };
  return createFeedStore(() => handle, { scheduleFrame: (cb) => cb(), nowFn: () => 0 });
};

afterEach(cleanup);

describe('wakeHint', () => {
  it('explains the sleeping free instance while the ending is not terminal', () => {
    expect(wakeHint(makeStore())).toBe(COLD_START);
  });

  it('quotes the server\'s own reason when it gave one', () => {
    const decision = reconnectDecision(1000, 0, 0.5);
    const store = makeStore({ terminal: true, close: { code: 1000, reason: 'server shutting down', decision } });
    expect(wakeHint(store)).toBe('server shutting down');
  });

  it('falls back to the reaction table, then to a bare "stopped"', () => {
    const decision = reconnectDecision(4002, 0, 0.5);
    expect(wakeHint(makeStore({ terminal: true, close: { code: 4002, reason: '', decision } }))).toBe(decision.label);
    expect(wakeHint(makeStore({ terminal: true, close: null }))).toBe('stopped');
  });
});

describe('wake panel (rendered)', () => {
  it('stays out of the way while the socket is alive', () => {
    for (const socket of ['open', 'connecting'] as const) {
      const { unmount } = render(<WakePanel store={makeStore({ socket })} waking={false} onWake={() => undefined} />);
      expect(screen.queryByTestId('wake')).toBeNull();
      unmount();
    }
  });

  it('offers a knock on a closed socket and reports the click', () => {
    const onWake = vi.fn();
    render(<WakePanel store={makeStore()} waking={false} onWake={onWake} />);

    const button = screen.getByTestId('wake');
    expect(button.textContent).toBe('Wake the server');
    expect(screen.getByTestId('wake-hint').textContent).toBe(COLD_START);
    fireEvent.click(button);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('offers a reconnect instead once the ending was final', () => {
    const decision = reconnectDecision(4002, 0, 0.5);
    const store = makeStore({ terminal: true, close: { code: 4002, reason: 'bad frame', decision } });
    render(<WakePanel store={store} waking={false} onWake={() => undefined} />);

    expect(screen.getByTestId('wake').textContent).toBe('Reconnect');
    expect(screen.getByTestId('wake-hint').textContent).toBe('bad frame');
  });

  it('waits rather than queueing a second knock', () => {
    const onWake = vi.fn();
    render(<WakePanel store={makeStore()} waking={true} onWake={onWake} />);

    const button = screen.getByTestId<HTMLButtonElement>('wake');
    expect(button.textContent).toBe('waking the server…');
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onWake).not.toHaveBeenCalled();
  });
});
