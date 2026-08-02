import { INSTRUMENTS } from '@fx/domain';
import { decodeFrame, FX_SUBPROTOCOL, type Frame } from '@fx/protocol';
import { BOOK_LEVELS } from '@fx/sim-core';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { FeedServerConfig } from '../src/config';
import { createFeedServer, type FeedServer } from '../src/server';

const ALLOWED_ORIGIN = 'http://localhost:5173';
const SNAPSHOT_RECORDS = INSTRUMENTS.length * 2 * BOOK_LEVELS;

function testConfig(overrides: Partial<FeedServerConfig> = {}): FeedServerConfig {
  return {
    port: 0,
    allowedOrigins: [ALLOWED_ORIGIN],
    heartbeatIntervalMs: 1000,
    tickMs: 10,
    seed: 42,
    updatesPerSec: 2000,
    slowClientBufferBytes: 1_000_000,
    maxClients: 20,
    sessionCeilingMs: 30 * 60_000,
    ...overrides,
  };
}

const servers: FeedServer[] = [];
const sockets: WebSocket[] = [];

async function startServer(overrides: Partial<FeedServerConfig> = {}): Promise<{ server: FeedServer; port: number }> {
  const server = createFeedServer(testConfig(overrides));
  servers.push(server);
  const port = await server.listen();
  return { server, port };
}

type Handshake = { outcome: 'open'; ws: WebSocket } | { outcome: 'refused'; status: number | undefined };

function handshake(url: string, protocols: string[], headers: Record<string, string> = {}): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, { headers });
    sockets.push(ws);
    ws.on('open', () => resolve({ outcome: 'open', ws }));
    ws.on('unexpected-response', (_req, res) => {
      resolve({ outcome: 'refused', status: res.statusCode });
      ws.terminate();
    });
    ws.on('error', reject);
  });
}

/**
 * Opens /feed and starts collecting frames *before* the open event resolves —
 * the snapshot arrives immediately after the 101, so a listener attached any
 * later can lose it. Frames decode through the real codec, which also runs
 * its density checks on every one of them.
 */
