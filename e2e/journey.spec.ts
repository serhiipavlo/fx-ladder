import { expect, test, type APIRequestContext } from '@playwright/test';

const FEED = 'http://127.0.0.1:8123';

// The full journey (T-0.4.9), exactly as §11 frames E2E: the test COMMANDS —
// /sim/seed → /sim/scenario → then drives a trade and reads the UI. The
// compressed scenario replays spec §8 under the page's feet, crash included,
// so the journey crosses a reconnect on both planes before the first order.
// Done-when: green 10 consecutive runs (workers: 1 — one world, serial).

async function post(request: APIRequestContext, path: string, data: unknown): Promise<void> {
  const res = await request.post(`${FEED}${path}`, { data });
  expect(res.ok()).toBeTruthy();
}

/** Polls a text source fast enough to catch 120 ms lifecycle stages. */
async function watchUntil(readText: () => Promise<string | null>, target: string): Promise<string[]> {
  const distinct: string[] = [];
  await expect
    .poll(
      async () => {
        const seen = await readText().catch(() => null);
        if (seen !== null && seen !== '' && distinct[distinct.length - 1] !== seen) distinct.push(seen);
        return seen;
      },
      { intervals: [25], timeout: 15_000 },
    )
    .toBe(target);
  return distinct;
}

test('seed → scenario → order: NEW → partial → FILLED in the blotter, position and P&L move', async ({
  page,
  request,
}) => {
  const errors: Error[] = [];
  page.on('pageerror', (err) => errors.push(err));

  // The test commands the world into a known state. Seed 3 is chosen ON
  // PURPOSE: the engine's derived stream scripts the first two orders after
  // this reseed with three fills each — the partial stages the journey must
  // SEE are deterministic, not lucky (§5.1).
  await post(request, '/sim/seed', { seed: 3 });

  await page.goto('/');
  await expect(page.getByTestId('feed-status')).toHaveText('live');

  // Spec §8 plays out compressed 100×: calm → spike → unbatched-and-back →
  // CRASH (both planes drop and recover under the page) → calm → freeze →
  // news → last look armed. The applied counter says when the play is over.
  await post(request, '/sim/scenario', { name: 'demo-5min', speed: 100 });
  await expect
    .poll(
      async () => {
        const stats = (await (await request.get(`${FEED}/sim/stats`)).json()) as {
          updatesPerSec: number;
          scenario: { applied: number } | null;
        };
        return stats.scenario === null ? 0 : stats.scenario.applied;
      },
      { timeout: 15_000 },
    )
    .toBe(11);
  const after = (await (await request.get(`${FEED}/sim/stats`)).json()) as { updatesPerSec: number };
  expect(after.updatesPerSec).toBe(2000); // the scenario's post-recovery calm

  // The page survived the scripted crash: hot plane live again…
  await expect(page.getByTestId('feed-status')).toHaveText('live', { timeout: 10_000 });

  // …and now the trade. The scenario armed last look at 0.3 for the human
  // demo; the test needs the deterministic fill path, so it commands clean.
  await post(request, '/sim/lastlook', { holdMs: 300, rejectRate: 0 });

  await page.getByTestId('ticket-submit').click();
  await expect(page.getByTestId('ticket-ack')).toBeVisible({ timeout: 10_000 });
  const clOrdId = (await page.getByTestId('ticket-ack').locator('code').textContent())!;
  expect(clOrdId).toBeTruthy();

  // The lifecycle on screen: statuses may only walk the §5.6 machine, and
  // both the partial and the fill must actually have been VISIBLE.
  const statusCell = page.locator(`.ag-row[row-id="${clOrdId}"] [col-id="status"]`);
  const stages = await watchUntil(() => statusCell.textContent(), 'FILLED');
  for (const stage of stages) {
    expect(['NEW', 'PARTIALLY_FILLED', 'FILLED']).toContain(stage);
  }
  expect(stages).toContain('PARTIALLY_FILLED');
  expect(stages[stages.length - 1]).toBe('FILLED');
  const row = page.locator(`.ag-row[row-id="${clOrdId}"]`);
  await expect(row.locator('[col-id="cumQty"]')).toHaveText('500');
  await expect(row.locator('[col-id="leavesQty"]')).toHaveText('0');

  // Position updated: long 500K, and the §7.3 split on display — unrealised
  // ticks with the hot mid while the position is open.
  const position = page.getByTestId('position-EURUSD');
  await expect(position).toBeVisible();
  await expect(position.locator('td').nth(1)).toHaveText('500K');
  const unrealised = page.getByTestId('unrealised-EURUSD');
  const sample = await unrealised.textContent();
  expect(sample).not.toBe('—');
  await expect
    .poll(async () => unrealised.textContent(), { intervals: [50], timeout: 10_000 })
    .not.toBe(sample); // the mid moved, the multiplication moved with it

  // Round-trip: sell the same size — the book flattens and realised P&L is
  // written by the server exactly on trade events.
  await page.getByTestId('ticket-side').click(); // buy → sell
  await page.getByTestId('ticket-submit').click();
  await expect(page.getByTestId('ticket-ack').locator('code')).not.toHaveText(clOrdId);
  const sellId = (await page.getByTestId('ticket-ack').locator('code').textContent())!;
  await expect(page.locator(`.ag-row[row-id="${sellId}"] [col-id="status"]`)).toHaveText('FILLED', {
    timeout: 15_000,
  });
  await expect(position.locator('td').nth(1)).toHaveText('0K');
  await expect(page.getByTestId('unrealised-EURUSD')).toHaveText('0.0'); // flat ticks at zero
  const realised = await page.getByTestId('realised-EURUSD').textContent();
  expect(Number.parseFloat(realised!)).not.toBeNaN(); // the server's number, on screen

  expect(errors).toEqual([]);
});
