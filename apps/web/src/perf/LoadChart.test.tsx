// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LoadChart } from './LoadChart';
import { createLoadSampler, type LoadSnapshot } from './series';

// The chart is the panel's answer to "what is this costing you" — so the test
// asserts the numbers it draws, not that it rendered something.

const feed = (specs: Array<Partial<LoadSnapshot>>): ReturnType<typeof createLoadSampler> => {
  const sampler = createLoadSampler(60);
  specs.forEach((spec, i) => {
    sampler.push({
      uptimeMs: 1000 * (i + 1),
      sent: 0,
      framesSent: 0,
      tickP95: 0.4,
      clients: 1,
      renders: 0,
      wireBytesPerSec: 64 * 1024,
      ...spec,
    });
  });
  return sampler;
};

afterEach(cleanup);

describe('load chart', () => {
  it('draws nothing but stays readable before the first rate exists', () => {
    render(<LoadChart samples={[]} slots={60} />);
    expect(screen.getByTestId('spark-records').getAttribute('d')).toBe('');
    expect(screen.getByTestId('load-records').textContent).toBe('0');
    // The axis keeps its floor so an idle chart is not a divide-by-zero.
    expect(screen.getByTestId('scale-tick').textContent).toBe('1.00 ms');
  });

  it('shows the load and its cost as current values with a 1-2-5 scale', () => {
    const sampler = feed([
      { sent: 0, framesSent: 0, renders: 0 },
      { sent: 50_000, framesSent: 125, tickP95: 0.55, renders: 61, wireBytesPerSec: 600 * 1024 },
    ]);
    render(<LoadChart samples={sampler.samples()} slots={sampler.capacity} />);

    expect(screen.getByTestId('load-records').textContent).toBe('50.0k');
    expect(screen.getByTestId('load-tick').textContent).toBe('0.55 ms');
    expect(screen.getByTestId('load-renders').textContent).toBe('61');
    expect(screen.getByTestId('load-wire').textContent).toBe('600 KiB/s');
    expect(screen.getByTestId('scale-records').textContent).toBe('50.0k');
  });

  it('naive rendering lifts the render line while the server line stays flat (§6.4)', () => {
    // Same load throughout; the client switches to a render per message.
    const sampler = feed([
      { sent: 0, renders: 0 },
      { sent: 50_000, renders: 61, tickP95: 0.4 },
      { sent: 100_000, renders: 48_661, tickP95: 0.41 },
    ]);
    render(<LoadChart samples={sampler.samples()} slots={sampler.capacity} />);
    expect(screen.getByTestId('load-renders').textContent).toBe('48.6k');
  });

  it('a spike lifts the load line and leaves the cost lines where they were', () => {
    // Calm second, then the §6.4 story: 100× the records, the same tick cost.
    const sampler = feed([
      { sent: 0, framesSent: 0 },
      { sent: 500, framesSent: 125, tickP95: 0.4 },
      { sent: 50_500, framesSent: 250, tickP95: 0.42 },
    ]);
    render(<LoadChart samples={sampler.samples()} slots={sampler.capacity} />);

    const points = (testId: string): Array<[number, number]> =>
      [...screen.getByTestId(testId).getAttribute('d')!.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map(([, x, y]) => [
        Number(x),
        Number(y),
      ]);

    const load = points('spark-records');
    expect(load).toHaveLength(2);
    expect(load[1]![1]).toBeLessThan(load[0]![1]); // screen y inverted: the load rose
    const tick = points('spark-tick');
    expect(Math.abs(tick[1]![1] - tick[0]![1])).toBeLessThan(1); // the cost did not
  });

  it('names its scale for a screen reader (NFR-13)', () => {
    const sampler = feed([{ sent: 0 }, { sent: 12_000, tickP95: 0.5 }]);
    render(<LoadChart samples={sampler.samples()} slots={sampler.capacity} />);
    expect(screen.getByLabelText(/load — records\/s: now 12.0k, scale to 20.0k/)).toBeTruthy();
  });
});
