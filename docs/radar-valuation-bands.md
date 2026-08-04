# RADAR valuation bands — oversold / overbought

**Status:** implemented, live on the Fleet RADAR path, **advisory-only**.
**Owner-facing question it answers:** *"is this coin currently stretched LOW or
stretched HIGH relative to how it normally behaves?"*

---

## What it is — and what it deliberately is not

| | |
|---|---|
| **Scope** | Position of the current price inside **this coin's own** recent range and momentum. |
| **NOT** | A fundamental valuation. Nothing here reads supply, revenue, FDV, tokenomics, or a "fair price". "Oversold" never means "worth more than it costs". |
| **NOT** | An entry signal, an exit signal, or a gate. Every output block carries `isEntrySignal:false`, `affectsGate:false`, `affectsTelegram:false`. |
| **Effect on trading** | **None.** `ENTRY_READY`, Absorb, Reclaim, `SETUP_SCORE`, `EXECUTION_SCORE`, `FINAL_CONFIDENCE`, `telegramEligible` are all untouched. An oversold coin is still only actionable when the existing RADAR gates pass. |

The wording in the UI states this in three places (column header tooltip, the
Focus-card panel title, and the per-row caveat list) because "oversold" is the
single most tempting label in the terminal to misread as a trade instruction.
The UI vocabulary is deliberately **Relative Value / Stretch / Oversold /
Overbought / Advisory only** — never "undervalued", "underpriced", or "cheap".

## The two layers

### 1. Momentum layer — every candidate, no database

Weighted multi-timeframe stretch over whatever the row actually carries:

| timeframe | weight | full-stretch reference |
|---|---|---|
| 1h | 0.10 | 4 % |
| 4h | 0.15 | 8 % |
| 12h | 0.20 | 12 % |
| 24h | 0.30 | 18 % |
| 7d | 0.25 | 35 % |

- Each timeframe contributes `clamp(change / reference, ±1.5)`; one extreme hour
  can never dominate the read.
- Weights are normalized over the timeframes that are **present**. An absent
  timeframe is reported in `momentum.missing`, never scored as a flat 0 %.
- **Volatility normalization:** when `atrPct` / `realizedVolatilityPct` is known,
  every reference is scaled by `clamp(atrPct / 5, 0.5, 3)` — a coin that
  routinely moves 15 %/day needs a much bigger drop to read oversold than one
  that moves 2 %/day. When volatility is unknown the factor is exactly 1 and the
  UI says the stretch is *not* volatility-normalized.
- **BTC-relative nudge:** a bounded ±12 score points from
  `btcRelativeChangePct`, reported separately as `momentum.btcRelativePoints`.

Because the Fleet snapshot rows carry only a 24 h change, most rows get a
one-timeframe momentum read. That is why the database layer matters.

### 2. Stored-history layer — top-ranked candidates, from Postgres

