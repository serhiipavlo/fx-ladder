// @vitest-environment jsdom
import { INSTRUMENTS } from '@fx/domain';
import type { Frame } from '@fx/protocol';
import normalJson from '@fx/protocol/fixtures/normal-stream.json';
import { encodeFrame } from '@fx/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Panel } from './Panel';
import type { FeedStreamHandle } from './stream/connect';
import { createStreamCore } from './stream/core';
import { createFeedStore } from './stream/store';

const normal = normalJson as unknown as Frame[];

function makeHarness() {
  const core = createStreamCore();
  let notify: () => void = () => undefined;
  const handle: FeedStreamHandle = {
    core,
    socketState: () => 'open',
    lastResync: () => null,
    lastClose: () => null,
    terminal: () => false,
    resume: () => undefined,
    close: () => undefined,
  };
  const store = createFeedStore(
    (onChange) => {
      notify = onChange;
      return handle;
    },
    { scheduleFrame: (cb) => cb(), nowFn: () => 0 },
  );
  return { core, store, notify };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('demo panel (done-when of T-0.2.7)', () => {
  it('fires the control-plane calls the demo lines need', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
        return new Response('{"ok":true}', { status: 200 });
      }),
    );

    const { store } = makeHarness();
    render(<Panel store={store} instruments={INSTRUMENTS} pollMs={0} />);

    fireEvent.click(screen.getByTestId('rate-50000'));
    fireEvent.click(screen.getByTestId('gap'));
    fireEvent.click(screen.getByTestId('news'));
    fireEvent.click(screen.getByTestId('freeze'));
    await act(async () => Promise.resolve());

    const byPath = (suffix: string) => calls.find((c) => c.url.endsWith(suffix));
    expect(byPath('/sim/rate')?.body).toEqual({ updatesPerSec: 50_000 });
    expect(byPath('/sim/gap')?.body).toEqual({ skipSeqs: 40 });
    expect(byPath('/sim/news')?.body).toEqual({ pair: 'GBPUSD', pips: 80, spreadX: 6 });
    expect(byPath('/sim/freeze')?.body).toEqual({ pair: 'GBPUSD', ms: 10_000 });
  });

  it('the render toggle flips the store mode in place', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const { store, core, notify } = makeHarness();
    core.onMessage(encodeFrame(normal[0]!), 0);
    notify();

    render(<Panel store={store} instruments={INSTRUMENTS} pollMs={0} />);
    expect(store.renderMode()).toBe('coalesced');
    fireEvent.click(screen.getByTestId('render-mode'));
    expect(store.renderMode()).toBe('naive');
    fireEvent.click(screen.getByTestId('render-mode'));
    expect(store.renderMode()).toBe('coalesced');
  });
});
