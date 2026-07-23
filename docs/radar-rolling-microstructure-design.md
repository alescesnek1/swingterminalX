# RADAR Rolling Microstructure - Technical Design and Risk Review

> **Status: LOCAL LIVE-CAPABLE, production inactive.**
> The local one-shot producer can now create `trusted:true` snapshots only from
> complete, fresh public Binance-futures measurements: a 300-second validated and
> sorted aggTrades window, two time-separated depth samples, 30+ validated 1m
> klines, and every Strict-Absorb input. The snapshot normalizer independently
> re-checks source, freshness, sample floors, validation metadata, all required
> fields, and buy dominance in `0..1`; any failure drops the row from strict use. Trusted collection also requires the exact HTTPS host `fapi.binance.com`; alternate hosts, IPs, protocol-relative URLs, and lookalikes fail before fetch.
>
> This is not production activation. The producer remains disabled by default;
> it is dry-run unless the separate POST flag and control-plane token are supplied.
> No scheduler, workflow, production configuration, private/signed endpoint,
> `ENTRY_READY` threshold, Telegram eligibility, or trading behavior changed.
> A local trusted row reaches only the existing Strict-Absorb gate; all existing
> independent gates still govern ENTRY_READY and Telegram.
## Design stance

The existing RADAR gate **already** reads the rolling field names below and
**already fails closed** when they are absent. See
`scripts/radar/trading-radar.mjs`:

- `absorptionConfirmed` (≈ lines 340–345) — the actual Absorb gate.
- `hasRollingMicrostructure` (≈ lines 1087–1090) — the rolling-present flag.
- `ABSORPTION_FIELD_GROUPS` (≈ lines 1060–1066) — the five input groups.

And the merge that feeds them is a flat spread `{ ...candidate, ...micro }` in
`netlify/functions/bot.mjs` (≈ line 2122).

Consequences that drive every decision in this design:

- This phase is **not** about building a new gate. It is about honestly
  **measuring** the field names the gate already consumes, and making sure
  stale or thin data never reaches it.
- The producer's only job is **measure → name correctly → post**, or **omit**.
  It never decides ENTRY_READY and never relaxes a gate.
- **Omit is the universal failure mode.** A field is either a real measurement
  or completely absent — never `null`, never `0`, never a default. This matches
  the existing convention (`computeDepthWithin1Pct` returns `null` → caller
  omits).
