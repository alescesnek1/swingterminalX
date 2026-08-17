# Netlify credit-drain audit (branch `fix/netlify-credit-drain-audit`)

Billing snapshot that triggered this audit:

| Line item          | Credits  | Usage        |
| ------------------ | -------- | ------------ |
| Total              | 15,582.9 | —            |
| Compute            | 12,202.9 | —            |
| Database compute   | 8,651.8  | 865.18 GB-h  |
| Functions compute  | 3,551.1  | 355.11 GB-h  |
| Bandwidth          | 3,153    | —            |
| Web requests       | 32       | —            |
| Production deploys | 195      | —            |

## Root cause

One defect explains the database, function, and bandwidth lines together.

`connectStream()` in `apps/edge/public/js/terminal.js` takes the dead-infra
branch (`LEGACY_FLY_STREAM_ENABLED === false`, the Fly.io WebSocket is
decommissioned) and called `_enableAggressivePoll()`. That is the **10-second
emergency cadence**, intended to cover a temporary WebSocket outage. Its only
disable path is `_disableAggressivePoll()` inside the WebSocket `onopen`
handler — which can never run in this build. So the emergency cadence became
the permanent steady state.

Each tick ran a full `doRefresh()`:

1. `GET /api/context` — a **Netlify Function** that runs **four Postgres
   queries** and returns up to **2,000 ticker + 600 microstructure rows**, with
   `Cache-Control: no-store` and no server-side caching of any kind.
2. `GET /api/markets` — edge function, CoinGecko/Binance fan-out.
3. `GET /api/regime` — edge function.

Nothing in the file listened for `visibilitychange`, so this continued at full
rate in a hidden background tab. Per open tab that is roughly **8,600
`/api/context` reads per day**, each costing four Postgres queries and a
multi-megabyte JSON response.

Consequences, matching the bill line by line:

- **Database compute (the largest line)** — the read volume never let the
  Netlify/Neon database idle, so it billed compute essentially around the clock,
  and each read was itself expensive.
- **Functions compute** — `/api/context` is a Node function; `/api/bot/fleet`
  compounded it (below).
- **Bandwidth** — the 2,600-row context payload, six times a minute, per tab.

Two secondary drains:

- **`/api/bot/fleet` polled every 4s forever.** `_startFleetPoll()` was called
  on entering the BOT or RADAR view, but `_stopFleetPoll()` was **never called
  anywhere**. One visit to either view left a 4s poll running for the rest of
  the session from whatever view the operator moved on to — ~21,600 function
  invocations/day/tab.
- **`/api/orderbook` polled every 1.5s** while a coin detail panel was open,
  including in a hidden tab.

## Cost map

