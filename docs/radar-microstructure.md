# RADAR Static Microstructure Producer

Read-only refresh of the RADAR **static** microstructure overlay
(order-book depth / spread / funding). In production it is driven by a **Netlify
Scheduled Function**, not by a trading worker. (The earlier GitHub Actions cron
is retired — see below.)

> [!WARNING]
> This is **not** a trading worker. It must **not** be replaced by, or routed
> through, `local-binance-worker` or a `worker-session`. It never starts a bot
> session, never runs a live/testnet lifecycle, never imports execution/order
> paths, and never touches Binance signed endpoints.

## What it does

The producer (`scripts/radar/radar-microstructure-producer.mjs`) runs a single
cycle per invocation:

1. `GET /api/bot/radar-candidates` — read the current RADAR candidate list from
   the control plane (auth via `X-BOT-WORKER-TOKEN`).
2. For the top N candidates, read **public** Binance futures market data only:
   - `GET https://fapi.binance.com/fapi/v1/depth` (order-book depth/spread)
   - `GET https://fapi.binance.com/fapi/v1/premiumIndex` (funding rate)
3. `POST /api/bot/radar-microstructure` — push the measured **static** fields
   back to the control plane so the RADAR UI can display them.

No API key/secret is required because only public market data is read. No
order, margin, leverage, withdraw, or otherwise signed endpoint is ever called.

### What "static" means for downstream gating

Static depth/spread/funding is necessary context, but it is **not sufficient**
for entry. It does not carry rolling absorption data, so:

- **STATIC (depth/spread/funding):** present
- **ROLLING ABSORPTION DATA:** missing
- **Absorb:** does **not** pass on static-only data (fail-closed)
- **ENTRY_READY:** no
- **Telegram:** no

This is intentional and correct. The static overlay informs the RADAR detail
view; it never on its own promotes a candidate to ENTRY_READY or fires an alert.
ENTRY_READY, Telegram, gates, thresholds, `EXECUTION_SCORE`, and `SETUP_SCORE`
are unchanged by this producer.

## Scheduler (production): Netlify Scheduled Function

Function: [`netlify/functions/radar-microstructure-refresh.mjs`](../netlify/functions/radar-microstructure-refresh.mjs)

- Runs every 10 minutes (`export const config = { schedule: '*/10 * * * *' }`).
- Reuses the exact same producer logic via the shared
  `runRadarMicrostructureProducer({ env, fetchFn, logger })` runner.
- Returns HTTP `200` even when nothing was measured; only a missing-config
  failure (no `BOT_WORKER_TOKEN`) returns a non-200 with a clear, non-secret
  error.
- Logs a safe summary only (counts + per-candidate skip reasons). Never logs
  the token, request headers, or response bodies.

### Why not GitHub Actions?

> [!IMPORTANT]
> The previous GitHub Actions cron is **disabled** for production. GitHub-hosted
> runners are **region-blocked by Binance public fapi (HTTP 451)** — every
> `depth`/`premiumIndex` call failed with `skip=http-451-or-region-block`, so a
> scheduled run always measured **zero**. Netlify's egress can reach Binance
> fapi, so the production schedule lives in the Netlify function above.
>
> The GitHub workflow
> [`.github/workflows/radar-microstructure.yml`](../.github/workflows/radar-microstructure.yml)
> is kept **manual-only** (`workflow_dispatch`, no `schedule:`) as an on-demand
> diagnostic for inspecting the producer's structured logs.

### Environment used by the Netlify function

Set these as **Netlify environment variables** (Site → Settings → Environment):

| Variable | Value | Purpose |
| --- | --- | --- |
| `BOT_WORKER_TOKEN` | *(Netlify env secret)* | Control-plane worker auth header |
| `CONTROL_BASE_URL` | defaults to `process.env.URL` or `https://swingterminalx.netlify.app` | Control-plane base URL |
| `WORKER_RADAR_MICROSTRUCTURE_ENABLED` | `true` (defaulted) | Master enable for the producer |
| `WORKER_RADAR_MICROSTRUCTURE_TOP_N` | `5` (defaulted) | Target number of measured symbols |
| `WORKER_RADAR_MICROSTRUCTURE_SCAN_LIMIT` | `50` (defaulted) | How deep to scan for measurable symbols |
| `WORKER_RADAR_MICROSTRUCTURE_CACHE_MS` | `10000` (defaulted) | Per-symbol measurement cache window |

No `BINANCE_API_KEY` / `BINANCE_API_SECRET` is set or needed.

### Manual invocation of the Netlify function

The scheduled function is also reachable over HTTP for diagnostics, but a manual
call **must** present the worker token (the scheduled trigger is recognised by
its `next_run` body and needs no header):

