-- Phase: scheduled price-history collection — duplicate-snapshot guard only.
-- No new tables, no destructive change to market_price_snapshots /
-- market_price_points (see 20260720130902_add-market-price-history).
--
-- WHY: a spacing-guard SELECT-then-fetch-then-INSERT in application code
-- (price-history-collect-scheduled.mjs) is NOT atomic — a GitHub Actions
-- cron re-fire, an overlapping workflow_dispatch, or a retried request could
-- still race past the SELECT and write two snapshots for the same source
-- within the same minute. This unique index makes that structurally
-- impossible at the database level rather than merely unlikely.
--
-- SCOPED TO THE SCHEDULER ONLY: this is a partial index
-- (WHERE source = 'scheduled_price_history') rather than a global
-- (source, minute) uniqueness constraint across every source. Two reasons:
--   1. The manual admin collector (admin-price-history-collect.mjs, source
--      'admin_price_history_collect') must stay completely unconstrained by
--      a guard that exists only for the unattended scheduler — an operator
--      double-clicking collect twice within the same minute is a real,
--      legitimate use of that tool and must keep working exactly as today.
--   2. A global index would need every existing row in
--      market_price_snapshots to be collision-free before this migration
--      could apply, requiring a production pre-check with DB access this
--      change does not need. Scoped to 'scheduled_price_history' — a source
--      value no existing row uses — the partial index matches zero current
--      rows by construction, so it cannot collide with anything already in
--      production regardless of that data's shape.
--
-- date_trunc(text, timestamptz) is STABLE, not IMMUTABLE (its result can
-- depend on the session TimeZone setting), so it cannot be used directly in
-- a functional index. Converting through `AT TIME ZONE 'UTC'` first fixes
-- the zone to a literal constant, producing a plain `timestamp` value whose
-- truncation no longer depends on any session setting — that composed
-- expression is IMMUTABLE and is what Postgres requires for an index. The
-- partial predicate `source = 'scheduled_price_history'` is itself a plain
-- equality check on a text column, also immutable, so the index as a whole
-- remains valid.
--
-- CREATE UNIQUE INDEX IF NOT EXISTS is additive and a no-op if the index
-- already exists. Not destructive: no DROP, no data change, no table
-- rewrite of existing columns.
CREATE UNIQUE INDEX IF NOT EXISTS market_price_snapshots_scheduled_source_minute_uniq_idx
  ON market_price_snapshots (
    source,
    date_trunc('minute', sampled_at AT TIME ZONE 'UTC')
  )
  WHERE source = 'scheduled_price_history';
