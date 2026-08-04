// Per-close-code reaction table (architecture §7.1): different endings demand
// different reactions, and without the code the client can only guess. Pure
// decision function — randomness is an argument, so the policy is testable
// without timers or sockets.

export interface ReconnectDecision {
  action: 'stop' | 'retry';
  /** Present when action is retry. */
  delayMs?: number;
  /** Honest, human-readable reason for the status line. */
  label: string;
}

/** Turns an attempt count and a jitter draw into a delay. */
interface BackoffCalculator {
  (attempt: number, random: number): number;
}

/** Judges a close code into a reaction (§7.1). */
interface ReconnectPolicy {
  (code: number, attempt: number, random: number): ReconnectDecision;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;

/**
 * Exponential backoff with full-range jitter: the raw delay doubles per
 * attempt and is scaled by [0.5, 1) so a herd of clients dropped together
 * returns as a smear, not a wave (§7.1).
 */
const backoff: BackoffCalculator = (attempt, random) => {
  const raw = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(raw * (0.5 + 0.5 * random));
};

export const reconnectDecision: ReconnectPolicy = (code, attempt, random) => {
  switch (code) {
    case 1000:
      // The server said goodbye on purpose — coming back would defy it.
      return { action: 'stop', label: 'closed by the server — not reconnecting' };
    case 4002:
      // Our own protocol bug: blind retries would decode the same garbage.
      return { action: 'stop', label: 'protocol error — reload the page' };
    case 4001:
      return {
        action: 'retry',
        delayMs: backoff(attempt, random),
        label: 'falling behind the feed — reconnecting',
      };
    case 4000:
      return { action: 'retry', delayMs: backoff(attempt, random), label: 'server crashed (simulated) — reconnecting' };
    default:
      // 1006 and friends: network weather.
      return { action: 'retry', delayMs: backoff(attempt, random), label: 'connection lost — reconnecting' };
  }
};
