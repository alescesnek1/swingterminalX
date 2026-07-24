# Trading RADAR backend-field mapping

**Status:** source-verified documentation audit for future KuCoin backtesting,
simulated/paper trading, and a later owner-approved live design. This report does
not add a strategy, a network call, a scheduler, credentials, an order path, or
a Telegram behavior.

## 1. Executive summary

The real source of truth for current Trading RADAR entry readiness is the V1
candidate output from `buildRadarV1Output()` in
`scripts/radar/trading-radar.mjs`, carried through
`evaluateTradingRadar()`. A candidate is put in the entry-ready list only when
V1 produces `EARLY_ENTRY_READY`, `STANDARD_ENTRY_READY`, or
`AGGRESSIVE_ENTRY_READY`; `evaluateTradingRadar()` then sets
`actionability: 'ENTRY_READY'`.

The Trading RADAR table is a rendering of candidate fields. Its labels --
including Dist, Setup, Exec, Conf, Dump, Flush, Stabil., Strict Absorb Gate,
Reclaim, and Regime -- are unsafe as standalone execution truth. Several are
stage diagnostics, compact render helpers, or score displays. A future KuCoin
strategy must consume the server-produced candidate object and verify its V1
state, data provenance/freshness, safety, levels, and an independent Risk
Manager result.

`telegramEligible` and the Telegram confirmed-entry selector are notification
controls, not trade authorization. Telegram applies extra delivery-specific
checks such as environment enablement, cooldown, deduplication, and its own
confirmation predicate. A Telegram event must never trigger execution.

## 2. Source files inspected

| Path | Ownership verified | Important functions / fields |
|---|---|---|
| `scripts/radar/trading-radar.mjs` | RADAR universe merge, heuristic stage, V1 scoring/gates, output shaping | `evaluateTradingRadar`, `classifyRadarStage`, `radarScorePack`, `buildRadarV1Output`, `allRadarConditionsPassed`, `gates`, `STATUS`, `actionability` |
| `netlify/functions/bot.mjs` | Fleet refresh/orchestration and persistence of `fleet.tradingRadar` | `refreshTradingRadarFromFleet`, `radarMarketsFromSnapshot`, two-pass bounded price-history support, `tradingRadar` browser payload |
| `netlify/functions/cron-alerts.mjs` | Existing confirmed-RADAR Telegram selection only | `radarConditionsPassed`, `evaluateConfirmedRadarEntryReady`, `isConfirmedRadarEntryReady`, `selectRadarEntryAlerts` |
| `apps/edge/public/js/terminal.js` | Matrix/focus rendering only | `renderTradingRadarPanel`, `_fleetRadarV1Status`, `_fleetRadarAbsorbCompact`, `_fleetRadarReclaimCompact`, `pillStatus` |
| `tests/radar.trading-v1.test.mjs` | V1 status/score/reclaim/strict-Absorb regression behavior | Confirms V1 output fields and that score fragments do not independently unlock entry |
| `tests/radar.single-source.test.mjs` | Single-source honesty guards | `distanceToEntryReadyScore === 100` iff V1 actionability is `ENTRY_READY`; scanner-only rows are not Telegram eligible |
| `tests/radar-trade-readiness.test.mjs` | Presentation-only readiness summary | Proves `tradeReadiness` mirrors existing state and carries no execution/Telegram decision |
| `tests/radar.telegram.test.mjs` and `tests/telegram.confirmed-gate.test.mjs` | Telegram fail-closed contract | Proves only fully confirmed, fresh, SAFE entries can send and that cooldown/dedupe/env remain separate |
| `tests/frontend.trading-radar-panel.test.mjs` | UI matrix/focus rendering guards | Proves V1 status precedence and display-only behavior |
| `tests/radar.absorb-v2.test.mjs`, `tests/radar-reclaim.test.mjs` | Strict Absorb/Reclaim fail-closed diagnostics | Proves stale, untrusted, proxy, and missing strict data do not unlock aggressive entry or Telegram |

