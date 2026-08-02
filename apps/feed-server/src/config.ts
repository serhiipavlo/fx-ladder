export interface FeedServerConfig {
  port: number;
  /** Origins allowed on the WS upgrade and echoed as CORS on fetch paths (architecture §7.1, §9.2). */
  allowedOrigins: readonly string[];
  heartbeatIntervalMs: number;
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
  };
}
