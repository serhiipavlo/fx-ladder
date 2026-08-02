import { FX_SUBPROTOCOL, type Frame } from '@fx/protocol';
import { useEffect, useState } from 'react';

import { feedWsUrl, healthzUrl } from './backend';

type ConnectionState = 'connecting' | 'connected' | 'disconnected';

const stateColor: Record<ConnectionState, string> = {
  connecting: '#b58900',
  connected: '#2aa198',
  disconnected: '#dc322f',
};

const WAKE_DEADLINE_MS = 90_000;
const WAKE_RETRY_MS = 3_000;

export function App(): React.JSX.Element {
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [heartbeats, setHeartbeats] = useState(0);
  const [lastFrame, setLastFrame] = useState<Frame | null>(null);
  const [health, setHealth] = useState('fetching…');
  const [attempt, setAttempt] = useState(1);
  const [waking, setWaking] = useState(false);

  useEffect(() => {
    setConnection('connecting');
    const ws = new WebSocket(feedWsUrl(), FX_SUBPROTOCOL);
    ws.onopen = () => setConnection('connected');
    ws.onclose = () => setConnection('disconnected');
    ws.onmessage = (event: MessageEvent<string>) => {
      const frame = JSON.parse(event.data) as Frame;
      if (frame.frameType === 'HEARTBEAT') {
        setHeartbeats((n) => n + 1);
        setLastFrame(frame);
      }
    };
    return () => ws.close();
  }, [attempt]);

  useEffect(() => {
    // The one deliberately cross-origin fetch of the walking skeleton: on the
    // deployed site it proves CORS between the static host and the container —
    // the WS handshake alone cannot (plan §3, v0.0.1).
    fetch(healthzUrl())
      .then((res) => res.json())
      .then((body: unknown) => setHealth(JSON.stringify(body)))
      .catch((err: unknown) => setHealth(`error: ${err instanceof Error ? err.message : String(err)}`));
  }, [attempt]);

  // The free Render instance spins down after ~15 min without inbound traffic
  // and takes up to a minute to cold-start (ADR-11 revision). Waking = knock
  // on /healthz until it answers, then reconnect the feed.
  async function wake(): Promise<void> {
    setWaking(true);
    setHealth('waking…');
    const deadline = Date.now() + WAKE_DEADLINE_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(healthzUrl());
        if (res.ok) {
          setWaking(false);
          setAttempt((n) => n + 1);
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
      <h1 style={{ marginTop: 0 }}>FX Ladder — walking skeleton</h1>
      <p>
        feed:{' '}
        <strong style={{ color: stateColor[connection] }}>{connection}</strong> ({FX_SUBPROTOCOL})
      </p>
      <p>
        heartbeats: <strong>{heartbeats}</strong>
        {lastFrame === null ? null : ` — last seq ${lastFrame.firstSeq}, serverTs ${lastFrame.serverTs} ms`}
      </p>
      <p>
        healthz: <code>{health}</code>
      </p>
      <p>
        <a href="/docs/">API docs</a> — control plane (OpenAPI) + feed (AsyncAPI)
      </p>
      {connection === 'disconnected' ? (
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
    </main>
  );
}
