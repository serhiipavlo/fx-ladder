import { expect, test } from '@playwright/test';

const FEED = 'http://127.0.0.1:8123';

// The T-0.4.6 done-when as a spec: the 5000-row burst renders with sorting
// and scroll position preserved, and the hot plane keeps its frame budget
// during the burst (AC-10, AC-11). The budget is the §6.4 number: a coalesced
// flush must fit a 60 Hz frame.
test('5000-row burst: sort and scroll survive the stream, the hot plane keeps its frame budget', async ({
  page,
  request,
}) => {
  expect((await request.post(`${FEED}/sim/seed`, { data: { seed: 42 } })).ok()).toBeTruthy();

  await page.goto('/');
  await expect(page.getByTestId('feed-status')).toHaveText('live');

  // First wave fills the grid so there is something to sort and scroll.
  expect((await request.post(`${FEED}/sim/blotter`, { data: { rows: 4500 } })).ok()).toBeTruthy();
  await expect(page.getByTestId('blotter-count')).toHaveText('4500', { timeout: 20_000 });

  // The user sorts by pair and scrolls into the middle of the book.
  const pairHeader = page.locator('.ag-header-cell[col-id="pair"]');
  await pairHeader.click();
  await expect(pairHeader).toHaveAttribute('aria-sort', 'ascending');
  const viewport = page.locator('.ag-grid-viewport');
  await viewport.evaluate((el) => (el.scrollTop = 2000));
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(2000);

  // Second wave streams in on top of the sorted, scrolled grid — updates keep
  // arriving for the first wave's orders too, so this IS "during a stream".
  expect((await request.post(`${FEED}/sim/blotter`, { data: { rows: 500 } })).ok()).toBeTruthy();
  await expect(page.getByTestId('blotter-count')).toHaveText('5000', { timeout: 20_000 });

  // AC-10: the user's sort model and scroll offset survived the stream.
  await expect(pairHeader).toHaveAttribute('aria-sort', 'ascending');
  expect(await viewport.evaluate((el) => el.scrollTop)).toBe(2000);

  // AC-11: the grid stays interactive with 5000 rows — flip the sort.
  await pairHeader.click();
  await expect(pairHeader).toHaveAttribute('aria-sort', 'descending');

  // The hot plane kept its frame budget during the burst: flush p95 in the
  // HUD is the client half of the perf-gate thresholds.
  await page.getByTestId('panel').locator('summary').click();
  const flushP95 = Number(await page.getByTestId('flush-p95').textContent());
  expect(flushP95).toBeGreaterThan(0);
  expect(flushP95).toBeLessThan(16.7);

  // And the ladder is still ticking — the burst starved nobody.
  const row = page.getByTestId('row-EURUSD');
  const before = await row.textContent();
  await expect(async () => {
    expect(await row.textContent()).not.toBe(before);
  }).toPass({ timeout: 5000 });
});
