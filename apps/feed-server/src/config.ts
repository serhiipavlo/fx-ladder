export interface FeedServerConfig {
  port: number;
  /** Origins allowed on the WS upgrade and echoed as CORS on fetch paths (architecture §7.1, §9.2). */
  allowedOrigins: readonly string[];
  heartbeatIntervalMs: number;
  /** Server tick — one frame per client per tick (architecture §6.1: 5–10 ms). */
  tickMs: number;
  /** Default market seed; /sim/seed replaces it at runtime. */
  seed: number;
  /** Default record rate; modest so the unattended public link stays cheap. /sim/rate raises it. */
  updatesPerSec: number;
  /**
   * Send-queue ceiling per client: past this, the connection closes with 4001
   * — one threshold, one close, recovery is the ordinary reconnect (§7.1,
   * the surviving half of ADR-09). The tick never waits for anyone.
   */
  slowClientBufferBytes: number;
  /** Concurrent WS clients allowed; the (N+1)-th handshake is refused (architecture §8). */
  maxClients: number;
  /**
   * A connection older than this closes with 1000 and a stated reason — an
   * abandoned tab must not hold the public link open forever (architecture §8).
   */
  sessionCeilingMs: number;
}

const DEV_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173';

export function configFromEnv(env: Record<string, string | undefined>): FeedServerConfig {
  return {
    port: Number(env['PORT'] ?? 8080),
    allowedOrigins: (env['FX_ALLOWED_ORIGINS'] ?? DEV_ORIGINS)
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    heartbeatIntervalMs: 1000,
    tickMs: 8,
    seed: 42,
    updatesPerSec: 300,
    slowClientBufferBytes: 1_000_000,
    maxClients: 20,
    sessionCeilingMs: 30 * 60_000,
  };
}