## 3. Frontend column mapping

The table header is defined in `apps/edge/public/js/terminal.js:9439-9441` and
its row is rendered at `:9391-9413`. Every cell reads an already-computed
candidate; none calls an execution path.

| UI label | Frontend render source | Backend field(s) | Computed in | Meaning | Classification | Backtest reconstructable? | Safe for future TradeIntent? |
|---|---|---|---|---|---|---|---|
| Dist | `c.distanceToEntryReadyScore` | `distanceToEntryReadyScore` | `evaluateTradingRadar` after V1 status; `classifyRadarStage` supplies non-V1 value | Ranking/proximity display. V1 reserves 100 for a real entry-ready row; all others are capped below 100. | Display/ranking mirror | Conditional only: needs the same historical market, scanner, and regime inputs; not candle-only. | Not independently. It may be a redundant consistency check with V1 actionability. |
| Setup | `c.SETUP_SCORE ?? c.setupQualityScore` | `SETUP_SCORE`; fallback `setupQualityScore` | `radarScorePack`; heuristic stage fallback | Weighted setup score. V1 requires `SETUP_SCORE >= 65`. The fallback is presentation-compatible heuristic data, not V1 truth. | V1 hard component when `SETUP_SCORE` is present | Conditional: needs price changes, volume, derivatives/regime inputs, and only bounded stored price-history support. | Yes, only as part of the V1 predicate; never from the UI fallback. |
| Exec | `c.EXECUTION_SCORE` | `EXECUTION_SCORE`, `executionDataMissing` | `radarScorePack` | Execution-quality score; V1 requires at least 65. Missing depth/spread/derivatives/flow are surfaced and penalized. | V1 hard component | Not candle-only. Requires compatible historical depth, spread, flow, and derivatives observations; otherwise `UNKNOWN`. | Yes, only with zero required execution-data gaps and the V1 predicate. |
| Conf | `c.FINAL_CONFIDENCE ?? c.confidence` | `FINAL_CONFIDENCE`, output `confidence` | `radarScorePack`, then adjusted in `evaluateTradingRadar` | V1 entry base requires confidence at least 55; existing Telegram requires at least 75. | V1 component plus Telegram threshold | Conditional: only if every upstream score/input is recreated. | Yes only as part of verified V1 and future risk checks; never as a score-only rule. |
| Dump | `conditionChecklist.relativeDump.status` via `pillStatus` | `conditionChecklist.relativeDump`, `DISLOCATION_SCORE` | `classifyRadarStage`; `radarScorePack` | Shows relative dump/panic stage evidence. | Stage diagnostic / UI pill | Conditional from candles plus relative-market/scanner inputs; scanner tags are not candle data. | No. It explains stage; no table value is a final gate. |
| Flush | `conditionChecklist.longFlush.status` | `conditionChecklist.longFlush`, `FLUSH_SCORE` | `classifyRadarStage`; `radarScorePack` | Shows long-flush evidence. Some V1 branches use the score, but the pill is not the gate. | Stage diagnostic / score input | Conditional: needs candles, volume, funding/OI/liquidation and book inputs depending on path. | No standalone use. Only verified V1 branch logic may use its raw backend inputs. |
| Stabil. | `conditionChecklist.stabilization.status` | `conditionChecklist.stabilization`, `STABILIZATION_SCORE` | `classifyRadarStage`; `radarScorePack` | Shows no-new-low/range/recovery evidence. | Stage diagnostic / score input | Conditional: some price structure is candle-reconstructable; sell fade/bids require stored microstructure. | No standalone use. |
| Strict Absorb Gate | `_fleetRadarAbsorbCompact(c)` (with `STALE` displayed as `DATA OFF`) | `STRICT_ABSORB_STATUS`, `STRICT_ABSORB_CONFIRMED`, `STRICT_ABSORB_SCORE`, `ABSORB_MODE`, `ABSORB_MISSING_FIELDS` | `evaluateAbsorbV2` inside `buildRadarV1Output` | Trusted fresh rolling absorption evidence. It tightens the aggressive branch; proxy, stale, untrusted, unavailable, or incomplete input is not confirmation. | Strict diagnostic that can tighten one V1 branch | Not reconstructable from candles. Requires complete stored historical rolling measurement with provenance. | Never use unknown/stale/proxy as positive evidence. An initial automated policy should require fresh trusted evidence; current non-aggressive display paths do not make it a universal V1 requirement. |
| Reclaim | `_fleetRadarReclaimCompact(c)` | `RECLAIM_STATUS`, `RECLAIM_SCORE`, `RECLAIM_*` diagnostics, `computedStructural*` fields | `evaluateReclaimV2`; score in `radarScorePack`; structural closed-klines enrichment | Price regained a meaningful level after dump. Reclaim v2 itself is additive and must not loosen V1. | Diagnostic plus V1 score/branch input | Conditional: may be reconstructed from stored candles/structural levels; explicit scanner source fields and current source availability must be preserved. | No label-only use. Use only verified raw V1 score/levels and source provenance. |
| Regime | `conditionChecklist.marketRegime.status` | `MARKET_REGIME_SCORE`, `gates.regimeAllowsLong`, `marketRegimeDiagnostics`, `regime.blocksMeanReversion` | `evaluateMarketRegime`, `radarScorePack`, V1 output | Current broad-market condition. V1 requires score at least 50 and no mean-reversion block. | V1 hard component | Conditional: requires historical multi-market universe and the versioned regime algorithm; not one symbol's candles alone. | Yes, as part of verified V1 and future risk policy. |