```
POST https://swingterminalx.netlify.app/.netlify/functions/radar-microstructure-refresh
Header: x-bot-worker-token: <your control-plane worker token>
```

There is no unauthenticated refresh endpoint.

## Configure the secret

The only secret required is the control-plane worker token.

- **Production (Netlify):** Site → Settings → Environment variables → add
  `BOT_WORKER_TOKEN`.
- **Manual GitHub diagnostic (optional):** Repository → Settings → Secrets and
  variables → Actions → `BOT_WORKER_TOKEN`.

Placeholder only — do not commit the real value:

```
BOT_WORKER_TOKEN=__REPLACE_WITH_CONTROL_PLANE_WORKER_TOKEN__
```

Secrets are never printed by the producer, the workflow, or the Netlify function.

## Disable the scheduler

Any one of the following disables it:

- **Stop the Netlify cron:** remove/rename the `export const config.schedule`
  in `netlify/functions/radar-microstructure-refresh.mjs`, or disable the
  scheduled function from the Netlify dashboard.
- **Hard-disable the producer:** set `WORKER_RADAR_MICROSTRUCTURE_ENABLED` to
  anything other than `true`. The producer logs
  `WORKER_RADAR_MICROSTRUCTURE_ENABLED is not true. Exiting.` and the function
  returns `200` having done nothing.
- **Remove the secret:** without `BOT_WORKER_TOKEN` the producer fails closed
  (CLI exit `1`; Netlify function returns `500`) and posts nothing.

## Run a manual smoke locally

```bash
# Read-only. Requires only the control-plane token; no Binance keys.
export BOT_WORKER_TOKEN=__REPLACE_WITH_CONTROL_PLANE_WORKER_TOKEN__
export CONTROL_BASE_URL=https://swingterminalx.netlify.app
export WORKER_RADAR_MICROSTRUCTURE_ENABLED=true
export WORKER_RADAR_MICROSTRUCTURE_TOP_N=5
export WORKER_RADAR_MICROSTRUCTURE_CACHE_MS=10000

node scripts/radar/radar-microstructure-producer.mjs
```

On Windows PowerShell:

```powershell
$env:BOT_WORKER_TOKEN='__REPLACE_WITH_CONTROL_PLANE_WORKER_TOKEN__'
$env:CONTROL_BASE_URL='https://swingterminalx.netlify.app'
$env:WORKER_RADAR_MICROSTRUCTURE_ENABLED='true'
$env:WORKER_RADAR_MICROSTRUCTURE_TOP_N='5'
$env:WORKER_RADAR_MICROSTRUCTURE_CACHE_MS='10000'
node scripts/radar/radar-microstructure-producer.mjs
```

Expected output is a single cycle log, e.g. `[PRODUCER] Posted N metrics ok=true`.

## Verify the backend updated

After a scheduled (or manual) run where Binance fapi was reachable and at least
one symbol measured, the control-plane snapshot should refresh:

```
GET https://swingterminalx.netlify.app/api/bot/radar-microstructure
Header: x-bot-worker-token: <your control-plane worker token>
```

Expect a **fresh `receivedAt`** and `metrics > 0` (e.g. `keys` including
`BEATUSDT`). If `measured` is `0` with `failedFetch` high and every per-candidate
line shows `skip=http-451-or-region-block`, the host running the producer cannot
reach Binance fapi (the exact reason GitHub Actions was retired).

## Exit-code policy

The producer is designed to be **scheduler-safe** — no unhandled exceptions.
A single cycle wraps fetch → enrich → post in try/catch and logs, never throws.

| Situation | Exit code | Why |
| --- | --- | --- |
| Producer disabled (`...ENABLED` ≠ `true`) | `0` | Clean no-op |
| No radar candidates | `0` | Nothing to measure this cycle |
| No microstructure measured | `0` | Nothing to post this cycle |
| Temporary Binance failure | `0` | Transient; next cron tick retries |
| Backend `POST` failure | `0` | **Decision:** treated as non-fatal so a transient control-plane blip does not red-mark the schedule; the next tick re-posts. Data is overlay-only and self-heals on the following cycle. |
| Missing `BOT_WORKER_TOKEN` | `1` | Misconfiguration — fail closed, post nothing |
| Missing `CONTROL_BASE_URL` | `1` | Misconfiguration — fail closed, post nothing |

The only non-zero exits are **configuration** failures (missing token/base URL),
which should never happen with the secret set. Runtime/network failures are
non-fatal by design so the schedule stays green and self-heals on the next tick.

The Netlify function maps the same outcomes to HTTP status: `200` for disabled /
no-candidates / no-data / Binance-failure / post-failure, and `500` only for a
missing-config failure (no `BOT_WORKER_TOKEN`). Manual HTTP calls without a valid
`x-bot-worker-token` get `401`.
