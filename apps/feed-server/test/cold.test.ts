import { INSTRUMENTS } from '@fx/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { etagOf } from '../src/cold';
import type { FeedServerConfig } from '../src/config';
import { createFeedServer, type FeedServer } from '../src/server';

function testConfig(): FeedServerConfig {
  return {
    port: 0,
    allowedOrigins: ['http://localhost:5173'],
    heartbeatIntervalMs: 1000,
    tickMs: 10,
    seed: 42,
    updatesPerSec: 100,
    slowClientBufferBytes: 1_000_000,
    maxClients: 20,
    sessionCeilingMs: 30 * 60_000,
  };
}

const servers: FeedServer[] = [];

async function startServer(): Promise<number> {
  const server = createFeedServer(testConfig());
  servers.push(server);
  return server.listen();
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('cold plane (done-when of T-0.3.4)', () => {
  it('serves the catalogue verbatim with the caching contract', async () => {
    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/instruments`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('etag')).toBe(etagOf(INSTRUMENTS));
    expect(await res.json()).toEqual(INSTRUMENTS);
  });

  it('a second request with the ETag returns 304 with an empty body', async () => {
    const port = await startServer();
    const first = await fetch(`http://127.0.0.1:${port}/api/instruments`);
    const etag = first.headers.get('etag')!;

    const second = await fetch(`http://127.0.0.1:${port}/api/instruments`, {
      headers: { 'If-None-Match': etag },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    // The 304 still refreshes the client's freshness window.
    expect(second.headers.get('etag')).toBe(etag);
    expect(second.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('a stale or foreign ETag gets the full body again', async () => {
    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/instruments`, {
      headers: { 'If-None-Match': '"something-else"' },
    });
    expect(res.status).toBe(200);
  });

  it('changing the catalogue changes the ETag', () => {
    const tag = etagOf(INSTRUMENTS);
    const grown = [...INSTRUMENTS, { ...INSTRUMENTS[0]!, symbol: 'XAUUSD' }];
    const reordered = [...INSTRUMENTS].reverse();
    expect(etagOf(grown)).not.toBe(tag);
    expect(etagOf(reordered)).not.toBe(tag);
    expect(etagOf(JSON.parse(JSON.stringify(INSTRUMENTS)))).toBe(tag); // stable across serialization
  });
});
