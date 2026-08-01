# FX Glossary for Frontend Engineers

> Reference guide for a Senior FX UI React Developer role (Barclays, BARX FX).
> Every term here answers one question: **what does it mean for the interface?**
> That's the job. It's also what separates an engineer who understands the domain from
> one who memorized definitions.
>
> 🔴 — almost certainly asked · 🟡 — should be recognizable · ⚪ — context
>
> Date: 2026-08-01

---

## Contents

1. [Instrument and quoting](#1-instrument-and-quoting)
2. [Price and spread](#2-price-and-spread)
3. [Market depth](#3-market-depth)
4. [Execution models](#4-execution-models)
5. [Order types](#5-order-types)
6. [Trade lifecycle](#6-trade-lifecycle)
7. [FX products](#7-fx-products)
8. [Position and P&L](#8-position-and-pl)
9. [Market structure](#9-market-structure)
10. [Data and protocols](#10-data-and-protocols)
11. [Latency](#11-latency)
12. [Trading UI conventions](#12-trading-ui-conventions)
13. [Regulation](#13-regulation)
14. [Barclays](#14-barclays)

---

## 1. Instrument and quoting

### Currency pair 🔴
`EURUSD`. The **base** currency comes first (EUR), the **quote** or counter second (USD).
The price tells you how many units of the quote you get for **one** unit of the base.

Buying EURUSD means buying EUR and selling USD. Volume is always stated in the base
currency: "5M EURUSD" is 5 million euros, not dollars.

### Major / minor / exotic ⚪
- **Majors** — the seven USD pairs: EURUSD, USDJPY, GBPUSD, USDCHF, AUDUSD, USDCAD, NZDUSD
- **Crosses** — no USD: EURGBP, EURJPY
- **Exotics** — TRY, ZAR, MXN, BRL. Wider spreads, thinner liquidity

**For UI:** exotics follow different precision conventions and trade at wider spreads. Don't
make formatting or highlight thresholds universal.

### Pip 🔴
The conventional minimum price step.

| Pair type | Pip | Example |
|---|---|---|
| Most pairs | 4th decimal = `0.0001` | EURUSD `1.0850` |
| **JPY pairs** | 2nd decimal = `0.01` | USDJPY `157.12` |

JPY is the exception because the rate sits near 157, not near 1.08. A fourth decimal there
would be absurdly small.

### Pipette (fractional pip) 🔴
One digit past the pip. Modern platforms quote exactly this way:

| Pair | Digits | Example |
|---|---|---|
| EURUSD | **5** | `1.08512` |
| USDJPY | **3** | `157.123` |

**For UI:** take precision from instrument reference data, **per pair**, never globally.
Show USDJPY with five decimals and the trader knows instantly that the product was built by
people who don't know FX.

### Big figure (handle) 🔴
The leading digits of the price. In `1.08512` the big figure is `1.08`; `512` is the pips
and the pipette.

Voice traders just say "51" — everyone already knows the handle.

**For UI — an important convention:** render the big figure **smaller or muted**, and the
pips **larger**. The eye tracks whatever moves. Look at any real terminal: `1.08` **`51`**
`2`. That isn't decoration, it's reading speed.

---

## 2. Price and spread

### Bid / Ask 🔴
- **Bid** — the price someone buys from you at (you sell)
- **Ask / Offer** — the price someone sells to you at (you buy)
- Ask is always higher than bid

Mnemonic: the bank quotes from **its own** side. Bid means the bank buys.

### Mid 🟡
`(bid + ask) / 2`. Use it to value and revalue positions, **never to execute** — nobody
trades at mid.

### Spread 🔴
`ask − bid`, in pips. The narrower it is, the more liquid the market. It widens on news, in
thin hours, and on exotics.

**For UI:** spread is the main indicator of market health. A sharp widening deserves its own
visual signal.

### Top of book (TOB) / L1 🟡
The best bid and ask. The bare minimum for a quote grid.

### Market data levels 🟡
| Level | What it gives |
|---|---|
| **L1** | Best bid/ask only |
| **L2** | Depth, aggregated **by price level** |
| **L3** | Every individual order, identified |

FX clients usually see L2. Each level up sharply raises both the data volume and the UI
complexity.

---

## 3. Market depth

### Order book 🔴
All the buy and sell orders, grouped by price level.

**Critical for FX:** the market is OTC, so **there is no single book**. Each bank builds its
own aggregated book from whatever liquidity sources it has. Your book and a competitor's
book differ at the same instant. That is what separates FX from exchanges and from crypto.

### Ladder / DOM (Depth of Market) 🔴
A vertical scale: **one row is one price level**, with volumes on each side.

```
        BID       PRICE       ASK
                 1.08512      4.0M
                 1.08511      2.5M
                 1.08510      1.2M   ← best ask
       ─────────────────────────────  ← spread
        3.0M     1.08508              ← best bid
        5.5M     1.08507
        8.0M     1.08506
```

**Two designs, and this will be asked:**

| | Floating | **Static** |
|---|---|---|
| Price column | moves, best price centered | **fixed** |
| Click | on a moving target | on a stationary one |
| Where used | market overview | **execution** |

Execution traders insist on the static one. Click a target that jumps and you open a
position at a price you never chose. The ladder in a real terminal **does not move**.

### Cumulative volume 🟡
Running volume up to each level. It answers one question: how much can I take if I sweep all
the way down to here?

### Sweep / sweep VWAP 🟡
Clearing several levels with one order. The average price you get is the sweep **VWAP**, and
it's worse than the top of book. That difference is **market impact**.

**For UI:** the moment the user types a volume, show the expected VWAP, not just top of
book. Anything less misleads them.

### Aggregation / Liquidity provider (LP) 🟡
The book is assembled from several LP feeds. A single price level can hold orders from
different providers.

---

## 4. Execution models

### ESP — Executable Streaming Prices 🔴
Prices stream continuously and the client clicks to trade instantly (**click-to-trade**).
This is how standard volumes trade on liquid pairs.

**UI:** grid and ladder, hot updates. All the complexity lives in the stream.

### RFQ — Request for Quote 🔴
The client asks for a price **on a specific volume**. The bank answers with a quote that
lives a few seconds. The client accepts or rejects. This is how large volumes, exotics, and
options trade.

**UI:** a completely different problem. Here you build a request lifecycle, a **countdown
timer** on the quote, and the states requested / quoted / accepted / expired.

> **BARX FX does both.** Two different interface worlds in one product — and knowing the
> difference is a strong interview signal.

### Last look 🔴
The liquidity provider can **reject a trade after the client has already clicked**. It holds
the order for a few milliseconds and checks whether the price moved against it.

The client pressed the button and got a rejection. This is a **UX problem unique to FX**.
Tell the user what happened, and make the retry effortless. Mentioning last look in an
interview shows you understand FX rather than transplanting crypto experience.

### Algo execution 🟡
An algorithm slices a large order into pieces to reduce impact.
The classics: **TWAP**, **VWAP**, **Implementation Shortfall**, **POV** (percentage of
volume).

At Barclays, the publicly named ones are **PowerFill** and **Gator**.

---

## 5. Order types

| Type | What it does | 🔴/🟡 |
|---|---|---|
| **Market** | Execute immediately at the best available price | 🔴 |
| **Limit** | No worse than a given price; may not fill | 🔴 |
| **Stop** | Turns into a market order once the trigger hits | 🔴 |
| **Stop-limit** | Turns into a limit order once triggered | 🟡 |
| **IOC** (Immediate or Cancel) | Fill what you can now, cancel the rest | 🟡 |
| **FOK** (Fill or Kill) | All or nothing, immediately | 🟡 |
| **GTC** (Good Till Cancelled) | Stays live until cancelled | 🟡 |
| **GTD / Day** | Until a date, or until end of day | ⚪ |
| **Iceberg** | Shows only part of the volume in the book | ⚪ |

**For UI:** which types are available depends on the instrument and the mode. Build the
ticket from reference data, never hardcode it.

---

## 6. Trade lifecycle

### Trade ticket 🔴
The entry form: pair, side, volume, type, tenor.

### Fill / Partial fill 🔴
A **fill** is an execution. A **partial fill** means only part of the volume went through;
the rest either keeps working or gets cancelled, depending on the order type.

**For UI:** a partial fill is neither an error nor a success. It's a third state, and the
blotter has to show it as one.

### Slippage 🔴
The gap between the price you expected and the price you got.

### Rejection 🔴
A refusal. Causes: last look, credit limit, stale price, invalid volume.
**Give the user the actual reason**, not a generic "error."

### Value date / Settlement 🟡
The day the currencies actually change hands.

| | Term |
|---|---|
| **Spot** (most pairs) | **T+2** |
| USDCAD, USDTRY, and a few others | T+1 |

Weekends and holidays in **both** currencies push the date out. The backend works it out;
the UI just displays it.

### Tenor 🟡
The horizon: `SPOT`, `1W`, `1M`, `3M`, `6M`, `1Y`, or a specific date (**broken date**).

---

## 7. FX products

| Product | What it is | 🔴/🟡 |
|---|---|---|
| **Spot** | Exchange now, settles T+2. Where most of the volume sits | 🔴 |
| **Forward** | Exchange in the future at a price fixed today | 🔴 |
| **FX Swap** | Spot one way plus a forward back. Liquidity management, not speculation | 🟡 |
| **NDF** | Non-Deliverable Forward. For restricted currencies (KRW, INR, BRL, TWD) — nothing is physically delivered, the difference settles in USD | 🟡 |
| **Vanilla option** | The right to buy or sell at a strike | 🟡 |
| **Exotic option** | Barrier, digital, Asian | ⚪ |

**Forward points** — the difference between the forward and the spot price, quoted in pips.

**Greeks** (for options): delta is sensitivity to price, gamma to delta, vega to volatility,
theta to time. ⚪ Knowing the names is enough.

---

## 8. Position and P&L

| Term | What it is |
|---|---|
| **Position** 🔴 | Net exposure. **Long EUR** means you bought more than you sold |
| **Flat / Square** 🟡 | Zero position |
| **Mark-to-market** 🟡 | Revaluing at the current market |
| **Unrealised P&L** 🔴 | Profit on an open position — moves on every tick |
| **Realised P&L** 🔴 | Locked in when you close |
| **Day change** 🟡 | Change against yesterday's close |

**For UI:** you recalculate unrealised P&L on every tick, for every position. It's the
second-heaviest computation after the grid itself — and it does not belong in React state.

---

## 9. Market structure

| Term | What it is |
|---|---|
| **Sell-side** 🔴 | Market-making banks that quote prices. **Barclays** |
| **Buy-side** 🔴 | Funds, corporates, price takers. **BARX's clients** |
| **SDP** (Single-Dealer Platform) 🔴 | One bank's own platform. **BARX is an SDP** |
| **MDP** (Multi-Dealer Platform) 🟡 | An aggregator across banks: FXall, 360T, Bloomberg FXGO |
| **ECN** 🟡 | Electronic network: EBS, LSEG Matching |
| **EMS / OMS** 🟡 | Execution / Order Management System on the client side |
| **Prime Broker (PB)** ⚪ | Intermediary that provides credit and access |
| **Desk** 🟡 | Trading desk |
| **Market maker** 🟡 | Quotes two-sided prices, manages the bank's risk |
| **Sales trader** 🟡 | Handles client flow |

> BARX is an SDP, and it competes with MDPs. That one fact explains **why replatforming
> happens at all**: the client can always walk over to an aggregator, so the bank's own
> platform has to be visibly better.

---

## 10. Data and protocols

### Snapshot + delta 🔴
First the full state of the book, then only the changes. The standard for streaming books.

### Sequence number 🔴
A monotonic counter on every update. **The only way to detect a lost message.** See a gap in
the numbering, request a fresh snapshot.

### Gap / Gap fill 🔴
A lost range of updates. After recovery the current price may well be correct, but **the
path is gone**. Everything derived from it — session high and low, day change, VWAP — is
now quietly wrong.

### Heartbeat 🔴
An empty message on a fixed interval. It proves the channel is alive while the market is
silent. **Without it, a calm market and a dead socket look identical.**

### Conflation 🔴
**The most important term in this section for your role.**

Updates arrive faster than you can draw them. So you **deliberately throw away** the
intermediate values and keep only the last one. For prices that's correct: the trader needs
the current price, not all 400 values from the past second.

You can conflate on the server (less traffic) or on the client (more flexible). In your pet
project, rAF batching is exactly client-side conflation.

⚠️ **Conflate prices, never events.** You can't drop a trade, a fill, or a rejection — they
don't replace one another. Telling these two kinds of stream apart is an architectural
decision, and it's worth raising in an interview.

### Throttling 🟡
A cap on output rate: "no more than 10 updates per second per instrument." Usually paired
with conflation.

### Stale 🔴
Data that hasn't updated for longer than some threshold. **Not the same as a price that
isn't moving.** A frozen EURUSD and a genuinely quiet EURUSD produce identical pixels. The
only thing that tells them apart is the timestamp of the last update.

### FIX Protocol 🟡
Financial Information eXchange — the industry standard for trading messages. Versions 4.2,
4.4, 5.0. Messages carry tags like `35=D` (New Order) and `35=8` (Execution Report).

The frontend rarely speaks FIX directly; the backend translates it into WS or REST. But
**FIX vocabulary leaks into the API** — `ExecType`, `OrdStatus`, `ClOrdID`. Learn to
recognize them.

---

## 11. Latency

| Term | What it is |
|---|---|
| **Tick-to-trade** 🟡 | From a tick arriving to an order going out |
| **Round-trip** 🟡 | There and back |
| **Jitter** 🔴 | How much latency **varies**. Often worse than latency itself: a steady 50ms beats a 5–200ms swing |
| **Co-location** ⚪ | Sitting your machines next to the venue |
| **Tick-to-pixel** 🔴 | From a tick arriving to pixels on screen. **This one is yours** |

---

## 12. Trading UI conventions

What glossaries leave out, but every real terminal shows.

| Convention | The point |
|---|---|
| **Big figure smaller, pips larger** 🔴 | `1.08` **`51`** `2` — the eye tracks whatever changes |
| **Price flash** 🔴 | A brief highlight on change, up or down. **It has to fade**, or the screen turns into one solid color |
| **Static ladder** 🔴 | The price column stays put, or clicks land on the wrong row |
| **One-click trading** 🟡 | No confirmation step. It lives behind its own toggle and is **marked clearly**, because it's dangerous |
| **Freshness** 🔴 | A stale price looks different from a live one |
| **Never color alone** 🟡 | Around 8% of men can't tell red from green. Add an arrow or a sign |
| **Keyboard** 🟡 | Traders work from the keyboard. The mouse is slow |
| **Density** 🟡 | Terminals pack information tightly. That's a requirement, not bad UX |

---

## 13. Regulation

| Term | What it is |
|---|---|
| **FX Global Code** 🟡 | An industry code of conduct. Among other things, it requires banks to **disclose how they use last look** |
| **Best execution** 🟡 | The duty to get the client the best outcome you can. This is where audit and reporting requirements come from |
| **MiFID II** ⚪ | European regulation; for FX it mostly touches derivatives |
| **Audit trail** 🟡 | An immutable log of actions. **It reaches the frontend:** you often have to log user actions with timestamps |

---

## 14. Barclays

> From public sources (August 2026). The official BARX FX page returned 403 — check the
> details in a browser before the interview.

| Term | What it is |
|---|---|
| **BARX** 🔴 | Barclays' cross-asset electronic trading platform. Launched as a single brand in 2019 |
| **BARX FX** 🔴 | The FX business: 80+ currencies, **480 pairs**, around the clock. Spot, forwards, swaps, NDF, vanilla and exotic options. Execution via streaming, RFQ, orders, algos |
| **PowerFill** 🟡 | An execution algorithm |
| **Gator** 🟡 | An execution algorithm |
| **BARX Direct** 🟡 | A low-latency offering with co-location |
| **BARXBot** 🟡 | A built-in AI assistant |
| **BARX One** 🟡 | The stated next generation of the platform — it pulls signals, models, and decision-making together |
| **FX One** 🔴 | **The name appears nowhere in public sources.** Most likely it's the internal name for the program moving BARX FX onto a new stack. In an interview, say **BARX FX** |

**Hubs:** London, Tokyo, New York, Singapore. Prague is the technology center.

---

## The minimum you need to know cold

If you're short on time, learn these ten:

1. **Ladder**, and why it's static
2. **ESP vs RFQ** — two different interface worlds
3. **Last look** — a UX problem unique to FX
4. **Conflation** — and that you conflate prices but never events
5. **Snapshot + delta + sequence** — and why a gap hurts more than a delay
6. **Stale ≠ unmoving** price
7. **Heartbeat** — otherwise you can't tell quiet from a dead channel
8. **Pip / pipette** — and why USDJPY gets 3 decimals
9. **Big figure** — and why you render it smaller
10. **BARX is an SDP** competing with MDPs — hence replatforming
