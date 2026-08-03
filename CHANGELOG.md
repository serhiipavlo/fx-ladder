# Changelog

## v1.2.3 — 2026-08-03

- fix: the blotter showed **`CANCELED` with an empty reason column** and nothing on screen said why. In FIX that emptiness is correct — a cancel carries no reject reason, because rejections and cancels are different events (§5.6) — but the fact that *does* explain it, the order's **time in force**, never reached the client at all.
  - `tif` now rides the wire: the ledger records it at registration, the subscription enriches every report with it, and the reconnect snapshot carries it too, so a refreshed page is no poorer than a live one;
  - the blotter gains a **`tif` column** (IOC highlighted, DAY muted) and the reason cell now reads **`IOC: 1383K of 1604K, rest withdrawn`** for cancels — the sentence is assembled where a human reads it, while the wire stays FIX-honest with `rejectReason: null`;
  - pinned by an E2E that asserts the sentence's numbers are the row's own, and by a server test proving every report — cancels included — carries its `tif`, with `cumQty` strictly between zero and the order quantity.

## v1.2.1 — 2026-08-03

- fix: pressing **burst** froze the page. Measured, it was three separate costs and none of them was the row count (5000 is the AC-11 number and the virtualised grid holds it fine):
  - **the blotter never forgot an order** — three bursts took the main thread from 138 ms blocked to **2016 ms**, because every flush re-sorted and re-diffed the whole accumulated book. The book is now bounded at 5000, retiring the oldest *finished* orders only: a live order still owes events, and dropping it would leave the next one nothing to fold onto;
  - **the server submitted all 5000 in one millisecond**, so every lifecycle came due on the same ticks and arrived as walls of simultaneous events — on the deployed 0.1-CPU instance that took **17 s** to play out and starved `/healthz` into a platform kill. Arrivals now stagger across up to 5 s (`spreadMs` in the response), the same 5000 orders as a stream;
  - **spreading them made the client worse** (1978 ms blocked): identical work over ten times as many frames, each still paying for the entire book. The grid now takes **transactions** instead of a fresh `rowData` array, so a flush costs what moved; newest-first is the grid's own sort model on a new `updated` column, and the component never sorts at all.
