# DEMO

One demo line per release (plan §2.3). The full 5-minute scripted runbook
arrives with v1.0.0.

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
