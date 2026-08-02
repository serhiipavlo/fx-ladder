# FX Ladder Backend — Implementation Plan

> Companion to `FX_BACKEND_ARCHITECTURE.md`. The architecture document answers **what** we build and **why**; this plan answers **in what order**, sliced into shippable versions. Wherever the two disagree, the architecture document wins and this plan must be updated.

---

## 1. Goal and principles

The primary goal of this plan is **versioned delivery**: ship a deployed MVP as early as possible, then improve it in small, tagged, always-demonstrable increments. Concretely:

1. **Every version is deployed, not just deployable.** A tag that never reached the cloud is a rehearsal, not a release. The public link is live from the very first version and never goes dark afterwards.
2. **Every version has a demo.** Each release must add something a viewer can *see or trigger* — a new behavior, a new failure mode handled, a new number on the stats panel. If a release has no demo line, its scope is wrong.
3. **Riskiest integration first.** The most expensive risks in this project are integration risks (WebSockets surviving the cloud ingress proxy, CORS between the static-host and container domains, a container image that builds the same way everywhere). They are burned down in v0.0.1, while the system is nearly empty — not discovered a day before the show. This is the walking-skeleton rule from architecture §13, promoted to a release of its own.
4. **The system is whole at every tag.** No release ships "half a plane". A data plane either exists end-to-end (server → wire → client) or is explicitly absent. Half-built verticals are allowed on branches, never on `main`.
5. **Quality ratchets, never loosens.** Test coverage rules, perf-gate thresholds and lint boundaries only tighten from version to version. A threshold, once raised, does not come back down to make a release easier.

**The server is a stand, not the exhibit.** This backend exists to generate real *frontend* problems — a live stream to survive, connection states to handle, cached REST to reconcile, typed order events to assemble, a grid to keep responsive. The 50 000 updates/s target follows from that, and not from server pride: it is the input rate at which the browser starts to break, which is exactly the problem the client-side work exists to solve. The server must therefore *deliver* 50k; making that delivery more elegant than delivery requires is no longer its job. Server-side engineering stops at the point where the browser becomes the bottleneck; past that line, more server work stops producing client problems. That is why several mechanisms an FX feed would normally carry (binary wire format, conflation, slow-consumer policy, a real matching engine, session-driven volatility) are **not in this ladder but in the post-1.0 backlog** (§5), each with a withdrawn ADR in the architecture document stating context, reason and price. They are deferred, not overlooked — and saying so out loud is part of the deliverable.

---

## 2. Versioning and release mechanics

### 2.1 Version scheme

Semantic-versioning shape, pre-1.0 semantics:

| Segment | Meaning here |
|---|---|
| `0.x.0` (minor) | A new capability slice: a plane, an engine, a scenario toolkit. Each maps to a row in the release ladder (§3). |
| `0.x.y` (patch) | Fixes and hardening inside the current slice. No new user-visible capability. |
| `1.0.0` | "Demo-ready": the full 5-minute scripted demo runs twice in a row from a clean state with zero manual intervention. |

**App version ≠ wire protocol version.** The wire protocol version is negotiated once at the WebSocket handshake, as the subprotocol name (`fx.v1`) — the 16-byte frame header stays version-free (architecture §6.1). It bumps *only* on a breaking wire change, independently of app releases. Client and server ship together, so outside deploy windows exactly one protocol version is live at a time; the subprotocol check makes accidental mismatch loud — an incompatible client fails the handshake and prompts a page reload instead of decoding garbage. Rule of thumb: adding a new frame type = new app minor, same protocol version (clients skip unknown frame types); changing the layout of an existing record = protocol version bump, called out in the changelog in bold.

### 2.2 Git and release flow

- **Trunk-based development.** Short-lived branches into `main`; `main` is always green and always deployable. No long-running `develop` branch — with a team of one it only manufactures merge conflicts.
- **Conventional commits** (`feat:`, `fix:`, `perf:`, `test:`, `docs:`) — the changelog is generated, not remembered.
- **Release = annotated tag `vX.Y.Z`** → GitHub Release with generated changelog → GitHub Actions deploys: feed-server image to ghcr and then to the Render web service via a deploy hook pinning the exact image tag; web via the Render static-site hook (Render builds it with `VITE_FEED_URL`). A post-deploy smoke check (open page, `/healthz`, one WS handshake, one heartbeat received) must pass or the release is marked failed.
- **PR previews**: Render builds a preview environment per pull request for anything touching `web` — free review builds, per architecture §9.
- **Rollback is a first-class path**: every image is tagged by version in ghcr, and the Render deploy hook redeploys whichever tag it pins (the dashboard keeps previous deploys too). Rolling back = re-deploying the previous tag. Practiced once deliberately in v0.0.1 so the first real rollback is not also the first attempt.
- **Two deploy tracks, one wire protocol.** Web (static site) and server (container) roll out independently, so every deploy has a short window where new web talks to old server or vice versa. For ordinary releases this is a seconds-long blip — clients recover via reconnect + snapshot. A release that bumps the protocol version deploys **paired** (server first, web immediately after) and rolls back paired too; the client's reaction to a failed `fx.vN` handshake is a "reload page" prompt, never a blind retry. PR previews always talk to the production backend — a preview of a protocol-changing PR is expectedly broken; known and accepted, not a bug.

### 2.3 Definition of Done — every release

A tag may be cut only when all of the following hold:

