# Changelog

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
