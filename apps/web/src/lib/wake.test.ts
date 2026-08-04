// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { wakeServer } from './wake';

/** A clock the injected sleep drives, so the deadline is reached without timers. */
const fakeClock = () => {
  let at = 0;
  return {
    now: (): number => at,
    sleep: (ms: number): Promise<void> => {
      at += ms;
      return Promise.resolve();
    },
    elapsed: (): number => at,
  };
};

const ok = (body: unknown): Response => Response.json(body);

describe('wakeServer (ADR-11 revision)', () => {
  it('answers on the first knock when the server is already up', async () => {
    const clock = fakeClock();
    const knocked: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      knocked.push(String(input));
      return ok({ status: 'ok' });
    });

    const outcome = await wakeServer({ fetchFn, now: clock.now, sleep: clock.sleep });

    expect(outcome).toEqual({ ok: true, body: { status: 'ok' } });
    expect(knocked).toHaveLength(1);
    expect(knocked[0]).toContain('/healthz');
    expect(clock.elapsed()).toBe(0); // no waiting on a warm server
  });

  it('keeps knocking through a cold start — both refusals and error responses', async () => {
    const clock = fakeClock();
    let knocks = 0;
    const fetchFn = vi.fn(async () => {
      knocks += 1;
      if (knocks === 1) throw new Error('ECONNREFUSED'); // container not listening yet
      if (knocks === 2) return new Response('cold', { status: 502 }); // proxy is, container isn't
      return ok({ status: 'ok' });
    });

    const outcome = await wakeServer({ fetchFn, now: clock.now, sleep: clock.sleep, retryMs: 3000 });

    expect(outcome).toEqual({ ok: true, body: { status: 'ok' } });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(clock.elapsed()).toBe(6000);
  });

  it('gives up at the deadline and says how long it waited', async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn(async () => new Response('cold', { status: 503 }));

    const outcome = await wakeServer({
      fetchFn,
      now: clock.now,
      sleep: clock.sleep,
      deadlineMs: 9000,
      retryMs: 3000,
    });

    expect(outcome).toEqual({ ok: false, error: 'server did not wake within 9 s' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('never knocks at all with a deadline already behind us', async () => {
    const fetchFn = vi.fn(async () => ok({ status: 'ok' }));
    const outcome = await wakeServer({ fetchFn, now: () => 0, sleep: async () => undefined, deadlineMs: 0 });

    expect(outcome.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
