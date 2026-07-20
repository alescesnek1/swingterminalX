-- Phase 2B: observability foundation only.
-- No market data, no radar, no auth, no trading tables here.
--
-- No schema_migrations table here on purpose: Netlify already tracks
-- applied migrations in its own `netlify.migrations` ledger, so a
-- second, unwritten ledger table would just be dead infrastructure.

CREATE TABLE IF NOT EXISTS system_events (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  level       text NOT NULL CHECK (level IN ('debug','info','warn','error','critical')),
  event       text NOT NULL,
  source      text NOT NULL,
  corr_id     uuid NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_name  text NULL,
  error_code  text NULL
);

CREATE INDEX IF NOT EXISTS system_events_ts_desc_idx ON system_events (ts DESC);
CREATE INDEX IF NOT EXISTS system_events_event_ts_idx ON system_events (event, ts DESC);
CREATE INDEX IF NOT EXISTS system_events_source_ts_idx ON system_events (source, ts DESC);
CREATE INDEX IF NOT EXISTS system_events_payload_gin_idx ON system_events USING GIN (payload);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id                 bigserial PRIMARY KEY,
  job                text NOT NULL,
  started_at         timestamptz NOT NULL,
  finished_at        timestamptz NULL,
  status             text NOT NULL CHECK (status IN ('ok','partial','failed','running')),
  symbols_requested  int NOT NULL DEFAULT 0,
  symbols_written    int NOT NULL DEFAULT 0,
  rows_written       int NOT NULL DEFAULT 0,
  source             text NULL,
  error_code         text NULL,
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ingest_runs_job_started_idx ON ingest_runs (job, started_at DESC);
CREATE INDEX IF NOT EXISTS ingest_runs_not_ok_idx ON ingest_runs (job, started_at DESC) WHERE status <> 'ok';
