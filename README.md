# FX Ladder

A synthetic FX trading demo built as a frontend showcase with a deliberately
minimal backend: a real-time WebSocket price feed with an honest liveness
contract (dense sequence numbers, heartbeats, provable gaps), a depth ladder
that prices the cost of size, an order lifecycle speaking the FIX event
grammar, a GraphQL warm plane for orders and positions, and a control plane
that lets tests and demos **command** the world instead of waiting for luck.
Everything deterministic by seed, everything measured, every failure
demonstrable on purpose.

**Live:** <https://fx-ladder-web.onrender.com> (free instance — the page
offers **Wake the server** after idle sleep; waking takes up to a minute).
API docs (OpenAPI + AsyncAPI, generated from the live Zod schemas):
[/docs](https://fx-ladder-web.onrender.com/docs/).

| Document | What it holds |
|---|---|
| [SYSTEM_MAP.md](SYSTEM_MAP.md) | where every file lives, what it owns, and which §/ADR holds its reason |
| [FX_LADDER_BUSINESS_SPEC_EN.md](FX_LADDER_BUSINESS_SPEC_EN.md) | product spec — FR/NFR/AC ids ([UA](FX_LADDER_BUSINESS_SPEC.md)) |
| [FX_BACKEND_ARCHITECTURE.md](FX_BACKEND_ARCHITECTURE.md) | backend architecture, ADRs, risk register |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | the release ladder and its execution backlog |
| [CHANGELOG.md](CHANGELOG.md) · [DEMO.md](DEMO.md) | what shipped, and one demo line per release |
| [DEPLOY.md](DEPLOY.md) · [CHAOS.md](CHAOS.md) | operations, and what a container death actually does |

## Quickstart

```bash
pnpm install
pnpm dev          # feed server + web, hot reload
pnpm verify       # typecheck + boundary/purity lint + tests (100% coverage gate on sim-core)
pnpm test:e2e     # Playwright against the local server only
pnpm gate:perf    # the performance gate below
pnpm chaos:drill  # SIGKILL the server mid-stream, watch clients come back
```

## Performance

Every number below is reproduced by one command — `pnpm gate:perf` — on the
reference machine (AMD Ryzen 9 9900X3D, 31 GB, node 24, Windows 11; CI runs
the same gate with headroom for shared-runner noise, and thresholds only
ratchet up — plan §4). Measured 2026-08-03, v1.0.0:

```
perf gate — thresholds v0.2.0, server window 8s after 2s warmup, client replay 5 simulated seconds
  fed updates/s                       50000
  received updates/s                  50050  >= 45000 (fx.v2)
  p95 server tick (ms)                0.356  <= 4
  wire fx.v2 (binary)             588 KiB/s  recorded, not gated
  wire fx.v1 (JSON)              3.62 MiB/s  6.3x the bytes of fx.v2
  client msg p95 (ms)                 0.001  <= 2 (JSON decode)
  client msg p95 v2 (ms)              0.000  <= 2 (binary decode)
  client flush p95 (ms)               0.003  <= 16.7 (60 fps budget)
  client frames replayed                625
  renders batched n/c             626 / 313  naive renders per message
  renders unbatched n/c        249602 / 313  797x — the §6.4 collapse as a number
  firehose msg p95 n/c (ms)   0.000 / 0.000  249601 messages replayed each
GATE GREEN
```

Reading it:

- **50k updates/s sustained** through one real WebSocket, with the server's
  8 ms tick at **p95 0.356 ms**.
- **One stream, two wires (ADR-12, v1.1.0):** the page negotiates the
  binary `fx.v2` — fixed 12-byte records, DataView decode — at **588 KiB/s**
  where the JSON `fx.v1` costs **3.62 MiB/s** for identical content: 6.3×
  fewer bytes, and the server tick got cheaper too (`JSON.stringify` was
  the dearer half). The demo panel's wire toggle shows the drop live; a
  v1-only client stays served forever.
- **The client pipeline holds the 60 fps budget**: the sans-I/O replay
  harness pushes the same firehose through the production stream core and
  store — coalesced flushes cost **p95 0.003 ms** against the 16.7 ms frame.
- **Naive versus coalesced is a 797× difference, measured.** On the batched
  wire a naive client renders per message (626 vs 313 — merely wasteful).
  Turn the wire into a frame per update (`POST /sim/mode {"batch":false}`)
  and naive renders **249 602 times** in five simulated seconds while the
  coalesced store still renders 313 — one per screen frame, no matter what
  the wire does. In a real DOM every one of those renders has a price,
  which is why the deployed demo panel's render switch chokes the page in
  seconds and the coalesced mode shrugs the same firehose off.
- Production cross-check (v0.2.0, real network, free instance): 50 070
  updates/s received, server tick p95 0.693 ms — the deployed instance and
  the reference machine tell one story. Historical measurements live in
  [tools/perf/thresholds.json](tools/perf/thresholds.json).
- **The same story live**: the demo panel draws the last 60 s as four
  small multiples — load (records/s) against its cost at each boundary
  (server tick p95, client renders/s, wire bytes/s). The gap between the
  load line and the cost lines is the claim above, watchable while you
  push the buttons that cause it.

## Stack

pnpm monorepo — `domain` / `sim-core` / `protocol` (pure TS, sans-I/O,
dependency direction lint-enforced) · Node + `ws` + `graphql-ws` feed server
· React 19 + Vite web with AG Grid, Apollo Client and React Query · Vitest
(+ fast-check, MSW) · Playwright · GitHub Actions → ghcr → Render.
