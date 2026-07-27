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
| `MARKET_CONTEXT_MULTI_TF_TOP_N` | `300` | How many top-volume symbols get multi-timeframe change. Max 500. Bounded by the Binance rate-limit budget; the long tail stays UNKNOWN. |
| `MARKET_CONTEXT_RADAR_ENABLED` | `false` | Master switch for the server RADAR publisher. Writes both the per-run history (`radar_run_snapshots`/`radar_run_candidates`) and the atomized current state (`radar_candidate_state`, one upserted row per `(market, symbol)`), which is what `/api/context` and the alert path read. |
| `MARKET_CONTEXT_RETENTION_ENABLED` | `false` | Master switch for the hourly retention sweep. |
| `MARKET_CONTEXT_RETENTION_MARKET_HOURS` | `48` | How long to keep heavy market rows (min 6h floor). |
| `MARKET_CONTEXT_RETENTION_RADAR_HOURS` | `168` | How long to keep RADAR results (for 24h/7d funnel); never shorter than the market window. |
| `RADAR_CANONICAL_CONTEXT_READ` *(frontend)* | `false` | Frontend cutover switch: read Scanner/RADAR from `/api/context` instead of the legacy `/api/markets` + Fleet path. Legacy path stays as fallback, and the switch to it is now stated on screen (it carries no server rolling microstructure, so Strict Absorb reads "DATA OFF" there). |

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
