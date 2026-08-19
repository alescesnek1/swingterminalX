# Emergency Netlify cost breaker

**Status:** implemented on `fix/netlify-emergency-cost-breaker`, committed
locally, **NOT pushed and NOT deployed**. No production env var has been changed
by this work — the code defaults are safe on their own, and the recommended
production settings at the bottom need explicit owner approval.

---

## The bill this exists for

| Line                | Credits  | Quantity        |
| ------------------- | -------- | --------------- |
| Total consumed      | 16,462.6 | —               |
| Compute (all)       | 12,788.5 | —               |
| **Database compute**| **9,206.3** | **920.63 GB-hours** |
| Functions compute   | 3,582.1  | 358.21 GB-hours |
| Bandwidth           | 3,415.3  | —               |
| Web requests        | tiny     | —               |

Database compute is the largest single line and it is billed **per GB-hour that
the database is AWAKE**, not per query. Production is configured to sleep after
**5 minutes** of inactivity but "still shows recent activity", so it never
sleeps.

That reframes the problem: **the cadence of the cheapest recurring touch matters
more than the cost of the heaviest query.** One trivial `SELECT` every three
minutes bills the same awake-time as a thousand.

---

## The cost map (what can wake the database)

`/api/markets` and every other Deno **edge** function touch no Postgres — the
bandwidth line comes from there, the database line does not.

### Writers

| Path | Trigger | Cadence | Env gate | Default when unset | DB work | Blocks sleep? |
| --- | --- | --- | --- | --- | --- | --- |
| `market-context-collect-scheduled.mjs` → `_market-context-collector.mjs` | Netlify **native** schedule | **every 3 min** | `MARKET_CONTEXT_COLLECT_ENABLED` | **off** (breaker) | full write cycle: run upsert + instruments + tickers + candles + book levels + agg trades + measurements, hundreds of rows | **YES — 3 min < 5 min sleep. Prime suspect.** |
| `market-context-collect-background.mjs` | HTTP, worker token, dispatched by the above | same 3 min when `MARKET_CONTEXT_BACKGROUND_ENABLED=true` | same | **off** (breaker) | same, with a ~15 min ceiling | YES |
| `_radar-context-publisher.mjs` | after each published market run | per collector cycle | `MARKET_CONTEXT_RADAR_ENABLED` | off (pre-existing) | RADAR rows for the run | follows the collector |
| `market-context-retention-scheduled.mjs` | native schedule | hourly (`17 * * * *`) | `MARKET_CONTEXT_RETENTION_ENABLED` | off (pre-existing) | bounded DELETEs | no (hourly > 5 min) |
| `price-history-collect-scheduled.mjs` | **GitHub Actions** cron | every 30 min | `PRICE_HISTORY_SCHEDULE_ENABLED`, `PRICE_HISTORY_COLLECT_ENABLED`, `PRICE_HISTORY_WRITE_ENABLED` | **off** (breaker) | 1 spacing read + up to 2,000-row batched insert | no (30 min), but heavy |
| `price-history-prune-scheduled.mjs` | GitHub Actions, cron commented out | manual | `PRICE_HISTORY_PRUNE_ENABLED` | **off** (breaker) | batched DELETEs | no |
| `_price-history-writer.mjs` | not wired to any endpoint | — | `PRICE_HISTORY_WRITE_ENABLED` | **off** (breaker) | one snapshot | no |
| `_observability.mjs` | admin endpoints + one Cockpit diagnostic | on demand | none | writes | 1 INSERT | no |
| `_user-store.mjs` | login / refresh / password change | on demand | none (**auth — untouched**) | reads + writes | few | no |

### Readers

