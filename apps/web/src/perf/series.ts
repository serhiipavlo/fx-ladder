// The load chart's arithmetic, sans-I/O like everything that matters here:
// snapshots in, plottable series out, no DOM and no clock of its own. The
// chart draws BOTH halves of AC-01 on one time axis — what the server was
// asked to do, and what it (and the render) cost — because that is the whole
// claim of this project in one picture: load goes up, cost does not.
//
// Rates are differentiated from the server's own cumulative counters against
// the server's own clock, so a slow poll or a paused tab skews nothing: a
// missed second widens dt and the rate stays honest.

/** One poll's worth of raw truth: server counters plus the client's own meters. */
export interface LoadSnapshot {
  /** Server clock, ms since start — monotonic within one process life. */
  uptimeMs: number;
  /** Cumulative records sent across all clients. */
  sent: number;
  /** Cumulative frames sent across all clients. */
  framesSent: number;
  /** Server tick duration p95, ms. */
  tickP95: number;
  clients: number;
  /**
   * Cumulative render passes the stream caused on this client. Counted, not
   * timed, on purpose: p95 timings split across two instruments depending on
   * the render mode (naive charges the message, coalesced charges the flush),
   * so a single timing series reads 0.00 in exactly the mode where the client
   * suffers most. A count of render passes is the same number in both — and
   * it is the §6.4 contrast itself.
   */
  renders: number;
  /** Wire bytes over the client's trailing second. */
  wireBytesPerSec: number;
}

/** One plotted point: rates derived, costs carried through. */
export interface LoadSample {
  atMs: number;
  recordsPerSec: number;
  framesPerSec: number;
  tickP95: number;
  rendersPerSec: number;
  wireBytesPerSec: number;
  clients: number;
}

export interface LoadSampler {
  /** Folds one poll; the first call only seeds — a rate needs two points. */
  push(snapshot: LoadSnapshot): void;
  /** Oldest first, at most `capacity` long. */
  samples(): readonly LoadSample[];
  /** How many slots the chart spreads its points across. */
  capacity: number;
}

export function createLoadSampler(capacity = 120): LoadSampler {
  const samples: LoadSample[] = [];
  let previous: LoadSnapshot | null = null;

  return {
    capacity,
    samples: () => samples,

    push(snapshot) {
      const last = previous;
      previous = snapshot;
      if (last === null) return;

      const dtMs = snapshot.uptimeMs - last.uptimeMs;
      // A restart resets the server's clock and counters — a new trading day
      // (ADR-10), not a negative rate. Reseed and wait for the next pair.
      if (
        dtMs <= 0 ||
        snapshot.sent < last.sent ||
        snapshot.framesSent < last.framesSent ||
        snapshot.renders < last.renders
      ) {
        return;
      }

      const perSec = (delta: number): number => (delta * 1000) / dtMs;
      samples.push({
        atMs: snapshot.uptimeMs,
        recordsPerSec: perSec(snapshot.sent - last.sent),
        framesPerSec: perSec(snapshot.framesSent - last.framesSent),
        tickP95: snapshot.tickP95,
        rendersPerSec: perSec(snapshot.renders - last.renders),
        wireBytesPerSec: snapshot.wireBytesPerSec,
        clients: snapshot.clients,
      });
      if (samples.length > capacity) samples.splice(0, samples.length - capacity);
    },
  };
}

/**
 * Axis ceiling from the 1-2-5 ladder: the scale must be readable and, more
 * importantly, STILL — a max that re-fits every second turns a chart into a
 * lava lamp and hides the very trend it is drawn to show.
 */
export function niceMax(values: readonly number[], floor = 1): number {
  const peak = values.reduce((max, value) => (value > max ? value : max), 0);
  if (!(peak > 0)) return floor;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * magnitude;
    if (peak <= candidate) return Math.max(candidate, floor);
  }
  return Math.max(10 * magnitude, floor);
}

export interface SparkGeometry {
  width: number;
  height: number;
  /** Value mapped to the top edge; 0 or less means a flat floor, never NaN. */
  max: number;
  /** Slots the x axis is divided into — the chart fills left to right. */
  slots: number;
}

/**
 * An SVG polyline path for one series, newest last. Pure string math: a test
 * can assert the geometry without a browser, and the chart cannot drift from
 * what the numbers say.
 */
export function sparkPath(values: readonly number[], geometry: SparkGeometry): string {
  const { width, height, max, slots } = geometry;
  if (values.length === 0) return '';
  const span = Math.max(1, slots - 1);
  const scale = max > 0 ? height / max : 0;
  const round = (value: number): number => Math.round(value * 10) / 10;

  return values
    .map((value, i) => {
      const x = round((Math.min(i, span) / span) * width);
      const clamped = Math.min(Math.max(value, 0), max);
      const y = round(height - clamped * scale);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
}

/** Current value of a series, or 0 before the first sample. */
export function latest(values: readonly number[]): number {
  return values.length === 0 ? 0 : values[values.length - 1]!;
}
