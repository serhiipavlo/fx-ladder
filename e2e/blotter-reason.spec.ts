import { expect, test } from '@playwright/test';

const FEED = 'http://127.0.0.1:8123';

// Reported from the deployed page: rows read "CANCELED" with an empty reason
// column, and nothing on screen said why. In FIX a cancel carries no reject
// reason — rejections and cancels are different events (§5.6) — so the
// explanation has to come from the order's time in force: an IOC took what
// the market had and withdrew the rest (§5.5). This pins that a reader can
// see it without knowing any of that.
test('a CANCELED row explains itself: IOC, how much filled, how much withdrawn', async ({ page, request }) => {
  expect((await request.post(`${FEED}/sim/seed`, { data: { seed: 42 } })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('feed-status')).toHaveText('live');

  // A burst is a mix of DAY and IOC, so it produces both endings.
  expect((await request.post(`${FEED}/sim/blotter`, { data: { rows: 400 } })).ok()).toBeTruthy();
  const cancelled = page.locator('.ag-row').filter({ has: page.locator('[col-id="status"]', { hasText: 'CANCELED' }) });
  await expect(cancelled.first()).toBeVisible({ timeout: 30_000 });

  const row = cancelled.first();
  // The tif column names the cause…
  await expect(row.locator('[col-id="tif"]')).toHaveText('IOC');
  // …and the reason column spells out the arithmetic the row already shows.
  const reason = await row.locator('[col-id="rejectReason"]').textContent();
  expect(reason).toMatch(/^IOC: \d+K of \d+K, rest withdrawn$/);

  // The numbers in that sentence are the row's own, not decoration.
  const cum = (await row.locator('[col-id="cumQty"]').textContent())!.trim();
  const qty = (await row.locator('[col-id="orderQtyK"]').textContent())!.trim();
  expect(reason).toBe(`IOC: ${cum}K of ${qty}, rest withdrawn`);

  // A finished DAY order stays quiet — the column explains, it does not chatter.
  const filled = page.locator('.ag-row').filter({ has: page.locator('[col-id="status"]', { hasText: 'FILLED' }) });
  await expect(filled.first()).toBeVisible({ timeout: 30_000 });
  await expect(filled.first().locator('[col-id="rejectReason"]')).toHaveText('');
});