function openFeed(port: number): Promise<{ ws: WebSocket; frames: Frame[] }> {
  const frames: Frame[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/feed`, [FX_SUBPROTOCOL], {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  sockets.push(ws);
  ws.on('message', (data) => {
    const frame = decodeFrame(String(data));
    if (frame !== null) frames.push(frame);
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', reject);
  });
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('hot plane (done-when of T-0.1.5)', () => {
  it('sends a full snapshot first, then deltas with seq dense across frames', { timeout: 10_000 }, async () => {
    const { port } = await startServer();
    const { frames } = await openFeed(port);
    await settle(600);

    const first = frames[0]!;
    expect(first.frameType).toBe('SNAPSHOT');
    expect(first.firstSeq).toBe(0);
    expect(first.count).toBe(SNAPSHOT_RECORDS);

    const deltas = frames.slice(1).filter((f) => f.frameType === 'DELTA');
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    let expected = SNAPSHOT_RECORDS;
    for (const delta of deltas) {
      expect(delta.firstSeq).toBe(expected);
      expected += delta.count;
    }
  });

  it('a heartbeat arrives during an idle second and carries the last assigned seq', { timeout: 10_000 }, async () => {
    // rate 1 → roughly one delta per second; a 300 ms heartbeat interval fits
    // several heartbeats into each silent stretch between deltas.
    const { port } = await startServer({ updatesPerSec: 1, heartbeatIntervalMs: 300 });
    const { frames } = await openFeed(port);
    await settle(2500);

    const heartbeats = frames.filter((f) => f.frameType === 'HEARTBEAT');
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    for (const hb of heartbeats) {
      expect(hb.count).toBe(0);
      expect(hb.records).toEqual([]);
      expect(hb.firstSeq).toBeGreaterThanOrEqual(SNAPSHOT_RECORDS - 1);
    }
  });

  it('two clients each get their own dense stream', { timeout: 10_000 }, async () => {
    const { port } = await startServer();
    const { frames: framesA } = await openFeed(port);
    await settle(200);
    const { frames: framesB } = await openFeed(port); // connects mid-stream, gets its own basis
    await settle(500);

    expect(framesB[0]!.frameType).toBe('SNAPSHOT');
    expect(framesB[0]!.firstSeq).toBe(0);
    // Density on each wire independently (decodeFrame already checked
    // intra-frame density; here we check across frames).
    for (const frames of [framesA, framesB]) {
      const data = frames.filter((f) => f.frameType !== 'HEARTBEAT');
      for (let i = 1; i < data.length; i += 1) {
        expect(data[i]!.firstSeq).toBe(data[i - 1]!.firstSeq + data[i - 1]!.count);
      }
    }
  });

  it('an inbound client message is a protocol error: close 4002', { timeout: 10_000 }, async () => {
    const { port } = await startServer();
    const { ws } = await openFeed(port);
    const closeCode = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    ws.send('hello?');
    expect(await closeCode).toBe(4002);
  });

  it(
    'a stalled consumer is closed with 4001 while the second client streams on — the tick never blocks',
    { timeout: 20_000 },
    async () => {
      // The kernel absorbs megabytes on loopback before the ws queue grows
      // (especially on Linux), so the pressure window must outrun any socket
      // buffering: ~4.5 MB/s for 3.5 s ≫ worst-case kernel buffers + ceiling.
      const { port } = await startServer({ updatesPerSec: 50_000, slowClientBufferBytes: 64 * 1024 });
      const { ws: stalled } = await openFeed(port);
      const { frames: healthyFrames } = await openFeed(port);

      // Stop reading from the socket: the kernel window fills, then the ws
      // send queue grows past the ceiling.
      (stalled as unknown as { _socket: { pause(): void; resume(): void } })._socket.pause();
      const closeCode = new Promise<number>((resolve) => stalled.on('close', resolve));

      await settle(3500);
      const healthyDuringStall = healthyFrames.length;
      expect(healthyDuringStall).toBeGreaterThan(50); // the tick kept publishing throughout

      // Resume reading so the buffered frames and the CLOSE(4001) drain.
      (stalled as unknown as { _socket: { pause(): void; resume(): void } })._socket.resume();
      expect(await closeCode).toBe(4001);

      // The healthy wire never blinked: still dense (codec-checked) and growing.
      await settle(300);
      expect(healthyFrames.length).toBeGreaterThan(healthyDuringStall);
      const data = healthyFrames.filter((f) => f.frameType !== 'HEARTBEAT');
      for (let i = 1; i < data.length; i += 1) {
        expect(data[i]!.firstSeq).toBe(data[i - 1]!.firstSeq + data[i - 1]!.count);
      }
    },
  );

  it('the (N+1)-th client is refused with the reason stated, and a freed slot reopens', async () => {
    const { port } = await startServer({ maxClients: 2 });
    const { ws: first } = await openFeed(port);
    await openFeed(port);

    const refused = await handshake(`ws://127.0.0.1:${port}/feed`, [FX_SUBPROTOCOL], { Origin: ALLOWED_ORIGIN });
    expect(refused).toEqual({ outcome: 'refused', status: 503 });

    // The cap counts live connections: closing one lets the next one in.
    const freed = new Promise<void>((resolve) => first.on('close', () => resolve()));
    first.close();
    await freed;
    await settle(50);
    const retry = await handshake(`ws://127.0.0.1:${port}/feed`, [FX_SUBPROTOCOL], { Origin: ALLOWED_ORIGIN });
    expect(retry.outcome).toBe('open');
  });

  it('a connection past the session ceiling closes with 1000 and the continue reason', { timeout: 10_000 }, async () => {
    const { port } = await startServer({ sessionCeilingMs: 700 });
    const { ws } = await openFeed(port);
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })),
    );
    const result = await closed;
    expect(result.code).toBe(1000);
    expect(result.reason).toContain('session ceiling');
    expect(result.reason).toContain('Reconnect');
  });

  it('graceful shutdown closes a streaming client with 1000', async () => {
    const { server, port } = await startServer();
    const { ws } = await openFeed(port);
    const closeCode = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await server.close();
    expect(await closeCode).toBe(1000);
  });
});

describe('/feed handshake guards', () => {
  it('a client offering fx.v0 is rejected at the handshake', async () => {
    const { port } = await startServer();
    const result = await handshake(`ws://127.0.0.1:${port}/feed`, ['fx.v0']);
    expect(result).toEqual({ outcome: 'refused', status: 400 });
  });

  it('a client with a disallowed Origin is refused before upgrade', async () => {
    const { port } = await startServer();
    const result = await handshake(`ws://127.0.0.1:${port}/feed`, [FX_SUBPROTOCOL], {
      Origin: 'https://evil.example',
    });
    expect(result).toEqual({ outcome: 'refused', status: 403 });
  });

  it('an unknown upgrade path is refused', async () => {
    const { port } = await startServer();
    const result = await handshake(`ws://127.0.0.1:${port}/nope`, [FX_SUBPROTOCOL]);
    expect(result).toEqual({ outcome: 'refused', status: 404 });
  });
});

describe('GET /healthz', () => {
  it('returns ok JSON and echoes an allowed Origin for CORS', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { Origin: ALLOWED_ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    const body = (await res.json()) as { ok: boolean; uptimeMs: number };
    expect(body.ok).toBe(true);
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it('grants no CORS to a foreign Origin', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('unknown paths return 404', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/whatever`);
    expect(res.status).toBe(404);
  });
});
