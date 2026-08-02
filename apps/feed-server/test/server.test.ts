import { FX_SUBPROTOCOL } from '@fx/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { FeedServerConfig } from '../src/config';
import { createFeedServer, type FeedServer } from '../src/server';

const ALLOWED_ORIGIN = 'http://localhost:5173';

function testConfig(overrides: Partial<FeedServerConfig> = {}): FeedServerConfig {
  return { port: 0, allowedOrigins: [ALLOWED_ORIGIN], heartbeatIntervalMs: 1000, ...overrides };
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

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('/feed handshake', () => {
  it('a fx.v1 client receives at least 3 heartbeats in 3.5 s', { timeout: 8000 }, async () => {
    const { port } = await startServer();
    const frames: Array<Record<string, unknown>> = [];

    const result = await handshake(`ws://127.0.0.1:${port}/feed`, [FX_SUBPROTOCOL], { Origin: ALLOWED_ORIGIN });
    if (result.outcome !== 'open') throw new Error(`handshake refused: ${String(result.status)}`);
    expect(result.ws.protocol).toBe(FX_SUBPROTOCOL);
    result.ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));

    await new Promise((resolve) => setTimeout(resolve, 3500));
    const heartbeats = frames.filter((frame) => frame['frameType'] === 'HEARTBEAT');
    expect(heartbeats.length).toBeGreaterThanOrEqual(3);
    // Header shape per architecture §6.1 — no records, last assigned seq.
    expect(heartbeats[0]).toMatchObject({ count: 0, firstSeq: 0 });
    expect(typeof heartbeats[0]?.['serverTs']).toBe('number');
  });

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

  it('graceful shutdown closes the client with 1000', async () => {
    const { server, port } = await startServer();
    const result = await handshake(`ws://127.0.0.1:${port}/feed`, [FX_SUBPROTOCOL]);
    if (result.outcome !== 'open') throw new Error('handshake unexpectedly refused');

    const closeCode = new Promise<number>((resolve) => result.ws.on('close', (code) => resolve(code)));
    await server.close();
    expect(await closeCode).toBe(1000);
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