| Function / path                        | Trigger                        | Frequency (before)            | DB?           | Cache headers                | Ran when tab hidden? | Reduction applied                                 |
| -------------------------------------- | ------------------------------ | ----------------------------- | ------------- | ---------------------------- | -------------------- | ------------------------------------------------- |
| `/api/context` (`context.mjs`)          | browser `doRefresh()`          | **every 10s / tab**           | **yes, 4 q.** | `no-store`                   | **yes**              | 60s cadence + hidden-tab pause + 30s server memo + in-flight coalescing |
| `/api/markets` (edge)                   | `doRefresh()` + CG enrichment  | every 10s / tab (×2 per tick) | no            | `s-maxage=30, SWR=60`        | **yes**              | 60s cadence + hidden-tab pause + refresh dedupe   |
| `/api/regime` (edge)                    | `doRefresh()`                  | every 10s / tab               | no            | `s-maxage`, SWR=120          | **yes**              | rides the same cadence fix                        |
| `/api/bot/fleet` (`bot.mjs`)            | fleet poll timer               | **every 4s, never stopped**   | no (Blobs)    | `no-store`                   | **yes**              | stopped when neither BOT nor RADAR view is open + hidden-tab pause |
| `/api/orderbook` (edge)                 | open coin detail panel         | every 1.5s                    | no            | `no-store`                   | **yes**              | hidden-tab pause                                  |
| `/api/news` (edge)                      | news loop                      | every 5min                    | no            | `s-maxage`, SWR              | **yes**              | hidden-tab pause                                  |
| `market-context-collect-scheduled.mjs`  | Netlify cron `*/3 * * * *`     | 480/day                       | **yes, write**| `no-store`                   | n/a (server)         | none in code — see env recommendations             |
| `cron-alerts.mjs`                       | Netlify cron `*/5 * * * *`     | 288/day                       | **yes, read** | `no-store`                   | n/a                  | **untouched — alerting path, out of scope**        |
| `personal-watch-triggers-scheduled.mjs` | Netlify cron `*/5 * * * *`     | 288/day                       | **yes**       | `no-store`                   | n/a                  | **untouched — alerting path**                      |
| `market-context-retention-scheduled.mjs`| Netlify cron `17 * * * *`      | 24/day                        | **yes**       | `no-store`                   | n/a                  | none                                               |
| `morning-briefing.mjs`                  | Netlify cron `0 5-9 * * *`     | 5/day                         | **yes**       | `no-store`                   | n/a                  | **untouched — Telegram path**                      |
| `/api/cockpit-radar-state`              | Cockpit focus (user action)    | user-driven                   | **yes**       | `no-store`                   | no                   | already has a TTL cache + in-flight dedupe         |
| `/api/briefing`, `/api/analyze`, `/api/market-briefing` | user click     | user-driven                   | no            | `no-cache`                   | no                   | not a drain — no timer reaches them                |

## Changes implemented (code only — no env var was changed)

**`apps/edge/public/js/terminal.js`**

- **Poll cost governor.** `_pageIsActive()` / `_pollTickAllowed(name)` gate every
  *recurring* tick on `document.visibilityState`. Skips are counted on
  `window.__pollGovernor` and logged, so a paused terminal is visibly paused and
  never mistaken for a broken one. `visibilitychange` → visible triggers one
  immediate catch-up `doRefresh()`. User-initiated and boot-time fetches are
  never gated.
- **Steady-state cadence.** New `STREAM_REST_POLL_DEFAULT_MS = 60s` and
  `_enableRestPoll()`; the dead-infra branch now uses these instead of the 10s
  emergency cadence. `window.STREAM_REST_POLL_MS` can override it, but an
  override below the emergency cadence is rejected so the hot loop cannot be
  reintroduced. 60s sits comfortably inside the collector's own 3-minute publish
  interval, so no published run can be missed.
- **In-flight dedupe.** `doRefresh()` is now a thin wrapper over
  `_doRefreshCore()` that shares one in-flight promise across concurrent
  triggers (steady tick, 5-min safety net, visibility resume, view switch,
  manual refresh).
- **Fleet poll lifecycle.** `_stopFleetPoll()` is now actually called when
  neither the BOT nor the RADAR view is showing.

**`netlify/functions/context.mjs`**

