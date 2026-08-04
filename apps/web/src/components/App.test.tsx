// @vitest-environment jsdom
import { INSTRUMENTS, type Instrument } from '@fx/domain';
import normalJson from '@fx/protocol/fixtures/normal-stream.json';
import { encodeFrame, type Frame } from '@fx/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import type { FeedStreamHandle, SocketState } from '../stream/connect';
import type { StreamCore } from '../stream/core';

// App owns composition, nothing else — so this test replaces the two things
// that reach outside the page (the feed socket and the trading section, both
// covered by their own suites) and asserts the wiring: every widget gets the
// one store, the healthz line lands, the wake button knocks and resumes, and
// unmounting closes the stream.

const feed = vi.hoisted(() => ({
  core: null as StreamCore | null,
  notify: (): void => undefined,
  socket: 'open' as SocketState,
  closes: 0,
  resumes: 0,
}));

vi.mock('../stream/connect', async () => {
  const { createStreamCore } = await vi.importActual<typeof import('../stream/core')>('../stream/core');
  return {
    connectFeedStream: (_url: string, onChange: () => void): FeedStreamHandle => {
      const core = createStreamCore();
      feed.core = core;
      feed.notify = onChange;
      return {
        core,
        socketState: () => feed.socket,
        lastResync: () => null,
        lastClose: () => null,
        terminal: () => false,
        resume: () => {
          feed.resumes += 1;
        },
        wire: () => 'fx.v2',
        setProtocols: () => undefined,
        close: () => {
          feed.closes += 1;
        },
      };
    },
  };
});

vi.mock('../warm/TradingPanel', () => ({
  TradingSection: ({ instruments }: { instruments: readonly Instrument[] }): React.JSX.Element => (
    <div data-testid="trading">trading: {instruments.length} instruments</div>
  ),
}));

const normal = normalJson as unknown as Frame[];
const SNAPSHOT = normal[0]!;

const SERVER_STATS = {
  generated: 10,
  sent: 10,
  framesSent: 2,
  batch: true,
  updatesPerSec: 300,
  clients: 1,
  uptimeMs: 1234,
  tick: { p95: 0.5 },
};

const renderApp = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
};

/**
 * Push a frame into the mocked socket's core and let the store's coalesced
 * flush land — App runs the production scheduler, so the render is a frame away.
 *
 * The frame is stamped with the same clock the ladder judges staleness by
 * (`performance.now`). Stamping it 0 would date every row to process start,
 * so the rows would read as stale the moment this suite runs later than
 * STALE_AFTER_MS into the worker's life — a test that passes by being early.
 */
const push = async (frame: Frame): Promise<void> => {
  await act(async () => {
    feed.core!.onMessage(encodeFrame(frame), performance.now());
    feed.notify();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
};

beforeEach(() => {
  feed.core = null;
  feed.socket = 'open';
  feed.closes = 0;
  feed.resumes = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/instruments')) return Response.json(INSTRUMENTS);
      if (url.includes('/healthz')) return Response.json({ status: 'ok' });
      if (url.includes('/sim/stats')) return Response.json(SERVER_STATS);
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App composition', () => {
  it('hands one store to the status line, the ladder and the demo panel', async () => {
    renderApp();
    await waitFor(() => expect(feed.core).not.toBeNull());
    await push(SNAPSHOT);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('FX Ladder');
    expect(screen.getByTestId('feed-status').textContent).toBe('live');
    expect(screen.getByTestId('wire').textContent).toBe('fx.v2');
    // The ladder reads the same core: the snapshot lit its rows.
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(INSTRUMENTS.length);
    expect(screen.getByTestId('row-EURUSD').style.opacity).toBe('1');
    expect(screen.getByTestId('panel')).toBeTruthy();
    expect(screen.getByTestId('trading').textContent).toContain(`${INSTRUMENTS.length} instruments`);
  });

  it('proves the cross-origin healthz call in the page itself', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText(/"status":"ok"/)).toBeTruthy());
    expect(screen.getByRole('link', { name: 'API docs' }).getAttribute('href')).toBe('/docs/');
  });

  it('keeps the wake button out of sight while the socket is open', async () => {
    renderApp();
    await waitFor(() => expect(feed.core).not.toBeNull());
    expect(screen.queryByTestId('wake')).toBeNull();
  });

  it('knocks on healthz and resumes the stream when the button is used', async () => {
    feed.socket = 'closed';
    renderApp();
    await waitFor(() => expect(screen.getByTestId('wake')).toBeTruthy());

    fireEvent.click(screen.getByTestId('wake'));
    await waitFor(() => expect(feed.resumes).toBe(1));
    expect(screen.getByText(/"status":"ok"/)).toBeTruthy();
    // The knock finished: the button is offered again rather than left waiting.
    expect(screen.getByTestId<HTMLButtonElement>('wake').disabled).toBe(false);
  });

  it('closes the stream when the page goes away', async () => {
    const { unmount } = renderApp();
    await waitFor(() => expect(feed.core).not.toBeNull());
    unmount();
    expect(feed.closes).toBe(1);
  });
});
