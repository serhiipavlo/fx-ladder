# Chaos drills

What happens when the container dies mid-stream — measured, not assumed
(T-1.0.1). The drill is one command and asserts its own outcomes; a human is
needed only to read the table.

```bash
pnpm chaos:drill
```

Local mode spawns the real server, SIGKILLs the whole process tree three
seconds into a five-client stream (no close frames — a real death), respawns
it 2.5 s later, and watches the clients come back through the production
reconnect policy (`apps/web/src/stream/reconnect.ts`, imported verbatim).
`--watch wss://host/feed` connects one probe and waits for someone else to
replace the container — the production rehearsal.

## Local kill — observed 2026-08-03

```
killed at t=3021 ms (SIGKILL, no close frames)
respawned; healthy at t=6081 ms

client 1: close 1006 at 3140 ms · retries [#0+364ms #1+869ms #2+1940ms] · back at 6339 ms (down 3199 ms) · first frame SNAPSHOT · seq dense true · frames 124→183
client 2: close 1006 at 3140 ms · retries [#0+263ms #1+908ms #2+1736ms] · back at 6065 ms (down 2925 ms) · first frame SNAPSHOT · seq dense true · frames 124→195
client 3: close 1006 at 3140 ms · retries [#0+276ms #1+942ms #2+1226ms #3+2503ms] · back at 8125 ms (down 4985 ms) · first frame SNAPSHOT · seq dense true · frames 124→107
client 4: close 1006 at 3140 ms · retries [#0+433ms #1+713ms #2+1225ms #3+2888ms] · back at 8438 ms (down 5298 ms) · first frame SNAPSHOT · seq dense true · frames 124→94
client 5: close 1006 at 3140 ms · retries [#0+281ms #1+695ms #2+1956ms] · back at 6094 ms (down 2954 ms) · first frame SNAPSHOT · seq dense true · frames 124→193

reconnect smear across 5 clients: 2373 ms (jitter working: > 0)
```

Reading the table against the §7.1 claims:

- **An abrupt death is never mistaken for a goodbye.** Every client saw
  `1006` (abnormal closure) — the reaction table retries it; a deliberate
  `1000` would have stopped them, and a kill cannot produce one.
- **The herd returns as a smear, not a wave.** All five dropped in the same
  millisecond; first-retry delays span 263–433 ms (full-range jitter on a
  500 ms base) and total downtimes span 2.9–5.3 s. Clients whose retry
  landed inside the dead window burned the attempt and doubled — exactly
  the backoff curve, exactly per client.
- **Recovery is resnapshot, not repair (ADR-08).** Every reconnected wire
  opened with a `SNAPSHOT` and stayed seq-dense; frames flowed immediately
  after.

## Production container replacement — observed 2026-08-03

A Render deploy of the same image (`rollback.yml`, tag v0.4.1) replaces the
container under a connected probe (`pnpm chaos:drill --watch
wss://fx-ladder-feed.onrender.com/feed`):

```
client 1: close 1006 at 52826 ms · retries [#0+282ms] · back at 53208 ms (down 382 ms) · first frame SNAPSHOT · seq dense true · frames 5245→131
```

The deploy took ~50 s from workflow dispatch to the traffic switch; the
probe streamed 5245 frames through all of it. Render starts the new
instance and only then stops the old one, so when the old socket died
(`1006` again — a stop is not a goodbye), the very first jittered retry
landed on a machine already serving: **382 ms of downtime, one attempt,
snapshot, dense**. A platform restart is strictly gentler than the local
SIGKILL drill above — the reconnect story covers both ends.

## Restart is a new trading day (ADR-10)

State lives in memory on purpose: no database, no persistence, restart =
clean books. The page now says so where a viewer would otherwise suspect a
bug — after a reconnect whose warm resync comes back empty-handed over a
non-empty blotter, a note appears next to the ticket:

> server restarted — a new trading day (ADR-10): state lives in memory, so
> orders and positions start clean

The first order of the new day retires the note. Pinned by
`e2e/reconnect.spec.ts` (“restart = a new trading day”), staged with the
control plane’s own verbs: reseed (the server forgets) plus a hard
disconnect (every socket crashes), which is exactly what a platform restart
looks like from a browser.
