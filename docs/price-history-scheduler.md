# Scheduled price-history collection (branch `feat/price-history-scheduler`)

Automates what `/api/admin-price-history-collect` (see
`docs/price-history-analytics.md`) already does manually: fetch a market
snapshot and write it to `market_price_snapshots` / `market_price_points`.
Everything below defaults **off** and requires the owner to enable flags one
at a time, in order.

## Why a separate collector, not the admin one on a cron

`admin-price-history-collect.mjs` forwards the caller's Supabase JWT to
`/api/markets`, which requires a cryptographically verified user session
(`apps/edge/netlify/edge-functions/lib/security.js` `verifyAuth`). An
unattended scheduler has no user session and can never present one without
storing a live user credential or a service-role key — both rejected.
Instead, `_coingecko-markets-source.mjs` fetches CoinGecko's public
`/coins/markets` pages directly: the same public upstream `/api/markets`
itself calls, no auth, no key, no cookies.

## New pieces

| File | Purpose |
|---|---|
| `netlify/functions/_coingecko-markets-source.mjs` | Public GET fetch of CoinGecko `/coins/markets`, paginated up to `PRICE_HISTORY_MAX_COINS`. Never throws. |
| `netlify/functions/price-history-collect-scheduled.mjs` | `/api/price-history-collect-scheduled`, POST-only. Scheduler-secret gated; fetches + writes a snapshot. |
| `netlify/functions/price-history-prune-scheduled.mjs` | `/api/price-history-prune-scheduled`, POST-only. Same scheduler secret; deletes snapshots older than `PRICE_HISTORY_RETENTION_DAYS`. |
| `netlify/functions/_price-history.mjs` (modified, additive) | Batched multi-row INSERT (was one query per row — see below); new `storeRawMeta`, `getLatestSnapshotAt`, `pruneSnapshotsOlderThan`. |
| `netlify/database/migrations/20260721090000_add-price-history-schedule-guard/` | `UNIQUE` index on `(source, minute)` — makes a duplicate snapshot impossible at the DB level. |
| `.github/workflows/price-history-collect.yml` | External authenticated scheduler (cron commented out). |
| `.github/workflows/price-history-prune.yml` | Same, for the pruner (cron commented out). |

### Why the insert had to be batched

`market_price_snapshots`/`market_price_points` currently hold data from
manual collections only. At the full production coin universe (~975 rows),
one `client.query()` per row is ~975 sequential round-trips to Postgres —
close to certain to exceed a Netlify function's execution timeout once this
runs unattended on a schedule. `writeMarketPriceSnapshot` now inserts in
chunks of 200 rows via a single multi-row `VALUES (...), (...), ...`
statement per chunk. Same `ON CONFLICT (snapshot_id, symbol) DO NOTHING`
semantics, same `inserted`/`dropped`/`duplicates` contract — just far fewer
round-trips. Existing callers (the admin collector, the DB-backed tests) are
unaffected.

## Auth model

Both new endpoints require header `x-price-history-scheduler-secret` to
exactly match env `PRICE_HISTORY_SCHEDULER_SECRET` (timing-safe compare).
This is a **different secret and header** from `personal-alerts.mjs`'s
`x-terminal-scheduler-secret` / `PERSONAL_ALERTS_SCHEDULER_SECRET` — never
share or reuse them. Like `personal-alerts.mjs`, this never uses Netlify's
native `config.schedule` trigger (it cannot attach a custom header) and
never trusts a request body field (including `next_run`) as authentication.

## Env flags

