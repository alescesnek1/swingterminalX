# RADAR backtest simulation contract

**Status:** pure local backtest semantics only. This contract creates no data source, exchange adapter, credentials, order, scheduler, runner, database record, or live/paper runtime behavior.

## Position sizing and risk

Each supplied trade plan uses one validated historical RADAR candidate fixture. The sizing object selects `fixedNotional`, `percentEquity`, or `riskAtStopPercentEquity`. Percent values are decimal fractions of the quote-specific ledger equity (for example `0.01` is one percent). Risk-at-stop sizing requires a concrete stop below the long entry price.

A deterministic risk decision rejects unknown quote balances, unsupported quote/product, invalid sizing, missing stop, exposure above `maxExposurePerTrade`, real stop risk above `maxRealRiskAtStop`, active positions at `maxOpenPositions`, or worst-case daily loss beyond `maxDailyLoss`. USDT and USDC never share a balance, PnL, margin, or equity curve.

## Fills, costs, and exits

Supported fill models are `candleClose`, `nextOpen`, and `conservativeIntrabar`. Long entries pay supplied slippage plus half spread; exits receive the same conservative adverse adjustment. Maker/taker fee selection is explicit and deterministic. No liquidity, partial-fill, or random-fill behavior is invented.

A long position exits at the candidate stop or first target. If both are touched in one evaluation candle, stop wins and the result records `ambiguous_intrabar_stop_first`. Positions otherwise remain open and carry a marked unrealized PnL, or close at dataset end only when requested. Exits are reported as reduce-only assumptions.

## Accounting and Futures

`tradePlans` permits multiple sequential simulated positions. The engine returns positions, plan-level risk decisions, detailed events, quote ledgers, and per-quote equity curve points. Ledger fields distinguish realized PnL, unrealized PnL, fees, funding fees, equity, available balance, and margin used.

Futures is isolated-margin only, defaults to 1x, and rejects leverage above 2x. Positive supplied funding rate is charged deterministically to the simulated long position; unknown liquidation proximity is reported, not fabricated. Cross margin, averaging down, and martingale are expressly disabled assumptions.

## Stable risk codes

`max_exposure_exceeded`, `max_real_risk_exceeded`, `max_open_positions_exceeded`, `max_daily_loss_exceeded`, `missing_stop`, `unknown_balance`, `unsupported_quote`, `unsupported_product`, `leverage_too_high`, `liquidation_unknown`, `invalid_sizing_model`, and `ambiguous_intrabar_stop_first` are stable machine-readable simulation/risk codes. `liquidation_unknown` is reported as an unknown warning for the skeleton; it never manufactures liquidation evidence.

## Portfolio scheduling scenarios

`runRadarPortfolioBacktest(scenario)` consumes versioned synthetic scenarios only. It orders candidate jobs by scheduled timestamp ascending, then configured numeric priority, symbol ascending, and fixture ID ascending. The scheduler carries simulated quote-specific balances, daily realized PnL, and open positions between jobs; it never mixes USDT and USDC. Same-time candidates beyond `maxOpenPositions` receive a stable `max_open_positions_exceeded` veto. Candle arrays are normalized by UTC open time before deterministic fills; stale/unknown candidates fail before sizing or fills.
