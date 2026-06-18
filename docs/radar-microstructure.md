# RADAR Static Microstructure Producer

Read-only refresh of the RADAR **static** microstructure overlay
(order-book depth / spread / funding). It is driven by a GitHub Actions cron
schedule, not by a trading worker.

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

## Scheduler

Workflow: [`.github/workflows/radar-microstructure.yml`](../.github/workflows/radar-microstructure.yml)

- Runs every 10 minutes (`cron: '*/10 * * * *'`).
- Can be run on demand via **workflow_dispatch** (Actions tab → *RADAR Static
  Microstructure Refresh* → *Run workflow*).
- Uses `concurrency` to avoid overlapping runs.
- `permissions: contents: read` only.

### Environment used by the workflow

| Variable | Value | Purpose |
| --- | --- | --- |
| `BOT_WORKER_TOKEN` | *(GitHub secret)* | Control-plane worker auth header |
| `CONTROL_BASE_URL` | `https://swingterminalx.netlify.app` | Control-plane base URL |
| `WORKER_RADAR_MICROSTRUCTURE_ENABLED` | `true` | Master enable for the producer |
| `WORKER_RADAR_MICROSTRUCTURE_TOP_N` | `5` | How many top candidates to measure |
| `WORKER_RADAR_MICROSTRUCTURE_CACHE_MS` | `10000` | Per-symbol measurement cache window |

No `BINANCE_API_KEY` / `BINANCE_API_SECRET` is set or needed.

## Configure the GitHub secret

The only secret required is the control-plane worker token:

```
Repository → Settings → Secrets and variables → Actions → New repository secret
Name:  BOT_WORKER_TOKEN
Value: <your control-plane worker token>
```

Placeholder only — do not commit the real value:

```
BOT_WORKER_TOKEN=__REPLACE_WITH_CONTROL_PLANE_WORKER_TOKEN__
```

Secrets are never printed by the producer or the workflow.

## Disable the scheduler

Any one of the following disables it:

- **Stop the cron:** comment out / remove the `schedule:` block in
  `.github/workflows/radar-microstructure.yml` (keep `workflow_dispatch` if you
  still want manual runs), or disable the workflow from the Actions tab.
- **Hard-disable the producer:** set `WORKER_RADAR_MICROSTRUCTURE_ENABLED` to
  anything other than `true`. The producer logs
  `WORKER_RADAR_MICROSTRUCTURE_ENABLED is not true. Exiting.` and exits `0`.
- **Remove the secret:** without `BOT_WORKER_TOKEN` the producer fails closed
  (exit `1`) and posts nothing.

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
non-fatal by design so the cron schedule stays green and self-heals on the next
tick.