- After: **0 long tasks, worst frame 57 ms, no degradation across repeated bursts** — confirmed on the deployed page too (three bursts, 0 ms blocked, worst frames 25–30 ms). A resync is reported as a delta too, so a reconnect or a new trading day clears the grid instead of leaving ghost rows.
- The panel's burst button now asks for **1000** orders: the grid's limit is not the constraint (AC-11's 5000 is proven by E2E against a real server and is one `/sim/blotter` call away), but the free instance's 0.1 CPU needs ~30 s to emit five thousand lifecycles — a burst you can narrate beats one you apologise for.

## v1.2.0 — 2026-08-03

The demo panel stops describing the load and starts drawing it: one load line and one cost line per boundary, sixty seconds wide, live.

- **load chart** in the panel — records/s (what the server pushes), server tick p95 (what it costs the server), client renders/s (what it costs the render), wire bytes/s (what it costs the network). `rate 50k` lifts the first line and leaves the rest flat; the render switch lifts exactly one of them; the wire toggle exactly another — the whole project's claim in one picture
- rates are **differentiated from the server's own cumulative counters against the server's own clock**, so a slow poll or a paused tab widens `dt` instead of inflating the rate; a restart reseeds rather than plotting a negative spike (ADR-10)
- **renders/s, not a p95, is the client's cost line** — found by watching it live: the timing instruments split across two fields by render mode (naive charges the message, coalesced charges the flush), so a single timing series reads `0.00 ms` in exactly the mode where the client suffers most. A count of render passes is honest in both — and it is the 797× contrast itself
- hand-drawn SVG, no charting dependency: a chart that measures frame budgets has no business spending them. Path geometry is pure math in `perf/series.ts` — property-tested for in-viewBox points, clamped values, a 1-2-5 axis that does not jitter, and no NaN on a zero ceiling
- observed live at 50k with the pathology armed: the render line jumped from the floor to **1.6k renders/s** while the server tick stayed at 0.68 → 0.69 ms

## v1.1.0 — 2026-08-03

The first backlog item to find its buyer (plan §5): the binary wire. Same frames, same §6.2 arithmetic, a sixth of the bytes (ADR-12).

- `fx.v2`: a 16-byte header plus fixed 12-byte records (little-endian, DataView). Per-record seq is **not on the wire** — a non-dense frame is inexpressible by construction, decode reconstructs `firstSeq + i`, four bytes per record saved
- version negotiation is the subprotocol mechanism doing its actual job: the client offers `[fx.v2, fx.v1]`, the server picks the newest wire both speak, and a v1-only client stays served with JSON forever — proven by a mixed-clients test riding one tick on two wires with identical content, aligned by the tick's own `serverTs`
- one client core, two decoders: structural damage on either wire is the same loud protocol-error resync; golden-bytes tests pin the layout against silent drift; the encoder refuses what the wire cannot carry (u32 seq, u16 count, u8 ids) — no silent truncation
- the HUD shows the negotiated wire and a live byte meter; the panel's `wire` toggle forces `fx.v1` and back — a deliberate reconnect each way, zero gaps (E2E-pinned)
- measured (`pnpm gate:perf`, both wires now recorded side by side): **588 KiB/s on fx.v2 vs 3.62 MiB/s on fx.v1 — 6.3× fewer bytes** at the same 50 050 updates/s received; server tick p95 improved to **0.356 ms** (`JSON.stringify` was the dearer half); binary decode p95 gated under the same 2 ms bound as JSON

## v1.0.0 — 2026-08-03

Demo-ready hardening (plan §3): not a feature release. The system became *presentable under stress* — chaos-tested, documented, and rehearsed.

- chaos drills (`pnpm chaos:drill`): a real SIGKILL mid-stream — five clients drop with `1006`, return through the production backoff policy as a **2.4 s smear** (first-retry jitter 263–433 ms; a retry into the dead window burns the attempt and doubles), and every reconnected wire opens with a SNAPSHOT and stays seq-dense; a Render container replacement under a connected probe cost **382 ms and one attempt**. Tables in [CHAOS.md](CHAOS.md)
- ADR-10, written where a viewer sees it: a resync answered with an empty snapshot over a non-empty book renders *"server restarted — a new trading day"* next to the ticket instead of looking broken; the first order of the new day retires the note (E2E-pinned, staged with the control plane's own verbs)
- widgets fail alone (AC-12, NFR-09): error boundaries fence the ladder, the trade section and the demo panel — and the blotter and positions separately, so a broken grid cannot take the ticket down; keyboard reachability pinned in E2E (AC-13, NFR-13)
- optional `/sim/*` lock (T-1.0.2): `FX_SIM_SECRET` armed → `401` without the matching `x-sim-secret` (constant-time compare) while every data plane stays open; **off is the documented default** — the demo wants its world steerable
- README front door with the perf report, every number reproduced by `pnpm gate:perf` on the named reference machine: **50 082 updates/s** received, tick p95 **0.562 ms**, **3.62 MiB/s** JSON, flush p95 **0.003 ms** — and the §6.4 contrast finally measured on both wire shapes: **249 602 naive renders vs 313 coalesced on the same firehose (797×)**
- risk register (§14) re-walked: the secret-header row now states the lock exists; the production-caught firehose lesson (v0.4.1) got its own row
- the 5-minute runbook leads DEMO.md: one press of `scenario: demo-5min` plays spec §8, a table gives the human their beats (the render flips are yours; a `LAST_LOOK` bounce during the trade is §5.5 on stage); the local fallback verified end to end on a fresh clone
- rehearsals (`pnpm rehearse`): a fresh container (the exact deployed image) plus a fresh browser profile follow the runbook at ×1 — **two consecutive clean passes, zero page errors, zero manual fixes**, with beat-for-beat identical timelines (spike 0:35 · naive flip 1:30 · crash crossed 2:15 · all 11 steps · trade filled); one full pass over a deliberately bad link (400 ms RTT, ~1.6 Mbps, the **production build** — that is what the CDN serves) survived on the reconnect story: the 50k spike cannot fit that pipe, the guard cuts, the client returns, and the demo never needed a hand

## v0.4.1 — 2026-08-03

- fix: the unbatched firehose is capped at 16 frames per wire per tick (~2000/s). `batch:false` at 50k updates/s meant 50k `stringify`+`send` a second per client — the §6.4 pathology starved the free instance's 0.1 CPU until `/healthz` timed out and the platform killed the instance (caught live within hours of v0.4.0, exactly like the proxy-ETag catch of v0.3.1). The pathology still chokes a naive client dozens of times over — capped, it can no longer kill its own server; the model keeps its full rate and `sent`/`generated` tell the story in `/sim/stats`. Verified under the lethal combo: 50 009/s generated, ~1 000 frames/s on the wire, healthz answering in ≤2 ms.

## v0.4.0 — 2026-08-03

Control: the warm plane (plan §3, phase 3). The full order loop in the user's hands — GraphQL over the same socket, execution reports as a subscription, an AG Grid blotter that eats 5000-row bursts, the demo as data, and reconnects that cannot lie about money.

- warm plane (ADR-05): `graphql-ws` on the same process and port as `/feed`, routed by path; `submitOrder` acks before any outcome — even immediate rejections defer onto the next macrotask and arrive as **events**; `executionReports` subscription: every event exactly once, in order, enriched from the ledger registration (`pair`/`side`/`orderQtyK`) so a blotter needs no local registry
- ledger in `sim-core`: average-cost positions (extending averages in, reducing realises against the average, crossing reopens at the fill price), trades log, `orderMeta` for wire enrichment; P&L in pipette·K; 100 % coverage held
- the §7.3 P&L split on screen, asserted at the component: realised comes from the server and moves only with trade events (positions refetch exactly then); unrealised is the client's multiplication against the hot mid, ticking with every feed frame
- Apollo Client v4 over the one WS for all operations (the production HTTP/WS split point marked in code); subscription events route **past React state** into a coalescing store — the §6.4 lesson replayed on the warm side: without `ignoreResults` a burst capped the client at ~200 messages/s, with it the 5000-order burst lands in ~3 s
- AG Grid blotter (AC-10, AC-11): delta row updates keyed by `clOrdId` — the user's sort model and scroll offset survive the stream; `POST /sim/blotter { rows ≤ 5000 }` fills the books through the ordinary submit path from a third seeded PRNG stream (reseed replays the same burst) behind a crude 10 000-live-order ceiling; live: 5000 orders → 4344 filled + 656 IOC-canceled, 10 039 trades, feed flush p95 under the 16.7 ms budget throughout
- scenario engine: `POST /sim/scenario` plays spec §8 **as data** — eleven timeline rows (calm → spike → unbatched-and-back → crash → recovery → freeze → news → last look armed), each proven to parse through its own `/sim/*` schema; `speed` compresses offsets (×1 = the live five-minute demo, tests replay it in 2.4 s); `/sim/stats` narrates the play (`applied`/`steps`); identical twice from the same seed, a new play cancels the old
- subscription reconnect (ADR-08 retold on the warm plane): every report carries a dense per-order `eventSeq` stamped at publish — a repeat is provably a duplicate, a hole provably loss; recovery takes the `orders` snapshot wholesale and resumes events, the store queueing in-flight reports and deduplicating by arithmetic; `/sim/disconnect { graceful: false }` crashes the `/graphql` sockets too — the whole process "died"
- full-journey E2E: seed → scenario (crash included — both planes drop and recover mid-run) → order → `NEW` → partial → `FILLED` in the grid → long 500K with unrealised ticking → round-trip sell → flat with realised on screen; **10/10 consecutive green**, zero page errors

## v0.3.0 — 2026-08-02

The market can be traded against (plan §3, phase 2): the order lifecycle exists as data — scripted executions carrying a correct FIX event grammar — plus the cold plane. The engine room, proven honestly; the user-facing loop arrives with the warm plane in v0.4.

- FIX event model in `domain`: `ExecType` vs `OrdStatus` (event vs state, terminal `CANCELED`/`EXPIRED` included), the §5.6 machine as a total function, and one shared validator enforcing `CumQty + LeavesQty = OrderQty` at every TRADE of a live order
- scripted execution engine in `sim-core`: NEW after the last-look hold → 1..3 TRADEs priced from the **current** top of book slipped against the taker → FILLED, or an IOC leftover closed with CANCELED, or a rejection; **every report folds through the domain validator before leaving the module** — an inconsistent sequence cannot exist on any wire; 100 % coverage held
- last look (§5.5): `holdMs`/`rejectRate` via `POST /sim/lastlook`, the hold observable in `transactTime`; `rejectRate: 1` bounces everything with `REJECTED / LAST_LOOK`, `0` bounces nothing
- engine wired on a **derived-seed PRNG** — order flow cannot perturb the market stream, so `/sim/seed` bit-identity is independent of order timing; reseed = new trading day (ADR-10)
- `POST /sim/order` (dev harness door): server-truth freshness — a frozen pair answers `REJECTED / STALE_PRICE` at processing time no matter what the client believed (§7.3, the race built as a test); executions block in `/sim/stats`; `scripts/orders-burst.mjs` — live: 30 orders → 41 trades · 20 partials · 21 filled · 1 canceled · 8 rejected at rate 0.3
- cold plane: `GET /api/instruments` with a strong `ETag` and `Cache-Control: max-age=3600`; a matching conditional request costs headers only (`304`, empty body)
- catalogue over React Query: `staleTime` = server `max-age` via one shared domain constant; explicit `If-None-Match` revalidation — a remount inside the window issues zero requests, an expired one issues exactly one conditional answered `304` (MSW-proven)

*Named honestly (plan §3):* with scripted fills the executed price does not derive from displayed depth — slippage is a parameter, not a consequence; the real matching engine stays in the backlog with its withdrawn ADR.

## v0.2.0 — 2026-08-02

The failure toolkit and the render contrast (plan §3): every failure the architecture promises is now demonstrable on command, and the client render switch puts the real bottleneck on screen.

- catalogue grows to 12 pairs — majors, crosses, exotics (deliberately jumpy, wide-spread); the first five `pairId`s stay wire-frozen; `/sim/news` lands a mid jump and a spread widening together, decaying to the exact baseline over 10 s
- close-code contract complete: `1000`/`4000`/`4001`/`4002` with `POST /sim/disconnect` (graceful vs simulated crash, `afterMs`) and the one-threshold slow-client guard — a stalled consumer is cut with `4001` while every other wire stays dense and the tick never blocks (surviving half of ADR-09)
- client reconnect policy: per-code reaction table, exponential backoff capped at 10 s with full-range jitter; terminal closes surface the server's reason next to a **Reconnect** button
- `POST /sim/mode` (`batch:false` = one frame per update — the §6.4 pathology on demand), `POST /sim/freeze` (a pair goes quiet, the client marks it **stale**, not disconnected — AC-06), stats extended with `framesSent`/`batch`
- **the centrepiece**: the render switch — naive per-message notification vs one `requestAnimationFrame` flush per screen frame, with per-message and per-flush p95 instrumentation exported for the gate and shown live
- guardrails for the unattended link: client cap (503 with the reason stated), 30-minute session ceiling closing `1000` with "press Reconnect to continue"
- demo panel: every demo line of the release from the page alone — rate presets to 50k, batch/render toggles, news/freeze per pair, gap, disconnects, reseed, live server/client counters
- perf gate at target, both halves of AC-01 in CI: **50k updates/s sustained** (received 50 031/s), server tick p95 **0.639 ms**, **3.62 MiB/s** JSON wire cost recorded, client coalesced flush p95 **0.004 ms** via the sans-I/O replay harness

## v0.1.1 — 2026-08-02

- fix: the post-deploy smoke expected the v0.0.1 unconditional heartbeat; since v0.1.0 a wire opens with a SNAPSHOT and heartbeats only through silence — the smoke now asserts the snapshot. The v0.1.0 release run went red on exactly this check while the deploy itself was healthy.

## v0.1.0 — 2026-08-02

MVP: live prices end-to-end on the real network (plan §3).

- `domain`: instrument catalogue for the five majors, exact decimal↔pipette math with no floats near a price (ADR-06), strict Zod control-plane schemas
- `sim-core`: xoshiro128\*\* with serializable state; bounded-walk market behind `advance(now)` — record streams are slicing-invariant prefixes of one stream per (seed, commands); 100 % coverage gate on all four metrics
- `protocol` v1: SNAPSHOT/DELTA/HEARTBEAT frames, dense seq assembled last in the pipeline (§6.2), loud codec, recorded fixtures grown from seed 42
- feed-server hot plane: 8 ms tick, snapshot on connect, per-wire dense sequencing, silence-only heartbeats carrying the last seq (§6.3), close codes `1000`/`4002`
- control plane: `POST /sim/seed` (dense mid-stream snapshot to every wire), `/sim/rate`, `/sim/gap`, `GET /sim/stats` with tick percentiles; validation at the border with field-level 400s; CORS preflight
- web: sans-I/O stream core — arithmetic gap detector, heartbeat watchdog, idempotent upserts — plus a fixed 1 s reconnect shell; five-pair ladder with per-pair render isolation (NFR-03)
- `/docs`: OpenAPI + AsyncAPI generated from the live Zod schemas, drift-gated in CI
- first Playwright E2E — seed → ticks → gap → exactly one detection → clean resync, 10 consecutive passes, retries 0 — and perf gate v1 (5 k sustained: 5007/s received, p95 tick 0.23 ms, 369 KiB/s JSON baseline), both in CI

## v0.0.1 — 2026-08-02

Walking skeleton: the pipeline is the release (plan §3, v0.0.1).

- pnpm monorepo — `domain` / `sim-core` / `protocol` / `feed-server` / `web`, strict TS, the §2.4 command set green from the first commit
- dependency-boundary and sim-core purity lint rules, proven by executable fixtures
- feed-server: `GET /healthz`, `/feed` negotiating the `fx.v1` subprotocol (server-side 400 otherwise), one heartbeat frame per second, Origin allowlist from env, graceful close `1000`
- web placeholder: connection state, live heartbeat counter, the cross-origin healthz probe, cold-start wake button for the free instance
- CI on push/PR (typecheck + boundary lint + tests + build); tag-driven release: image → ghcr → Render deploy hooks (exact-tag `imgURL`) → post-deploy smoke with retries
- Render Blueprint (`render.yaml`): image-backed feed service (free plan) and the static site declared as code; ADR-11 revised Azure → Render
- deployed publicly: <https://fx-ladder-web.onrender.com> (feed: <https://fx-ladder-feed.onrender.com>)
