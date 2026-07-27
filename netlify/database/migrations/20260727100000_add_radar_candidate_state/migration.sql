-- Atomized, indexed per-symbol RADAR state. One row per (market, symbol), upserted
-- in place: the CURRENT RADAR verdict for a coin, readable without knowing anything
-- about collection runs.
--
-- Why this replaces the run-keyed read: radar_run_snapshots is keyed
-- `run_id PRIMARY KEY REFERENCES market_collection_runs`, and the canonical read
-- resolves "the newest published market run, then that run's RADAR result". The
-- collector marks a run published at the END of collection and only THEN scores it,
-- so between those two moments the newest run exists with no RADAR row and the read
-- returns status PENDING. The terminal treats PENDING as "no canonical radar" and
-- falls back to the legacy browser-computed path, so Strict Absorb flipped between
-- a real verdict and "DATA OFF" every cycle. Both readings were true — about
-- different runs. Keying state to the SYMBOL removes the race by construction:
-- there is always a current row, and it carries its own clock.
--
-- run_id is provenance only, never a dependency: ON DELETE SET NULL, so retention
-- pruning a run can never delete or orphan the current RADAR state.
--
-- Every score is NULL-able and NULL means "not computed" → UNKNOWN. A NULL score
-- must never read as a zero/bearish score.
--
-- radar_run_snapshots / radar_run_candidates are deliberately left in place: they
-- remain the append-per-run history the 24h/7d funnel rollups scan. This table is
-- the current-state read, not a replacement for that history.

CREATE TABLE IF NOT EXISTS radar_candidate_state (
  market text NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol text NOT NULL,
  -- Own clock. computed_at is when the RADAR verdict was produced; observed_at is
  -- the market-data time it was produced FROM. Freshness is judged per row, so a
  -- stale coin is visible as stale instead of taking the whole read down.
  computed_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  run_id bigint NULL REFERENCES market_collection_runs(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'canonical_context',

  -- V1 state machine + entry classification
  status text NOT NULL,
  entry_type text NULL,
  entry_ready boolean NOT NULL DEFAULT false,

  -- Spec scores (0-100). Composite first, then the components RADAR watches.
  setup_score numeric NULL,
  execution_score numeric NULL,
  risk_reward_score numeric NULL,
  market_regime_score numeric NULL,
  confidence numeric NULL,
  dislocation_score numeric NULL,
  flush_score numeric NULL,
  stabilization_score numeric NULL,
  reclaim_score numeric NULL,
  order_book_support_score numeric NULL,
  flow_confirmation_score numeric NULL,
  derivatives_risk_score numeric NULL,

  -- Reclaim + absorb are first-class watched factors, so they are queryable columns
  -- rather than buried in the payload.
  reclaim_status text NULL,
  absorb_status text NULL,
  absorb_mode text NULL,
  strict_absorb_status text NULL,
  strict_absorb_score numeric NULL,
  strict_absorb_confirmed boolean NOT NULL DEFAULT false,

  -- Trade plan levels. Read per symbol (Cockpit), not filtered on.
  entry_zone_low numeric NULL,
  entry_zone_high numeric NULL,
  stop_loss numeric NULL,
  hard_invalidation numeric NULL,
  -- One level per checkpoint, matching what the evaluator actually emits
  -- (takeProfitCheckpoints[].level). Each checkpoint's pct/basis stays in payload.
  tp1_level numeric NULL,
  tp2_level numeric NULL,
  tp3_level numeric NULL,
  -- Parsed from POSITION_SIZE_GUIDANCE. NULL means the guidance could not be parsed
  -- — never 0, because 0% is itself a real verdict (RISK_OFF_BLOCKED / INVALIDATED).
  position_size_pct_low numeric NULL,
  position_size_pct_high numeric NULL,
  position_size_guidance text NULL,
  timeframe_context text NULL,
  time_validity text NULL,

  -- Honest data quality. 'unknown' is the default so a row can never imply that
  -- missing inputs were complete.
  data_status text NOT NULL DEFAULT 'unknown' CHECK (data_status IN ('ready', 'pending', 'degraded', 'unknown')),
  missing_inputs text[] NOT NULL DEFAULT '{}',
  data_quality jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Full evaluator output, so nothing the engine produced is lost to the column set.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (market, symbol)
);

-- Freshness scans and "what changed" reads.
CREATE INDEX IF NOT EXISTS radar_candidate_state_computed_idx
  ON radar_candidate_state (computed_at DESC);
-- Cockpit looks a coin up across venues.
CREATE INDEX IF NOT EXISTS radar_candidate_state_symbol_idx
  ON radar_candidate_state (symbol);
-- Scanner/RADAR list filtering by state.
CREATE INDEX IF NOT EXISTS radar_candidate_state_status_idx
  ON radar_candidate_state (status);
-- Default RADAR ordering: best setup, then best execution.
CREATE INDEX IF NOT EXISTS radar_candidate_state_ranking_idx
  ON radar_candidate_state (setup_score DESC NULLS LAST, execution_score DESC NULLS LAST);
-- The alert path's hot query. Partial, because entry-ready rows are a tiny minority
-- of the universe and this keeps that scan proportional to the matches, not the set.
CREATE INDEX IF NOT EXISTS radar_candidate_state_entry_ready_idx
  ON radar_candidate_state (computed_at DESC)
  WHERE entry_ready;
-- Absorb/reclaim diagnostics across the universe.
CREATE INDEX IF NOT EXISTS radar_candidate_state_absorb_idx
  ON radar_candidate_state (strict_absorb_confirmed, absorb_status);
