import { FX_SUBPROTOCOL, type HeartbeatFrame } from '@fx/protocol';
import { useEffect, useState } from 'react';

import { feedWsUrl, healthzUrl } from './backend';

type ConnectionState = 'connecting' | 'connected' | 'disconnected';

const stateColor: Record<ConnectionState, string> = {
  connecting: '#b58900',
  connected: '#2aa198',
  disconnected: '#dc322f',
};

export function App(): React.JSX.Element {
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [heartbeats, setHeartbeats] = useState(0);
  const [lastFrame, setLastFrame] = useState<HeartbeatFrame | null>(null);
  const [health, setHealth] = useState('fetching…');

  useEffect(() => {
    const ws = new WebSocket(feedWsUrl(), FX_SUBPROTOCOL);
    ws.onopen = () => setConnection('connected');
    ws.onclose = () => setConnection('disconnected');
    ws.onmessage = (event: MessageEvent<string>) => {
      const frame = JSON.parse(event.data) as HeartbeatFrame;
      if (frame.frameType === 'HEARTBEAT') {
        setHeartbeats((n) => n + 1);
        setLastFrame(frame);
      }
    };
    return () => ws.close();
  }, []);

  useEffect(() => {
    // The one deliberately cross-origin fetch of the walking skeleton: on the
    // deployed site it proves CORS between the static host and the container —
    // the WS handshake alone cannot (plan §3, v0.0.1).
    fetch(healthzUrl())
      .then((res) => res.json())
      .then((body: unknown) => setHealth(JSON.stringify(body)))
      .catch((err: unknown) => setHealth(`error: ${err instanceof Error ? err.message : String(err)}`));
  }, []);

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
    </main>
  );
}
