import { execFileSync, spawn, type ChildProcess } from 'node:child_process';

import { decodeFrame, FX_SUBPROTOCOL } from '@fx/protocol';

import { reconnectDecision } from '../../apps/web/src/stream/reconnect';

// Chaos drill (T-1.0.1): kill the server MID-STREAM — a real SIGKILL of a
// real process, no graceful close frames — and watch real clients come back
// through the production reconnect policy. The §7.1 claims this measures:
//   · an abrupt death surfaces as an abnormal close (1006), never 1000;
//   · clients return with exponential backoff and FULL-RANGE jitter — a
//     herd dropped together reconnects as a smear, not a wave;
//   · every reconnected wire opens with a SNAPSHOT and stays seq-dense —
//     recovery is resnapshot, not repair (ADR-08);
//   · nobody needs a human: the drill is one command, asserts its own
//     outcomes, and prints the timings CHAOS.md records.
//
// Local mode (default): spawns the server, kills it, respawns it — the
// container-kill rehearsal. Watch mode (--watch wss://host/feed): connects
// and waits for someone ELSE to replace the container (a Render redeploy),
// recording the same story over the real network.

const PORT = 8098;
const CLIENTS = 5;
const STREAM_BEFORE_KILL_MS = 3000;
const RESPAWN_AFTER_MS = 2500;
const STABLE_AFTER_RECONNECT_MS = 2000;

interface Attempt {
  attempt: number;
  delayMs: number;
  label: string;
}

interface ClientReport {
  id: number;
  closeCode: number | null;
  closedAtMs: number | null;
  attempts: Attempt[];
  reconnectedAtMs: number | null;
  firstFrameAfter: string | null;
  seqDense: boolean;
  framesBefore: number;
  framesAfter: number;
}

const now = (): number => performance.now();

class DrillClient {
  readonly report: ClientReport;
  private ws: WebSocket | null = null;
  private nextSeq: number | null = null;
  private phase: 'before' | 'down' | 'after' = 'before';
  private readonly url: string;
  private readonly t0: number;

  constructor(id: number, url: string, t0: number) {
    this.url = url;
    this.t0 = t0;
    this.report = {
      id,
      closeCode: null,
      closedAtMs: null,
      attempts: [],
      reconnectedAtMs: null,
      firstFrameAfter: null,
      seqDense: true,
      framesBefore: 0,
      framesAfter: 0,
    };
  }

  connect(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.url, FX_SUBPROTOCOL);
      this.ws = ws;
      this.nextSeq = null; // a fresh wire numbers from scratch (§6.2)
      ws.onopen = () => {
        if (this.phase === 'down') {
          this.phase = 'after';
          this.report.reconnectedAtMs = now() - this.t0;
        }
        resolve();
      };
      ws.onmessage = (event: MessageEvent) => {
        const frame = decodeFrame(String(event.data));
        if (frame === null) return;
        if (this.phase === 'after' && this.report.firstFrameAfter === null) {
          this.report.firstFrameAfter = frame.frameType;
        }
        if (frame.frameType !== 'HEARTBEAT') {
          // Density within a connection: any hole would be transport loss.
          if (this.nextSeq !== null && frame.firstSeq !== this.nextSeq) this.report.seqDense = false;
          this.nextSeq = frame.firstSeq + frame.count;
        }
        if (this.phase === 'after') this.report.framesAfter += 1;
        else this.report.framesBefore += 1;
      };
      ws.onclose = (event: CloseEvent) => {
        if (this.phase === 'before') {
          this.phase = 'down';
          this.report.closeCode = event.code;
          this.report.closedAtMs = now() - this.t0;
        }
        if (this.phase !== 'after') this.retry(event.code);
      };
      ws.onerror = () => undefined; // the close handler owns the story
    });
  }

  /** The production policy, verbatim: backoff + full-range jitter (§7.1). */
  private retry(code: number): void {
    const attempt = this.report.attempts.length;
    const decision = reconnectDecision(code, attempt, Math.random());
    if (decision.action !== 'retry') {
      throw new Error(`client ${this.report.id}: policy said stop on code ${code} — a kill must read as retryable`);
    }
    this.report.attempts.push({ attempt, delayMs: decision.delayMs!, label: decision.label });
    setTimeout(() => void this.connect(), decision.delayMs);
  }

  close(): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000);
  }
}

function spawnServer(): ChildProcess {
  const child = spawn(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'apps/feed-server/src/index.ts'],
    { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' },
  );
  return child;
}