| Path | Trigger | Cadence | Env gate | Default when unset | DB work | Browser can repeat? | Blocks sleep? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/api/context` (`context.mjs`) | browser `doRefresh()` | 60 s per open tab, memoized | `CONTEXT_READ_CACHE_MS` (memo), `DB_READS_ENABLED` (master) | available, memo **180 s** | 4 queries, up to 2,000 tickers + 600 measurements | yes | at 180 s memo: no |
| `bot.mjs` → `listRecentPricePoints` ×5 (RADAR top-5 corroboration) | `/api/bot/fleet` | Fleet poll is **4 s**; the RADAR refresh throttles to ≤60 s | `PRICE_HISTORY_READS_ENABLED` | **off** (breaker) | 5 queries | yes | **YES when on — 60 s < 5 min. Second suspect.** |
| `bot.mjs` → `listRecentPricePointsForSymbols` (advisory valuation) | same | same | `PRICE_HISTORY_READS_ENABLED` | **off** (breaker) | 1 batched query | yes | same |
| `/api/cockpit-radar-state` | Cockpit render | 30 s client TTL, one coin | `DB_READS_ENABLED` (master only) | available | 1–2 queries | yes | possible |
| `/api/admin-price-history-signals` | Cockpit view entry (×2 symbols) and RADAR focus | was **every** view entry, now 5 min memo + visibility gate | `PRICE_HISTORY_READS_ENABLED` | **off** (breaker) | 1 query per symbol | yes | possible |
| `/api/admin-price-history` | manual admin | on demand | `PRICE_HISTORY_READS_ENABLED` | **off** (breaker) | 2 queries | no | no |
| `cron-alerts.mjs` → `getPublishedRadar` | native schedule | **every 5 min** | `RADAR_ALERTS_CANONICAL_SOURCE` | off (pre-existing) — **NOT touched: Telegram / ENTRY_READY path** | 1 read | no | **YES when on — 5 min sits exactly on the boundary** |
| `_personal-watch-notifier.mjs` → `getAtomizedMarketContext` | native schedule | **every 5 min** | `PERSONAL_WATCH_TRIGGERS_ENABLED` | off (pre-existing) — **NOT touched: Telegram path** | 1 heavy read | no | **YES when on** |
| `morning-briefing.mjs` | native schedule | 5×/day | none | reads | 1 read | no | no |

---

## Root-cause candidates, ranked

1. **`market-context-collect-scheduled` at `*/3`.** A write cycle every three
   minutes against a five-minute sleep timer. The database can never idle, and
   the cycle itself is the heaviest DB work in the repo. Both the awake-time and
   the per-query cost point here first.
2. **`/api/bot/fleet` polled every 4 s while the Bot or RADAR view is open.**
   `shouldRefreshTradingRadar` throttles the RADAR rebuild to once a minute, but
   once a minute is still six Postgres queries a minute, per open tab, forever —
   and it too is under the sleep threshold.
3. **`cron-alerts` and `personal-watch-triggers`, both `*/5`.** One cheap read
   each, landing exactly on the sleep boundary; between them they can hold the
   database awake on their own. **Deliberately not changed** — both are Telegram
   / ENTRY_READY paths. Env-only recommendation.
4. **`/api/context` at a 30 s memo.** Two reads a minute per tab against a
   collector that publishes every three minutes: the extra reads could not
   return newer data.
5. **GitHub Actions `price-history-collect` every 30 min.** Cadence is fine;
   the write is up to 2,000 rows and the awake window is long.
6. `market-context-retention` hourly — cheap, correct as-is.

---

## What the breaker does

`netlify/functions/_cost-breaker.mjs` is the single decision point. It imports
nothing, reads no env var at import time, opens no connection, and contains no
trading, order, signing, Telegram, ENTRY_READY, RADAR-gate or auth logic. It can
only ever *subtract* work.

**"Disabled" means nothing happens:** no `@netlify/database` import, no
`pool.connect()`, no upstream fetch, no write, no expensive read — and a normal
**2xx** JSON answer that names the reason. Never a 500: an emergency breaker
must not create a retry storm or an error-rate spike.

**Every gate requires the exact string `'true'`.** Unset, blank, `'1'`,
`'TRUE'`, `'yes'` all mean OFF.

| Flag | Default | Guards |
| --- | --- | --- |
| `PRICE_HISTORY_SCHEDULE_ENABLED` | off | the external scheduler entrypoint |
| `PRICE_HISTORY_COLLECT_ENABLED` | off | the collection cycle |
| `PRICE_HISTORY_WRITE_ENABLED` | off | `writeMarketPriceSnapshot` **inside the storage module** |
| `PRICE_HISTORY_PRUNE_ENABLED` | off | `pruneSnapshotsOlderThan` inside the storage module |
| `PRICE_HISTORY_READS_ENABLED` | off | the four price-history readers |
| `MARKET_CONTEXT_COLLECT_ENABLED` | off | the 3-minute collector, at the scheduled entrypoint AND in the coordinator |
| `DB_READS_ENABLED` | unset = narrow flags decide | **master kill switch.** `=false` forces every gate above off, and additionally degrades `/api/context` and `/api/cockpit-radar-state`. Only the exact string `'false'` engages it, so a typo can neither cause nor lift a blackout. |

The write/prune/read gates live **inside `_price-history.mjs`**, not only at the
endpoints, so a caller that forgets a flag — or passes a perfectly good
connection — still cannot write or read.

### Honest degradation

- Missing history is **UNKNOWN**, never a band, never a signal. The advisory
  valuation layer reports `historyUnavailableReason: 'HISTORY_DISABLED'` and
  leaves each candidate's momentum-only reading untouched — nothing synthesises
  a `FAIR` band out of a read that never happened.
- The RADAR price-history corroboration degrades to `status: 'HISTORY_DISABLED'`
  with UNKNOWN reclaim and UNKNOWN absorption and `affectsServerGate: false`. It
  can only ever **withhold** setup corroboration, never grant it, so a disabled
  read cannot promote a candidate — and it is not a rejection either.
- "We declined to read" is reported as `DB_HISTORY_READS_DISABLED`, never as
  `DB_UNAVAILABLE`. Sending the operator hunting a Postgres outage that does not
  exist is its own kind of dishonesty.
- Deferred panels say **deferred**, with the reason. No box spins forever.

### Observability

Response headers `X-Cost-Guard: engaged` and `X-DB-Read-Guard: <REASON>` on
every disabled path, plus `[COST_GUARD] path_disabled` logged once per path per
process (then every 500th) with a counter. Only the four fixed reason codes can
reach a header or a log line — `costGuardHeaders` refuses any other string, so
no arbitrary value (a token, an email, a connection detail) can escape through
them.

Reasons: `PRICE_HISTORY_DISABLED`, `MARKET_CONTEXT_COLLECT_DISABLED`,
`DB_HISTORY_READS_DISABLED`, `COST_BREAKER_DISABLED_PATH`.

### Browser side

`_dbPanelReadAllowed(name, slotId)` in `terminal.js` is stricter than the
existing poll governor: a DB-backed panel read is spent only when the tab is
visible **and** the panel is on screen. It guards non-recurring repaints too — a
repaint caused by a 4 s Fleet tick is not a user asking for fresh history. The
gate errs toward spending a request, never toward starving a visible panel: a
DOM that does not implement `offset*` counts as visible.

Plus: `/api/context` memo default 30 s → **180 s** (the collector's own publish
interval, so no data can be missed; `freshness` is still recomputed per serve),
and a 5-minute memo on the admin price-history card so re-entering the Cockpit
repaints instead of re-reading.

**No new timer, schedule, or cron was added anywhere.**

---

## Recommended emergency production env — NOT applied

These need explicit owner approval. Nothing here has been set.

```
PRICE_HISTORY_SCHEDULE_ENABLED=false
PRICE_HISTORY_COLLECT_ENABLED=false
PRICE_HISTORY_WRITE_ENABLED=false
PRICE_HISTORY_PRUNE_ENABLED=false
MARKET_CONTEXT_COLLECT_ENABLED=false
MARKET_CONTEXT_MULTI_TF_ENABLED=false
MARKET_CONTEXT_FUTURES_ENABLED=false
CONTEXT_READ_CACHE_MS=180000
```

Additionally recommended, because each is a sub-5-minute DB touch the code
changes deliberately do **not** cover (Telegram / ENTRY_READY paths):

```
MARKET_CONTEXT_BACKGROUND_ENABLED=false
MARKET_CONTEXT_RETENTION_ENABLED=false
MARKET_CONTEXT_RADAR_ENABLED=false
PRICE_HISTORY_READS_ENABLED=false
RADAR_ALERTS_CANONICAL_SOURCE=false      # cron-alerts */5 DB read
PERSONAL_WATCH_TRIGGERS_ENABLED=false    # personal-watch-triggers */5 DB read
```

`DB_READS_ENABLED` should stay **unset**. It is the panic lever: setting it to
`false` blanks the canonical terminal (the browser falls back to `/api/markets`,
which touches no database) and should be reserved for "stop the bill this
minute".

### What turning these off costs

- No new canonical market runs: `/api/context` serves the **last published run**
  and labels it `STALE` after six minutes. The scanner falls back to
  `/api/markets` when the read fails, so the terminal stays usable.
- No new RADAR verdicts from the publisher; `/api/cockpit-radar-state` reports
  `RADAR_STATE_EMPTY` / stale rather than pretending.
- No price-history growth, so the history panels and the advisory
  oversold/overbought layer read `HISTORY_DISABLED`.
- With `RADAR_ALERTS_CANONICAL_SOURCE=false`, `cron-alerts` keeps its
  pre-existing non-canonical behaviour — this is an env recommendation about a
  path the code change did not touch, and it should be reviewed against the
  alerting requirement before being applied.

### Also worth doing outside the code

Comment out the `schedule:` block in
`.github/workflows/price-history-collect.yml` (currently `*/30`). It is a no-op
while the flags are off, but it is one less thing that can wake the database if
a flag is ever flipped back by accident. **Not done here** — the task forbids
touching workflow files.

---

## Tests

`tests/cost.breaker.test.mjs` (24) and `tests/cost.breaker-frontend.test.mjs`
(18). They assert cost behaviour and the safety invariants only:

- disabled scheduled collect / prune / market-context return **before** any DB
  connect, upstream fetch, module import or write (every dependency is a
  tripwire);
- a write-disabled path cannot write even when handed a working pool;
- readers return a named reason and **no rows**, without connecting;
- disabled valuation reads `HISTORY_DISABLED`, never `FAIR`;
- `/api/context` is still auth-gated on every unauthenticated shape, and the
  guard is reached only *after* authentication in all four guarded endpoints;
- no disabled path answers 5xx;
- hidden tab / off-screen panel / no selected coin spend no read;
- no breaker import in `cron-alerts`, `telegram`, `personal-alerts`,
  `_personal-watch-*`, `bot.mjs`, `trading-radar`, `_radar-context-publisher`,
  `_market-context-absorb`, `_market-context-store`, or any auth module;
- the set of Netlify native schedules and GitHub Actions crons is unchanged, and
  `package.json` gained no dependency.
