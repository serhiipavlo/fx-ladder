# DEMO

One demo line per release (plan §2.3). The full 5-minute scripted runbook
arrives with v1.0.0.

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