/** SIGKILL the whole tree — no close frames, no goodbyes: a real death. */
function killServer(child: ChildProcess): void {
  if (child.pid === undefined) throw new Error('server pid unknown');
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

async function waitHealthy(base: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch {
      // still booting
    }
    if (Date.now() > deadline) throw new Error('server never became healthy');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function localDrill(): Promise<ClientReport[]> {
  console.log(`chaos drill: ${CLIENTS} clients, SIGKILL mid-stream, respawn after ${RESPAWN_AFTER_MS} ms\n`);
  let server = spawnServer();
  await waitHealthy(`http://127.0.0.1:${PORT}`, 20_000);

  const t0 = now();
  const clients = Array.from({ length: CLIENTS }, (_, i) => new DrillClient(i + 1, `ws://127.0.0.1:${PORT}/feed`, t0));
  await Promise.all(clients.map((c) => c.connect()));
  await sleep(STREAM_BEFORE_KILL_MS);

  const tKill = now() - t0;
  killServer(server);
  console.log(`killed at t=${tKill.toFixed(0)} ms (SIGKILL, no close frames)`);

  await sleep(RESPAWN_AFTER_MS);
  server = spawnServer();
  await waitHealthy(`http://127.0.0.1:${PORT}`, 20_000);
  console.log(`respawned; healthy at t=${(now() - t0).toFixed(0)} ms\n`);

  const allBack = (): boolean => clients.every((c) => c.report.reconnectedAtMs !== null);
  const deadline = Date.now() + 30_000;
  while (!allBack()) {
    if (Date.now() > deadline) break;
    await sleep(50);
  }
  await sleep(STABLE_AFTER_RECONNECT_MS);

  for (const client of clients) client.close();
  killServer(server);
  return clients.map((c) => c.report);
}

async function watchDrill(url: string): Promise<ClientReport[]> {
  console.log(`chaos drill (watch): 1 client on ${url}, waiting for the container to be replaced…\n`);
  const t0 = now();
  const client = new DrillClient(1, url, t0);
  await client.connect();
  console.log('connected — replace the container now (e.g. dispatch the rollback workflow)');

  const deadline = Date.now() + 15 * 60_000;
  while (client.report.reconnectedAtMs === null) {
    if (Date.now() > deadline) throw new Error('no container replacement observed within 15 min');
    await sleep(200);
  }
  await sleep(STABLE_AFTER_RECONNECT_MS);
  client.close();
  return [client.report];
}

function verdict(reports: ClientReport[]): boolean {
  let ok = true;
  for (const r of reports) {
    const attempts = r.attempts.map((a) => `#${a.attempt}+${a.delayMs}ms`).join(' ');
    const downMs = r.reconnectedAtMs !== null && r.closedAtMs !== null ? r.reconnectedAtMs - r.closedAtMs : null;
    console.log(
      `client ${r.id}: close ${r.closeCode} at ${r.closedAtMs?.toFixed(0)} ms · ` +
        `retries [${attempts}] · back at ${r.reconnectedAtMs?.toFixed(0)} ms (down ${downMs?.toFixed(0)} ms) · ` +
        `first frame ${r.firstFrameAfter} · seq dense ${r.seqDense} · frames ${r.framesBefore}→${r.framesAfter}`,
    );
    ok &&=
      r.closeCode !== 1000 && // an abrupt death must not impersonate a goodbye
      r.reconnectedAtMs !== null &&
      r.firstFrameAfter === 'SNAPSHOT' && // recovery is resnapshot (ADR-08)
      r.seqDense &&
      r.framesAfter > 0;
  }
  if (reports.length > 1) {
    const times = reports.map((r) => r.reconnectedAtMs!).sort((a, b) => a - b);
    const spread = times[times.length - 1]! - times[0]!;
    console.log(`\nreconnect smear across ${reports.length} clients: ${spread.toFixed(0)} ms (jitter working: > 0)`);
    ok &&= spread > 0;
  }
  return ok;
}

async function main(): Promise<void> {
  const watchIndex = process.argv.indexOf('--watch');
  const reports = watchIndex >= 0 ? await watchDrill(process.argv[watchIndex + 1]!) : await localDrill();
  const ok = verdict(reports);
  console.log(ok ? '\ndrill green: nobody needed a human' : '\ndrill RED — see the table');
  process.exit(ok ? 0 : 1);
}

void main();
