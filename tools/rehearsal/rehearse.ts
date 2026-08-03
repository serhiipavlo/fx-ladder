import { execFileSync, spawn, type ChildProcess } from 'node:child_process';

import { chromium } from '@playwright/test';

// The T-1.0.5 rehearsal: the DEMO.md runbook executed for real — a fresh
// container (the exact deployed image), a fresh browser profile, the
// scenario at x1 with the human's own beats (the render flips, the trade)
// clicked at the runbook's timestamps. Zero manual fixes is the exit
// criterion, so the harness performs only what the script prescribes and
// fails loudly on anything else. --throttled runs the same rehearsal over
// a deliberately bad network: the 50k spike cannot fit the pipe, the
// slow-client guard cuts, the reconnect story carries the page — surviving
// that IS the assertion.
//
//   pnpm rehearse             one clean pass
//   pnpm rehearse --throttled one pass over a ~1.6 Mbps, 400 ms RTT link

const IMAGE = 'ghcr.io/serhiipavlo/fx-ladder/feed-server:v0.4.1';
const FEED_PORT = 8135;
const WEB_PORT = 5199;
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const now = (): number => performance.now();

async function waitHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${FEED_PORT}/healthz`)).ok) return;
    } catch {
      // booting
    }
    if (Date.now() > deadline) throw new Error('container never became healthy');
    await sleep(200);
  }
}

async function stats(): Promise<{ updatesPerSec: number; batch: boolean; scenario: { applied: number } | null }> {
  return (await (await fetch(`http://127.0.0.1:${FEED_PORT}/sim/stats`)).json()) as never;
}

/**
 * Clean passes run the dev server — the runbook's own local fallback.
 * Throttled passes serve a PRODUCTION build the way the deployed CDN does:
 * a dev page ships thousands of unbundled modules and would spend minutes
 * paying 400 ms RTT each — an artifact of dev tooling, not the demo's story.
 */
function startWeb(throttled: boolean): ChildProcess {
  const vite = 'node_modules/vite/bin/vite.js';
  if (throttled) {
    execFileSync(process.execPath, [vite, 'build'], {
      cwd: 'apps/web',
      env: { ...process.env, VITE_FEED_URL: `http://127.0.0.1:${FEED_PORT}` },
      stdio: 'ignore',
    });
    return spawn(
      process.execPath,
      [vite, 'preview', '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'],
      { cwd: 'apps/web', stdio: 'ignore' },
    );
  }
  return spawn(
    process.execPath,
    [vite, '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'],
    { cwd: 'apps/web', env: { ...process.env, FX_BACKEND_PORT: String(FEED_PORT) }, stdio: 'ignore' },
  );
}

async function waitWeb(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(WEB_ORIGIN)).ok) return;
    } catch {
      // booting
    }
    if (Date.now() > deadline) throw new Error('web dev server never came up');
    await sleep(200);
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  } else {
    child.kill('SIGKILL');
  }
}

interface Beat {
  at: number;
  what: string;
}