### Non-column fields that a future mapper needs

`STATUS`, `actionability`, `allRadarConditionsPassed`, `gates`,
`executionDataMissing`, `dataQuality`, `safetyStatus`, `ENTRY_ZONE`,
`STOP_LOSS_LEVEL`, `HARD_INVALIDATION`, `TAKE_PROFIT_LEVELS`,
`RISK_REWARD_SCORE`, freshness timestamps, and source/venue provenance are more
important than any compact table cell.

The following are expressly presentation/advisory context, not execution gates:
`tradeReadiness`, `pressureZones`, `positioningContext`, browser live-orderbook
views, static microstructure status, and bounded price-history context. The bot
preserves baseline Telegram eligibility across its price-history second pass;
price-history support cannot create alert eligibility.

## 4. ENTRY_READY and actionability truth

### V1 status and combined gates

`buildRadarV1Output()` (`scripts/radar/trading-radar.mjs:890-1095`) computes
`STATUS`. Its base requires all of the following:

- `SETUP_SCORE >= 65`;
- `EXECUTION_SCORE >= 65`;
- `RISK_REWARD_SCORE >= 55`;
- `MARKET_REGIME_SCORE >= 50` and no `regime.blocksMeanReversion`;
- no critical safety/fundamental risk;
- a structural stop and at least three take-profit checkpoints; and
- `FINAL_CONFIDENCE >= 55` plus the entry-type data-quality requirement.

It returns `allRadarConditionsPassed` only when that base is valid, the
entry-type data-quality gate passes, and `STATUS` includes `ENTRY_READY`. Its
`gates` object exposes `setupValid`, `executionValid`, `riskRewardValid`,
`regimeAllowsLong`, `dataQualitySufficient`, `microstructureTrusted`, and
`microstructureMissing`.

`evaluateTradingRadar()` (`:2544-2564`, `:2783-2787`) maps only the V1
`EARLY_ENTRY_READY`, `STANDARD_ENTRY_READY`, and
`AGGRESSIVE_ENTRY_READY` statuses to `actionability: 'ENTRY_READY'`. It builds
`state.entryReady` solely from that actionability. A heuristic stage of
`ENTRY_READY` is explicitly demoted rather than allowed to leak into the final
entry-ready list.

