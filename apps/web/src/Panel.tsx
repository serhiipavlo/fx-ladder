import type { Instrument } from '@fx/domain';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { backendUrl } from './backend';
import { LoadChart } from './perf/LoadChart';
import { createLoadSampler } from './perf/series';
import type { FeedStore } from './stream/store';

// The demo panel (T-0.2.7): every demo line of v0.2.0 runs from here — no
// curl, no DevTools. Left side commands the world (/sim/*), right side is the
// render switch; the footer shows what the server says about itself.

interface ServerStats {
  generated: number;
  sent: number;
  framesSent: number;
  batch: boolean;
  updatesPerSec: number;
  clients: number;
  uptimeMs: number;
  tick: { p95: number };
}

async function post(path: string, body: unknown): Promise<string> {
  try {
    const res = await fetch(backendUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return `${path} ✓`;
    const text = await res.text();
    return `${path} → ${res.status}: ${text.slice(0, 140)}`;
  } catch (err) {
    return `${path} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const RATE_PRESETS = [300, 5000, 20_000, 50_000];

const button: React.CSSProperties = { font: 'inherit', padding: '0.15rem 0.6rem', cursor: 'pointer' };
const row: React.CSSProperties = { display: 'flex', gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' };

export interface PanelProps {
  store: FeedStore;
  /** The catalogue as served by the cold plane. */
  instruments: readonly Instrument[];
  /** Server-stats poll period; 0 disables (tests). */
  pollMs?: number;
}

export function Panel({ store, instruments, pollMs = 1000 }: PanelProps): React.JSX.Element {
  useSyncExternalStore(store.subscribe, () => store.version());
  const [last, setLast] = useState('—');
  const [server, setServer] = useState<ServerStats | null>(null);
  const [pair, setPair] = useState('GBPUSD');
  const [seed, setSeed] = useState(42);
  // One sampler for the panel's lifetime; it folds each poll into the chart's
  // series and the setServer below is what repaints them (v1.2.0).
  const [sampler] = useState(() => createLoadSampler(60));

  const run = (promise: Promise<string>): void => void promise.then(setLast);

  useEffect(() => {
    if (pollMs === 0) return;
    let alive = true;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(backendUrl('/sim/stats'));
        if (!alive || !res.ok) return;
        const stats = (await res.json()) as ServerStats;
        // Both halves of the same second: what the server reported and what
        // this client's own meters saw while it was reporting it.
        sampler.push({
          uptimeMs: stats.uptimeMs,
          sent: stats.sent,
          framesSent: stats.framesSent,
          tickP95: stats.tick.p95,
          clients: stats.clients,
          renders: store.renderStats().renders,
          wireBytesPerSec: store.core.bytesPerSec(performance.now()),
        });
        setServer(stats);
      } catch {
        if (alive) setServer(null);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), pollMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [pollMs, sampler, store]);

  const render = store.renderStats();

  return (
    <details style={{ marginTop: '1rem', border: '1px solid #ddd', padding: '0.75rem 1rem' }} data-testid="panel">
      <summary style={{ cursor: 'pointer' }}>demo panel — /sim/* controls, render switch, counters</summary>

      <div style={{ ...row, marginTop: '0.75rem' }}>
        <span>rate:</span>
        {RATE_PRESETS.map((rate) => (
          <button
            key={rate}
            style={button}
            data-testid={`rate-${rate}`}
            onClick={() => run(post('/sim/rate', { updatesPerSec: rate }))}
          >
            {rate >= 1000 ? `${rate / 1000}k` : rate}
          </button>
        ))}
        <span style={{ marginLeft: '1rem' }}>server batching:</span>
        <button
          style={button}
          data-testid="batch-toggle"
          onClick={() => run(post('/sim/mode', { batch: !(server?.batch ?? true) }))}
        >
          {(server?.batch ?? true) ? 'on → turn off' : 'off → turn on'}
        </button>
      </div>

      <div style={{ ...row, marginTop: '0.5rem' }}>
        <span>render:</span>
        <button
          style={button}
          data-testid="render-mode"
          onClick={() => store.setRenderMode(render.mode === 'coalesced' ? 'naive' : 'coalesced')}
        >
          {render.mode} → switch
        </button>
        <span>
          renders {render.renders}, msg p95 <span data-testid="msg-p95">{render.messageP95.toFixed(2)}</span> ms,
          flush p95 <span data-testid="flush-p95">{render.flushP95.toFixed(2)}</span> ms
        </span>
        <span style={{ marginLeft: '1rem' }}>wire:</span>
        <button
          style={button}
          data-testid="wire-toggle"
          onClick={() => store.setWire(store.wire() === 'fx.v1' ? 'fx.v2' : 'fx.v1')}
        >
          {store.wire() ?? '…'} → {store.wire() === 'fx.v1' ? 'back to v2' : 'force v1'}
        </button>
      </div>

      <div style={{ ...row, marginTop: '0.5rem' }}>
        <span>pair:</span>
        <select value={pair} onChange={(e) => setPair(e.target.value)} style={{ font: 'inherit' }} data-testid="pair">
          {instruments.map((i) => (
            <option key={i.symbol}>{i.symbol}</option>
          ))}
        </select>
        <button style={button} data-testid="news" onClick={() => run(post('/sim/news', { pair, pips: 80, spreadX: 6 }))}>
          news +80 pips ×6
        </button>
        <button style={button} data-testid="freeze" onClick={() => run(post('/sim/freeze', { pair, ms: 10_000 }))}>
          freeze 10 s
        </button>
        <span style={{ marginLeft: '1rem' }}>blotter:</span>
        <button
          style={button}
          data-testid="blotter-burst"
          onClick={() => run(post('/sim/blotter', { rows: 5000 }))}
        >
          burst 5000 orders
        </button>
        <span style={{ marginLeft: '1rem' }}>scenario:</span>
        <button
          style={button}
          data-testid="scenario"
          onClick={() => run(post('/sim/scenario', { name: 'demo-5min' }))}
        >
          demo-5min
        </button>
      </div>

      <div style={{ ...row, marginTop: '0.5rem' }}>
        <span>failures:</span>
        <button style={button} data-testid="gap" onClick={() => run(post('/sim/gap', { skipSeqs: 40 }))}>
          gap 40
        </button>
        <button style={button} onClick={() => run(post('/sim/disconnect', { graceful: true }))}>
          disconnect graceful
        </button>
        <button style={button} onClick={() => run(post('/sim/disconnect', { graceful: false }))}>
          disconnect hard
        </button>
        <span style={{ marginLeft: '1rem' }}>seed:</span>
        <input
          type="number"
          value={seed}
          onChange={(e) => setSeed(Number(e.target.value))}
          style={{ font: 'inherit', width: '6rem' }}
          data-testid="seed-input"
        />
        <button style={button} data-testid="seed" onClick={() => run(post('/sim/seed', { seed }))}>
          reseed
        </button>
      </div>

      <LoadChart samples={sampler.samples()} slots={sampler.capacity} />

      <p style={{ marginBottom: 0 }}>
        last: <code data-testid="last-action">{last}</code>
        <br />
        server:{' '}
        <code data-testid="server-stats">
          {server === null
            ? 'stats unavailable'
            : `rate ${server.updatesPerSec}/s · batch ${server.batch ? 'on' : 'off'} · generated ${server.generated} · sent ${server.sent} · frames ${server.framesSent} · clients ${server.clients} · tick p95 ${server.tick.p95.toFixed(2)} ms`}
        </code>
      </p>
    </details>
  );
}
