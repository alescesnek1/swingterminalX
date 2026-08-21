# Canonical context expiry — root cause, current state, and the re-enable path

**Status:** `/api/context` enforces a **30-minute hard freshness budget** server-side.
An older published run is refused with `503 STALE_EXPIRED` and **no rows**.

---

## 1. Root cause of the 28-hour snapshot

Three things had to line up, and all three were true:

1. **Nothing publishes a new run.** `MARKET_CONTEXT_COLLECT_ENABLED=false` in
   production. That is the emergency Netlify cost breaker
   (`netlify/functions/_cost-breaker.mjs`, `docs/netlify-cost-breaker.md`) and it
   is **deliberate** — database compute is billed per GB-hour *awake*, and the
   collector's `*/3 * * * *` schedule sits below the 5-minute sleep threshold, so
   running it kept Postgres permanently awake. The collector is **disabled, not
   broken**: `market-context-collect-scheduled.mjs` returns
   `{ok:true, skipped:true, reason:'COLLECT_DISABLED'}` before it imports a
   module, opens a connection or fetches anything.

2. **The read had no age predicate.** `getAtomizedMarketContext()` asks for

   ```sql
   SELECT … FROM market_collection_runs
    WHERE scope_id=$1 AND status='published'
    ORDER BY observed_at DESC LIMIT 1
   ```

   "The newest published run" — with no `WHERE observed_at > …`. With nothing
   publishing, that is *the same row forever*, ageing without bound.

3. **`freshness` was a label, not a gate.** Both the store and `context.mjs`
   computed `FRESH | STALE | MISSING` from wall-clock age **after** the read, and
   then returned **HTTP 200 with the full body regardless**. `STALE` was
   decoration on a response that was served anyway.

So the last run published before the breaker was engaged kept being handed out
as canonical data. The browser's hard-age refusal (shipped in
`fix/production-reliability-p0-p2`) stopped it reaching the scanner, but the
endpoint was still offering it.

## 2. What this branch changes

**`netlify/functions/_market-context-store.mjs`** — `getAtomizedMarketContext()`
accepts an **opt-in** `maxAgeMs` (default `null` = previous behaviour, byte for
byte). When set, the run's age is checked immediately after the run row is read
and **before** the ticker and microstructure queries are issued. An expired run
returns

```js
{ ok:false, reason:'STALE_EXPIRED', staleExpired:true, ageMs, maxAgeMs, observedAt }
```

Fails closed: an unparseable `observed_at` expires too.

> **Cost note:** this is strictly *cheaper* than before. The expensive pair of
> queries (up to 2,000 tickers + 600 microstructure rows) is skipped entirely on
> an expired read. No new query is added on the healthy path — the age comes from
> the run row that was already being fetched.

**`netlify/functions/context.mjs`** — passes
`maxAgeMs: CONTEXT_HARD_MAX_AGE_MS` (**30 min**, matching
`HARD_MAX_MARKET_AGE_MS` in `apps/edge/public/js/freshness-badge.js` so client
and server draw the line in the same place) and answers:

```
HTTP 503
{ ok:false, reason:'STALE_EXPIRED', stale_expired:true,
  age_ms, max_age_ms, observedAt, detail }
X-Context-Stale: expired
X-Context-Age-Ms: <n>
X-Context-Observed-At: <iso>
```

No ticker row, no microstructure row, no RADAR payload — by construction, since
the store returned before fetching any. The verdict is memoized like a success
(it is global and monotonic, so re-deriving it per request would spend a round
trip to learn the same thing), and a memo hit replays the **same 503**, with the
age recomputed from `observedAt` so it can never under-report.

**`apps/edge/public/js/terminal.js`** — recognises `503 STALE_EXPIRED` as the
*expected* degraded state and tags it `canonicalDegraded`, so it reports as INFO
("Canonical context stale; using live /api/markets") rather than as a fault, and
falls back to the live `/api/markets` read exactly as before. A genuine
401/503/network failure still surfaces a red toast.