- Because the merge spreads straight into the gate, **staleness and min-sample
  must be enforced before the number reaches the gate** — at the producer
  (don't post) and at the merge (drop stale). That merge guard is the only
  backend change in the whole phase, and it is gate-free / safety-only.

---

## 1–2. Rolling field model (definitions, formulas, windows, sample floors)

Conventions used throughout:

- `W = 300 s` trailing trade window.
- aggTrades classify aggressor side by `isBuyerMaker` (`m===true` ⇒ taker
  **sell**, `m===false` ⇒ taker **buy**).
- All "min sample" floors are configurable with the listed defaults.
- **Missing representation is identical for every field: the key is absent from
  the posted object.** Never `null`, `0`, or a defaulted boolean.

### deltaImprovement → emits `deltaImprovementPct`, `marketBuyVolumeDominance`

| Attribute | Definition |
|---|---|
| Source data | `GET /fapi/v1/aggTrades?symbol&startTime&endTime` over W |
| Formula | Split W into halves H1 (older 150 s), H2 (recent 150 s). `deltaₕ = buyNotionalₕ − sellNotionalₕ`. `deltaImprovementPct = (delta_H2 − delta_H1) / totalNotional_W × 100`. Also `marketBuyVolumeDominance = buyNotional_W / totalNotional_W`. |
| Time window | 300 s, two 150 s sub-windows |
| Min samples | ≥ 30 trades/half (≥ 60 total) **and** `totalNotional_W ≥ MIN_NOTIONAL` |
| Stale threshold | `now − rollingAt > ROLLING_TTL` (default 15 min) |
| Fail-closed | Insufficient trades/notional ⇒ omit both fields |
| Missing repr. | keys absent |

### aggressiveSellsFailed → emits boolean `aggressiveSellsFailed`

| Attribute | Definition |
|---|---|
| Source data | aggTrades (sell flow) + `GET /fapi/v1/klines?interval=1m` lows over W |
| Formula | Require a real sell event: `sellNotional_W ≥ SELL_SPIKE_FLOOR` **and** `sellNotional_W ≥ buyNotional_W`. Then `aggressiveSellsFailed = lastPrice ≥ windowLow × (1 + RECOVER_EPS)` (default `RECOVER_EPS = 0.001`) — sells hit but price did not make/hold a new low. |
| Time window | 300 s trades; 5×1 m klines |
| Min samples | ≥ 60 trades; sell side ≥ `SELL_SPIKE_FLOOR` |
| Stale threshold | `now − rollingAt > ROLLING_TTL` |
| Fail-closed | **No measurable sell pressure ⇒ omit** (absence of sells ≠ "sells failed"; emitting `false` would be inventing a signal) |
| Missing repr. | key absent |

### bidDepthRebuildPct → emits `bidDepthRebuildPct`

| Attribute | Definition |
|---|---|
| Source data | **2+ depth snapshots within the same run**, ~15–25 s apart (`GET /fapi/v1/depth`) |
| Formula | `nearBid = Σ price×qty for bids within 1 % below mid` (bid-only variant of `computeDepthWithin1Pct`). `bidDepthRebuildPct = (nearBid_last − nearBid_min) / nearBid_min × 100` across the snapshots. Positive = bids replenished. |
| Time window | Intra-run, ≥ 2 snapshots over ~15–30 s |
| Min samples | ≥ 2 valid snapshots with `nearBid > 0` |
| Stale threshold | `now − rollingAt > ROLLING_TTL` |
| Fail-closed | < 2 valid snapshots ⇒ omit |
| Missing repr. | key absent |

### bidAbsorption → emits boolean `bidAbsorption`

| Attribute | Definition |
|---|---|
| Source data | aggTrades sell flow + `bidDepthRebuildPct` + price |
| Formula | `bidAbsorption = (sellNotional_W ≥ SELL_SPIKE_FLOOR) AND (priceDrawdown_W ≤ MAX_DRAWDOWN, default 0.3 %) AND (bidDepthRebuildPct ≥ 0)` — real sells absorbed without price breaking and without bid collapse |
| Time window | 300 s + intra-run depth |
| Min samples | sell event present + depth-rebuild computable |
| Stale threshold | `now − rollingAt > ROLLING_TTL` |
| Fail-closed | No sell event or depth missing ⇒ omit |
| Missing repr. | key absent |

### supportRetest → emits boolean `supportRetested`, `distanceToSupportPct`

| Attribute | Definition |
|---|---|
| Source data | `GET /fapi/v1/klines?interval=1m` over 30–60 min lookback + last price |
| Formula | `swingLow = min(low)` over lookback excluding the last *k* candles. `distanceToSupportPct = (lastPrice − swingLow)/swingLow × 100`. `supportRetested = price came within RETEST_BAND (≤ 0.75 %, matching the gate's existing threshold) of swingLow in the recent ~10 min AND last close > swingLow` (held). |
| Time window | 30–60 m klines; retest check ~10 m |
| Min samples | ≥ 30 1 m candles |
| Stale threshold | `now − rollingAt > ROLLING_TTL` |
| Fail-closed | Too few candles / no valid swing low ⇒ omit both |
| Missing repr. | keys absent |

### absorptionScore → emits `absorptionScore` (0–100), **composite only**

| Attribute | Definition |
|---|---|
| Source data | Pure function of the five fields above — **no independent data, no invention** |
| Formula | Computed **only when every sub-input is present and meets its min-sample**: `30·aggressiveSellsFailed + 25·bidAbsorption + 20·clamp01(deltaImprovementPct/DELTA_REF) + 15·supportRetested + 10·clamp01(bidDepthRebuildPct/REBUILD_REF)` → 0–100 |
| Time window | Union of the inputs' windows |
| Min samples | Union of all sub-field minimums |
| Stale threshold | `now − rollingAt > ROLLING_TTL` |
| Fail-closed | **Any sub-input missing ⇒ omit `absorptionScore` entirely.** Never emit a partial/low score — that would flip `hasRollingMicrostructure` true on incomplete data and corrupt `absorptionBlockedReason`. |
| Missing repr. | key absent |

---

## 3. Allowed public Binance endpoints (read-only, unsigned)

| Endpoint | Use | Status |
|---|---|---|
| `GET /fapi/v1/depth` | near-bid depth, spread, rebuild | already used |
| `GET /fapi/v1/aggTrades` | aggressor flow, delta, sell pressure | **new** — add to `ALLOWED_ENDPOINTS` allowlist |
| `GET /fapi/v1/klines` | swing low / support retest / window low | **new** — add to allowlist |
| `GET /fapi/v1/premiumIndex` | funding (static) | already used |

Hard constraints carried forward and asserted by tests:

- Hosts restricted to `fapi.binance.com` (futures) and the public spot mirrors
  already allowlisted.
- Reject any URL containing `signature`, `timestamp`, `apikey`, `margin`,
  `leverage`.
- Reject `/order`, `/dapi`, `/sapi`.
- No `aggTrades`/`klines` parameter set ever includes a signed param.
- `trades` is **not** needed — `aggTrades` with `startTime/endTime`
  reconstructs the trailing window statelessly and is lighter.

---

## 4. Storage shape — `fleet.radarMicrostructureSnapshot.data[SYMBOL]`

Additive and backward-compatible: existing flat static fields stay (nothing
downstream breaks); rolling lives in a separated, timestamped, sample-counted
block.

```
data["BEATUSDT"] = {
  // existing flat static fields (unchanged, back-compat) ----------------
  orderBookDepthWithin1Pct, depthUsdWithin1Pct, spreadPct, fundingRate,
  staticAt: "2026-06-18T12:00:05Z",

  // NEW: rolling block — separated + timestamped + sampled --------------
  rolling: {
    absorptionScore, deltaImprovementPct, marketBuyVolumeDominance,
    aggressiveSellsFailed, bidAbsorption, bidDepthRebuildPct,
    supportRetested, distanceToSupportPct,
    windowMs: 300000,
    samples: { aggTrades, depthSnapshots, klines },
    at: "2026-06-18T12:00:05Z"   // rollingAt — drives staleness
  }
}
```

**Merge change (gate-free, safety-only):** `refreshTradingRadarFromFleet`
currently does `{ ...candidate, ...micro }`. It must instead hoist `rolling.*`
onto the row **only when** `now − rolling.at ≤ ROLLING_TTL` **and** `samples`
meet the floors; otherwise the rolling fields are dropped and the row keeps
static-only. Static fields continue to hoist as today. No threshold, score
weight, or gate boolean is touched.

---

## 5. UI diagnostics

Extends the existing micro panel in `apps/edge/public/js/terminal.js`
(≈ line 7330+), which already shows *Static present/missing*, *Rolling
present/missing*, *Absorption blocked by*, *Missing absorption fields*. Add:

- **Static present** — already wired to `hasStaticMicrostructure` (keep).
- **Rolling present** — already wired to `hasRollingMicrostructure` (keep).
- **Rolling stale** — new row: `rolling.at` older than `ROLLING_TTL` ⇒
  "stale (as of HH:MM)". When stale, *Rolling present* must read **missing**
  (merge dropped it), so the two never contradict.
- **Rolling samples** — new row: `aggTrades / depthSnapshots / klines` counts,
  so a thin-data omission is visible.
- **Missing fields** — reuse the existing `missingAbsorptionFields` chip list.

---

## 6. Safety invariants (each gets a regression test)

1. **Static-only never passes Absorb** — already true
   (`hasRollingMicrostructure=false` ⇒ `absorptionConfirmed` unreachable).
   Regression-lock it.
2. **Rolling stale never passes Absorb** — merge drops stale rolling ⇒ row
   reverts to static-only ⇒ invariant 1.
3. **Low sample count never passes Absorb** — producer omits below floor; merge
   re-checks `samples`. Either way the field never reaches the gate.
4. **No Telegram unless existing strict ENTRY_READY gates pass** — unchanged.
   This phase touches no Telegram/ENTRY_READY code; the repo guard test
   (`tests/radar.telegram.test.mjs`) stays green.
5. **No invention** — `aggressiveSellsFailed`/`bidAbsorption` omit (never emit
   `false`) when there is no measurable sell event; `absorptionScore` omits
   unless all inputs present.

---

## 7. Test plan (write tests BEFORE implementation)

Pure-function unit tests on fixtures (no network):

- `computeBidDepthRebuildPct`: 1 snapshot → omit; 2 snapshots rising → positive;
  collapsing → ≤ 0.
- `classifyAggressiveFlow` (aggTrades fixture): correct buy/sell notional split
  by `m`; `marketBuyVolumeDominance` correct; below `MIN_NOTIONAL` → omit.
- `computeDeltaImprovement`: improving vs deteriorating halves; < 60 trades →
  omit.
- `detectAggressiveSellsFailed`: sell spike + recovery → true; sell spike + new
  low → correct false/omit; **no sells → omit** (not `false`).
- `detectSupportRetest`: retest-and-hold → true with `distanceToSupportPct`; too
  few candles → omit.
- `composeAbsorptionScore`: all inputs present → 0–100; **any input missing →
  omit**.

Integration / guard tests:

- Producer with mocked `fetch`: posts a `rolling` block with `samples`/`at`;
  thin data → static-only payload (no `rolling`).
- Merge test: fresh rolling hoists to row; stale rolling dropped; static
  unaffected.
- Safety tests for invariants 1–5 above (static-only, stale, low-sample,
  no-Telegram, no-invention).
- Endpoint allowlist test: `aggTrades`/`klines` permitted; any signed param /
  `/order` / `/sapi` / `/dapi` rejected.
- Scheduler guard test (extend existing
  `tests/radar.microstructure-scheduler.test.mjs`): rolling workflow still has
  no worker/session, no signed endpoints, no `BINANCE_API_KEY/SECRET`, no
  Telegram/ENTRY_READY.

---

## 8. Cadence recommendation

**Run every 5 minutes (`cron: '*/5 * * * *'`), each run fully self-contained.**

- GitHub Actions cron has a **hard ~5-minute floor and is frequently delayed**
  several minutes. 30 s / 1 m are **not achievable** on GitHub cron, so do not
  design for them there.
- This is acceptable because each run **reconstructs the trailing 5-minute trade
  window from `aggTrades?startTime`** — gaps between runs are covered for flow
  metrics. Only `bidDepthRebuildPct` is sampled at run time (hence the intra-run
  dual-snapshot design).
- Set `ROLLING_TTL ≈ 12–15 min` (≈ 2–3 missed ticks) so a stalled scheduler
  **fails closed** automatically.
- If genuine sub-minute absorption is ever required, it must use a **separate
  read-only scheduler that still obeys every guardrail** (public-only, unsigned,
  no order paths) — and **must not** be solved by reintroducing
  `local-binance-worker` or a worker session. That is explicitly out of scope.

---

## 9. Top-N cap & memory/cache design

- **Separate, lower cap for rolling:** `WORKER_RADAR_ROLLING_TOP_N` default
  **5**, hard cap **10** (rolling costs ~5 calls/symbol: 2× depth + aggTrades +
  klines + reuse premiumIndex, vs 2 for static). Keep the static
  `TOP_N_HARD_CAP = 50` independent.
- **Weight budget:** 5 symbols × ~5 calls ≈ **25 unsigned public calls/run** —
  negligible against Binance fapi weight limits even with retries.
- **Memory:** per-run in-process `Map` only (like the existing producer); **no
  cross-run persistence, no global/module state, no session.** The only
  persisted state is the posted snapshot in the fleet doc, bounded by top-N.
- **Flag:** the entire rolling path is behind `WORKER_RADAR_ROLLING_ENABLED`
  (default `false`), independent of the static enable, so it ships dark and is
  enabled in staging first.

---

## Acceptance criteria

1. Pure measurement functions exist with unit tests; every "below sample /
   unmeasurable" path **omits** the field (asserted), never emits `null`/`0`/
   `false`-by-default.
2. Producer posts the additive `rolling` block with `samples` + `at`;
   thin/failed data yields a static-only payload.
3. Backend merge hoists rolling fields **only when fresh and sufficiently
   sampled**; stale/thin rolling is dropped and the row is static-only.
4. All five safety invariants have passing regression tests; `absorptionConfirmed`
   cannot be reached from static-only, stale, or low-sample data.
5. Endpoint allowlist extended to `aggTrades` + `klines` only; signed/order/
   `sapi`/`dapi` still rejected by test.
6. Rolling path is OFF by default (`WORKER_RADAR_ROLLING_ENABLED=false`);
   enabling it changes **no** ENTRY_READY/Telegram/threshold/score behavior —
   proven by the existing suites staying green.
7. UI shows rolling present / **stale** / sample counts / missing fields without
   contradiction.
8. No `local-binance-worker`, no worker session, no live/testnet lifecycle, no
   signed Binance endpoint anywhere in the path.

---

## Implementation phases

- **Phase 0 — this doc:** sign-off on field formulas, storage shape, cadence,
  TTL.
- **Phase 1 — pure math + tests:** measurement functions on fixtures only. No
  network, no posting, no flag. (Lowest risk; fully reviewable.)
- **Phase 2 — producer wiring (dark):** extend the producer behind
  `WORKER_RADAR_ROLLING_ENABLED=false`; add `aggTrades`/`klines` to the
  allowlist; post the additive `rolling` block. Static path untouched.
- **Phase 3 — merge staleness + hoist + UI (gate-free):** TTL/sample-gated hoist
  in `refreshTradingRadarFromFleet`; UI stale/sample rows. Safety invariant
  tests land here.
- **Phase 4 — scheduler:** `*/5` workflow (extend or sibling of the static one),
  still read-only; enable flag in **staging** first, watch false positives.
- **Phase 5 — production enable:** flip the flag in prod, monitor the risk table
  below.

---

## Risk table (false-positive sources)

| Risk | How it fakes "Absorb" | Mitigation | Fail-closed default |
|---|---|---|---|
| **Spoofed book depth** | Fake bid walls inflate `bidDepthRebuildPct`/`bidAbsorption` | Require coincidence with **real executed** aggressive-sell flow (aggTrades), not resting size; cap rebuild contribution at 10 pts; never let depth alone satisfy the gate | If only depth (no trade flow) → omit rolling |
| **Illiquid tokens** | A few trades swing delta/score wildly | `MIN_NOTIONAL` + min-trade floors per window; top-N is volume-ranked; hard cap 10 | Below floor → omit |
| **Binance route inconsistency** (futures-only symbol, mirror lag, 451) | Partial reads emit half a picture | Per-endpoint try/catch → omit just that field; `absorptionScore` omits unless **all** inputs present | Any leg fails → that field absent |
| **Sudden BTC/ETH risk-off** | Local "absorption" while market breaks down | **Out of scope to fix here** — the existing `marketRegime` gate (`regime.blocksMeanReversion`) already blocks; this phase must not weaken it | Regime gate unchanged, still blocks |
| **Stale scanner context** | Old candidate list measured as if current | `ROLLING_TTL` on `rolling.at`; merge drops stale; scanner-context freshness is its own existing concern | Stale → rolling dropped, static-only |
| **Producer stall / missed cron** | Last good score lingers and looks live | TTL ≈ 2–3 ticks; UI "rolling stale"; merge drops | Stall → fails closed within ~15 min |
| **Partial-window delta noise** | Half-window blip reads as improvement | Two-half comparison + normalize by total notional + min trades/half | Thin half → omit |

---

This is a design document only. Implementation is deferred to the phases above
and must preserve every guardrail: public-only, unsigned, no order/execution
path, no `local-binance-worker`, no worker session, and no change to
ENTRY_READY, Telegram, thresholds, gates, or scores.

## Current producer hardening status (2026-07-23, local-only)

The rolling producer now has a safe standalone target path for a future **local machine or VPS** runner whose public Binance Futures egress has been independently verified. It remains disabled by default and no recurring runner is added in this change.

- With explicit `--symbols` or `WORKER_RADAR_ROLLING_SYMBOLS`, only validated futures symbols are used. Otherwise the producer reads the existing worker-token-protected `GET /api/bot/radar-candidates`; fetch failure fails closed.
- `BOT_WORKER_TOKEN` is sent only as the existing `X-BOT-WORKER-TOKEN` request header and is never logged. `CONTROL_BASE_URL` is required for candidate loading and any POST.
- POST is refused for zero candidates, zero measured rows, zero trusted rows, invalid rows, missing configuration, or public Binance HTTP 451. A valid snapshot is the only payload that may reach `/api/bot/radar-rolling-microstructure`.
- GitHub-hosted Actions remains unsuitable for a rolling runner because Binance Futures public egress can return HTTP 451. Do not add a GitHub schedule. A future runner must be local/VPS, conservative, explicitly enabled, and monitored through the existing rolling snapshot freshness/strict diagnostics.
- This path uses only unsigned public `aggTrades`, `depth`, and `klines`; it has no Telegram, trading, order, session, scheduler, or Binance API-key/secret path.