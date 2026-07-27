-- Canonical RADAR results, derived from a single published market collection run.
-- A RADAR result is DERIVED, disposable data: it is keyed by the run it was
-- computed over and cascades away with that run. There is no revision head and no
-- compare-and-swap here; the one published market_collection_run is the head, and
-- the RADAR result that references it is the canonical read. Recomputing a run
-- overwrites its single result row (idempotent). All values are safe aggregates;
-- no secrets, tokens, or raw upstream payloads are stored.

CREATE TABLE IF NOT EXISTS radar_run_snapshots (
  run_id bigint PRIMARY KEY REFERENCES market_collection_runs(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('ready', 'pending', 'failed', 'unknown')),
  source text NOT NULL DEFAULT 'canonical_context',
  computed_at timestamptz NOT NULL,
  candidate_count integer NOT NULL DEFAULT 0,
  entry_ready_count integer NOT NULL DEFAULT 0,
  market_regime jsonb NOT NULL DEFAULT '{}'::jsonb,
  pipeline jsonb NOT NULL DEFAULT '{}'::jsonb,
  absorb_funnel jsonb NOT NULL DEFAULT '{}'::jsonb,
  universe_diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS radar_run_candidates (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES market_collection_runs(id) ON DELETE CASCADE,
  market text NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol text NOT NULL,
  stage text NULL,
  entry_status text NULL,
  absorb_status text NULL,
  absorb_mode text NULL,
  strict_absorb_status text NULL,
  proxy_absorb_status text NULL,
  strict_absorb_score numeric NULL,
  proxy_absorb_score numeric NULL,
  strict_absorb_confirmed boolean NOT NULL DEFAULT false,
  reclaim_status text NULL,
  data_status text NOT NULL DEFAULT 'unknown' CHECK (data_status IN ('ready', 'pending', 'unknown')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (run_id, market, symbol)
);

-- Funnel history reads join candidates/snapshots to the run's observed_at, so the
-- 24h / 7d rollups scan by run. Index the run linkage on both derived tables.
CREATE INDEX IF NOT EXISTS radar_run_candidates_run_idx
  ON radar_run_candidates (run_id);
CREATE INDEX IF NOT EXISTS radar_run_candidates_absorb_idx
  ON radar_run_candidates (absorb_status, strict_absorb_confirmed);
CREATE INDEX IF NOT EXISTS radar_run_snapshots_computed_idx
  ON radar_run_snapshots (computed_at DESC);