| Flag | Default | Effect |
|---|---|---|
| `PRICE_HISTORY_SCHEDULER_SECRET` | unset | Required for either endpoint to authenticate any request. |
| `PRICE_HISTORY_SCHEDULE_ENABLED` | unset | `!== 'true'` → collector returns `200 SCHEDULE_DISABLED`, touches neither DB nor CoinGecko. |
| `PRICE_HISTORY_COLLECT_ENABLED` | unset | `!== 'true'` → collector returns `200 COLLECT_DISABLED`, touches neither DB nor CoinGecko. |
| `PRICE_HISTORY_WRITE_ENABLED` | unset | Reused from the manual collector. `!== 'true'` → collector still fetches CoinGecko but skips the DB write (`write:{skipped:true,reason:'DISABLED'}`, HTTP 200). |
| `PRICE_HISTORY_MIN_SPACING_SEC` | `540` (9 min) | Minimum age (seconds) of the last `scheduled_price_history` snapshot before another fetch is allowed. Invalid/missing/≤0 → falls back to `540`, **never** `0`. |
| `PRICE_HISTORY_MAX_COINS` | `1000` | Rows requested from CoinGecko. Invalid/missing → `1000`; hard-capped at `2000` regardless (matches the writer's own row ceiling). |
| `PRICE_HISTORY_STORE_RAW_META` | `false` | `=== 'true'` stores each row's sanitized `raw_meta`; otherwise stores `{}` (nothing downstream reads `raw_meta`, so this roughly halves storage). |
| `PRICE_HISTORY_PRUNE_ENABLED` | unset | `!== 'true'` → pruner returns `200 PRUNE_DISABLED`, deletes nothing. |
| `PRICE_HISTORY_RETENTION_DAYS` | unset | Missing/invalid/≤0 → pruner deletes nothing (`PRUNE_INVALID_RETENTION`). When valid, snapshots (and their cascaded points) older than this many days are deleted in bounded batches. |

## Rollout (each step is a separate, owner-executed action)

1. Push/deploy this branch after the usual review. Every flag above stays
   **unset**. The pending `20260720130902_add-market-price-history`
   migration and the new `20260721090000_add-price-history-schedule-guard`
   migration both auto-apply on that push.
2. Read-only check: `GET /api/admin-price-history?limit=5` still shows only
   the pre-existing snapshots.
3. Set `PRICE_HISTORY_SCHEDULER_SECRET` in Netlify env **and** the identical
   value as the `PRICE_HISTORY_SCHEDULER_SECRET` GitHub Actions secret.
   Nothing else yet.
4. Run `price-history-collect.yml` once via `workflow_dispatch`. Expect
   `SCHEDULE_DISABLED`, HTTP 200, no new rows.
5. Set `PRICE_HISTORY_SCHEDULE_ENABLED=true`. Run `workflow_dispatch` again.
   Expect `COLLECT_DISABLED`, HTTP 200, no new rows.
6. Set `PRICE_HISTORY_COLLECT_ENABLED=true`. Run `workflow_dispatch` again.
   Expect a real CoinGecko fetch with `write:{skipped:true,reason:'DISABLED'}`
   — **this is also the timing rehearsal**; note the wall-clock duration.
7. Set `PRICE_HISTORY_WRITE_ENABLED=true`. Run `workflow_dispatch` — this is
   the **first real write**. Verify via `/api/admin-price-history` that a
   new `scheduled_price_history` snapshot exists with a plausible
   `coin_count`.
8. Run `workflow_dispatch` a **second time immediately**. It must return
   `MIN_SPACING` and create no new snapshot — this is the idempotency proof.
9. Uncomment the `schedule:` block in `price-history-collect.yml` at
   `*/30 * * * *`. Soak 24h: confirm evenly-spaced, duplicate-free
   snapshots and no non-2xx runs.
10. Tighten to `*/15 * * * *`. Soak another 24h.
11. Only once history has accumulated past the intended retention window: set
    `PRICE_HISTORY_RETENTION_DAYS` (14 recommended to start) and
    `PRICE_HISTORY_PRUNE_ENABLED=true`, then run
    `price-history-prune.yml` once via `workflow_dispatch` and confirm only
    snapshots older than the window were removed. Uncomment its `schedule:`
    only after that manual run looks correct.

## Rollback (fastest first — every tier except the last is env-only)

1. Unset `PRICE_HISTORY_WRITE_ENABLED` — fetches continue (diagnosable), no
   more writes.
2. Unset `PRICE_HISTORY_SCHEDULE_ENABLED` — endpoint returns to a clean
   disabled 200, zero side effects.
3. Unset `PRICE_HISTORY_COLLECT_ENABLED` — stops CoinGecko calls entirely.
4. Unset `PRICE_HISTORY_PRUNE_ENABLED` — stops all deletion independently.
5. Re-comment the `schedule:` block(s) in the workflow YAML (keep
   `workflow_dispatch`).
6. Disable the workflow(s) in the GitHub Actions UI — immediate, no commit
   needed.
7. `git revert` the feature commits.

A storage emergency can drop `PRICE_HISTORY_RETENTION_DAYS` to a smaller
value and dispatch the pruner manually rather than waiting for the next
scheduled run.

## Explicitly unchanged

`admin-price-history-collect.mjs`, `admin-price-history.mjs`,
`admin-price-history-signals.mjs`, `_price-history-writer.mjs`,
`_price-history-signals.mjs`, `netlify.toml`, and all RADAR/trading/
`ENTRY_READY`/Telegram/UI code. No secrets, tokens, JWTs, env values, DB
URLs, or raw records appear in any file this change adds or touches.
