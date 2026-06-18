# RADAR Static Microstructure — Provider-Backed Optional Overlay

Static microstructure (order-book depth / spread / funding) is an **optional,
provider-backed overlay** for the RADAR detail view. It is **not** a hard
dependency, **not** an automatic Binance scraping cron, and **never** a trading
worker.

The **production default is `MARKET_DATA_PROVIDER=none`** → the producer makes
**zero external fetches**, posts nothing, and the UI shows **"provider
unavailable"** (fail-closed). Binance-public fetching is a **diagnostic /
local-only** path that must be opted into explicitly. There is **no production
scheduler** anywhere.

> [!WARNING]
> This is **not** a trading worker. It must **not** be replaced by, or routed
> through, `local-binance-worker` or a `worker-session`. It never starts a bot
> session, never runs a live/testnet lifecycle, never imports execution/order
> paths, and never touches Binance signed endpoints. No `BINANCE_API_KEY` /
> `BINANCE_API_SECRET` is ever required (public market data only).

## Why provider-backed (the 451 story)

Binance public fapi (`depth` / `premiumIndex`) is reachable only from an
operator's local PC. **Both GitHub Actions and Netlify serverless egress are
region-blocked by Binance public fapi (HTTP 451)** — every call returned
`skip=http-451-or-region-block`, so an automatic run always measured **zero**.
We are **not** chasing servers/proxies/extra egress (no Render, no proxies) to
work around this.

So the microstructure layer was refactored into a **Market Data Provider**
abstraction. The control plane and UI treat a missing/unconfigured provider as
*"provider unavailable"*, not as an error — and absolutely not as a reason to
relax any gate.

The Binance-public fetch was useful as a **proof-of-concept** that real
order-book depth/spread/funding could be measured and surfaced. It is **not** a
production data source.

## Market Data Provider abstraction

File: [`scripts/radar/market-data-provider.mjs`](../scripts/radar/market-data-provider.mjs)

```js
const provider = createMarketDataProvider(env, opts);
provider.name                       // 'none' | 'binance-public' | 'snapshot'
await provider.getStaticMicrostructure(candidate); // { available, reason, symbol?, fields? }
provider.health();                  // { name, status, reason }
```

Selected by the `MARKET_DATA_PROVIDER` env (fail-closed default):

| `MARKET_DATA_PROVIDER` | Provider | Behaviour |
| --- | --- | --- |
| *(unset)* / `none` / unknown | **none** (default) | `unavailable`, reason `provider-unavailable`. **Zero external calls.** |
| `binance-public` | **binance-public** | DIAGNOSTIC / LOCAL-ONLY. Uses the existing public fapi logic. Must be set explicitly; never the default; never scheduled. Public data only — no signed/keyed endpoint. |
| `snapshot` | **snapshot** | Reads only a previously stored `fleet.radarMicrostructureSnapshot`. Never fetches an external API. |

## What "static" means for downstream gating

Static depth/spread/funding is context, but it is **not sufficient** for entry.
It carries no rolling absorption data, and provider-unavailable carries no data
at all. Either way it is **fail-closed**:

- **STATIC (depth/spread/funding):** present / stale / **provider unavailable** / missing
- **ROLLING ABSORPTION DATA:** missing
- **Absorb:** does **not** pass on missing, untrusted, or static-only data
- **ENTRY_READY:** no
- **Telegram:** no

`ENTRY_READY`, Telegram eligibility, gates, thresholds, `EXECUTION_SCORE`, and
`SETUP_SCORE` are **unchanged** by this overlay. The provider status is advisory
display context only.

## Expected production behaviour (default `none`)

With no provider configured, the RADAR focus card shows:

- **STATIC provider unavailable**
- **ROLLING missing**
- **Absorb: not pass**
- **ENTRY_READY: no**
- **Telegram: no**

This is correct and intended — not an error state. The producer, if run, logs:

```
[PRODUCER] provider=none reason=provider-unavailable measured=0 posted=false
{"tag":"radar-microstructure","provider":"none","providerStatus":"unavailable","reason":"provider-unavailable",...,"posted":false}
```

and exits `0` without contacting Binance or the control plane.

## Manual local diagnostic (binance-public, explicit opt-in)

`binance-public` is **diagnostic / local-only** and must be set explicitly. Run
the one-shot producer from an operator PC whose egress can reach `fapi.binance.com`:

