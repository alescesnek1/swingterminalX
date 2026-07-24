-- Netlify-only canonical Context Store, shadow foundation. No reader is cut
-- over by this migration; all revisions are immutable and the one global head
-- is the only publication pointer.

CREATE TABLE IF NOT EXISTS market_collection_runs (
  id bigserial PRIMARY KEY,
  scope_id text NOT NULL DEFAULT 'global' CHECK (scope_id = 'global'),
  run_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'collected', 'published', 'failed', 'skipped')),
  reason_code text NULL,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_id, run_key)
);

CREATE TABLE IF NOT EXISTS market_context_snapshots (
  id bigserial PRIMARY KEY,
  scope_id text NOT NULL DEFAULT 'global' CHECK (scope_id = 'global'),
  run_id bigint NOT NULL UNIQUE REFERENCES market_collection_runs(id) ON DELETE RESTRICT,
  observed_at timestamptz NOT NULL,
  collected_at timestamptz NOT NULL,
  data_status text NOT NULL CHECK (data_status IN ('complete', 'partial', 'unavailable')),
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS radar_context_snapshots (
  id bigserial PRIMARY KEY,
  scope_id text NOT NULL DEFAULT 'global' CHECK (scope_id = 'global'),
  market_revision_id bigint NOT NULL REFERENCES market_context_snapshots(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'unknown')),
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS context_heads (
  scope_id text PRIMARY KEY CHECK (scope_id = 'global'),
  published_market_revision_id bigint NULL REFERENCES market_context_snapshots(id) ON DELETE RESTRICT,
  published_radar_revision_id bigint NULL REFERENCES radar_context_snapshots(id) ON DELETE RESTRICT,
  published_radar_market_revision_id bigint NULL REFERENCES market_context_snapshots(id) ON DELETE RESTRICT,
  published_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (published_radar_revision_id IS NULL AND published_radar_market_revision_id IS NULL)
    OR (published_radar_revision_id IS NOT NULL AND published_radar_market_revision_id = published_market_revision_id)
  )
);

INSERT INTO context_heads (scope_id) VALUES ('global') ON CONFLICT (scope_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS market_context_rows (
  id bigserial PRIMARY KEY,
  revision_id bigint NOT NULL REFERENCES market_context_snapshots(id) ON DELETE CASCADE,
  market text NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol text NOT NULL,
  base_asset text NOT NULL,
  quote_asset text NOT NULL,
  last_price numeric NULL,
  price_change_percent numeric NULL,
  high_price numeric NULL,
  low_price numeric NULL,
  base_volume numeric NULL,
  quote_volume numeric NULL,
  trade_count integer NULL,
  observed_at timestamptz NOT NULL,
  data_status text NOT NULL CHECK (data_status IN ('complete', 'partial', 'unavailable', 'unsupported')),
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (revision_id, market, symbol)
);

CREATE TABLE IF NOT EXISTS market_microstructure_rows (
  id bigserial PRIMARY KEY,
  revision_id bigint NOT NULL REFERENCES market_context_snapshots(id) ON DELETE CASCADE,
  market text NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol text NOT NULL,
  observed_at timestamptz NOT NULL,
  window_start timestamptz NULL,
  window_end timestamptz NULL,
  data_status text NOT NULL CHECK (data_status IN ('complete', 'partial', 'unavailable', 'unsupported')),
  failure_code text NULL,
  klines_1m jsonb NOT NULL DEFAULT '[]'::jsonb,
  depth_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  trades_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing_inputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (revision_id, market, symbol)
);

CREATE TABLE IF NOT EXISTS radar_candidate_snapshots (
  id bigserial PRIMARY KEY,
  radar_revision_id bigint NOT NULL REFERENCES radar_context_snapshots(id) ON DELETE CASCADE,
  market text NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_status text NOT NULL CHECK (data_status IN ('pending', 'ready', 'unknown')),
  UNIQUE (radar_revision_id, market, symbol)
);

CREATE INDEX IF NOT EXISTS market_collection_runs_scope_observed_idx
  ON market_collection_runs (scope_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS market_context_snapshots_scope_observed_idx
  ON market_context_snapshots (scope_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS market_context_rows_revision_market_volume_idx
  ON market_context_rows (revision_id, market, quote_volume DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS market_context_rows_market_symbol_observed_idx
  ON market_context_rows (market, symbol, observed_at DESC);
CREATE INDEX IF NOT EXISTS market_microstructure_rows_revision_market_symbol_idx
  ON market_microstructure_rows (revision_id, market, symbol);
CREATE INDEX IF NOT EXISTS radar_context_snapshots_market_revision_idx
  ON radar_context_snapshots (market_revision_id, created_at DESC);
