import { latest, niceMax, sparkPath, type LoadSample } from './series';

// Load and its cost on one time axis (v1.2.0). Four small multiples, sixty
// seconds wide: one load line and one cost line per boundary — the server's
// tick, the client's render, the network's bytes. Read left to right they
// answer the project's whole claim in one glance: `rate 50k` lifts the load
// line while the cost lines stay flat; flipping render to naive lifts
// exactly the render line, and the wire toggle exactly the byte line.
//
// Hand-drawn SVG on purpose: a chart that measures frame budgets has no
// business importing a charting library and spending them. Each series is
// one path string from pure math (series.ts) — no canvas, no layout thrash,
// one repaint per poll.

const WIDTH = 190;
const HEIGHT = 42;

export interface LoadChartProps {
  samples: readonly LoadSample[];
  /** Slots the x axis spreads across — the chart fills left to right. */
  slots: number;
}

interface SeriesSpec {
  key: string;
  label: string;
  colour: string;
  /** Axis floor so an idle chart still has a readable scale. */
  floor: number;
  pick: (sample: LoadSample) => number;
  format: (value: number) => string;
}

const SERIES: readonly SeriesSpec[] = [
  {
    key: 'records',
    label: 'load — records/s',
    colour: '#2aa198',
    floor: 1000,
    pick: (s) => s.recordsPerSec,
    format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)),
  },
  {
    key: 'tick',
    label: 'server tick p95',
    colour: '#268bd2',
    floor: 1,
    pick: (s) => s.tickP95,
    format: (v) => `${v.toFixed(2)} ms`,
  },
  {
    key: 'renders',
    label: 'client renders/s',
    colour: '#b58900',
    floor: 60,
    pick: (s) => s.rendersPerSec,
    format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)),
  },
  {
    key: 'wire',
    label: 'wire',
    colour: '#6c71c4',
    floor: 64 * 1024,
    pick: (s) => s.wireBytesPerSec,
    format: (v) => (v >= 1024 * 1024 ? `${(v / (1024 * 1024)).toFixed(2)} MiB/s` : `${(v / 1024).toFixed(0)} KiB/s`),
  },
];

export function LoadChart({ samples, slots }: LoadChartProps): React.JSX.Element {
  return (
    <div
      data-testid="load-chart"
      style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', marginTop: '0.75rem' }}
    >
      {SERIES.map((series) => {
        const values = samples.map(series.pick);
        const max = niceMax(values, series.floor);
        const current = latest(values);
        return (
          <figure key={series.key} style={{ margin: 0 }}>
            <figcaption style={{ color: '#586e75', fontSize: '0.85em' }}>
              {series.label}{' '}
              <strong style={{ color: series.colour }} data-testid={`load-${series.key}`}>
                {series.format(current)}
              </strong>
            </figcaption>
            <svg
              width={WIDTH}
              height={HEIGHT}
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              role="img"
              aria-label={`${series.label}: now ${series.format(current)}, scale to ${series.format(max)}`}
              style={{ border: '1px solid #eee', display: 'block' }}
            >
              <path
                d={sparkPath(values, { width: WIDTH, height: HEIGHT, max, slots })}
                data-testid={`spark-${series.key}`}
                fill="none"
                stroke={series.colour}
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
            </svg>
            <small style={{ color: '#93a1a1' }}>
              0 … <span data-testid={`scale-${series.key}`}>{series.format(max)}</span> · {samples.length}s
            </small>
          </figure>
        );
      })}
    </div>
  );
}