```bash
# Read-only. PUBLIC market data only; no Binance keys/secret.
export MARKET_DATA_PROVIDER=binance-public
export BOT_WORKER_TOKEN=__REPLACE_WITH_CONTROL_PLANE_WORKER_TOKEN__
export CONTROL_BASE_URL=https://swingterminalx.netlify.app
export WORKER_RADAR_MICROSTRUCTURE_TOP_N=5
export WORKER_RADAR_MICROSTRUCTURE_CACHE_MS=10000

MARKET_DATA_PROVIDER=binance-public node scripts/radar/radar-microstructure-producer.mjs
```

On Windows PowerShell:

```powershell
$env:MARKET_DATA_PROVIDER='binance-public'
$env:BOT_WORKER_TOKEN='__REPLACE_WITH_CONTROL_PLANE_WORKER_TOKEN__'
$env:CONTROL_BASE_URL='https://swingterminalx.netlify.app'
$env:WORKER_RADAR_MICROSTRUCTURE_TOP_N='5'
$env:WORKER_RADAR_MICROSTRUCTURE_CACHE_MS='10000'
node scripts/radar/radar-microstructure-producer.mjs
```

In `binance-public` mode the producer performs exactly **one** read-only cycle:

1. `GET /api/bot/radar-candidates` (control plane, `X-BOT-WORKER-TOKEN`).
2. For the top-N candidates, read **public** Binance market data only:
   - `GET https://fapi.binance.com/fapi/v1/depth` (order-book depth/spread)
   - `GET https://fapi.binance.com/fapi/v1/premiumIndex` (funding rate)
3. `POST /api/bot/radar-microstructure` — push the measured **static** fields
   (tagged `provider: "binance-public"`) so the RADAR UI can display them.

No order, margin, leverage, withdraw, or otherwise signed endpoint is ever
called. Logs are a safe summary only (counts + per-candidate skip reasons) —
never the token, request headers, or response bodies.

## Non-production diagnostic endpoints (no automatic schedule)

These exist for on-demand inspection only and run **nothing automatically**:

- **GitHub workflow** [`.github/workflows/radar-microstructure.yml`](../.github/workflows/radar-microstructure.yml):
  `workflow_dispatch` only, **no `schedule:`**. It sets
  `MARKET_DATA_PROVIDER=binance-public` for the manual run; GitHub egress is
  451-blocked, so it is for diagnostics only. Do **not** add a cron.
- **Netlify function** [`netlify/functions/radar-microstructure-refresh.mjs`](../netlify/functions/radar-microstructure-refresh.mjs):
  token-protected, **no `export const config.schedule`**. It does **not** default
  `MARKET_DATA_PROVIDER`, so with the production default it returns a clean
  `provider-unavailable` result and never fetches Binance.

## Verify the stored snapshot / provider status

```
GET https://swingterminalx.netlify.app/api/bot/radar-microstructure
Header: x-bot-worker-token: <your control-plane worker token>
```

The response includes `provider`, `providerStatus` (`present` / `stale` /
`unavailable`), `unavailableReason`, `present`, and `stale` alongside the
existing `metrics` / `keys` / `receivedAt`. With the default `none` provider and
no stored data, `providerStatus` is `unavailable` and `unavailableReason` is
`provider-unavailable`.

## Exit-code policy

The producer is **scheduler-safe** — no unhandled exceptions. A single cycle
wraps fetch → enrich → post in try/catch and logs, never throws.

| Situation | Exit code | Why |
| --- | --- | --- |
| Provider unavailable (`none` / `snapshot` / unknown — the default) | `0` | Fail-closed no-op; **zero external calls** |
| (binance-public) No radar candidates | `0` | Nothing to measure this cycle |
| (binance-public) No microstructure measured | `0` | Nothing to post this cycle |
| (binance-public) Temporary Binance failure | `0` | Transient; never red-marks anything |
| (binance-public) Backend `POST` failure | `0` | Non-fatal; overlay-only data self-heals next run |
| (binance-public) Missing `BOT_WORKER_TOKEN` | `1` | Misconfiguration — fail closed, post nothing |
| (binance-public) Missing `CONTROL_BASE_URL` | `1` | Misconfiguration — fail closed, post nothing |

The only non-zero exits are **configuration** failures in explicit
`binance-public` mode (missing token/base URL). The default `none` provider can
never fail this way because it never fetches or posts.

The Netlify function maps the same outcomes to HTTP status: `200` for
provider-unavailable / no-candidates / no-data / Binance-failure / post-failure,
and `500` only for a missing-config failure (no `BOT_WORKER_TOKEN`) in
`binance-public` mode. Manual HTTP calls without a valid `x-bot-worker-token`
get `401`.
