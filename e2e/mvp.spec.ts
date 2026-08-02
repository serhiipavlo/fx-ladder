import { expect, test } from '@playwright/test';

const FEED = 'http://127.0.0.1:8123';

// The v0.1.0 demo as a spec (plan §3): live prices end-to-end with a correct
// resync after provable loss. Deterministic by construction — the gap comes
// from the control plane, not from network tricks.
test('seed → connect → ticks → gap → detector fires → clean resync', async ({ page, request }) => {
  const seeded = await request.post(`${FEED}/sim/seed`, { data: { seed: 42 } });
  expect(seeded.ok()).toBeTruthy();

  await page.goto('/');
  const row = page.getByTestId('row-EURUSD');
  await expect(row).toBeVisible();
  await expect(page.getByTestId('feed-status')).toHaveText('live');

  // Ticks are visible: the top of book changes.
  const before = await row.textContent();
  await expect(async () => {
    expect(await row.textContent()).not.toBe(before);
  }).toPass({ timeout: 5000 });

  // Tear the stream: every wire gets exactly one 40-seq hole.
  const gapped = await request.post(`${FEED}/sim/gap`, { data: { skipSeqs: 40 } });
  expect(gapped.ok()).toBeTruthy();

  // The detector proves the loss arithmetically — exactly one detection.
  await expect(page.getByTestId('gaps')).toHaveText('1', { timeout: 5000 });

  // Clean recovery: reconnect + fresh snapshot, live again, still ticking.
  await expect(page.getByTestId('feed-status')).toHaveText('live', { timeout: 5000 });
  await expect(row).toHaveCSS('opacity', '1');
  const afterGap = await row.textContent();
  await expect(async () => {
    expect(await row.textContent()).not.toBe(afterGap);
  }).toPass({ timeout: 5000 });
});
