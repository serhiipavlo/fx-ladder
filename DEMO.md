# DEMO

The 5-minute runbook first; one demo line per release (plan §2.3) below it
as history.

## The 5-minute runbook (T-1.0.4)

### Pre-flight — two minutes before you speak

1. Open <https://fx-ladder-web.onrender.com>. If the free instance slept,
   the page says so — press **Wake the server** and give it up to a minute.
   You want the feed line reading **live** before you start.
2. Open the demo panel (`demo panel — /sim/* controls…` under the ladder).
3. Optional second tab: [/docs](https://fx-ladder-web.onrender.com/docs/) —
   the OpenAPI/AsyncAPI page generated from the live schemas.
4. **Decision point:** if the venue network is hostile, switch to the local
   fallback below — same server, same script, zero cloud.

### The script

Press **`scenario: demo-5min`** in the panel. The whole of spec §8 now runs
itself on a timeline; your job is the client half and the narration. The
clock below is the scenario's own.

| When | What happens | What you do and say |
|---|---|---|
| 0:00 | Calm market: 12 pairs, 300/s, batched | "Live prices over one WebSocket — dense sequence numbers, heartbeats through silence; the `gaps` counter is an arithmetic proof of completeness." |
| 0:30 | Spike to 50 000/s | Point at the panel counters: received rate climbs, frames stay ~125/s. "One batched frame per 8 ms tick — the wire cost is honest JSON, ~3.6 MiB/s." |
| 1:30 | The wire turns into a frame per update | **Flip `render` to `naive`.** The page starts to choke — this is the main 30 seconds. "Render per message: 797× more renders for the same information. The bottleneck lives between the socket and the render, not on the wire." |
| 1:50 | The wire re-batches | **Flip `render` back to `coalesced`.** The page breathes instantly. "Same firehose, one flush per screen frame." |
| 2:00 | Crash: every socket drops (close 4000) | Do nothing. "Jittered backoff, resnapshot, no thundering herd — the reconnect smear is measured in CHAOS.md." The feed line walks reconnecting → live. |
| 2:20 | Market calms to 2 000/s | Breathing room — take a question, or show `/docs`. |
| 3:15 | USDJPY freezes for 10 s | Point at the dimmed row: "**stale**, not disconnected — the channel is provably alive while one pair is provably quiet." |
| 3:45 | News on GBPUSD: +80 pips, spread ×6 | "The jump and the widening arrive together and decay — the economics, not two separate knobs." |
| 4:00 | Last look arms: 80 ms hold, 30 % reject | **Trade.** Submit the ticket: ack instantly, then `NEW` → partial → `FILLED` assemble in the blotter from typed events; position goes long, unrealised ticks with the mid. If the order bounces `REJECTED / LAST_LOOK` — that is §5.5 working; say so and resubmit. Sell the same size: flat book, realised P&L written by the server. |

Bonus beats, any time after the script:

- **`blotter: burst 5000 orders`** — the grid eats 5000 real lifecycles;
  sort a column, scroll, burst again: sort and scroll survive, the ladder
  never drops a frame (AC-10, AC-11).
- **`disconnect hard` mid-order** — the warm socket crashes with the rest
  and the blotter returns whole from the snapshot: a repeat is provably a
  duplicate, a hole provably loss, so neither can render.
- **reseed** — a new trading day (ADR-10): the page says exactly that
  instead of looking broken.

### Local fallback — a clean machine to a running demo

Prerequisites: Node ≥ 22 and pnpm (`npm i -g pnpm`), git.

```bash
git clone https://github.com/serhiipavlo/fx-ladder.git
cd fx-ladder
pnpm install
pnpm dev
```

Open <http://localhost:5173> — the same page against a local server; the
whole script above works identically (the scenario, the panel, the trade).
No network needed beyond the clone.

Container variant (closest to production — the exact deployed image):

```bash
docker run --rm -p 8080:8080 ghcr.io/serhiipavlo/fx-ladder/feed-server:v1.0.0
pnpm --filter @fx/web exec vite
```

If 8080 is taken locally, map another port and point the web dev server at
it: `docker run --rm -p 8090:8080 …` then `FX_BACKEND_PORT=8090 pnpm
--filter @fx/web exec vite`.

## v1.1.0

The feed line now names its wire: **fx.v2**, with a live byte meter beside
it. `rate 50k` — the meter reads ~590 KiB/s. Press `wire: fx.v2 → force v1`
in the panel: the page reconnects onto the JSON wire and the meter jumps to
~3.6 MiB/s **for the same stream**; flip back and it falls again. Six times
fewer bytes, zero gaps either way — the §6.2 arithmetic does not care how
records are spelled.

## v0.4.0

The trade section under the ladder. **submit** — the ack lands instantly,
then the blotter assembles the order's life from typed events: `NEW`, a
partial, `FILLED`, each priced off the moving book. The position goes long
and unrealised P&L ticks with the mid **between** events, while realised
moves only when a trade books — the §7.3 split on one screen. Sell the same
size: flat, realised written by the server. `blotter: burst 5000 orders`
floods the grid through the real engine — sort and scroll survive, the
ladder never drops a frame. `disconnect hard` mid-order — the warm socket
crashes with the rest and the blotter returns whole: a repeat is provably a
duplicate, a hole provably loss, so neither can render. Finally
`scenario: demo-5min` — the whole §8 show from one click, identical every
time.

## v0.3.0

The engine room. DevTools → Network: `/api/instruments` loads once, then a
refresh answers `304` with an empty body — the client's `staleTime` and the
server's `max-age` are the same number by construction. The machine:

```bash
node scripts/orders-burst.mjs https://fx-ladder-feed.onrender.com 30
```

— thirty synthetic orders expand into scripted lifecycles and the executions
mix moves in `/sim/stats`: trades, partials, fills, an IOC leftover canceled.
Turn last look up (`POST /sim/lastlook {"holdMs":80,"rejectRate":0.5}`) and
the same burst starts bouncing with `REJECTED / LAST_LOOK` after its hold
window. Freeze a pair first and an order for it rejects with `STALE_PRICE` —
the server is the truth about freshness, not the client's belief.

## v0.2.0

Open the demo panel under the ladder. `rate 50k` — twelve pairs stream
smoothly, one batched frame per tick. Flip **render** to `naive` and turn
**server batching off** — the interface stutters within seconds under a frame
per update; flip both back and it breathes again: the bottleneck lives
between the socket and the render, not on the wire. `news +80 ×6` on GBPUSD —
the spike and the spread widening ripple through the ladder together and decay
away. `disconnect hard` — the client names the crash and returns with jittered
backoff. `freeze 10 s` on USDJPY — one row dims to **· stale** while everything
around it ticks: the channel is provably alive, the pair is provably quiet.

## v0.1.0

Open <https://fx-ladder-web.onrender.com>: five pairs tick live in the ladder,
one batched frame per tick (visible in DevTools → Network → /feed). Kill the
network and restore — the heartbeat watchdog declares the feed dead within
3 s, the client reconnects and resnapshots. Then tear the stream on purpose:
`/docs` → `POST /sim/gap` → Try it out — the `gaps` counter proves the loss
arithmetically and the ladder recovers the same way: reconnect, fresh
snapshot, live again. Prices correct, no duplicates, no frozen ghosts.

## v0.0.1

Open <https://fx-ladder-web.onrender.com> on a phone: the page loads, shows
**connected** (`fx.v1`), the heartbeat counter ticks once per second, and the
healthz line renders the result of a genuinely cross-origin fetch. If the
free instance was asleep, the page says so and **Wake the server** brings it
up in under a minute. Unimpressive on purpose — the demo *is* the pipeline.
