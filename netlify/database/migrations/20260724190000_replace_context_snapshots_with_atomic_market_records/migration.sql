-- Canonical Binance market data is stored as atomic, time-addressable records.
-- A collection run is audit metadata only; it never owns a market snapshot.
-- The legacy tables are removed only when they contain no market data.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM market_context_snapshots LIMIT 1)
     OR EXISTS (SELECT 1 FROM market_context_rows LIMIT 1)
     OR EXISTS (SELECT 1 FROM market_microstructure_rows LIMIT 1)
     OR EXISTS (SELECT 1 FROM radar_context_snapshots LIMIT 1)
     OR EXISTS (SELECT 1 FROM radar_candidate_snapshots LIMIT 1) THEN
    RAISE EXCEPTION 'Refusing to remove non-empty legacy Context Store tables';
  END IF;
END $$;

DROP TABLE IF EXISTS radar_candidate_snapshots;
DROP TABLE IF EXISTS context_heads;
DROP TABLE IF EXISTS radar_context_snapshots;
DROP TABLE IF EXISTS market_microstructure_rows;
DROP TABLE IF EXISTS market_context_rows;
DROP TABLE IF EXISTS market_context_snapshots;

ALTER TABLE market_collection_runs
  ADD COLUMN IF NOT EXISTS completed_at timestamptz NULL;

CREATE TABLE IF NOT EXISTS market_instruments (
  market text NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol text NOT NULL,
  base_asset text NOT NULL,
  quote_asset text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market, symbol)
);

CREATE TABLE IF NOT EXISTS market_ticker_observations (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES market_collection_runs(id) ON DELETE RESTRICT,
  market text NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol text NOT NULL,
  observed_at timestamptz NOT NULL,
  last_price numeric NULL,
  price_change_percent numeric NULL,
  high_price numeric NULL,
  low_price numeric NULL,
  base_volume numeric NULL,
  quote_volume numeric NULL,
  trade_count integer NULL,
  data_status text NOT NULL CHECK (data_status IN ('complete', 'partial', 'unavailable', 'unsupported')),
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (run_id, market, symbol),
  FOREIGN KEY (market, symbol) REFERENCES market_instruments(market, symbol) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS market_candles_1m (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES market_collection_runs(id) ON DELETE RESTRICT,
  market text NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol text NOT NULL,
  open_time timestamptz NOT NULL,
  close_time timestamptz NOT NULL,
  open_price numeric NOT NULL,
  high_price numeric NOT NULL,
  low_price numeric NOT NULL,
  close_price numeric NOT NULL,
  base_volume numeric NOT NULL,
  quote_volume numeric NULL,
  trade_count integer NULL,
  is_closed boolean NOT NULL DEFAULT false,
  UNIQUE (market, symbol, open_time),
  FOREIGN KEY (market, symbol) REFERENCES market_instruments(market, symbol) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS market_order_book_levels (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES market_collection_runs(id) ON DELETE RESTRICT,
  market text NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol text NOT NULL,
  observed_at timestamptz NOT NULL,
  source_update_id bigint NULL,
  side text NOT NULL CHECK (side IN ('bid', 'ask')),
  level_rank smallint NOT NULL CHECK (level_rank > 0),
  price numeric NOT NULL,
  quantity numeric NOT NULL,
  UNIQUE (run_id, market, symbol, side, level_rank),
  FOREIGN KEY (market, symbol) REFERENCES market_instruments(market, symbol) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS market_agg_trades (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES market_collection_runs(id) ON DELETE RESTRICT,
  market text NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol text NOT NULL,
  agg_trade_id bigint NOT NULL,
  event_time timestamptz NOT NULL,
  price numeric NOT NULL,
  quantity numeric NOT NULL,
  quote_quantity numeric NOT NULL,
  buyer_is_maker boolean NOT NULL,
  is_best_match boolean NULL,
  UNIQUE (market, symbol, agg_trade_id),
  FOREIGN KEY (market, symbol) REFERENCES market_instruments(market, symbol) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS market_microstructure_measurements (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES market_collection_runs(id) ON DELETE RESTRICT,
  market text NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol text NOT NULL,
  observed_at timestamptz NOT NULL,
  window_start timestamptz NULL,
  window_end timestamptz NULL,
  data_status text NOT NULL CHECK (data_status IN ('complete', 'partial', 'unavailable', 'unsupported')),
  failure_code text NULL,
  missing_inputs text[] NOT NULL DEFAULT ARRAY[]::text[],
  candle_count integer NOT NULL DEFAULT 0,
  order_book_bid_levels integer NOT NULL DEFAULT 0,
  order_book_ask_levels integer NOT NULL DEFAULT 0,
  best_bid numeric NULL,
  best_ask numeric NULL,
  spread_bps numeric NULL,
  bid_quote_depth numeric NULL,
  ask_quote_depth numeric NULL,
  agg_trade_count integer NOT NULL DEFAULT 0,
  taker_buy_quote numeric NULL,
  taker_sell_quote numeric NULL,
  UNIQUE (run_id, market, symbol),
  FOREIGN KEY (market, symbol) REFERENCES market_instruments(market, symbol) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS market_collection_runs_published_observed_idx
  ON market_collection_runs (status, observed_at DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS market_ticker_observations_market_symbol_time_idx
  ON market_ticker_observations (market, symbol, observed_at DESC);
CREATE INDEX IF NOT EXISTS market_ticker_observations_run_volume_idx
  ON market_ticker_observations (run_id, market, quote_volume DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS market_candles_1m_market_symbol_time_idx
  ON market_candles_1m (market, symbol, open_time DESC);
CREATE INDEX IF NOT EXISTS market_candles_1m_run_symbol_idx
  ON market_candles_1m (run_id, market, symbol);
CREATE INDEX IF NOT EXISTS market_order_book_levels_market_symbol_time_idx
  ON market_order_book_levels (market, symbol, observed_at DESC, side, level_rank);
CREATE INDEX IF NOT EXISTS market_order_book_levels_run_symbol_idx
  ON market_order_book_levels (run_id, market, symbol);
CREATE INDEX IF NOT EXISTS market_agg_trades_market_symbol_time_idx
  ON market_agg_trades (market, symbol, event_time DESC);
CREATE INDEX IF NOT EXISTS market_agg_trades_run_symbol_idx
  ON market_agg_trades (run_id, market, symbol);
CREATE INDEX IF NOT EXISTS market_microstructure_measurements_market_symbol_time_idx
  ON market_microstructure_measurements (market, symbol, observed_at DESC);
CREATE INDEX IF NOT EXISTS market_microstructure_measurements_run_symbol_idx
  ON market_microstructure_measurements (run_id, market, symbol);