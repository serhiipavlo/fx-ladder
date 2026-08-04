import { healthzUrl } from './backend';

// Waking the free instance (ADR-11 revision): knock on /healthz until it
// answers or the deadline passes. The stream's own retry then reconnects on
// its next attempt — this loop never touches the socket, it only proves the
// container is up. Clock, sleep and fetch are arguments so the policy is
// testable without timers.

export const WAKE_DEADLINE_MS = 90_000;
export const WAKE_RETRY_MS = 3_000;

/** The server answered; `body` is whatever /healthz reported. */
export interface WakeSuccess {
  ok: true;
  body: unknown;
}

/** The deadline passed with no answer. */
export interface WakeFailure {
  ok: false;
  error: string;
}

export type WakeOutcome = WakeSuccess | WakeFailure;

export interface WakeOptions {
  deadlineMs?: number;
  retryMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Knocks on /healthz until the container answers or the deadline passes. */
interface ServerWaker {
  (options?: WakeOptions): Promise<WakeOutcome>;
}

export const wakeServer: ServerWaker = async (options = {}) => {
  const deadlineMs = options.deadlineMs ?? WAKE_DEADLINE_MS;
  const retryMs = options.retryMs ?? WAKE_RETRY_MS;
  const doFetch = options.fetchFn ?? ((input: RequestInfo | URL) => fetch(input));
  const now = options.now ?? ((): number => Date.now());
  const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  const deadline = now() + deadlineMs;
  while (now() < deadline) {
    try {
      const res = await doFetch(healthzUrl());
      if (res.ok) return { ok: true, body: await res.json() };
    } catch {
      // still cold — keep knocking
    }
    await sleep(retryMs);
  }
  return { ok: false, error: `server did not wake within ${deadlineMs / 1000} s` };
};
