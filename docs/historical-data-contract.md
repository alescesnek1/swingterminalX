# Historical market-data ingestion contract

**Status:** versioned pure contract only. It does not fetch, import, persist, replay, or trade market data. It defines the input shape and fail-closed validation needed before a future separate backtesting implementation may read historical data.

## 1. Versioned dataset envelope

Every dataset uses schemaVersion `historical-market-data/v1` and a producer-owned datasetVersion. Provenance includes provider, venue, product (`spot` or `futures`), quote (`USDT` or `USDC`), normalized source symbol, sourceType, source URL/reference, and UTC fetchedAt/importedAt timestamps. A URL/reference is provenance only; this contract never requests it.

The envelope also carries interval, UTC range (start/end/timezone), candles, gaps, and corrections. Gaps and corrections are explicit metadata even when empty. A future importer must increment datasetVersion when it corrects source content or metadata; it must not silently rewrite an existing version.

## 2. Candle integrity

Supported intervals are `1m`, `5m`, `15m`, `1h`, `4h`, and `1d`. Candle open aligns to the UTC epoch interval, close is exactly one interval later, and duplicate open times are invalid. Detected gaps make the dataset unsuitable for contiguous replay until a future backtest explicitly models them; a known gap is recorded, not filled or interpolated.

Each candle has UTC open/close time, numeric positive OHLC values with `low <= open/close <= high`, non-negative volume, optional non-negative quote volume and trade count, and sourceStatus `AVAILABLE`. Missing or degraded source data is `UNKNOWN`; it never becomes a synthetic candle.

## 3. Futures and depth evidence

For Futures, the optional futures block may carry funding rate, mark price, index price, optional open interest, a future liquidation-distance block, and explicit leverage/margin assumptions for a future simulator. Missing Futures fields are the non-blocking `futures_field_missing` warning and remain `UNKNOWN`, never inferred from spot candles.

Depth is optional. An available snapshot has a UTC snapshot time, non-empty bid/ask levels, non-negative spread, depth summary, and source freshness in its future producer contract. Missing depth produces `depth_unavailable` and normalized depth state `UNKNOWN`. It is never fabricated from candles.

## 4. RADAR reconstruction boundary

Candle-only datasets support only partial structural, reclaim, and level work. Execution quality requires aligned depth. Strict Absorb, actionability, and notification eligibility are `NOT_RECONSTRUCTABLE` without a stored source-labelled `trading-radar-v1` historical candidate fixture. Requesting a non-reconstructable RADAR field fails closed with `radar_field_not_reconstructable`.

## 5. Validation response and codes

`validateHistoricalMarketDataset(dataset, options)` returns ok, blocking reasonCodes, non-blocking warnings, a compact normalizedSummary, the contract schemaVersion, and supplied datasetVersion.

Blocking codes: `missing_dataset`, `unsupported_schema_version`, `unsupported_product`, `unsupported_quote`, `invalid_symbol`, `invalid_interval`, `non_utc_time`, `misaligned_interval`, `duplicate_candle`, `candle_gap`, `invalid_ohlc`, `negative_volume`, `missing_required_field`, `radar_field_not_reconstructable`, and `unknown_state`.

Warning codes: `futures_field_missing` and `depth_unavailable`. Both explicitly mean `UNKNOWN`, never an assumed positive signal.

The import-free implementation is `scripts/radar/historical-data-contract.mjs`.