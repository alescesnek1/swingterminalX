# Canonical Context Store — rollout & flags

The canonical market Context Store and the server RADAR publisher are **fully
built but flag-gated OFF by default**. Nothing changes in production until the
owner flips the environment flags in the Netlify UI, in the order below. Every
stage is reversible by turning its flag back off.

The old CoinGecko `price-history` writer is intentionally **left running in
parallel** during the whole rollout — it is only retired after a verified read
cutover (a separate, later step).

## Environment flags (set in Netlify → Site settings → Environment variables)

| Flag | Default | Purpose |
|------|---------|---------|
| `MARKET_CONTEXT_COLLECT_ENABLED` | `false` | Master switch for the 3-minute collector (writes atomic market records to Postgres). |
| `MARKET_CONTEXT_FUTURES_ENABLED` | `false` | **Keep false.** Binance futures egress from Netlify is unverified; spot only for now. |
| `MARKET_CONTEXT_MICROSTRUCTURE_TOP_N` | `5` | How many symbols get deep microstructure (depth/trades/klines). Max 600; ~9 request weight each. **This is the ceiling on how many coins can ever become `ENTRY_READY`** — order-book support + flow are 50% of `EXECUTION_SCORE`, and an unmeasured coin cannot reach the 65 gate. Current rollout target: `200`. |
| `MARKET_CONTEXT_MICROSTRUCTURE_POOL_SIZE` | `400` | Size of the liquid pool the budget may draw from (ranked by USD-stable 24h quote volume). Bounds tradeability: a pair outside this pool never consumes a measurement slot, because the universe filter would reject it anyway. |
| `MARKET_CONTEXT_MICROSTRUCTURE_MAJOR_SLOTS` | `20` | Slots reserved for the top-liquidity coins, so BTC/ETH/major context is always measured. Every remaining slot goes to the deepest 24h drawdowns inside the pool — the coins that can actually carry a dislocation+flush setup. A pump earns no slot. |
| `MARKET_CONTEXT_MULTI_TF_ENABLED` | `false` | Collect 1h/4h/12h/7d % change (Binance rolling-window ticker) for the top-N symbols. Off = scanner shows only 24h; 1h/4h/12h/7d are UNKNOWN. |
| `MARKET_CONTEXT_MULTI_TF_TOP_N` | `300` | How many symbols get 1h/4h/12h/7d change. Max **1200**. **Ranked by 24h volume, NOT by the dislocation budget** — so with the default 300 the coins RADAR now surfaces (deepest drawdowns, often mid-caps far down the volume list) frequently have no multi-timeframe data and the scanner shows blanks for them. Set to `1000` to cover the whole USD-stable universe (measured live: 750 TRADING pairs exist, so 1000 covers all of them). |

### Measured multi-timeframe cost (local live test, 2026-07-27)

The spot pacer budget is **3600 weight/min** and the collector runs every **180s**.

| Spend | Weight |
|---|---|
| Microstructure, 200 symbols × 9 | 1800 |
| Multi-timeframe, 750 symbols → 8 batches × 4 windows × 200 | 6400 |
| **Total** | **8200** → ~123s of the 180s cycle (107s of it pacer waiting) |

Verified end-to-end against the real Binance spot endpoint: **750/750 symbols with all
four windows, 0 failed batches.** Headroom is ~57s, so microstructure can grow to
roughly 480 symbols before a cycle stops fitting in the interval.

**Without the pacer the same run 429s** and, because windows are fetched in order
(1h → 4h → 12h → 7d), the shortfall always lands on `7d`. A rate-limited batch is
retried (a 429 means "later", not "no such data"), and any surviving shortfall is
reported per window in `multiTimeframeWindowCoverage` plus a
`[MARKET_CONTEXT] multi_timeframe_degraded` warning — so a two-thirds-empty 7d column
can never again look like a property of the market rather than a failed fetch.

Measured on the unpaced worst case (750 symbols, full speed, deliberately rate-limited):

| Backoff | Result |
|---|---|
| none (drop on first 429) | 500/750 with all four windows, 250 missing `7d` |
| 3s / 6s | 650/750, 100 missing `7d` |
| **12s / 24s, 30s total cap** | **750/750, 0 missing, 48.5s** |

Binance's allowance is a **rolling 60s window**, which is why a 3s pause cleared almost
nothing — the retry fired straight back into the same exhausted budget.

