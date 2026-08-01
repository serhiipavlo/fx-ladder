# FX Ladder — Business Specification

> **Product:** FX Ladder — a frontend trading terminal for the FX market.
> **Status:** draft, pre-implementation
> **Date:** 2026-07-31
> **Data:** synthetic. The product does not connect to real market data sources and does
> not execute real trades.

---

## 0. The dual nature of this document

This document describes **two different things**, and confusing them is the fastest way to
build the wrong thing.

| Level | What it is | Measure of success |
|---|---|---|
| **Product** | An FX terminal for a trader. Sections 1–8 are written as if the product were real. | The user notices movement faster and doesn't trade on a stale price |
| **Actual** | A portfolio artifact for a Senior FX UI React Developer role (JR-0000102383, Barclays FX One) | Passes the "real-time high-throughput UI" filter and holds up in an architecture discussion |

The product requirements are written in earnest, not for show — **requirements derived from
a real user need produce a coherent system, while requirements derived from a job posting's
tech list produce a showcase with no logic.** The latter is obvious immediately and reads as
cargo cult.

> ⚠️ **This file is a working document.** Don't drop it into the product repository as-is:
> section 0 and Appendix B are meant for you, not the employer. What goes into the
> repository is a translation of sections 1–8.

The structure follows your own framework from
[spec-driven-sdlc](https://github.com/serhiipavlo/spec-driven-sdlc): problem → discovery →
requirements → acceptance criteria, with end-to-end IDs for traceability (invariant 5).

---

## 1. Problem

### 1.1 Context

An FX trader keeps 20–50 pairs under watch at once. Prices update continuously — at peak
moments, hundreds of times per second on active pairs. Decisions are made in seconds, and
they're made **based on what the screen shows**.

This creates a class of problem that ordinary applications don't have: **the screen can
lie.** Not through a bug — but because the connection degraded, or the interface can't
repaint fast enough, or the data is stale and the UI has no way to show it.

### 1.2 Jobs-To-Be-Done

| ID | Statement |
|---|---|
| **JTBD-1** | When the market moves fast, I want to see which of my pairs moved and by how much, so I can react before the opportunity disappears |
| **JTBD-2** | When I click on a price, I want confidence that I'll get exactly that price, so I don't take unexpected slippage |
| **JTBD-3** | When the connection degrades, I want to know immediately, so I don't trade on a dead screen |
| **JTBD-4** | When I've made a series of trades, I want to see their status in one place, so I know my position |

**JTBD-3 is central.** It drives the entire class of non-functional requirements, and it's
exactly what distinguishes a trading interface from a dashboard. A dashboard that freezes
for 3 seconds is an inconvenience. A trading interface that freezes for 3 seconds and
doesn't say so is a financial loss.

### 1.3 Measurable outcome

| Metric | Target |
|---|---|
| Time from a price move to it being visually noticeable | < 100ms at the 95th percentile |
| Trades executed at a price marked fresh but actually stale | **0** |
| Time from a connection break to indicating it to the user | < 1s |
| Missed updates after reconnection that the user isn't warned about | **0** |

---

## 2. Users

| Persona | What they do | What matters most to them |
|---|---|---|
| **Trader** (primary) | Watches a watchlist, enters a position from the ladder or the ticket | Speed of reaction, trust in the displayed price |
| **Sales trader** | Watches trade flow, execution statuses | Completeness and freshness of the blotter |
| **Desk operator** | Monitors connection health and feed quality | Explicit diagnostics, not guesswork |

Not served: risk management, compliance, back office, reporting.

---

## 3. Functional requirements

### 3.1 Live quotes

| ID | Requirement | JTBD |
|---|---|---|
| **FR-01** | The user sees a quote grid for selected pairs: bid, ask, spread, day change, direction of the last move | 1 |
| **FR-02** | A cell that changed is visually highlighted by direction of movement; the highlight fades and doesn't accumulate | 1 |
| **FR-03** | The user adds and removes pairs from their watchlist; the set persists across sessions | 1 |
| **FR-04** | The grid sorts by any column and doesn't lose the sort order during updates | 1 |

### 3.2 Market depth

| ID | Requirement | JTBD |
|---|---|---|
| **FR-05** | For a selected pair, the user sees a depth ladder: price levels with volumes on both sides | 1, 2 |
| **FR-06** | The ladder shows cumulative volume up to each level, to assess the cost of sweeping through it | 2 |
| **FR-07** | Clicking a level opens a ticket pre-filled with that level's price and side | 2 |

### 3.3 Trade entry

| ID | Requirement | JTBD |
|---|---|---|
| **FR-08** | The user enters a trade: pair, side, volume, execution type | 2 |
| **FR-09** | The form validates input before submission and explains the reason for rejection specifically, not generically | 2 |
| **FR-10** | The form shows the price the trade will execute at, and **explicitly warns if it has changed since the ticket was opened** | 2 |
| **FR-11** | Submission is blocked if the price is marked stale | 2, 3 |
| **FR-12** | The user sees confirmation of execution or the reason for rejection | 2, 4 |

**FR-10 and FR-11 are the essence of JTBD-2.** Without them the ticket becomes an ordinary
form, and the entire point of a trading interface disappears.

### 3.4 Blotter

| ID | Requirement | JTBD |
|---|---|---|
| **FR-13** | The user sees a list of their trades for the session with each one's status | 4 |
| **FR-14** | Statuses update on their own, without a reload and without losing scroll position | 4 |
| **FR-15** | The blotter filters by pair, side, status, and stays responsive with thousands of rows | 4 |
| **FR-16** | The user sees an aggregated position for each pair | 4 |

### 3.5 Connection state and data trustworthiness

| ID | Requirement | JTBD |
|---|---|---|
| **FR-17** | The interface continuously shows connection state: live / recovering / offline | 3 |
| **FR-18** | A price that hasn't updated for longer than a threshold is visually marked stale — distinct from "the price isn't moving" | 3 |
| **FR-19** | On connection loss the system recovers on its own, and the user sees that recovery is in progress | 3 |
| **FR-20** | If updates were lost during a disconnect, after recovery the user gets the current state and **a notice that a gap occurred** | 3 |
| **FR-21** | The user can trigger a manual reconnect without reloading the application | 3 |

**FR-18 is the subtlest requirement in this document.** "The price hasn't changed" and "we
don't know the current price" are two different states of the world that look identical
unless deliberate effort is made to distinguish them. Conflating them in a trading interface
is unacceptable.

### 3.6 Reference data

| ID | Requirement | JTBD |
|---|---|---|
| **FR-22** | The system knows the list of available instruments and their parameters (quote precision, lot size, trading hours) | 1, 2 |
| **FR-23** | Price display precision follows the specific pair's convention, not universal formatting | 1 |

FR-23 looks trivial until you see USDJPY with five decimal places. To a trader that's an
instant signal that the product was built by people who don't know the domain.

---

## 4. Non-functional requirements

### 4.1 Throughput and responsiveness

| ID | Requirement | Rationale |
|---|---|---|
| **NFR-01** | The interface stays responsive at **50,000 updates/s** aggregated across all pairs | Peak activity on news is exactly when the interface is needed most and when it usually breaks |
| **NFR-02** | The frame budget isn't exceeded: 60fps under nominal load, ≥ 30fps under peak load | Below 30fps, movement highlighting stops reading as motion |
| **NFR-03** | An update to one pair doesn't cause a repaint of others | Otherwise cost grows quadratically and a 50-pair watchlist becomes impossible |
| **NFR-04** | Tick-to-pixel latency < 100ms at the 95th percentile | JTBD-1 |
| **NFR-05** | Memory doesn't grow unbounded over a long session | A trading day is 8+ hours without a reload |

### 4.2 Resilience

| ID | Requirement |
|---|---|
| **NFR-06** | Connection recovery is automatic, with increasing backoff and jitter, to avoid a reconnection storm |
| **NFR-07** | The system distinguishes a graceful disconnect from an abnormal one, and reacts differently |
| **NFR-08** | A gap in the data sequence is detected, not silently passed through |
| **NFR-09** | An error in one part of the interface doesn't crash the whole application |

### 4.3 Quality

| ID | Requirement |
|---|---|
| **NFR-10** | Stream and state-handling logic has 100% test coverage |
| **NFR-11** | Every user scenario from section 8 is covered by an end-to-end test |
| **NFR-12** | A test exists that fails when performance degrades below NFR-02 |
| **NFR-13** | Keyboard navigation covers all core actions; critical states aren't conveyed by color alone |

NFR-13 isn't cosmetic: color blindness affects ~8% of men, and red/green movement
highlighting is exactly the case that hits. Plus traders work from the keyboard — the mouse
is slow.

---

## 5. Boundaries

### 5.1 In scope

Live quotes, depth, trade entry, blotter, connection state, reference data.

### 5.2 Deliberately out of scope

| Not doing | Why |
|---|---|
| Real connection to market data sources | Market data licensing; a synthetic feed also gives controllable frequency for demonstration |
| Real trade execution | The product is a demo |
| Authentication, roles, permissions | Adds nothing to the stated problem, eats time |
| Charting and technical analysis | A separate class of problem; the ladder and grid already cover the JTBDs |
| Risk limits, margin, compliance | A different product |
| Mobile version | Traders work at a multi-monitor desk |
| Historical data, reporting | Not in the JTBDs |

**The "not doing" list matters more than the "doing" list.** It shows the boundaries were
drawn deliberately, not out of a lack of time — and that's exactly what interviews ask you
to talk about.

---

## 6. Acceptance criteria

Atomic, automatically verifiable.

| ID | Criterion | Verifies |
|---|---|---|
| **AC-01** | At 50,000 updates/s, frame rate doesn't drop below 30fps for 60s | NFR-01, NFR-02 |
| **AC-02** | An update to one pair causes a repaint of exactly one cell | NFR-03 |
| **AC-03** | After 30 minutes of continuous streaming, memory consumption doesn't exceed the starting level by more than an agreed threshold | NFR-05 |
| **AC-04** | On connection loss, an indicator appears within 1s | FR-17, FR-19 |
| **AC-05** | After reconnection with data loss, the user sees a gap notice | FR-20, NFR-08 |
| **AC-06** | A price with no updates past the threshold is displayed as stale and visually distinct from an unmoving one | FR-18 |
| **AC-07** | Submitting a trade at a stale price is rejected with an explanation | FR-11 |
| **AC-08** | A price change between opening the ticket and submitting is shown to the user before confirmation | FR-10 |
| **AC-09** | Every pair is formatted according to its own quote precision | FR-23 |
| **AC-10** | Sort order and scroll position persist during a stream of updates | FR-04, FR-14 |
| **AC-11** | The blotter stays responsive with 5,000 rows | FR-15 |
| **AC-12** | A rendering error in one widget doesn't crash the page | NFR-09 |
| **AC-13** | All core actions are reachable from the keyboard | NFR-13 |
| **AC-14** | Manual reconnection restores the stream without a reload | FR-21 |

---

## 7. Phases

Each phase is self-contained: stopping at it still leaves a coherent product.

| Phase | Scope | Business value on completion |
|---|---|---|
| **1. Trustworthy price** | FR-01…04, FR-17…21, all performance and resilience NFRs | The trader sees prices and **knows when not to trust them**. This is already a product. |
| **2. Action** | FR-05…12, FR-22, FR-23 | The trader can act on what they see |
| **3. Control** | FR-13…16 | The trader sees the consequences of their actions |

**Phase 1 carries the entire point.** It alone closes the central JTBD-3 and all the
non-functional requirements. If time is short, build only this phase and finish it properly.

---

## 8. Demo scenario

The product must be demonstrable in 5 minutes. The scenario is part of the requirements,
because it defines exactly what has to work flawlessly.

1. **Calm market.** A 30-pair watchlist, moderate flow. Prices are alive, highlighting reads clearly.
2. **Spike.** Feed frequency rises to peak. The interface stays responsive; counters show load and frame retention.
3. **Comparison.** Switch to a naive processing mode — the interface chokes. Switch back — it recovers. *This is the main 30 seconds of the demo.*
4. **Disconnect.** The feed cuts off. State indication appears; prices are marked stale; trade entry is blocked.
5. **Recovery.** The connection comes back on its own; the user sees a gap warning and an up-to-date state.
6. **Trade.** Click a ladder level → ticket → the price moves → warning → confirmation → a row in the blotter.

---

## Appendix A. Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| Scope creeps into charting and analytics | Phase 1 never finishes, nothing to show | Section 5.2 is a contract with yourself |
| Performance judged "by eye" without measurement | The core thesis becomes unprovable | AC-01…03 are automated from day one |
| Synthetic feed feels unrealistic | The demo doesn't convince | Frequency and spread profile drawn from real intraday patterns |
| Tests written after the code, for coverage's sake | NFR-10 formally satisfied, not actually | Stream-handling logic is written test-first |

## Appendix B. Traceability to job requirements

| JR-0000102383 requirement | Closed by |
|---|---|
| Real-time high-throughput UI *(primary filter)* | NFR-01…05, AC-01…03, demo step 3 |
| React+TS: hooks, patterns, performance, error boundaries, context | NFR-03, NFR-09, FR-17 |
| WebSockets under continuous streaming | FR-17…21, NFR-06…08 |
| TanStack React Query | FR-22, FR-13 (cold and warm data) |
| Apollo Client / GraphQL | FR-12…14 (trade statuses) — **closes the one gap in core** |
| Vitest, RTL, Playwright, test architecture, mocking | NFR-10…12, section 8 |
| 100% unit coverage | NFR-10 — achievable, since stream logic is pure TS with no DOM |
| Architectural ownership, not just ticket execution | Section 5.2 + decisions in ADRs |
| AG Grid | FR-15, AC-11 |
| React Hook Form + Zod | FR-08, FR-09 |
| UX and accessibility | NFR-13, AC-13 |
| Vite, pnpm monorepo, CI/CD | implementation infrastructure |

Not closed by this project: micro-frontends, Kubernetes. Both are in "valued," not "core."
