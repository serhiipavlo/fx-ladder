import { expect, test, type Locator, type Page } from '@playwright/test';

const FEED = 'http://127.0.0.1:8123';

// The done-when of T-1.3.1 against the real server: the depth the wire has
// always carried is on screen (FR-05), the cumulative column reads as the
// cost of walking it (FR-06), and a clicked level loads a ticket that
// actually submits (FR-07).
//
// Determinism comes from the control plane, as everywhere else here: a frozen
// pair stops moving on the wire while the channel stays alive (§8, AC-06), so
// the numbers read off the screen are the numbers the click carries.

const numberIn = async (locator: Locator): Promise<number> =>
  Number((await locator.textContent())!.replace(/[^\d.-]/g, ''));

/** Waits for a pair to stop moving after /sim/freeze took hold. */
const settle = async (page: Page, probe: Locator): Promise<void> => {
  await expect(async () => {
    const first = await probe.textContent();
    await page.waitForTimeout(250);
    expect(await probe.textContent()).toBe(first);
  }).toPass({ timeout: 10_000 });
};

test('every level is drawn, and the walk reads as a cost (FR-05, FR-06)', async ({ page, request }) => {
  expect((await request.post(`${FEED}/sim/seed`, { data: { seed: 42 } })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('feed-status')).toHaveText('live');

  // The page opens on the first pair of the catalogue.
  await expect(page.getByTestId('depth-pair')).toHaveText('EURUSD');
  expect((await request.post(`${FEED}/sim/freeze`, { data: { pair: 'EURUSD', ms: 20_000 } })).ok()).toBeTruthy();
  await settle(page, page.getByTestId('depth-ask-0-cum'));

  // Four levels a side is what the model streams (§5.4) — and until now the
  // render read only the first of them.
  await expect(page.getByTestId('depth-bid-3')).toBeVisible();
  await expect(page.getByTestId('depth-ask-3')).toBeVisible();

  // Volume accumulates going deeper, and walking an offer book deeper costs
  // more: the average leaves the best price and never returns to it.
  const cums: number[] = [];
  const avgs: number[] = [];
  for (let level = 0; level < 4; level += 1) {
    cums.push(await numberIn(page.getByTestId(`depth-ask-${level}-cum`)));
    avgs.push(await numberIn(page.getByTestId(`depth-ask-${level}-avg`)));
  }
  for (let level = 1; level < 4; level += 1) {
    expect(cums[level]!, `cum must grow at level ${level}`).toBeGreaterThan(cums[level - 1]!);
    expect(avgs[level]!, `walking to level ${level} cannot be cheaper`).toBeGreaterThanOrEqual(avgs[level - 1]!);
  }
  expect(avgs[3]!).toBeGreaterThan(avgs[0]!);

  // Level 0 of the panel is the very price the ladder row has always shown:
  // one book, two views of it, no second source of truth.
  const askTop = (await page.getByTestId('depth-ask-0-price').textContent())!;
  const bidTop = (await page.getByTestId('depth-bid-0-price').textContent())!;
  await expect(page.getByTestId('row-EURUSD')).toContainText(askTop);
  await expect(page.getByTestId('row-EURUSD')).toContainText(bidTop);
});

test('a clicked level loads the ticket and the order goes through (FR-07)', async ({ page, request }) => {
  expect((await request.post(`${FEED}/sim/seed`, { data: { seed: 42 } })).ok()).toBeTruthy();
  // No last look in the way: this test is about the ticket being loaded and
  // accepted, not about §5.5's bounce.
  expect((await request.post(`${FEED}/sim/lastlook`, { data: { holdMs: 0, rejectRate: 0 } })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('feed-status')).toHaveText('live');

  // The ladder row is the pair selector for the depth panel.
  await page.getByTestId('row-GBPUSD').click();
  await expect(page.getByTestId('depth-pair')).toHaveText('GBPUSD');

  expect((await request.post(`${FEED}/sim/freeze`, { data: { pair: 'GBPUSD', ms: 20_000 } })).ok()).toBeTruthy();
  await settle(page, page.getByTestId('depth-ask-1-cum'));
  const walkQty = await numberIn(page.getByTestId('depth-ask-1-cum'));

  await page.getByTestId('depth-ask-1').click();

  // Buying from the offers, for the volume the walk to that level takes.
  await expect(page.getByTestId('ticket-pair')).toHaveValue('GBPUSD');
  await expect(page.getByTestId('ticket-side')).toHaveText('buy');
  await expect(page.getByTestId('ticket-qty')).toHaveValue(String(walkQty));
  // The prices came along as a reference, and the panel says so.
  await expect(page.getByTestId('ticket-from-depth')).toContainText('indicative');

  // The loaded ticket is a usable ticket, not a display.
  await page.getByTestId('ticket-submit').click();
  await expect(page.getByTestId('ticket-ack')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('blotter')).toContainText('GBPUSD', { timeout: 10_000 });

  // And the other side: a bid level sells.
  await page.getByTestId('depth-bid-0').click();
  await expect(page.getByTestId('ticket-side')).toHaveText('sell');
});
