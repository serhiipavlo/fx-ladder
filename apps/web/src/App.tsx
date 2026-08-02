import { FX_SUBPROTOCOL } from '@fx/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { feedWsUrl, healthzUrl } from './backend';
import { Ladder } from './Ladder';
import { connectFeedStream } from './stream/connect';
import { createFeedStore, type FeedStore } from './stream/store';

const WAKE_DEADLINE_MS = 90_000;
const WAKE_RETRY_MS = 3_000;

function StatusLine({ store }: { store: FeedStore }): React.JSX.Element {
  useSyncExternalStore(store.subscribe, () => store.version());
  const socket = store.socketState();
  const status = store.core.status();
  const stats = store.core.stats();

  const label =
    socket === 'open'
      ? status === 'live'
        ? 'live'
        : status === 'resync'
          ? 'resyncing'
          : 'connecting'
      : socket === 'connecting'
        ? 'connecting'
        : 'disconnected — retrying';
  const color = label === 'live' ? '#2aa198' : label.startsWith('disconnected') ? '#dc322f' : '#b58900';

  return (
    <p>
      feed:{' '}
      <strong style={{ color }} data-testid="feed-status">
        {label}
      </strong>{' '}
      ({FX_SUBPROTOCOL}) — frames {stats.frames}, records{' '}
      {stats.records}, heartbeats {stats.heartbeats}, gaps <span data-testid="gaps">{stats.gaps}</span>, last seq{' '}
      {stats.lastSeq ?? '—'}
    </p>
  );
}

export function App(): React.JSX.Element {
  const [store, setStore] = useState<FeedStore | null>(null);
  const [health, setHealth] = useState('fetching…');
  const [waking, setWaking] = useState(false);

  useEffect(() => {
    const created = createFeedStore((onChange) => connectFeedStream(feedWsUrl(), onChange));
    setStore(created);
    return () => created.close();
  }, []);

  useEffect(() => {
    // The one deliberately cross-origin fetch of the walking skeleton: on the
    // deployed site it proves CORS between the static host and the container.
    fetch(healthzUrl())
      .then((res) => res.json())
      .then((body: unknown) => setHealth(JSON.stringify(body)))
      .catch((err: unknown) => setHealth(`error: ${err instanceof Error ? err.message : String(err)}`));
  }, []);

  // The free Render instance sleeps after ~15 min without inbound traffic and
  // takes up to a minute to cold-start (ADR-11 revision). Waking = knock on
  // /healthz until it answers; the stream's own 1 s retry then reconnects.
  async function wake(): Promise<void> {
    setWaking(true);
    setHealth('waking…');
    const deadline = Date.now() + WAKE_DEADLINE_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(healthzUrl());
        if (res.ok) {
          setHealth(JSON.stringify(await res.json()));
          setWaking(false);
          return;
        }
      } catch {
        // still cold — keep knocking
      }
      await new Promise((resolve) => setTimeout(resolve, WAKE_RETRY_MS));
    }
    setWaking(false);
    setHealth(`error: server did not wake within ${WAKE_DEADLINE_MS / 1000} s`);
  }

  return (
    <main style={{ fontFamily: 'ui-monospace, monospace', padding: '2rem', lineHeight: 1.8 }}>
      <h1 style={{ marginTop: 0 }}>FX Ladder</h1>
      {store === null ? null : (
        <>
          <StatusLine store={store} />
          <Ladder store={store} />
          {store.socketState() === 'closed' ? (
            <p>
              <button
                onClick={() => void wake()}
                disabled={waking}
                style={{ font: 'inherit', padding: '0.4rem 1rem', cursor: waking ? 'wait' : 'pointer' }}
              >
                {waking ? 'waking the server…' : 'Wake the server'}
              </button>
              <br />
              <small>free instance sleeps after ~15 min idle; waking takes up to a minute</small>
            </p>
          ) : null}
        </>
      )}
      <p>
        healthz: <code>{health}</code>
      </p>
      <p>
        <a href="/docs/">API docs</a> — control plane (OpenAPI) + feed (AsyncAPI)
      </p>
    </main>
  );
}
