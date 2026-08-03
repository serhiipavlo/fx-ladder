import { expect, test } from '@playwright/test';

const FEED = 'http://127.0.0.1:8123';

// T-0.4.8's done-when in the browser: a forced disconnect mid-order loses no
// execution report and duplicates none once reconnected. The client's seq
// arithmetic makes both failures THROW (a §5.6 contradiction or a fold of a
// duplicate) — the pageerror listener is the negative proof, the blotter
// ending at FILLED with the exact quantity the positive one.

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${FEED}/sim/seed`, { data: { seed: 42 } })).ok()).toBeTruthy();
});

async function submitAndReadId(page: import('@playwright/test').Page): Promise<string> {
  await page.getByTestId('ticket-submit').click();
  await expect(page.getByTestId('ticket-ack')).toBeVisible();
  const id = await page.getByTestId('ticket-ack').locator('code').textContent();
  expect(id).toBeTruthy();
  return id!;
}

test('crash during the last-look hold: the lifecycle completes on the resumed subscription', async ({
  page,
  request,
}) => {
  const errors: Error[] = [];
  page.on('pageerror', (err) => errors.push(err));

  await page.goto('/');
  await expect(page.getByTestId('feed-status')).toHaveText('live');

  // A long hold: the crash lands before any event fires, then the whole
  // lifecycle plays out — on whichever side of the reconnect it finds.
  expect((await request.post(`${FEED}/sim/lastlook`, { data: { holdMs: 2500, rejectRate: 0 } })).ok()).toBeTruthy();
  const clOrdId = await submitAndReadId(page);

  expect((await request.post(`${FEED}/sim/disconnect`, { data: { graceful: false } })).ok()).toBeTruthy();
  await expect(page.getByTestId('feed-status')).toHaveText('live', { timeout: 10_000 });

  const row = page.locator(`.ag-row[row-id="${clOrdId}"]`);
  await expect(row.locator('[col-id="status"]')).toHaveText('FILLED', { timeout: 15_000 });
  await expect(row.locator('[col-id="cumQty"]')).toHaveText('500');
  await expect(row.locator('[col-id="leavesQty"]')).toHaveText('0');
  expect(errors).toEqual([]);
});

test('restart = a new trading day: the book empties and the page says why (ADR-10)', async ({ page, request }) => {
  const errors: Error[] = [];
  page.on('pageerror', (err) => errors.push(err));

  await page.goto('/');
  await expect(page.getByTestId('feed-status')).toHaveText('live');

  // A filled order on the books…
  expect((await request.post(`${FEED}/sim/lastlook`, { data: { holdMs: 100, rejectRate: 0 } })).ok()).toBeTruthy();
  const clOrdId = await submitAndReadId(page);
  await expect(page.locator(`.ag-row[row-id="${clOrdId}"] [col-id="status"]`)).toHaveText('FILLED', {
    timeout: 15_000,
  });

  // …then the closest thing to a container kill the control plane can stage:
  // the server forgets everything (reseed = new day) and every socket
  // crashes. The reconnected resync finds no memory of the book we hold.
  expect((await request.post(`${FEED}/sim/seed`, { data: { seed: 5 } })).ok()).toBeTruthy();
  expect((await request.post(`${FEED}/sim/disconnect`, { data: { graceful: false } })).ok()).toBeTruthy();

  await expect(page.getByTestId('feed-status')).toHaveText('live', { timeout: 10_000 });
  await expect(page.getByTestId('blotter-count')).toHaveText('0', { timeout: 15_000 });
  await expect(page.getByTestId('new-day')).toBeVisible();
  await expect(page.getByTestId('new-day')).toContainText('a new trading day');
  await expect(page.getByTestId(`position-EURUSD`)).toHaveCount(0); // positions reset with the day

  // The first order of the new day retires the note and fills the book again.
  await page.getByTestId('ticket-submit').click();
  await expect(page.getByTestId('ticket-ack').locator('code')).not.toHaveText(clOrdId);
  const nextId = (await page.getByTestId('ticket-ack').locator('code').textContent())!;
  await expect(page.locator(`.ag-row[row-id="${nextId}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('new-day')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('crash with the lifecycle firing into the outage: state returns wholesale from the snapshot', async ({
  page,
  request,
}) => {
  const errors: Error[] = [];
  page.on('pageerror', (err) => errors.push(err));

  await page.goto('/');
  await expect(page.getByTestId('feed-status')).toHaveText('live');

  // A short hold: NEW and every fill land while the warm socket is down —
  // recovery has ONLY the snapshot to build from (ADR-08 retold).
  expect((await request.post(`${FEED}/sim/lastlook`, { data: { holdMs: 200, rejectRate: 0 } })).ok()).toBeTruthy();
  const clOrdId = await submitAndReadId(page);
  expect((await request.post(`${FEED}/sim/disconnect`, { data: { graceful: false } })).ok()).toBeTruthy();

  await expect(page.getByTestId('feed-status')).toHaveText('live', { timeout: 10_000 });
  const row = page.locator(`.ag-row[row-id="${clOrdId}"]`);
  await expect(row.locator('[col-id="status"]')).toHaveText('FILLED', { timeout: 15_000 });
  await expect(row.locator('[col-id="cumQty"]')).toHaveText('500');
  await expect(row.locator('[col-id="leavesQty"]')).toHaveText('0');
  expect(errors).toEqual([]);
});