async function rehearse(throttled: boolean): Promise<Beat[]> {
  const beats: Beat[] = [];
  const t0 = now();
  const mark = (what: string): void => {
    beats.push({ at: Math.round(now() - t0), what });
    console.log(`  [${((now() - t0) / 1000).toFixed(1).padStart(6)}s] ${what}`);
  };

  // Fresh container — the exact deployed image, clean state by construction.
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', 'fx-rehearsal',
    '-p', `${FEED_PORT}:8080`,
    '-e', `FX_ALLOWED_ORIGINS=${WEB_ORIGIN},http://localhost:${WEB_PORT}`,
    IMAGE,
  ]);
  const web = startWeb(throttled);
  try {
    await waitHealthy(30_000);
    await waitWeb(30_000);
    mark(`container healthy, web up (${throttled ? 'production build' : 'dev'}, fresh state)`);

    // Fresh browser: a brand-new profile every pass.
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));

      if (throttled) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 400,
          downloadThroughput: 200_000, // ~1.6 Mbps — the 3.6 MiB/s spike cannot fit
          uploadThroughput: 100_000,
        });
        mark('network throttled: 400 ms RTT, ~1.6 Mbps down');
      }

      // A production bundle over ~1.6 Mbps is a patient load, not a broken one.
      await page.goto(WEB_ORIGIN, { timeout: throttled ? 120_000 : 30_000 });
      await page.getByTestId('feed-status').filter({ hasText: 'live' }).waitFor({ timeout: 30_000 });
      mark('page live — pre-flight done');

      await page.getByTestId('panel').locator('summary').click();
      await page.getByTestId('scenario').click();
      mark('scenario: demo-5min pressed — §8 plays itself');

      // 0:30 — the spike. Confirm from stats like the panel narration would.
      await sleep(35_000);
      mark(`0:35 posture — rate ${(await stats()).updatesPerSec}/s (the spike)`);

      // 1:30 — the wire turns hostile; the HUMAN flips render to naive.
      await sleep(55_000);
      await page.getByTestId('render-mode').click();
      mark('1:30 render flipped to naive — the main 30 seconds');

      // 1:50 — the wire re-batches; flip back, the page breathes.
      await sleep(20_000);
      await page.getByTestId('render-mode').click();
      mark('1:50 render back to coalesced');

      // 2:00 — the scripted crash. Wait through it: the reconnect story.
      await sleep(15_000);
      await page.getByTestId('feed-status').filter({ hasText: 'live' }).waitFor({ timeout: 30_000 });
      mark('2:15 crash crossed — feed live again, nobody touched anything');

      // 3:15 freeze and 3:45 news play out on their own; give them the stage,
      // and trade only once the timeline's last step (last look armed) fired —
      // the §5.5 rejections must genuinely be on the table.
      await sleep(105_000);
      const armed = Date.now() + 30_000;
      while (((await stats()).scenario?.applied ?? 0) < 11) {
        if (Date.now() > armed) throw new Error('the scenario never finished its timeline');
        await sleep(500);
      }
      mark(`4:00+ — all 11 steps applied, last look armed`);

      // The trade. A LAST_LOOK bounce is §5.5 working: resubmit, exactly as
      // the runbook tells the human. Six attempts at 30% is a 0.07% false red.
      let filled = false;
      for (let attempt = 0; attempt < 6 && !filled; attempt += 1) {
        await page.getByTestId('ticket-submit').click();
        await page.getByTestId('ticket-ack').waitFor({ timeout: 10_000 });
        const id = await page.getByTestId('ticket-ack').locator('code').textContent();
        const status = page.locator(`.ag-row[row-id="${id}"] [col-id="status"]`);
        await status.waitFor({ timeout: 10_000 });
        await sleep(1500); // the scripted life at 80 ms hold + 120 ms gaps
        const text = await status.textContent();
        if (text === 'FILLED') {
          filled = true;
          mark(`trade filled on attempt ${attempt + 1} (${id})`);
        } else if (text === 'REJECTED') {
          mark(`attempt ${attempt + 1} bounced LAST_LOOK — §5.5 on stage, resubmitting`);
        } else {
          await sleep(1500);
          if ((await status.textContent()) === 'FILLED') {
            filled = true;
            mark(`trade filled on attempt ${attempt + 1} (${id})`);
          }
        }
      }
      if (!filled) throw new Error('the trade never filled within the scripted attempts');

      await page.getByTestId('position-EURUSD').waitFor({ timeout: 10_000 });
      mark('position on screen — the §7.3 split visible');

      if (errors.length > 0) throw new Error(`page errors during the rehearsal: ${errors.join(' | ')}`);
      mark('zero page errors, zero manual fixes');
      return beats;
    } finally {
      await browser.close();
    }
  } finally {
    killTree(web);
    try {
      execFileSync('docker', ['rm', '-f', 'fx-rehearsal'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
}

const throttled = process.argv.includes('--throttled');
console.log(`rehearsal (${throttled ? 'throttled network' : 'clean'}) — image ${IMAGE}\n`);
try {
  await rehearse(throttled);
  console.log('\nREHEARSAL GREEN');
  process.exit(0);
} catch (err) {
  console.error(`\nREHEARSAL RED: ${err instanceof Error ? err.message : String(err)}`);
  try {
    execFileSync('docker', ['rm', '-f', 'fx-rehearsal'], { stdio: 'ignore' });
  } catch {
    // already gone
  }
  process.exit(1);
}
