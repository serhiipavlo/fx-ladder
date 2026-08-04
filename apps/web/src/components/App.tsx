import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { ApolloProvider } from '@apollo/client/react';

import { feedWsUrl, healthzUrl } from '../lib/backend';
import { Boundary } from './Boundary';
import { instrumentsQueryOptions } from '../lib/catalogue';
import { Ladder } from './Ladder';
import { Panel } from './Panel';
import { StatusLine } from './StatusLine';
import { wakeServer } from '../lib/wake';
import { WakePanel } from './WakePanel';
import { createWarmClient } from '../warm/client';
import { TradingSection } from '../warm/TradingPanel';
import { connectFeedStream } from '../stream/connect';
import { createFeedStore, type FeedStore } from '../stream/store';

// The page itself owns nothing but composition: the feed store, the warm
// plane's client, the catalogue query, and the healthz line. Every widget
// below sits behind its own boundary (AC-12) — one broken panel must not
// take the ladder down with it.

interface AppComponent {
  (): React.JSX.Element;
}

export const App: AppComponent = () => {
  const [store, setStore] = useState<FeedStore | null>(null);
  const [health, setHealth] = useState('fetching…');
  const [waking, setWaking] = useState(false);
  // Page-lifetime Apollo client; the ws link is lazy and reconnects itself,
  // and onReconnect drives the T-0.4.8 state reconciliation in the section.
  const [warm] = useState(() => createWarmClient());
  // The catalogue is the server's, cached per the §7.2 contract; the built-in
  // copy renders as placeholder while the canonical one arrives.
  const { data: instruments = [] } = useQuery(instrumentsQueryOptions);

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

  const wake = useCallback(async (): Promise<void> => {
    setWaking(true);
    setHealth('waking…');
    const outcome = await wakeServer();
    setHealth(outcome.ok ? JSON.stringify(outcome.body) : `error: ${outcome.error}`);
    setWaking(false);
    // The knock only proves the container answers; resume() is what clears a
    // terminal ending, and the stream's own 1 s retry re-opens the feed.
    store?.resume();
  }, [store]);

  return (
    <main style={{ fontFamily: 'ui-monospace, monospace', padding: '2rem', lineHeight: 1.8 }}>
      <h1 style={{ marginTop: 0 }}>FX Ladder</h1>
      {store !== null && (
        <>
          <StatusLine store={store} />
          <Boundary name="ladder">
            <Ladder store={store} instruments={instruments} />
          </Boundary>
          <WakePanel store={store} waking={waking} onWake={() => void wake()} />
          <ApolloProvider client={warm.client}>
            <Boundary name="trade">
              <TradingSection feedStore={store} instruments={instruments} onReconnect={warm.onReconnect} />
            </Boundary>
          </ApolloProvider>
          <Boundary name="demo panel">
            <Panel store={store} instruments={instruments} />
          </Boundary>
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
};
