# KuCoin architecture baseline

**Status:** planning/documentation only. No KuCoin adapter, private API call,
credential handling, order path, scheduler, runner, or Telegram behavior is
implemented by this document.

## 1. Product direction

- **Exchange direction:** KuCoin EU. Alpaca is dropped for this bot direction.
- **Products:** Spot and Futures, with USDT and USDC treated as separate quote
  currencies and balance/risk domains. Product availability must still be
  discovered per KuCoin EU account and symbol; it is not assumed from a symbol
  name.
- **Delivery order:** deterministic backtesting first, simulated/paper trading
  second, and live trading only after explicit manual owner approval.
- **Operating model:** cloud-first, multi-user, and browser-first for Mac and
  Windows users. Normal users must not run a local worker.
- **Platform boundary:** Netlify remains the Terminal X UI and control plane.
  A managed execution runner is a later option only if a live system needs an
  always-on reconciliation and execution boundary.
- **Network policy:** no IP rotation, geo-bypass, proxy bypass, or evasion.
  A future runner may use stable private/static egress only for reliability,
  compliance, and KuCoin API-key IP allowlisting.
- **Safety invariant:** existing Binance code and every existing RADAR,
  `ENTRY_READY`, Telegram, worker, kill-switch, and trading gate remain
  unchanged. This plan does not authorize KuCoin runtime work.

## 2. Netlify reality

### What Netlify can safely do