- [ ] CI green: typecheck, boundary linter, unit + property tests, protocol roundtrip fuzz
- [ ] `sim-core` coverage at 100 % for everything that exists (cheap by construction — architecture §4, §11)
- [ ] Perf gate passes at the threshold **of this release** (from v0.1.0 on; thresholds per §3; ratchet-only)
- [ ] Deployed to the public URLs (Render); post-deploy smoke check green
- [ ] `CHANGELOG.md` updated; demo line for the release written down in `DEMO.md`
- [ ] Any reversed or revised decision reflected in the ADR list (as was done for ADR-03)

---

### 2.4 Execution conventions — read before writing code

This plan is meant to be executed task by task (§7), in short independently verifiable steps. Everything below is fixed so that no task requires a taste decision.

**Stack — pinned, do not substitute.**

| Layer | Choice |
|---|---|
| Runtime | Node 22 LTS, ESM throughout |
| Language | TypeScript, `strict: true`; no `any` in a package's public API |
| Workspace | pnpm workspaces |
| Server | Node `http` + `ws` — no web framework, no uWS (architecture §7.1) |
| Client | Vite + React + TypeScript |
| Validation | Zod, schemas in `domain`, imported by both sides |
| Unit + property tests | Vitest + fast-check |
| E2E | Playwright |
| Client-side mocks | MSW (REST and GraphQL) |
| Warm plane | `graphql-js` + `graphql-ws` (server), Apollo Client (client) |
| Cold plane | TanStack React Query |
| Blotter grid | AG Grid Community |

Any dependency outside this list needs one line in the PR body: what it replaces and why the pinned option failed.

**Layout, ports, env.** Packages `packages/domain`, `packages/sim-core`, `packages/protocol`; apps `apps/feed-server`, `apps/web`. Server listens on `:8080` and serves every path (`/healthz`, `/feed`, `/graphql`, `/api/*`, `/sim/*`). Web dev server on `:5173` proxies those paths to `:8080`, so local development sees one origin and zero CORS. The deployed client reads the backend origin from `VITE_FEED_URL` at build time.

**Commands.** These exist from the first task and stay green afterwards:

```bash
pnpm verify
```

`verify` = typecheck + lint (including the dependency-boundary rules) + unit tests. It is the gate every task ends on. Alongside it: `pnpm dev` (server + web together), `pnpm test`, `pnpm test:e2e`, `pnpm gate:perf` (prints measured numbers, exits non-zero on regression), `pnpm build`.

**Invariants enforced by the build, not by review.** A violation must fail `pnpm verify`, not wait for a human:

- `sim-core` imports nothing from Node, the DOM or timers, and calls neither `Date.now()` nor `Math.random()` — time and randomness arrive as arguments (architecture §4).
- Dependency direction: `domain` ← {`sim-core`, `protocol`} ← apps. Apps never import each other.
- Prices are integers (pipettes) everywhere except the render formatter (ADR-06).
- `seq` is assigned last in the send pipeline, immediately before frame assembly (architecture §6.2).
- Warm-plane events are never merged, reordered or dropped (architecture §7.3).
- A wire-format change bumps the subprotocol (`fx.vN`) in the same commit that changes both sides.

**Task shape.** One task = one branch = one PR-sized change: ideally ≤ 10 files, always ending with `pnpm verify` green *and* the task's own "Done when" checks satisfied. Tasks within a release are ordered; do not start the next one before the previous is green, unless §7 marks them as parallel.

**When the documents do not answer a question.** Implement the smallest thing that satisfies the "Done when" checks and record the assumption in the PR body under `Assumptions:`. Do not invent scope, do not add configuration knobs "just in case", and never weaken a check to make it pass. Stop and ask only when the answer would change a **contract** — wire format, endpoint body, close code, dependency direction, or a published threshold; those are the genuinely blocking questions and there are few of them.

**Never:** commit with CI red; `.skip()` a test to get green; lower a perf threshold (that needs an ADR, §4); relax a `sim-core` invariant to make a test pass; introduce a mock inside `sim-core` tests (if one seems necessary, the code under test has an I/O dependency it must not have).

---

## 3. Release ladder

Overview — how releases map onto the architecture's phases (§13):

| Version | Architecture phase | One-line goal |
|---|---|---|
| v0.0.1 | pre-phase (skeleton) | Pipeline and public link exist; integration risks dead |
| v0.1.0 | Phase 1, slice A | **MVP: live prices end-to-end on the real network** |
| v0.2.0 | Phase 1 complete | Full failure toolkit + the render contrast on screen |
| v0.3.0 | Phase 2 | The market acts: scripted executions, last look, cold plane |
| v0.4.0 | Phase 3 | The user controls: warm plane, orders, blotter, scenarios |
| v1.0.0 | Hardening | Scripted 5-minute demo, chaos-tested, documented |

The architecture's Phase 1 is deliberately split into two releases: v0.1.0 proves the *vertical* (every layer present, thin), v0.2.0 proves the *failure and rendering story* (every layer honest). Shipping the vertical early is the whole point of the plan.

---

### v0.0.1 — Bootstrap: the walking skeleton

**Goal.** A public link that works, a pipeline that ships, and the three expensive integration risks — WS through the cloud proxy, CORS between the static host and the container, and a reproducible image build — proven dead while the codebase is ~200 lines.