- **Short-TTL read memo**, default 30s, ceiling 180s (never longer than the
  collector's publish interval), disabled by setting `CONTEXT_READ_CACHE_MS=0`.
  Safe because the read takes **no identity input** — it is the same global
  published run for every caller.
- **Auth is unchanged and still enforced before the memo is consulted.** An
  unauthenticated caller never reaches cached data.
- **Freshness is recomputed on every serve** from `market.observedAt`, so a
  memoized body can never claim `FRESH` after it has actually aged out.
- **Failures are never memoized** and never masked by a previous good response —
  a DB failure still returns 503 with its reason and logs a counter line.
- **Concurrent cold reads coalesce** onto one database read.
- Response stays `Cache-Control: no-store` (it is behind auth). A new
  `X-Context-Cache: hit|miss` header and `contextReadStats` counters make the
  DB-backed path observable.

Expected effect on `/api/context` Postgres reads, per open tab, versus before:
6/min → at most 1/min while visible, 0/min while hidden, further collapsed
across tabs and warm invocations by the 30s memo.

## Recommended env / dashboard changes — NOT APPLIED

None of these were changed. They need owner approval.

### A. Immediate safe OFF switches

| Variable                             | Now        | Recommend | Effect |
| ------------------------------------ | ---------- | --------- | ------ |
| `MARKET_CONTEXT_MULTI_TF_ENABLED`     | check      | `false` unless the multi-timeframe columns are actually used | Removes a large per-cycle Binance fan-out and shrinks each stored run (fewer rows written every 3 min → less DB compute and storage). |
| `MARKET_CONTEXT_FUTURES_ENABLED`      | check      | `false` unless futures context is used | Same, on the futures leg. |
| `PRICE_HISTORY_SCHEDULE_ENABLED`      | check      | `false` if the price-history panels are not in daily use | Stops a DB-writing collector outright. |

### B. Throttling / lower-frequency switches

| Setting                                   | Now              | Recommend | Effect |
| ----------------------------------------- | ---------------- | --------- | ------ |
| `market-context-collect-scheduled.mjs` cron | `*/3 * * * *`   | `*/5 * * * *` | **Code change, needs approval — not applied.** 480 → 288 DB-writing runs/day (−40%). Note the RADAR absorb baseline window (`COLLECTOR_WINDOW_MIN_SEC`/`MAX_SEC`) is tuned to the 3-minute cadence; verify STRICT absorb still confirms before keeping this. |
| `CONTEXT_READ_CACHE_MS` (new)              | unset → 30s      | leave unset, or `60000` | Halves the residual `/api/context` DB reads again. Ceiling is 180s. |
| `MARKET_CONTEXT_MICROSTRUCTURE_TOP_N`      | check (def. 5)   | keep small | Directly sizes per-cycle rows written. |
| `MARKET_CONTEXT_RAW_SAMPLE_TOP_N`          | check            | lower / `0` | Raw agg-trade + depth samples are the bulkiest rows written per cycle. |

### C. Dashboard settings to verify manually (highest-value item)

**This is where the 8,651 database credits actually land — check it first.**

1. Netlify dashboard → **Database → compute settings**.
2. Confirm **scale-to-zero / autosuspend is ENABLED** and note its idle timeout.
   With a 10-second poll from any open tab, the database could never reach an
   idle window, so it billed compute continuously — 865 GB-hours is consistent
   with a compute unit that essentially never suspended. The frontend fix is what
   makes suspension reachable at all; the setting still has to be on.
3. Set the **idle timeout to the minimum** offered (typically 5 minutes).
4. Check the **minimum/maximum compute size (CU)**. If autoscaling has a floor
   above the smallest unit, lower it — GB-hours are CU × hours.
5. After deploying this branch, re-check the compute graph over 24h. It should
   show real suspended gaps overnight. If it does not, something still polls.

### D. Risky — owner approval required, do not set unilaterally

| Variable                        | Why it is risky |
| ------------------------------- | --------------- |
| `MARKET_CONTEXT_COLLECT_ENABLED=false` | Stops canonical market collection entirely. RADAR would go `PENDING`/stale and the terminal would fall back to `/api/markets`. Biggest single DB saving, biggest product loss. |
| `CRON_ALERTS_ENABLED=false`      | Disables the RADAR ENTRY_READY alert path. **Out of scope for this audit** — listed only so it is not touched by mistake. |
| `PERSONAL_ALERTS_ENABLED=false`  | Disables personal watch alerts. Same caveat. |
| `RADAR_TELEGRAM_ENABLED=false`   | Telegram delivery. **Do not change as a cost measure.** |

## Out of scope / deliberately untouched

No change was made to: the trading or order path, ENTRY_READY evaluation,
Telegram delivery, `cron-alerts.mjs`, `personal-alerts.mjs`,
`morning-briefing.mjs`, authentication, any environment variable, or any
database migration. No data was deleted and no destructive DB command was run.