### Telegram is stricter and different from trade eligibility

`cron-alerts.mjs:evaluateConfirmedRadarEntryReady()` requires an entry-ready
status, `actionability === 'ENTRY_READY'`, `telegramEligible === true`, all
condition flags, `safetyStatus === 'SAFE'`, no `executionDataMissing`, score
thresholds (Exec 65, Setup 65, R/R 55, Regime 50, Confidence 75), valid
entry/stop/TP levels, and non-stale state. It then separately applies enabled
configuration, cooldown, and dedupe before delivery.

Therefore Telegram eligibility is **not** trade eligibility:

- it is an existing notification/sending authorization;
- a future TradeIntent requires its own future source/venue mapping and a
  RiskManager decision;
- a future TradeIntent must never be created merely because a Telegram message
  was selected or delivered.

## 5. Gate classification

### Hard RADAR prerequisites for a future TradeIntent

- Fresh server-produced V1 candidate with an allowed V1 entry-ready `STATUS`.
- `actionability === 'ENTRY_READY'` and `allRadarConditionsPassed === true`.
- V1 `gates` all true, including setup, execution, risk/reward, regime, and
  entry-type data quality.
- Required levels: entry zone, stop/invalidation, and target structure.
- Required execution fields present; no unknown data presented as zero.
- Supported, verified mapping from the RADAR source symbol/venue to a KuCoin EU
  Spot or Futures product.

### Risk/safety gates for the future RiskManager

- `safetyStatus === 'SAFE'`, no critical safety/fundamental risk, and no
  untrusted/stale source.
- Candidate freshness, exchange health, reconciliation state, wide-spread/thin
  market controls, exposure/loss/trade/leverage caps, and kill switches.
- For Futures: isolated-margin policy, leverage cap, funding and liquidation
  distance. These do not exist as a KuCoin order policy today and remain future
  RiskManager work.
- For the first automated policy, fresh trusted strict-Absorb data is required
  before an intent. This is a planned tightening, not a modification of current
  RADAR or Telegram behavior.

### Advisory context

- `pressureZones`, `positioningContext`, browser live order-book reads, static
  microstructure status, price-history support, scanner tags, and UI summaries.
- The V1 diagnostic text (`REASON`, `ACTION`, `BLOCKED_BY`,
  `NEXT_CONFIRMATION`) helps explain a decision but does not authorize one.

### Diagnostics

- `conditionChecklist`, `stage`, `riskFlags`, strict/proxy Absorb detail,
  Reclaim v2 detail, score breakdown strings, missing-field lists, and regime
  reasons.
- Diagnostics must remain visible and honest, but must not be upgraded to
  synthetic gates.

### UI-only execution prohibitions

- Matrix header text, pill colour/text, focus-card prose, formatted score text,
  selected-row state, filters, and `tradeReadiness` must never drive execution.
- The `SETUP_SCORE ?? setupQualityScore` display fallback must never substitute
  for a missing V1 `SETUP_SCORE`.

## 6. Historical backtesting feasibility

