# Changelog

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
