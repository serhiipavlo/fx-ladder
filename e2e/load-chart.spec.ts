import { expect, test } from '@playwright/test';

const FEED = 'http://127.0.0.1:8123';

/** The chart writes `294` under a thousand and `49.9k` above it. */
function parseCompact(text: string): number {
  return text.endsWith('k') ? Number(text.slice(0, -1)) * 1000 : Number(text);
}

// The load chart (v1.2.0) drawing the claim it exists for: the load line
// follows /sim/rate while the server's cost line does not. A chart that only
// rendered would prove nothing — this asserts the numbers it puts on screen.
test('the chart follows the load and leaves the server cost flat', async ({ page, request }) => {
  expect((await request.post(`${FEED}/sim/seed`, { data: { seed: 42 } })).ok()).toBeTruthy();
  expect((await request.post(`${FEED}/sim/rate`, { data: { updatesPerSec: 300 } })).ok()).toBeTruthy();

  const errors: Error[] = [];
  page.on('pageerror', (err) => errors.push(err));

  await page.goto('/');
  await expect(page.getByTestId('feed-status')).toHaveText('live');
  await page.getByTestId('panel').locator('summary').click();
  await expect(page.getByTestId('load-chart')).toBeVisible();

  // The first poll only seeds the sampler — a rate needs two points.
  await expect
    .poll(async () => page.getByTestId('spark-records').getAttribute('d'), { timeout: 15_000 })
    .not.toBe('');

  const calmRecords = parseCompact((await page.getByTestId('load-records').textContent())!);
  const calmTick = Number((await page.getByTestId('load-tick').textContent())!.replace(' ms', ''));
  expect(calmRecords).toBeLessThan(5000); // the calm rate, drawn honestly

  // Now the demo's own gesture: 50k. Wait for a second that was fully loaded
  // — the one spanning the rate change is a genuine average, not a spike.
  expect((await request.post(`${FEED}/sim/rate`, { data: { updatesPerSec: 50_000 } })).ok()).toBeTruthy();
  await expect
    .poll(async () => parseCompact((await page.getByTestId('load-records').textContent())!), { timeout: 25_000 })
    .toBeGreaterThan(20_000);

  const loaded = parseCompact((await page.getByTestId('load-records').textContent())!);
  expect(loaded).toBeGreaterThan(calmRecords * 10); // the load line moved, and moved far
  // …while the server's own cost stayed inside its millisecond budget.
  const loadedTick = Number((await page.getByTestId('load-tick').textContent())!.replace(' ms', ''));
  expect(loadedTick).toBeLessThan(4);
  expect(loadedTick).toBeLessThan(calmTick + 2);

  // The path is real geometry, not a decoration: points inside the viewBox.
  const path = (await page.getByTestId('spark-records').getAttribute('d'))!;
  const points = [...path.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map(([, x, y]) => [Number(x), Number(y)]);
  expect(points.length).toBeGreaterThan(1);
  for (const [x, y] of points) {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(190);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(42);
  }
  // Newest point sits higher on screen than the calm start: the spike is drawn.
  expect(points[points.length - 1]![1]).toBeLessThan(points[0]![1]);

  expect((await request.post(`${FEED}/sim/rate`, { data: { updatesPerSec: 300 } })).ok()).toBeTruthy();
  expect(errors).toEqual([]);
});
