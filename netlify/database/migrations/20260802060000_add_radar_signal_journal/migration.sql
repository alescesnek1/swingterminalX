-- Append-only archive of RADAR signal TRANSITIONS.
--
-- WHY THIS EXISTS: nothing in the system remembers what RADAR said. The current
-- verdict lives in radar_candidate_state, which is upserted per (market, symbol) —
-- one row per coin, overwritten every cycle, so yesterday's verdict is gone. The
-- per-run history (radar_run_snapshots / radar_run_candidates) is pruned by
-- retention after MARKET_CONTEXT_RETENTION_RADAR_HOURS (default 7 days) because it
-- stores every candidate of every run.
--
-- Without an archive there is nothing honest to backtest against: candles can always
-- be re-fetched from a public endpoint, but the verdict RADAR produced at that moment
-- exists only if it was written down. (The public-candle backtest MVP had to fall
-- back to a synthetic fixture, which is what let a candidate captured on one market
-- be replayed against another.)
--
-- WHY TRANSITIONS AND NOT EVERY VERDICT: measured on the live universe — 171
-- candidates scored per cycle x 480 cycles/day = ~82,000 rows/day if every verdict
-- were kept, and ~7,200/day for actionable rows alone. Recording only the moments a
-- coin ENTERS a new state bounds it to a few hundred rows a day, which can be kept
-- for years. A coin sitting in the same state for six hours is one fact, not 120.
--
-- This table is deliberately NOT pruned by pruneCanonicalContext: it is the archive,
-- and it is small precisely so it never has to be.

CREATE TABLE IF NOT EXISTS radar_signal_journal (
  id bigserial PRIMARY KEY,
  market text NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol text NOT NULL,

  -- The verdict's own clocks: computed_at is when RADAR produced it, observed_at is
  -- the market-data time it was produced FROM. A backtest must anchor to observed_at.
  computed_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  -- Provenance only. ON DELETE SET NULL so retention pruning a run can never delete
  -- or orphan a recorded signal.
  run_id bigint NULL REFERENCES market_collection_runs(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'canonical_context',

  -- The transition itself. previous_status is NULL the first time a coin is seen.
  previous_status text NULL,
  status text NOT NULL,
  entry_type text NULL,
  entry_ready boolean NOT NULL DEFAULT false,
  actionability text NULL,

  -- Scores as computed. NULL means "not computed" -> UNKNOWN, never a zero.
  setup_score numeric NULL,
  execution_score numeric NULL,
  risk_reward_score numeric NULL,
  market_regime_score numeric NULL,
  confidence numeric NULL,

  -- The plan as it stood at that moment. This is what a backtest replays; without it
  -- the archived signal cannot be turned into a simulated trade.
  entry_zone_low numeric NULL,
  entry_zone_high numeric NULL,
  stop_loss numeric NULL,
  hard_invalidation numeric NULL,
  tp1_level numeric NULL,
  tp2_level numeric NULL,
  tp3_level numeric NULL,

  -- Evidence quality at the moment of the signal, so a later reader can separate a
  -- STRICT-confirmed signal from a proxy one instead of treating them alike.
  reclaim_status text NULL,
  absorb_status text NULL,
  absorb_mode text NULL,
  strict_absorb_status text NULL,
  strict_absorb_confirmed boolean NULL,
  safety_status text NULL,
  data_status text NULL,
  missing_inputs text[] NOT NULL DEFAULT '{}',

  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Idempotency: a retried publish of the same run must not double-record the same
  -- transition. computed_at is per-run, so this is the natural key.
  CONSTRAINT radar_signal_journal_unique_transition UNIQUE (market, symbol, status, computed_at)
);

-- "What did RADAR say about this coin, in order" — the backtest read.
CREATE INDEX IF NOT EXISTS radar_signal_journal_symbol_time_idx
  ON radar_signal_journal (symbol, computed_at DESC);
-- "What fired recently" — the review/monitoring read.
CREATE INDEX IF NOT EXISTS radar_signal_journal_time_idx
  ON radar_signal_journal (computed_at DESC);
-- Entry-ready signals are the rare, important ones; keep them cheap to find.
CREATE INDEX IF NOT EXISTS radar_signal_journal_entry_ready_idx
  ON radar_signal_journal (computed_at DESC) WHERE entry_ready;