| Signal / gate | Candle-only | Additional historical requirements | Honest backtest state when unavailable |
|---|---|---|---|
| Dist | No | Full historical RADAR/scanner/regime inputs and current version of the calculation | `NOT_RECONSTRUCTABLE` as a standalone score |
| Setup | No | Candles/volume plus historical derivatives, market regime, and bounded price-history context | `UNKNOWN` if required input is absent |
| Exec | No | Depth, spread, trade-flow, and derivatives snapshots aligned to each decision time | `UNKNOWN`; never infer execution quality from candles |
| Conf | No | All Setup/Exec/Regime inputs and safety inputs | `UNKNOWN` |
| Dump | Conditional | Relative-market/scanner state for parity with current stage | Reconstruct only the documented candle portion; otherwise `UNKNOWN` |
| Flush | No | Funding, OI/liquidation, book and scanner inputs depending on branch | `UNKNOWN` if complete evidence is absent |
| Stabilization | Partial | Candles can reconstruct no-new-low/range/recovery; sell fade/bids require microstructure | Partial evidence is not a final entry gate |
| Strict Absorb | No | Complete trusted rolling order-flow/depth/liquidation samples with source/sample timestamps | `NOT_RECONSTRUCTABLE`; cannot be proxied from candles |
| Reclaim | Partial | Historical structural source fields, closed klines, and the same versioned Reclaim logic | `UNKNOWN` when source level/provenance is absent |
| Regime | No | Full historical RADAR universe and versioned regime model | `UNKNOWN` without the universe |
| Levels / R:R | Conditional | Candle/structural data and exact historical input assumptions | `UNKNOWN` if stop/targets cannot be derived honestly |
| Safety | No | Historical token/listing/news/safety evidence and versioned classifier input | `UNKNOWN`, therefore no automated replay entry |

Historical stored RADAR candidates would provide the strongest faithful replay.
Without them, any reconstruction must identify itself as a separately versioned
model, not proof that the original live RADAR would have emitted the same row.

## 7. Future KuCoin strategy rule draft

This is a conservative design rule, not current runtime behavior.

A future server-side `TradeIntent` may be emitted only when all of these hold:

1. the candidate is fresh and was generated by the server-side V1 RADAR
   pipeline;
2. V1 `STATUS` is an allowed entry-ready status, `actionability` is
   `ENTRY_READY`, `allRadarConditionsPassed` is true, and all V1 `gates` pass;
3. `SETUP_SCORE`, `EXECUTION_SCORE`, `RISK_REWARD_SCORE`,
   `MARKET_REGIME_SCORE`, confidence, data quality, and levels are present and
   meet the verified predicate;
4. safety is `SAFE`, required execution/microstructure data is fresh and
   trustworthy, and the initial automation policy rejects stale/unknown strict
   Absorb rather than treating it as positive evidence;
5. the source symbol has a verified, supported KuCoin EU Spot/Futures mapping,
   with quote currency and product metadata recorded; and
6. the future RiskManager explicitly approves the intent.

The future system must not:

- trade from table text, pills, focus-card prose, or frontend-computed labels;
- trade from advisory-only price-history, pressure-zone, positioning, static, or
  browser order-book context;
- trade from stale, proxy, untrusted, incomplete, or unknown strict Absorb;
- trade from a missing V1 field or a UI display fallback;
- submit an order because Telegram selected, sent, or acknowledged a message.

## 8. Open questions and UNKNOWNs

- No KuCoin adapter, product catalog, or source-symbol mapping exists.
- The current RADAR source universe is Binance-context; cross-venue parity is
  unproven.
- Historical availability of KuCoin EU candles, funding, OI, depth, trades, and
  liquidation data is not established here.
- There is no durable historical record sufficient to replay all current strict
  rolling Absorb/flow/depth decisions.
- Current V1 contains early/standard paths whose data-quality policy differs
  from the proposed initial automated strict-Absorb policy; the latter needs an
  explicit future implementation review, never a silent reinterpretation.
- KuCoin Spot/Futures quote/product availability, tick/minimums, and supported
  order protections must be verified in a future public-data/catalog phase.
- The future RiskManager thresholds and owner live-approval representation are
  not implemented.

## 9. Recommended next coding task

Create only the exchange-neutral, pure **RADAR candidate schema and validation
module**, with no fetches, credentials, KuCoin adapter, scheduler, runner, or
order path. It should validate provenance/freshness, distinguish V1 truth from
advisory context, reject missing/unknown prerequisites, and have unit tests for
all documented fail-closed cases. Review that isolated module before beginning
historical-data or backtest work.