Netlify is appropriate for authenticated Terminal X screens, strategy and
backtest configuration, durable control-plane requests, reports, bounded
backtest batches, paper-ledger APIs, and audit views. Its function limits make
it suitable for short, idempotent work: synchronous functions have a 60-second
limit, scheduled functions 30 seconds, and Background Functions 15 minutes.
Background Functions also retry after a failure, so they cannot be treated as
an exactly-once order daemon. See the [Netlify function configuration](https://docs.netlify.com/build/functions/configuration/)
and [Background Functions documentation](https://docs.netlify.com/build/functions/background-functions/).

### What Netlify must not do

Netlify must not be the persistent private-market WebSocket consumer, order
reconciliation daemon, liquidation monitor, or holder of per-user exchange
secrets. It must not sign KuCoin requests for a multi-user live product.

### Netlify-only live mode

A Netlify-only mode would be conservative swing automation only: short,
idempotent checks, a durable state read on every invocation, explicit
reconciliation before a retry, and exchange-native stop/TP protection. It is
risky for Futures because retries, scheduling delay, cold starts, and process
boundaries can leave an open position without an active monitor. It cannot
support scalping or promise continuous protection.

### Later live boundary

If live execution is approved, use a managed runner with a dedicated workload
identity and external vault/KMS access. Netlify writes authenticated, durable
intent/control records; the runner claims, signs, submits, and reconciles them.
Exchange-native protection is mandatory because it remains active when the
runner is unavailable.

## 3. Trading RADAR strategy source

The first strategy is not a new heuristic. It starts from the existing Trading
RADAR backend output and may eventually create a `TradeIntent` only after the
backend-field mapping and future risk-manager contract are implemented.

### Current signal path

1. `netlify/functions/bot.mjs` builds the current market/scanner inputs and
   persists the Trading RADAR state in the Fleet control-plane state.
2. `scripts/radar/trading-radar.mjs` `evaluateTradingRadar()` merges market
   snapshots with scanner candidates, rolling microstructure, closed-klines
   structural context, and scanner context.
3. For every universe candidate it calls `classifyRadarStage()`,
   `buildPriceLevels()`, safety classification, and `buildRadarV1Output()`.
4. `buildRadarV1Output()` is the single source of truth for V1 status. Only
   `EARLY_ENTRY_READY`, `STANDARD_ENTRY_READY`, and
   `AGGRESSIVE_ENTRY_READY` become `actionability: 'ENTRY_READY'`.
5. `state.entryReady` is filtered only from that V1 actionability. A heuristic
   stage can never promote an entry by itself.
6. `netlify/functions/cron-alerts.mjs` separately applies the existing strict
   Telegram selector; no future strategy may weaken or replace it.

The current source universe and rolling microstructure are Binance-context
data. A future KuCoin implementation must record source venue and timestamp and
must not assume a same-named KuCoin market has equivalent microstructure,
funding, liquidity, or fill conditions.

### Matrix label mapping

The matrix in `apps/edge/public/js/terminal.js` renders fields from an already
computed candidate. Headers, pills, formatting, focus cards, and the
`tradeReadiness` summary are not execution authority.

| Matrix label | Backend candidate field(s) | Classification |
|---|---|---|
| Dist | `distanceToEntryReadyScore` | Display/ranking metric. It is capped below 100 outside V1; exactly 100 mirrors a V1 entry. Never a standalone gate. |
| Setup | `SETUP_SCORE` | V1 input; threshold is at least 65, but only as part of V1. |
| Exec | `EXECUTION_SCORE`, `executionDataMissing` | V1 input; threshold is at least 65 and missing execution data blocks strict alert eligibility. Never standalone. |
| Conf | `confidence`, `FINAL_CONFIDENCE` | Candidate display is adjusted from stage and V1 confidence. V1 base needs at least 55; existing Telegram needs at least 75. Never standalone. |
| Dump | `conditionChecklist.relativeDump`, `DISLOCATION_SCORE` | Stage diagnostic; neither table label nor score alone authorizes entry. |
| Flush | `conditionChecklist.longFlush`, `FLUSH_SCORE` | Stage diagnostic; required in some V1 paths but not a standalone permission. |
| Stabil. | `conditionChecklist.stabilization`, `STABILIZATION_SCORE` | Stage diagnostic; required in some V1 paths but not a standalone permission. |
| Strict Absorb Gate | `STRICT_ABSORB_STATUS`, `STRICT_ABSORB_CONFIRMED`, `STRICT_ABSORB_SCORE` | Strict rolling evidence. It tightens the aggressive path only; proxy, stale, unavailable, or untrusted data never substitutes for it. It does not alone create `ENTRY_READY`. |
| Reclaim | `RECLAIM_STATUS`, `RECLAIM_SCORE`, reclaim diagnostics | The structured Reclaim v2 output is additive/diagnostic and never loosens V1. `RECLAIM_SCORE` participates in V1 branch selection, but a reclaim label alone cannot authorize entry. |
| Regime | `MARKET_REGIME_SCORE`, `marketRegimeDiagnostics`, `gates.regimeAllowsLong` | V1 input. Score must be at least 50 and the regime must not block mean reversion. |

Other backend fields important to a future mapping are `STATUS`, `ACTION`,
`ENTRY_TYPE`, `ENTRY_ZONE`, `STOP_LOSS_LEVEL`, `HARD_INVALIDATION`,
`TAKE_PROFIT_LEVELS`, `RISK_REWARD_SCORE`, `gates`, `allRadarConditionsPassed`,
`safetyStatus`, `BLOCKED_BY`, `NEXT_CONFIRMATION`, and data-quality/missing-data
fields. `pressureZones`, `positioningContext`, price-history context, browser
orderbook views, and `tradeReadiness` are context/display additions and are not
execution gates.

### Backend rule before any future TradeIntent

This is a design constraint, not implemented behavior. A future server-side
RADAR-to-intent mapper must fail closed and require, at minimum:

1. a fresh candidate produced by the server-side V1 pipeline;
2. `actionability === 'ENTRY_READY'` and a V1 entry-ready `STATUS`;
3. `allRadarConditionsPassed === true`, with V1 `gates` and data-quality
   conditions passing;
4. `safetyStatus === 'SAFE'`, valid entry/stop/invalidation/target structure,
   and no stale or untrusted required data; and
5. a separate future Risk Manager approval.

`telegramEligible` remains the existing notification gate, not a substitute for
the future trade-execution authorization. Ambiguous, absent, stale, advisory,
cross-venue, or UI-only information remains `UNKNOWN` and produces no intent.

### Known unknowns

- No KuCoin market-data adapter or KuCoin-native RADAR input exists yet.
- Historical rolling strict-Absorb, order-book, flow, and some derivatives
  observations have not been durably stored for a long historical replay.
- Existing RADAR is long mean-reversion oriented; future short strategy rules,
  if any, need a separate approved mapping.
- The exact historic availability/retention of KuCoin EU public data must be
  measured before claiming a backtest horizon.

## 4. Backtesting-first plan

Build a deterministic RADAR-driven simulator before credentials or live API
work. Import available public historical candles as far back as a documented
source can honestly provide, version every data set, and preserve source venue,
symbol mapping, interval, collection time, and gap/correction metadata.

Reconstruct only what stored data supports:

- candles can support historical price movement, selected reclaim/setup inputs,
  stops, targets, and portions of regime reconstruction;
- historical regime must be recomputed from a versioned rule and marked as a
  reconstruction, not current-server truth;
- strict rolling Absorb, live depth, flow, OI, funding, liquidation, and
  execution inputs are `UNKNOWN` unless a compatible historical source or a
  future stored snapshot exists;
- optional depth snapshots may improve simulation, but absence must not be
  filled with invented liquidity.

The simulator must model fees, spread, configurable slippage, funding paid or
received for Futures, stops/targets, partial fills, conservative latency, and
liquidation distance. It must support walk-forward and out-of-sample runs,
parameter sweeps with predeclared ranges, and warnings that repeated tuning is
overfitting rather than proof.

Required scorecard metrics: total return, maximum drawdown, win rate, profit
factor, average R, largest loss, daily-loss distribution, trade count, exposure
time, fees, funding paid/received, liquidation proximity, performance by market
regime and RADAR-gate combination, and false-positive/missed-trade review where
the historical data supports it.

## 5. Spot and Futures safety

Spot is the first validation product. Futures are in the design because the
owner's KuCoin EU account has Futures enabled, but remain locked until manual
approval.

- Futures start at 1x leverage; a pilot maximum is 2x unless the owner
  explicitly approves more.
- Isolated margin first; no cross margin initially.
- No martingale, averaging down, or automatic leverage increases.
- Exits are reduce-only where the verified product supports them.
- Futures risk must include funding, maintenance/liquidation distance, and
  exchange degradation.
- Unknown, stale, un-reconciled, or insufficient state means no trade.

## 6. Multi-user secret model for later live use

No secret work is authorized now. Future live onboarding must use these
boundaries:

- no browser persistence or display of plaintext credentials;
- no per-user key/secret/passphrase in Netlify environment variables;
- envelope encryption at rest via an external KMS/vault;
- only a future managed runner workload identity may decrypt;
- KuCoin keys limited to the required read/trade permission, never withdrawal;
- masked metadata only, explicit revoke/delete, audit logging, ownership checks,
  failed-auth lockout, and rate limits;
- a signed read-only key test before any account can be considered for live
  trading.

## 7. Target architecture

```text
Terminal X frontend + existing Supabase-backed/current auth model
        |
Netlify control plane ---- durable event/memory store
        |                         |
        |                   Backtest engine <--- historical data catalog
        |                         |
Trading RADAR --> strategy mapper --> Risk Manager --> paper ledger
                                                    |
                                              Order Manager
                                                    |
                           later only: managed runner + vault/KMS
                                      |                 |
                             KuCoinSpotAdapter   KuCoinFuturesAdapter

Durable events --> existing-safe notification boundary --> Telegram notifications
```

The strategy mapper is server-side, consumes only mapped RADAR candidate truth,
and creates no exchange request. The Risk Manager vetoes every `TradeIntent`.
The Order Manager owns only simulated state until a later explicit live phase.

## 8. Risk Manager

The Risk Manager has final veto power over every intent. Initial policy must
cover maximum exposure, maximum real loss at stop, maximum daily loss, maximum
positions, maximum trades/day, maximum leverage, liquidation distance, stale
data, wide spread, thin orderbook, fake-spike conditions, failed/unknown RADAR
gates, exchange degradation, reconciliation-required state, global/per-account
kill switches, and the owner live-approval gate.


## 9. Order Manager

Design state only:

```text
intent -> risk_decision -> queued -> simulated_submitted -> simulated_filled
      -> simulated_stopped | simulated_take_profit

later live only:
queued -> submitted -> acknowledged -> reconciled
       -> partial_fill | filled | canceled | rejected
       -> exit_protected -> closed
```

Future live submission requires durable idempotency/client-order identity,
lease/claim ownership, reconciliation before retry, and sanitized audit events.
No live order path is created now.

## 10. Frontend UX direction

Future Terminal X panels: Backtesting Lab, Trading RADAR Strategy Mapping, Bot
Control, Strategy Monitor, Risk Monitor, Execution Monitor, Memory/Data Health,
Telegram Notifications, and Emergency Controls.

Every future surface must show which server RADAR gates are satisfied, why entry
is blocked, why risk vetoed, and one unambiguous mode:
`BACKTEST`, `SIM_PAPER`, `PAPER_EXCHANGE_TEST`, `LIVE_LOCKED`, `LIVE_ARMED`, or
`LIVE_ACTIVE`. It must also show Spot/Futures, USDT/USDC, leverage and
liquidation distance for Futures, and owner approval state.

## 11. Telegram direction

Initial future behavior is notification-only: intent created, risk approval or
veto, simulated/paper entry, material state change, planned stop/target/exit,
actual simulated exit, and emergency/risk event. It creates no trading command
and no KuCoin call.

Later commands, if approved, create durable audited requests. Dangerous actions
require ownership checks and explicit confirmation; no command directly reaches
KuCoin or bypasses the Risk Manager, kill switches, or current Telegram rules.

## 12. Implementation roadmap

1. KuCoin architecture docs baseline.
2. Trading RADAR backend-field mapping report.
3. Exchange-neutral domain model.
4. Historical data catalog.
5. RADAR-driven deterministic backtest engine.
6. Strategy contract.
7. Risk Manager.
8. Paper ledger.
9. Backtesting Lab UI.
10. KuCoin public-data adapter.
11. Credential-vault design.
12. Managed runner skeleton, only if later needed.
13. Read-only private account reconciliation.
14. Explicit live approval gate.
15. Micro-live pilot only after owner approval.

Each runtime phase requires a separate approved design, narrowly scoped code,
tests, rollback path, documentation/handoff update, and explicit push/deploy
approval. No phase is implicitly authorized by this roadmap.

## 13. Recommended next coding task

Write the **Trading RADAR backend-field mapping report** as a source-verified
artifact, then review it before creating any domain model. It should freeze the
candidate schema, provenance/freshness requirements, V1 entry predicate,
advisory-field exclusions, and unresolved KuCoin cross-venue questions. It must
not create an adapter, fetch, credential path, runner, scheduler, or order flow.