Read from `market_price_points` (the scheduled CoinGecko price-history
collector's table — see `docs/price-history-scheduler.md`):

| component | weight | meaning |
|---|---|---|
| range percentile | 0.45 | where the price sits between the window low (0) and high (100) |
| sampled Wilder RSI | 0.35 | RSI over the sampled closes, period `min(14, floor(n/2))` |
| z-score | 0.20 | `(price − windowMean) / stdev`, contribution clamped at ±2σ |

Also reported for the operator (not scored): `meanDeviationPct`, `windowLow`,
`windowHigh`, `windowMeanPrice`, `pointsUsed`, `windowHours`.

Honesty rules baked into this layer:

- Requires **≥ 12 usable points spanning ≥ 30 minutes**; otherwise
  `INSUFFICIENT_HISTORY` (distinct from `NO_HISTORY`).
- The RSI is labelled **sampled** everywhere, because the points are collector
  samples at an irregular cadence, not candles.
- A perfectly flat window is `FLAT_WINDOW`, **not** `FAIR`. A flat series has no
  defined RSI, so `sampledWilderRsi` returns `null` rather than the conventional
  50 — otherwise "no movement" would manufacture a neutral *measurement*.
- The newest stored point's `change_1h_pct` / `change_24h_pct` / `change_7d_pct`
  may fill **missing** momentum timeframes, but only while ≤ 90 minutes old, and
  the fill is disclosed in `momentum.filledFromHistory`.

## Combination, bands, confidence

```
both layers   → score = 0.45 × momentum + 0.55 × history      (basis momentum+history)
history only  → score = history                               (basis history_only)
momentum only → score = momentum                              (basis momentum_only)
neither       → score = null, band UNKNOWN                    (basis none)
```

Score runs **−100 (oversold) … 0 (fair) … +100 (overbought)**:

| score | band |
|---|---|
| ≤ −60 | `DEEPLY_OVERSOLD` |
| −60 … −25 | `OVERSOLD` |
| −25 … +25 | `FAIR` |
| +25 … +60 | `OVERBOUGHT` |
| ≥ +60 | `DEEPLY_OVERBOUGHT` |
| no score | `UNKNOWN` |

Confidence: `low` (momentum only, or the two layers disagree) · `medium`
(history present) · `high` (both layers agree over ≥ 24 points and ≥ 6 h) ·
`unknown` (nothing usable). Layer disagreement is reported explicitly on
`layersAgree:false`, in the summary sentence, and as a caveat.

## Fail-closed behaviour

| situation | result |
|---|---|
| row carries no timeframe change and no history | `UNKNOWN`, `VALUATION_SCORE: null` — **never** `OVERSOLD` (which a reader could take as an invitation to act) and never `OVERBOUGHT` (a bearish label) |
| `null` / `undefined` / `''` change fields | treated as **absent**; a genuinely measured `0` stays a measurement (the `Number(null) === 0` trap) |
| database unreachable / reader missing / query throws | momentum-only bands survive; `radar.valuationSummary.historyAvailable:false` carries the reason; `console.warn('[bot] RADAR valuation stored-history layer unavailable')` |
| database reachable but empty | `historyAvailable:true`, `historySymbolsWithData:0`, per-symbol `NO_HISTORY` — a *different*, visible state from a failure |
| display module fails to load | column renders `UNKNOWN`, `console.warn` + `window.ErrorLog.record('radar_valuation_display_unavailable')` — never a blank cell |

## Where the code lives

| file | role |
|---|---|
| `scripts/radar/valuation-bands.mjs` | pure engine: both layers, bands, merge, summary. No DB, no network, no env, no clock except an injected `now`. |
| `scripts/radar/trading-radar.mjs` | attaches the momentum-only `candidate.valuation` next to the other context-only blocks (`pressureZones`, `positioningContext`, `tradeReadiness`). Reads it back nowhere. |
| `netlify/functions/_price-history.mjs` | `listRecentPricePointsForSymbols` — **one** batched read (`ROW_NUMBER() OVER (PARTITION BY symbol …)`), hard-capped at 60 symbols × 200 points, truncation reported as `symbolsDropped`. |
| `netlify/functions/_radar-valuation-context.mjs` | loads the layers for the top **40** ranked candidates (60 points each) and merges them; writes `radar.valuationSummary`. Touches only `candidate.valuation`. |
| `netlify/functions/bot.mjs` | calls the loader after RADAR evaluation *and* after the Telegram-eligibility restore, so it cannot influence either. Logs any failure. |
| `apps/edge/public/js/price-history-signals-panel.js` | pure display models `radarValuationDisplayModel` / `radarValuationSummaryModel`, exposed on `window.__priceHistorySignalsPanel`. |
| `apps/edge/public/js/terminal.js` | the `Value` column, the Oversold/Overbought filter chips, the Focus-card valuation panel, the coverage note. |
| `apps/edge/public/css/terminal.css` | `.radar-val-pill*` — cyan for oversold (attention), amber for overbought (caution), muted grey for UNKNOWN. Deliberately **not** the green/red of the pass/fail gate pills, so a band can never be mistaken for an approval. |

## Cost

No new external fetch, no new scheduler, no new cron, no migration. One extra
Postgres statement per RADAR refresh (≤ 60 min cadence), replacing what would
otherwise have been up to 40 separate per-symbol reads.

## Tests

- `tests/radar.valuation-bands.test.mjs` — layer maths, band edges, the
  `Number(null)` trap, `FLAT_WINDOW`, disagreement, the honesty contract.
- `tests/radar.valuation-context.test.mjs` — bounding, single batched read,
  DB-failure vs empty-DB, and a byte-identical assertion that **no** field other
  than `valuation` changes during enrichment.
- `tests/price-history.multi-symbol-reader.test.mjs` — input validation, the
  60 × 200 caps, SQL shape, `DB_UNAVAILABLE`.
- `tests/frontend.radar-valuation-display.test.mjs` — display models, terminal /
  CSS / `index.html` wiring, and a source-level guard that no gate path reads the
  valuation block.

## Deliberately not done (candidate follow-ups)

1. **Canonical store**: `radar_candidate_state` has no valuation columns, so
   `/api/cockpit-radar-state` does not return the band. Adding it needs a
   migration and is a separate reviewed change.
2. **Coverage beyond the top 40**: the bound is a cost decision, not a
   limitation of the maths. Raising `RADAR_VALUATION_TOP_N` (and the reader's
   `MAX_BATCH_SYMBOLS`) is the one-line widening if the read stays cheap.
3. **Longer windows**: the band is only ever as long-horizon as the collector's
   retention. With the current retention the window is hours-to-days, so it
   answers "stretched low this week", not "stretched low this cycle".