## 3. Every store consumer, and how each one fails closed

Audited in full (`fix/canonical-store-consumer-freshness-guards`). Every
user-facing consumer now refuses a stale published run:

| Consumer | Classification | Guard | 28h run |
|---|---|---|---|
| `context.mjs` | user-facing terminal read | `maxAgeMs` 30 min | `503 STALE_EXPIRED`, no rows |
| `_personal-watch-notifier.mjs` | **Telegram** watch alerts | `maxAgeMs` 30 min | returns `CONTEXT_STALE_EXPIRED` **before** reading recipients or sending |
| `morning-briefing.mjs` + `scripts/briefing/morning-briefing.mjs` | **Telegram** briefing | its own **15 min** budget (`DEFAULT_MAX_DATA_AGE_MS`) | axis marked `MARKET_STALE`, `markets` becomes `[]` — contributes nothing |
| `cron-alerts.mjs` (`getPublishedRadar`) | **Telegram** ENTRY_READY alerts | its own **6 min** budget (`CANONICAL_RADAR_STALE_MS`) | `RADAR_STALE`, no alert |
| `_radar-context-publisher.mjs` (`getRadarInputBundle`, `getRadarStatusIndex`) | internal producer | flag-gated (`MARKET_CONTEXT_RADAR_ENABLED=false`) | no-op |
| `_market-context-collector.mjs` (`getMicrostructureBaseline`) | internal producer | flag-gated (`MARKET_CONTEXT_COLLECT_ENABLED=false`) | no-op |

**The personal-watch notifier was the only real hole.** `evaluateWatchTriggers`
receives no timestamp and cannot self-protect, so a 28-hour run would have sent
"your stop broke" off a day-old price. It now passes `maxAgeMs` (30 min, the
same constant as `/api/context`) using the same `nowMs` clock the triggers and
cooldowns use, and returns before any recipient read or Telegram send.

The briefing and cron-alerts were already stricter than the store budget — that
is asserted by test so it cannot regress. Telegram credentials, the sender, and
the message shape are untouched.

A test enumerates every direct `getAtomizedMarketContext` caller and fails if a
new one appears, so the next consumer cannot be added without a freshness
decision.
## 4. Safely re-enabling the publisher (NOT done here)

Nothing in this branch re-enables anything, and no env var was changed. If the
canonical store is wanted live again, this is the shape of it:

1. **Cadence above the sleep threshold.** The collector's schedule is
   `*/3 * * * *` in `market-context-collect-scheduled.mjs` — below the database's
   5-minute sleep timer, which is the actual cost driver. A safe re-enable means
   moving to `*/6` or slower **first**; that is a code change to `config.schedule`
   and must be agreed explicitly.
2. **`MARKET_CONTEXT_COLLECT_ENABLED=true`** in production (env change — owner).
3. **Keep the write caps** already in the source:
   `MARKET_CONTEXT_MICROSTRUCTURE_TOP_N` (default 5),
   `MARKET_CONTEXT_MULTI_TF_TOP_N` (default 300, max 500), and
   `refuseIfCycleCannotFit()`, which refuses a configuration that cannot finish
   inside the 30s scheduled-function ceiling.
4. **Background path if the cycle is large:** `MARKET_CONTEXT_BACKGROUND_ENABLED=true`
   plus `CONTROL_BASE_URL` and `BOT_WORKER_TOKEN`, giving ~15 min instead of 30s.
5. **Verify before trusting:** once a run publishes, `/api/context` starts
   answering 200 again automatically — the expiry gate needs no toggle. Confirm
   with the `age_ms` in the 503 shrinking to under 30 min and then disappearing.
6. **Watch the bill.** Database compute is billed on *awake* time; re-enabling a
   sub-5-minute cadence returns to the condition that produced 920.63 GB-hours.

Until then the terminal runs on the live `/api/markets` edge read, which touches
no database at all, and the expiry gate above guarantees the canonical store
cannot quietly substitute for it.
