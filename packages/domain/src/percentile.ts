/**
 * p-th percentile of a sample set (nearest-rank); 0 for an empty set. Shared
 * by the server's tick telemetry and the client's frame instrumentation —
 * both halves of the perf gate speak the same arithmetic.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}