`MULTI_TF_RETRY_WAIT_BUDGET_MS` (30s) caps retry waiting for the **whole** collection,
not per window. Retries are per batch and a full pass has 32 of them, so an unbounded
backoff could add minutes to a cycle scheduled every 180s — and overrunning starts a
second, overlapping run that competes for the same IP allowance and causes the very
429s being retried. Once the cap is spent, remaining failures are reported rather than
waited on, and `retryBudgetExhausted` says so per window.
| `MARKET_CONTEXT_RADAR_ENABLED` | `false` | Master switch for the server RADAR publisher. Writes both the per-run history (`radar_run_snapshots`/`radar_run_candidates`) and the atomized current state (`radar_candidate_state`, one upserted row per `(market, symbol)`), which is what `/api/context` and the alert path read. |
| `MARKET_CONTEXT_RETENTION_ENABLED` | `false` | Master switch for the hourly retention sweep. |
| `MARKET_CONTEXT_RETENTION_MARKET_HOURS` | `48` | How long to keep heavy market rows (min 6h floor). |
| `MARKET_CONTEXT_RETENTION_RADAR_HOURS` | `168` | How long to keep RADAR results (for 24h/7d funnel); never shorter than the market window. |
| `RADAR_CANONICAL_CONTEXT_READ` *(frontend)* | `false` | **BROWSER-side switch — a Netlify env var CANNOT enable it.** Set it per browser with `localStorage.setItem('radarCanonicalContextRead','true')` then reload, or `window.RADAR_CANONICAL_CONTEXT_READ = true`. While it is off the terminal serves the legacy `/api/markets` feed, **which has no 4h and no 12h change at all and only partial 1h** — so those scanner columns are blank however well the collector is configured. 24h is unaffected, which is exactly what makes the state confusing. The RADAR panel now says so explicitly instead of falling back silently. Frontend cutover switch: read Scanner/RADAR from `/api/context` instead of the legacy `/api/markets` + Fleet path. Legacy path stays as fallback, and the switch to it is now stated on screen (it carries no server rolling microstructure, so Strict Absorb reads "DATA OFF" there). |

## Read routes over the canonical DB

| Route | Auth | Scope | Notes |
|-------|------|-------|-------|
| `/api/context` | verified Supabase JWT | Whole universe | Tickers + microstructure + the full RADAR candidate set. RADAR comes from the atomized `radar_candidate_state`, so a freshly published-but-unscored run no longer reads PENDING. |
| `/api/cockpit-radar-state?symbol=X[&market=spot\|futures]` | verified Supabase JWT | **One coin** | GET-only, read-only. Serves the Cockpit off the `(market, symbol)` primary key. `404 NOT_SCORED` when the server has not scored that coin (a coverage gap, distinct from an error); `400 INVALID_SYMBOL`; `503 DB_UNAVAILABLE`. Reports `computedAt`/`ageMs`/`freshness` so a stale verdict can never render as current. |

## One-time prerequisite

Apply the migrations (adds atomic tables + `radar_run_snapshots` / `radar_run_candidates`):

```bash
npm run db:migrate:apply
```

## Rollout order (each stage is a separate, reversible decision)

1. **Collector shadow** — set `MARKET_CONTEXT_COLLECT_ENABLED=true` (spot only).
   Watch the `Market Context Collect Scheduler` function logs for
   `cycle_completed` and confirm ticker/candle/trade/measurement counts. No UI
   changes yet.
2. **RADAR shadow** — set `MARKET_CONTEXT_RADAR_ENABLED=true`. The publisher runs
   after each market publish; confirm `[RADAR_PUBLISH] cycle_completed` and that
   `/api/context` returns `radar.status: "READY"` with candidates and a
   `providerStatus`. STRICT confirms only when a symbol's DB microstructure is
   complete and trusted; otherwise it stays UNKNOWN — this is correct.
3. **Read cutover** — set `RADAR_CANONICAL_CONTEXT_READ=true` so the terminal
   reads canonical context. The legacy `/api/markets` + Fleet path remains present
   as an automatic fallback; turning the flag off reverts instantly.
4. **Retention** — set `MARKET_CONTEXT_RETENTION_ENABLED=true` once data volume
   warrants it. Confirm `retention_completed` logs and that `protectedRunId`
   matches the latest published run.
5. **Retire legacy sources** — only after the above are verified: stop the
   CoinGecko price-history writer and the Fleet radar-context source. Separate,
   explicitly-approved step.

## Honesty guarantees baked in

- STRICT_ABSORB can only CONFIRM from a trusted rolling provider. The collector
  is a truthfully-labelled provider (`netlify-atomic-collector`, spot, real
  N-1→N window); it is never disguised as the futures feed, and thin/incomplete
  data yields UNKNOWN, never a fake confirmation.
- A published market run with no computed RADAR reads back as `PENDING`, never a
  fabricated ready result.
- Retention never deletes instruments, run audit metadata, or the latest
  published run, and floors the market window at 6h.