**Scope.**
- pnpm monorepo scaffold: `domain` / `sim-core` / `protocol` / `feed-server` / `web`, with the dependency-boundary linter active from the first commit (architecture §4: rules that fail the build don't erode).
- `feed-server`: Node `http` + `ws` serving `/healthz` and a trivial `/feed` WS that sends one heartbeat frame per second — just enough traffic to prove the proxy path and idle-timeout behavior.
- `web`: placeholder page that connects to `/feed`, shows connection state, and makes one cross-origin `fetch` to `/healthz`, printing the result. The WS handshake only proves the Origin allowlist — CORS lives on the fetch path, and without this call the third integration risk would survive the release unproven.
- CI: typecheck, lint, unit-test job (trivial tests), Docker build, push to ghcr.
- CD: deploy the container and the static site; post-deploy smoke check; free-plan limits written down (750 instance-hours/month, egress allotment) — no payment method attached, so overrun halts the service instead of billing.
- Local dev loop verified on Windows (the actual dev machine): pure-JS `ws` means no native module and no prebuilt-binary hunt — this is one of the reasons it was chosen (architecture §7.1).
- One deliberate rollback exercised and timed.

**Demo.** Open the link on a phone: page loads, shows "connected", heartbeat counter ticks. Unimpressive on purpose — the demo *is* the pipeline.

**Exit criteria.** Public URL serves the page over the real network; `wss://` handshake succeeds through the ingress; the cross-origin `/healthz` fetch succeeds from the static-site page; CI green on a PR; rollback to the previous image tag verified.

**Explicitly out.** Any market model. Any real protocol beyond the heartbeat frame.

---

### v0.1.0 — MVP: live prices end-to-end

**Goal.** The smallest release a recruiter could be shown without apology: real FX pairs ticking live over a batched WebSocket feed on the public URL, with correct resync after a network loss. This is the MVP the rest of the plan improves.

**Scope.**
- `domain`: instrument set for ~5 majors; integer-pipette price math (ADR-06); ids and Zod schemas for the control-plane bodies that exist this release.
- `sim-core`: seeded PRNG (xoshiro128, `Math.random` banned by lint); bounded random walk around a per-pair anchor + fixed per-pair spread; `advance(now)` shape final — time is an argument from day one (architecture §4, §5.1–5.2).
- `protocol` v1: JSON frames — small header + array of same-shaped records; heartbeat frames; subprotocol `fx.v1` negotiated at handshake. **Sequence numbers are assigned last in the send pipeline** (architecture §6.2), and the dense-seq test exists now: it is the contract the gap detector rests on, and anything that thins the stream later must go to the left of it.
- `feed-server`: `/feed` hot plane — snapshot on connect, per-tick batching, heartbeat 1 s, close codes `1000` and `4002`, Origin allowlist.
- Control plane: `POST /sim/seed`, `POST /sim/rate` (capped low for now), `POST /sim/gap` (skip N seqs — pulled forward from v0.2, see demo), `GET /sim/stats` (generated / sent, plus per-tick duration percentiles — the numbers the perf gate reads; a gate that measures nothing gates nothing).
- `web`: connect, decode, top-of-book ladder for the 5 pairs; seq-gap detector → full resnapshot (ADR-08); heartbeat-timeout watchdog (no heartbeat > N s = connection dead); basic auto-reconnect with a fixed 1 s retry — full backoff + jitter arrives with the close-code table in v0.2, but without *some* reconnect the demo line below cannot happen.
- Tests: property invariants for everything that exists (prices on the pipette grid, bid < ask, same seed → bit-identical stream); protocol encode→decode roundtrip fuzz; frame fixtures recorded here — they become the client-side test doubles and the replay harness later (architecture §11); first Playwright E2E against the **local feed-server** (per revised ADR-03): seed → connect → ticks visible → `/sim/gap` → detector fires → clean resync — deterministic, no network tricks.
- Perf gate v1: modest, honest threshold (sustained 5k updates/s, p95 tick duration within budget, bytes/s recorded as a baseline). CI thresholds carry deliberate headroom — shared runners are noisy, and a tight absolute gate turns neighbour noise into false reds; the ratcheted "honest numbers" are measured on one fixed local machine per release. The 50k target belongs to v0.2; gates only ratchet up.

**Demo.** Open the link: five pairs tick live. DevTools shows one batched frame per tick instead of a message per update. Kill wifi, restore — the heartbeat watchdog declares the feed dead, the client reconnects and resnapshots. Then `/sim/gap` on a live connection — the seq detector proves the loss arithmetically and recovers the same way. Prices correct, no duplicates, no frozen ghosts.

**Exit criteria.** Demo above works on the deployed instance; E2E and perf gate green in CI; `/sim/seed` makes two runs bit-identical locally.

**Explicitly out.** Depth beyond a few levels, orders of any kind, GraphQL, REST catalog, the client naive-mode switch (v0.2).

---

### v0.2.0 — The failure toolkit and the render contrast

**Goal.** Complete Phase 1: every failure the architecture promises to handle becomes demonstrable on command, and the release's centrepiece — the client-side naive/coalesced render switch — puts the real bottleneck on screen.

**Scope.**
- `sim-core`: full instrument set including crosses (simulated independently — triangular coherence is backlog, architecture §5.2); a few depth levels per side (§5.4); `/sim/news` drives the price jump together with the spread widening (§5.3).
- Close-code contract complete: `1000` / `4000` / `4001` / `4002` with the client reaction table from §7.1; backoff + jitter replace the v0.1 fixed-interval retry.
- Slow-client guard (architecture §7.1, partially withdrawn ADR-09): one `bufferedAmount` threshold → close `4001`; recovery is the existing reconnect-and-resnapshot path. No snapshot-only degradation mode — that is the part the ADR withdraws.
- Control plane completed for Phase 1: `/sim/mode` (`batch` on/off — the server half of the contrast), `/sim/disconnect` (graceful vs hard), `/sim/freeze`, `/sim/news` (`/sim/gap` already shipped in v0.1.0); `/sim/stats` full (generated / sent, current rate, clients, tick duration).
- **The release's star — the client render switch** (§6.4): `setState` per record versus coalescing a whole frame into one `requestAnimationFrame` pass. Combined with the server `batch` flag it gives four combinations and one visible conclusion: the bottleneck lives between the socket and the render, not on the wire.
- Public-endpoint guardrails (architecture §8): cap on concurrent WS clients, and a session ceiling per connection — after ~30 min the server closes with `1000` and the client offers "session ended — continue". The public link is unattended from v0.0.1 on; from this release an abandoned tab stops holding a connection open indefinitely.
- `web`: demo/stats panel — connection state, the `/sim/*` switches, the render-mode toggle, live counters. The demo lines below stop depending on curl and DevTools.
- Perf gate at target: **50k updates/s sustained**, p95 server tick within budget, ~6 MB/s on the wire recorded as the honest JSON cost (architecture §6.1), and **p95 client frame-handling time inside the 60 fps budget** — both halves of AC-01.

**Demo.** From the demo panel: `/sim/rate 50000` — smooth. Flip the client to naive per-message rendering — the interface stutters within seconds, then flip back. `/sim/news GBPUSD` — spike and spread widening ripple through the ladder. `/sim/disconnect` hard — the client shows the right state and reconnects with backoff. `/sim/freeze USDJPY` — one pair goes stale while the channel stays provably alive.

**Exit criteria.** Perf gate at full threshold green in CI and reproduced once against the deployed instance manually; every `/sim/*` endpoint above drives a visible behavior; the render switch produces a difference a viewer sees without instrumentation.

**Explicitly out.** Anything that trades. Conflation, slow-consumer policy, binary codec and the session model stay in the backlog (§5).

---

### v0.3.0 — Action: the market can be traded against

**Goal.** Phase 2: the order lifecycle exists as data — scripted executions carrying a correct FIX event grammar — plus the cold plane. The machine becomes *capable* of action; the user-facing order loop arrives in v0.4, so this release proves the event model honestly (tests, stats, dev harness) rather than wiring a throwaway transport that ADR-05 would forbid anyway.

**Scope.**
- Scripted execution module (§5.5, per withdrawn ADR-04): an order expands into a defined sequence of events — `NEW` → partial → partial → `FILLED`, or a rejection; fill prices come from the current top of book with a configurable offset; an IOC leftover terminates with `CANCELED`. Property suite: `CumQty + LeavesQty = OrderQty` at every `TRADE` of a live order; every sequence reaches exactly one terminal state; shrinking-friendly generators (fast-check).
- Last look (§5.5): `holdMs` and `rejectRate`, controlled via `POST /sim/lastlook` — this is what creates the "submitted, waiting" state the ticket has to render and resolve.
- Cold plane: `GET /api/instruments` with `ETag` / `304` / `Cache-Control` — the React Query contract from §7.2, visible in DevTools.
- Server-side freshness re-check on the order path implemented and unit-proven (client blocks stale sends as UX; the server is the truth — §7.3).
- FIX-dictionary event model in `domain`: `ExecType` (event) vs `OrdStatus` (state) with the state machine from §5.6, including the consistency note (terminal `CANCELED`/`EXPIRED` in the enum).

**Demo.** Instruments load once, then `304` on refresh — visible in DevTools, with React Query's `staleTime` lined up against the server's `max-age`. The engine room: property suite green, a dev harness submits a burst of synthetic orders and `/sim/stats` shows fills, partials and rejects moving; turn `rejectRate` up via `/sim/lastlook` and the same burst starts bouncing after its hold window.

**Exit criteria.** Event-grammar property suite green with 100 % coverage of the execution module; last-look rejects observable and tunable; `304` path verified on the deployed instance.

**Explicitly out.** GraphQL, subscriptions, blotter, P&L.

*Named honestly:* with scripted fills the executed price no longer derives from the depth the ladder displays, so FR-06's "cost of walking the volume" is indicative rather than exact. The real matching engine in the backlog (§5) is what would close that gap; until then this is a stated limitation, not an unnoticed one.

---

### v0.4.0 — Control: the warm plane

**Goal.** Phase 3: the full order loop in the user's hands — GraphQL over the same port, execution reports as a subscription, blotter and positions, and the one-call scripted demo.

**Scope.**
- `graphql-ws` on the same process and port as `/feed`, routed by path (ADR-05): `submitOrder` mutation; `executionReports` subscription (every event exactly once, in order — never merged or dropped, §7.3); `trades` / `positions` queries.
- P&L split per §7.3: realised — server-side on the warm plane; unrealised — client-side from the hot mid.
- Subscription reconnect semantics: resubscribe + state reconciliation on reconnect, consistent with ADR-08's snapshot philosophy.
- `POST /sim/blotter` (e.g. 5000 rows — the AC-11 load for the grid) and `POST /sim/scenario` (`demo-5min`: the entire scripted show as data, §8).
- E2E grows to the full journey: `/sim/seed` → `/sim/scenario` → submit order → `NEW` → partial fill → `FILLED` visible in UI — still against the local feed-server only.

**Demo.** Submit an order into a moving book: ack, partial, fill — each as a typed event in the blotter, position and realised P&L update; unrealised P&L ticks with the hot mid between events. Then `/sim/scenario demo-5min` runs the whole show from one call.

**Exit criteria.** Full-journey E2E green in CI; a subscription survives a forced reconnect without losing or duplicating an execution report; blotter burst renders without dropping the hot plane.

**Explicitly out.** New market features — this release is transport and control, not model.

---

### v1.0.0 — Demo-ready hardening

**Goal.** Not a feature release. The system becomes *presentable under stress*: chaos-tested, documented, and rehearsed.

**Scope.**
- Chaos drills: kill the container mid-stream — clients reconnect with jittered backoff (no thundering herd, §7.1) and resnapshot cleanly; a restart is documented as "a new trading day" (ADR-10), written where a viewer sees it.
- Optional secret header on `/sim/*` behind a flag (the one-hour hardening from §8/§14) — default off for the public demo, documented.
- Perf report with measured numbers (sustained rate, p95 server tick, p95 client frame time, naive versus coalesced) published in the README; risk register (§14) re-walked and updated.
- `DEMO.md` runbook: the 5-minute script step by step, plus the fallback path per revised ADR-03 — the same server run locally (`docker run` / dev mode) if the venue's network or the cloud fails.
- ADR set finalized; changelog complete since v0.0.1.

**Exit criteria.** The scripted demo executed **twice in a row from a clean state** (fresh container, fresh browser) with zero manual fixes; one full rehearsal over a deliberately bad network (throttled) survives on the strength of the reconnect story.

---

## 4. Ways of working (cross-cutting, every release)

- **Tests lead for streams and states.** Property invariants are written as the executable spec *before* the implementation they constrain (architecture §11) — for sim-core, the execution event grammar and the seq contract this order is the shortest path, not ideology.
- **The perf ratchet.** Thresholds are versioned in the repo next to the gate script. CI thresholds keep headroom for shared-runner noise; the ratchet itself tracks numbers measured on one fixed reference machine. Raising one is a `perf:` commit with the new number; lowering one requires an ADR.
- **ADR discipline.** Any reversal or material revision of a recorded decision updates the ADR list in the architecture document (pattern already set by ADR-03's revision). The plan links to ADRs, never restates them.
- **One vertical per branch.** A branch delivers a runnable slice of the current release, merges within days, and dies. If a branch outlives a week, its scope was a release, not a task.
- **Docs move with code.** A capability lands together with its section updates and its demo line; "document later" is treated as scope creep in reverse.

---

## 5. Post-1.0 backlog (candidates, unscheduled)

Held deliberately out of scope until the demo goal is met. The first block is what the v-min cut removed: **narrative upgrades for an architecture conversation, not conditions for meeting the project's goals** — each has a withdrawn ADR or an explicit paragraph in the architecture document stating why it was dropped and what it costs. Each would be a `1.x` minor with its own demo line.

Cut in v-min, recoverable:

- **Binary wire format** (fixed-length records, DataView decode) plus the contrast measurement against JSON: ~6 MB/s → ~800 KB/s at 50k updates/s. A wire-version bump (`fx.v2`) and a real numbers exhibit.
- **Conflation** — merging repeated updates of one key before the wire, with `conflatedTotal` telemetry; roughly halves frame size at 50k. Re-adopting it means re-adopting withdrawn ADR-07: the merge step goes *left* of sequence numbering, or the gap detector breaks.
- **Graceful slow-consumer degradation** (the withdrawn half of ADR-09): snapshot-only mode as a step before closing `4001`, so a weak client gets a coarser stream instead of a disconnect. Matters once there is a real multi-client audience.
- **Market microstructure**: Ornstein–Uhlenbeck mid with a jump component, session curves (Sydney → Tokyo → London → NY with the overlap), session-driven tick frequency and `/sim/timescale`, triangular cross coherence.
- **Real matching engine** (withdrawn ADR-04): price-time priority walk, VWAP fills, slippage and partials as arithmetic consequences of depth rather than script parameters.

Never in scope, still interesting:

- Additional scripted scenarios beyond `demo-5min` (e.g. a "central-bank day").
- Control-plane auth on by default (secret header), if the demo ever runs unattended for long periods.
- External load rig (k6/artillery) driving the deployed instance for a published stress report — distinct from the in-CI perf gate, which stays local by design (§11).
- Broader instrument universe (metals, exotics) with per-class volatility profiles.

---

## 6. Traceability: releases ↔ architecture

| Version | Implements sections | ADRs exercised | Spec anchors touched |
|---|---|---|---|
| v0.0.1 | §4 (skeleton), §9 | ADR-01, ADR-11 | NFR on live link / real network |
| v0.1.0 | §3, §5.1–5.2, §6.1–6.3, §7.1 (partial), §8 (partial) | ADR-02, ADR-03 (revised), ADR-06, ADR-08 | NFR-08 (gap detect), AC-05, NFR-10 starts |
| v0.2.0 | §5.2–5.4, §6 (full, incl. §6.4), §7.1 (full), §8 | ADR-09 (the surviving threshold half); ADR-07 withdrawn — see §5 | NFR-01/02, NFR-06/07, FR-05/06, AC-01, AC-04, AC-06 |
| v0.3.0 | §5.5–5.6, §7.2, §7.3 (stale re-check) | ADR-06 (fill prices in pipettes); ADR-04 withdrawn | FR-11, FR-23 |
| v0.4.0 | §7.3, §8 (scenario, blotter) | ADR-05, ADR-10 | FR-20 context, AC-11 |
| v1.0.0 | §9, §11, §14 | all revisited | full demo script (spec §8) |

---

## 7. Execution backlog

Atomic tasks in execution order, grouped by release. Each has a **deliverable** (what exists afterwards, by path) and **done when** (checks that decide it, without judgement). Conventions, pinned stack and the standing invariants are in §2.4; the *why* behind every contract is in the architecture document — read the referenced section before implementing, not after.

Tasks marked ∥ may run in parallel with the previous one; everything else is sequential.

### v0.0.1 — Bootstrap

**T-0.0.1 · Monorepo scaffold**
*Deliverable:* root `package.json`, `pnpm-workspace.yaml`, shared `tsconfig.base.json`, the five package directories with stub entry points, and the §2.4 command set.
*Done when:* `pnpm install` and `pnpm verify` both pass on a clean checkout; every package typechecks with `strict: true`.

**T-0.0.2 · Boundary and purity rules**
*Deliverable:* lint configuration enforcing the dependency direction plus a ban on `Math.random`, `Date.now`, `setTimeout`/`setInterval` and Node built-ins inside `sim-core`.
*Done when:* a deliberately added violating import fails `pnpm verify`; removing it makes verify pass again. Include that check as a test fixture, not as a manual note.

**T-0.0.3 · feed-server skeleton**
*Deliverable:* `apps/feed-server` — Node `http` + `ws`; `GET /healthz` returning JSON; `/feed` accepting the `fx.v1` subprotocol and sending one heartbeat frame per second; `Origin` allowlist from env.
*Done when:* a `ws` client with subprotocol `fx.v1` receives ≥ 3 heartbeats in 3.5 s; a client offering `fx.v0` is rejected at handshake; a request with a disallowed `Origin` is refused. All three as tests.

**T-0.0.4 · web placeholder** ∥
*Deliverable:* `apps/web` — page that connects to `/feed`, shows connection state and a heartbeat counter, and performs one cross-origin `fetch` of `/healthz`, printing the result.
*Done when:* against a locally running server the page shows "connected", the counter increments, and the fetch result renders. The fetch must be genuinely cross-origin in the deployed build (that is the CORS proof — the WS handshake does not provide it).

**T-0.0.5 · CI**
*Deliverable:* GitHub Actions workflow running install → `pnpm verify` → `pnpm build` on push and PR.
*Done when:* the workflow is green on a PR, and a deliberately broken test turns it red.

**T-0.0.6 · Image, deploy, smoke**
*Deliverable:* multi-stage `Dockerfile` for `linux/amd64`; ghcr push; deploy jobs for the container and the static site; `scripts/smoke.mjs` checking page load, `/healthz`, one WS handshake and one heartbeat.
*Done when:* a tag deploys both tracks and the smoke script exits 0 against the public URLs; a forced smoke failure marks the release failed.

**T-0.0.7 · Rollback drill**
*Deliverable:* `DEPLOY.md` with the exact rollback commands and the measured time of one deliberate rollback.
*Done when:* the previous revision has actually served traffic once and the elapsed time is written down.

### v0.1.0 — MVP

**T-0.1.1 · `domain` foundations**
*Deliverable:* instrument catalogue for ~5 majors (`symbol`, `base`, `quote`, `precision`, `pipDigit`, `lotSizeK`, `minQtyK`, `tier`); pipette conversion and formatting; Zod schemas for the control-plane bodies of this release.
*Done when:* property test — `format(toPipettes(x)) === x` across generated valid prices for every instrument; every schema rejects at least one malformed body in tests.

**T-0.1.2 · Seeded PRNG**
*Deliverable:* xoshiro128 in `sim-core` with serializable state.
*Done when:* same seed → identical sequences (property test); state restored mid-sequence continues identically; no global randomness anywhere (guaranteed by T-0.0.2).

**T-0.1.3 · Market model and `advance(now)`**
*Deliverable:* market state plus the single entry point `advance(now)` returning the events since the previous call: bounded walk around a per-pair anchor, fixed per-pair spread, book of a few levels per side (architecture §5.2–5.4).
*Done when:* property suite green — best bid < best ask always; every price on the pipette grid; identical `(seed, sequence of now values)` produce a bit-identical event stream; `sim-core` coverage 100 %.

**T-0.1.4 · `protocol`**
*Deliverable:* frame types (`SNAPSHOT`/`DELTA`/`HEARTBEAT`), header and record shapes from architecture §6.1, encode/decode, `fx.v1` constant.
*Done when:* roundtrip fuzz (encode→decode returns the input) over generated frames; assembling a frame from N records yields `firstSeq…firstSeq+N-1` with no holes — the dense-seq test, which is the gap detector's contract.

**T-0.1.5 · Hot plane on the server**
*Deliverable:* 5–10 ms tick loop; snapshot frame on connect; delta frames per tick; heartbeat during silence; close codes `1000` and `4002`; sequence numbers assigned last in the pipeline.
*Done when:* an integration test with a real `ws` client sees snapshot-then-deltas, dense `seq` across frames, a heartbeat during an idle second, and code `1000` on graceful shutdown.

**T-0.1.6 · Control plane v1**
*Deliverable:* `POST /sim/seed`, `POST /sim/rate`, `POST /sim/gap`, `GET /sim/stats` (generated, sent, current rate, client count, tick-duration percentiles), all bodies validated by the `domain` schemas.
*Done when:* invalid bodies return 400 with a field-level reason and never reach the simulator; `/sim/gap {skipSeqs:40}` produces exactly one hole of 40 on the wire; `/sim/stats` reports a non-zero p95 tick duration under load.

**T-0.1.7 · Client stream layer**
*Deliverable:* `apps/web` stream module — connect, decode, apply upserts to pair state, gap detector → request snapshot, heartbeat watchdog, fixed-interval reconnect.
*Done when:* unit tests over the T-0.1.9 fixtures — a gap fixture raises exactly one detection and one resnapshot; a heartbeat-silence fixture marks the connection dead within the threshold; applying the same record twice changes nothing (idempotence).

**T-0.1.8 · Ladder UI** ∥
*Deliverable:* top-of-book ladder for the 5 pairs, per-instrument formatting, stale/disconnected states visible.
*Done when:* rendering is driven only by the stream layer's state; a single pair's update does not re-render the others (assert with a render counter — this is NFR-03's first checkpoint).

**T-0.1.9 · Frame fixtures**
*Deliverable:* recorded frame sequences under `packages/protocol/fixtures` — normal stream, stream with a gap, stream with a mid-stream snapshot, heartbeat-only silence.
*Done when:* fixtures are generated by a committed script from a fixed seed (regenerable, not hand-edited) and are consumed by T-0.1.7's tests.

**T-0.1.10 · First E2E**
*Deliverable:* Playwright spec against a locally started feed-server: `/sim/seed` → connect → ticks visible → `/sim/gap` → gap notice → resync.
*Done when:* the spec passes 10 consecutive runs with no retries configured. Flakiness here means a determinism bug, not a flaky test.

**T-0.1.11 · Perf gate v1**
*Deliverable:* `pnpm gate:perf` feeding 5k updates/s, measuring p95 tick duration and bytes/s; thresholds in a versioned file next to the script.
*Done when:* the gate prints its numbers, passes at the v0.1 threshold, and fails when the threshold is halved.

### v0.2.0 — Failure toolkit and render contrast

**T-0.2.1 · Full instrument set and news**
*Deliverable:* complete pair list; `/sim/news` applying a price jump plus a decaying spread multiplier.
*Done when:* after a news command the spread of the target pair widens by the requested factor and returns to baseline; other pairs are untouched.

**T-0.2.2 · Close-code contract and slow-client guard**
*Deliverable:* codes `1000`/`4000`/`4001`/`4002` server-side; `POST /sim/disconnect` (graceful vs hard); one `bufferedAmount` threshold → close `4001` (architecture §7.1).
*Done when:* each code is produced by a test that triggers its cause; an artificially stalled consumer is closed with `4001` while a second client keeps streaming without interruption — the tick never blocks.

**T-0.2.3 · Client reconnect policy**
*Deliverable:* backoff with jitter replacing the fixed retry; per-code reaction table from architecture §7.1.
*Done when:* `1000` produces no reconnect; `4000` reconnects with growing, jittered delays (assert non-constant intervals); `4002` stops and surfaces a protocol error.

**T-0.2.4 · Control plane complete**
*Deliverable:* `/sim/mode` (`batch` on/off), `/sim/freeze`, `/sim/stats` extended; all Zod-validated.
*Done when:* `batch:false` produces one frame per update (assert frame count ≈ update count); `/sim/freeze` stops one pair's updates while heartbeats continue — the client marks it stale, not disconnected.

**T-0.2.5 · Render switch — the release's centrepiece**
*Deliverable:* client toggle between per-record state updates and coalescing a whole frame into one `requestAnimationFrame` pass; instrumentation of per-frame handling time.
*Done when:* at 50k updates/s the coalesced mode holds p95 frame handling inside the 60 fps budget and the naive mode measurably does not; both numbers are exported for the perf gate and shown in the panel.

**T-0.2.6 · Public-endpoint guardrails**
*Deliverable:* cap on concurrent WS clients; per-connection session ceiling (~30 min) closing with `1000` plus a "continue" affordance in the UI.
*Done when:* the (N+1)-th client is refused with a stated reason; a connection past the ceiling closes with `1000` and the UI offers to resume rather than reconnecting silently.

**T-0.2.7 · Demo panel** ∥
*Deliverable:* panel with connection state, the `/sim/*` controls, the render toggle and live counters.
*Done when:* every demo line of v0.2.0 can be performed from the panel alone — no curl, no DevTools.

**T-0.2.8 · Perf gate at target**
*Deliverable:* gate raised to 50k updates/s, recording p95 tick, bytes/s (~6 MB/s expected for JSON) and p95 client frame time.
*Done when:* green in CI at the new thresholds, reproduced once manually against the deployed instance, and the measured numbers are written into the thresholds file as the new ratchet.

### v0.3.0 — Executions and the cold plane

**T-0.3.1 · FIX event model in `domain`**
*Deliverable:* `ExecType`, `OrdStatus` (including terminal `CANCELED`/`EXPIRED`), `RejectReason`, quantity fields, and the state machine from architecture §5.6.
*Done when:* property test — no event sequence reaches an undeclared transition; `CumQty + LeavesQty = OrderQty` holds at every `TRADE` of a live order.

**T-0.3.2 · Scripted execution module**
*Deliverable:* an order expands into a defined event sequence (partials, fill, rejection); fill prices from the current top of book with a configurable offset; IOC leftovers terminate as `CANCELED`.
*Done when:* property suite green over generated orders; exactly one terminal state per order; 100 % coverage of the module.

**T-0.3.3 · Last look**
*Deliverable:* `holdMs` and `rejectRate` in the execution path; `POST /sim/lastlook`.
*Done when:* with `rejectRate: 1` every order returns `REJECTED / LAST_LOOK` after at least `holdMs`; with `0` none do; the hold is observable in event timestamps.

**T-0.3.4 · Cold plane**
*Deliverable:* `GET /api/instruments` with `ETag`, `Cache-Control: max-age=3600`, and `304` on a matching `If-None-Match`.
*Done when:* the second request with the ETag returns `304` with an empty body; changing the catalogue changes the ETag.

**T-0.3.5 · Server-side freshness re-check**
*Deliverable:* order submission re-validates the pair against the server's own state; frozen pair → `REJECTED / STALE_PRICE`.
*Done when:* an order submitted for a frozen pair is rejected even when the client believed the price fresh — the test must construct exactly that race.

**T-0.3.6 · Dev harness and execution stats**
*Deliverable:* script submitting a burst of synthetic orders; fills/partials/rejects counters in `/sim/stats`.
*Done when:* a burst moves all three counters, and turning `rejectRate` up shifts the mix as expected.

**T-0.3.7 · React Query wiring** ∥
*Deliverable:* client fetches the catalogue through React Query with `staleTime` aligned to the server's `max-age`.
*Done when:* a remount inside the window issues no network request; after expiry it issues a conditional one that returns `304` (assert via MSW).

### v0.4.0 — Warm plane

**T-0.4.1 · GraphQL server on the same port**
*Deliverable:* schema in `domain`; `graphql-ws` mounted on `/graphql` in the existing server process, routed by path (ADR-05).
*Done when:* a `graphql-ws` client completes connection init on the same port that serves `/feed`, and `/feed` is unaffected by GraphQL traffic.

**T-0.4.2 · `submitOrder`**
*Deliverable:* mutation returning `SubmitAck` immediately, routing the order into the execution module.
*Done when:* the ack returns before the first `ExecutionReport`; an order rejected by the freshness check still acks, then reports the rejection as an event.

**T-0.4.3 · `executionReports` subscription**
*Deliverable:* per-order event stream, every event exactly once, in order.
*Done when:* for 100 concurrent orders, no event is duplicated, dropped or reordered — asserted per `clOrdId`, not in aggregate.

**T-0.4.4 · `trades` / `positions` and realised P&L**
*Deliverable:* queries plus server-side `netQty`, `avgPx`, `realisedPnl`.
*Done when:* a scripted buy-then-sell sequence yields the arithmetically expected realised P&L and flat position.

**T-0.4.5 · Apollo wiring and unrealised P&L** ∥
*Deliverable:* Apollo Client; blotter and positions updated from subscription events; unrealised P&L computed client-side from the hot mid.
*Done when:* unrealised P&L ticks with the feed between execution events while realised P&L changes only on events — the split from architecture §7.3, asserted.

**T-0.4.6 · Blotter grid**
*Deliverable:* AG Grid blotter; `POST /sim/blotter { rows: 5000 }`.
*Done when:* the 5000-row burst renders with sorting and scroll position preserved, and the hot plane keeps its frame budget during the burst (AC-10, AC-11).

**T-0.4.7 · Scenario engine**
*Deliverable:* `POST /sim/scenario` with the `demo-5min` timeline as data.
*Done when:* one call runs the full sequence identically twice from the same seed, with the timeline asserted from `/sim/stats` transitions.

**T-0.4.8 · Subscription reconnect**
*Deliverable:* resubscribe plus state reconciliation after a dropped connection.
*Done when:* a forced disconnect mid-order loses no execution report and duplicates none once reconnected.

**T-0.4.9 · Full-journey E2E**
*Deliverable:* Playwright spec: seed → scenario → submit order → `NEW` → partial → `FILLED` visible in the blotter with position and P&L updated.
*Done when:* green 10 consecutive runs against the local server.

### v1.0.0 — Hardening

**T-1.0.1 · Chaos drills** — kill the container mid-stream; clients reconnect with jittered backoff and resnapshot cleanly. *Done when:* documented with observed behaviour and timings, and no manual intervention was needed.

**T-1.0.2 · Optional `/sim/*` secret header** behind a flag, default off. *Done when:* enabling the flag rejects unauthenticated control calls while the data planes stay open; disabled is the documented default.

**T-1.0.3 · Perf report** in the README: sustained rate, p95 server tick, p95 client frame time, bytes/s, naive versus coalesced. *Done when:* every number is reproducible by `pnpm gate:perf` on the reference machine.

**T-1.0.4 · `DEMO.md` runbook** — the 5-minute script step by step plus the local fallback path. *Done when:* someone following only this file, on a clean machine, reaches a running demo.

**T-1.0.5 · Two clean rehearsals** — the scripted demo twice in a row from a fresh container and a fresh browser, zero manual fixes; ADR list and changelog finalised.

---

*Maintained alongside the architecture document. When a release ships, its row here gains the tag date; when scope moves between releases, it moves in this file first and in the code second.*
