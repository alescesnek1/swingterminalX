-- Phase: market price history storage foundation only.
-- No reclaim/absorption computation, no trading/RADAR wiring, no live
-- ingest wiring here — this migration only creates the tables and indexes
-- that a later phase will read/write via netlify/functions/_price-history.mjs.

CREATE TABLE IF NOT EXISTS market_price_snapshots (
  id          bigserial PRIMARY KEY,
  source      text NOT NULL,
  sampled_at  timestamptz NOT NULL,
  coin_count  integer NOT NULL DEFAULT 0 CHECK (coin_count >= 0),
  status      text NOT NULL CHECK (status IN ('ok', 'partial', 'failed')),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_price_snapshots_sampled_at_desc_idx
  ON market_price_snapshots (sampled_at DESC);
CREATE INDEX IF NOT EXISTS market_price_snapshots_source_sampled_at_idx
  ON market_price_snapshots (source, sampled_at DESC);

CREATE TABLE IF NOT EXISTS market_price_points (
  id               bigserial PRIMARY KEY,
  snapshot_id      bigint NOT NULL REFERENCES market_price_snapshots(id) ON DELETE CASCADE,
  symbol           text NOT NULL,
  name             text NULL,
  price_usd        numeric NULL,
  change_1h_pct    numeric NULL,
  change_24h_pct   numeric NULL,
  change_7d_pct    numeric NULL,
  volume_24h_usd   numeric NULL,
  market_cap_usd   numeric NULL,
  rank             integer NULL,
  source           text NULL,
  sampled_at       timestamptz NOT NULL,
  raw_meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS market_price_points_snapshot_symbol_uniq_idx
  ON market_price_points (snapshot_id, symbol);
CREATE INDEX IF NOT EXISTS market_price_points_symbol_sampled_at_idx
  ON market_price_points (symbol, sampled_at DESC);
CREATE INDEX IF NOT EXISTS market_price_points_sampled_at_desc_idx
  ON market_price_points (sampled_at DESC);
CREATE INDEX IF NOT EXISTS market_price_points_snapshot_id_idx
  ON market_price_points (snapshot_id);
