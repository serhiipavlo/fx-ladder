import { expect, test } from '@playwright/test';

const FEED = 'http://127.0.0.1:8123';

// The fx.v2 wire in the browser (ADR-12): the page negotiates binary by
// default, the panel's toggle forces fx.v1 and back — a deliberate
// reconnect each way, judged by nobody's close-code table — and the gap
// counter stays at zero throughout: two wires, one seq arithmetic.
test('the page rides fx.v2, the toggle forces fx.v1 and returns — live both ways, zero gaps', async ({
  page,
  request,
}) => {
  expect((await request.post(`${FEED}/sim/seed`, { data: { seed: 42 } })).ok()).toBeTruthy();
  const errors: Error[] = [];
  page.on('pageerror', (err) => errors.push(err));

  await page.goto('/');
  await expect(page.getByTestId('feed-status')).toHaveText('live');
  await expect(page.getByTestId('wire')).toHaveText('fx.v2'); // binary negotiated by default

  await page.getByTestId('panel').locator('summary').click();
  await page.getByTestId('wire-toggle').click();
  await expect(page.getByTestId('wire')).toHaveText('fx.v1', { timeout: 10_000 });
  await expect(page.getByTestId('feed-status')).toHaveText('live', { timeout: 10_000 });

  await page.getByTestId('wire-toggle').click();
  await expect(page.getByTestId('wire')).toHaveText('fx.v2', { timeout: 10_000 });
  await expect(page.getByTestId('feed-status')).toHaveText('live', { timeout: 10_000 });

  // Both hops were our own deliberate drops: no gap was ever proven, because
  // none existed — each new wire opened with its own snapshot (ADR-08).
  await expect(page.getByTestId('gaps')).toHaveText('0');
  // And the meter shows a real number on the binary wire.
  await expect(page.getByTestId('wire-rate')).not.toHaveText('0.0 KiB/s');
  expect(errors).toEqual([]);
});
