import { expect, test } from '@playwright/test';

const FEED = 'http://127.0.0.1:8123';

// AC-13 (NFR-13): the core action — submitting an order — is reachable from
// the keyboard alone. Native controls carry most of the weight; this pins
// that the tab order actually leads somewhere and Enter actually fires.
test('an order can be submitted with the keyboard alone', async ({ page, request }) => {
  expect((await request.post(`${FEED}/sim/seed`, { data: { seed: 42 } })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('feed-status')).toHaveText('live');

  // Walk the tab order from the top of the page to the submit button — no
  // mouse anywhere. The bound is generous but finite: an unreachable button
  // fails loudly, not by spinning.
  await page.locator('body').press('Tab');
  let reached = false;
  for (let i = 0; i < 40; i += 1) {
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
    if (focused === 'ticket-submit') {
      reached = true;
      break;
    }
    await page.keyboard.press('Tab');
  }
  expect(reached).toBe(true);

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ticket-ack')).toBeVisible({ timeout: 10_000 });

  // And the demo panel opens from the keyboard too: its summary is focusable.
  await page.getByTestId('panel').locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('panel')).toHaveAttribute('open', '');
});
