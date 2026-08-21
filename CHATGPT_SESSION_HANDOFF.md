# CHATGPT_SESSION_HANDOFF.md

> **Purpose.** This is the single file the owner uploads into a *fresh* ChatGPT
> conversation to continue work on **Swing Terminal Version X** without pasting
> an old, frozen chat. Treat it as current project memory: business context,
> architecture, guardrails, recent decisions, and priorities.
>
> **Ground truth wins.** If anything here conflicts with newer code / git log /
> logs, the repo is right and this file is stale — say so and I'll refresh it.
>
> **This project is NOT realitni_bot / Hlídač trhu.** There is **no Stripe, no
> billing, no subscriptions, no referral codes, no broker Telegram commands, no
> `/reply` or `/admin_summary` support system** here. If you find yourself
> reasoning about any of those, you have the wrong project — stop and ask.
>
> _**Emergency Netlify cost breaker** (2026-08-19, branch `fix/netlify-emergency-cost-breaker`,
> committed locally, **NOT pushed, NOT deployed, NO env var changed**):_ Netlify
> credits kept draining after the earlier polling hotfix. Bill: 16,462.6 total,
> of which **database compute 9,206.3 credits / 920.63 GB-hours** — the largest
> single line. The database dashboard shows "sleep after 5 minutes" configured
> yet "recent activity" present, so it never sleeps.
>
> **The reframe that matters:** database compute is billed per GB-hour AWAKE, not
> per query. A trivial `SELECT` every three minutes bills the same awake-time as
> a thousand queries. So the cadence of the cheapest recurring touch, not the
> weight of the heaviest query, is the cost driver.
>
> **Root causes, ranked.** (1) `market-context-collect-scheduled` runs on a
> Netlify **native** `*/3` schedule — a full write cycle every three minutes
> against a five-minute sleep timer; it can never sleep, and this is also the
> heaviest DB work in the repo. (2) `/api/bot/fleet` is polled every **4 s** while
> the Bot or RADAR view is open; `shouldRefreshTradingRadar` throttles the rebuild
> to once a minute, but that is still ~6 Postgres queries a minute per open tab,
> also under the sleep threshold. (3) `cron-alerts` and
> `personal-watch-triggers`, both native `*/5`, one cheap read each landing
> exactly on the boundary. (4) `/api/context` memo was 30 s against a collector
> that publishes every 3 min. (5) GitHub Actions `price-history-collect` `*/30`,
> up to a 2,000-row write.
>
> **What was built.** New `netlify/functions/_cost-breaker.mjs` — one decision
> point, imports nothing, reads no env at import, opens no connection, holds no
> trading/order/signing/Telegram/ENTRY_READY/RADAR-gate/auth logic, and can only
> ever subtract work. Every gate needs the env var to be exactly `'true'`;
> `PRICE_HISTORY_{SCHEDULE,COLLECT,WRITE,PRUNE,READS}_ENABLED` and
> `MARKET_CONTEXT_COLLECT_ENABLED` all default **off**, plus a master
> `DB_READS_ENABLED=false` panic lever (only the exact string `'false'` engages
> it). Disabled means *nothing happens* — no `@netlify/database` import, no
> `pool.connect()`, no fetch, no write — and answers **2xx** with a named reason,
> never 5xx (an emergency breaker must not create a retry storm). The
> write/prune/read gates sit **inside `_price-history.mjs`**, so a caller holding
> a working pool still cannot touch the DB.
>
> The scheduled market-context entrypoint now returns before it can even dispatch
> the background function — previously a disabled collector still burned a second
> function invocation every three minutes. `/api/context` memo default 30 s →
> **180 s** (the collector's publish interval, so no data is missed; `freshness`
> is still recomputed per serve). Browser: `_dbPanelReadAllowed` spends a DB read
> only when the tab is visible AND the panel is on screen, guarding poll-driven
> repaints too; deferred panels say *deferred*, never spin. Asset token 6l3 → 6l4.
>
> **Honesty.** A disabled read reports `DB_HISTORY_READS_DISABLED` /
> `HISTORY_DISABLED` — never `DB_UNAVAILABLE` (no phantom outage to hunt) and
> never a value. The advisory valuation layer leaves each candidate's
> momentum-only band alone: nothing invents `FAIR` from a read that never
> happened. The RADAR price-history corroboration degrades to UNKNOWN /
> UNKNOWN with `affectsServerGate:false`, so it can only ever **withhold** setup
> support, never grant it — fail-closed, and not a rejection either.
>
> **Deliberately NOT touched:** `cron-alerts`, `telegram`, `personal-alerts`,
> `_personal-watch-*`, `bot.mjs`, `trading-radar`, `_radar-context-publisher`,
> `_market-context-absorb`, `_market-context-store`, every auth module,
> `netlify.toml`, `package.json`, the migrations, and all GitHub workflows —
> asserted by tests. No new scheduler or cron.
>
> Tests: `tests/cost.breaker.test.mjs` (24) + `tests/cost.breaker-frontend.test.mjs`
> (18). Full suite 2,517 pass / 5 fail — all five are the pre-existing
> uncommitted **Arkham** WIP on this branch, unrelated. Lint 0 errors / 163
> warnings, identical to `main`.
>
> **Owner action needed:** the recommended emergency production env is listed in
> `docs/netlify-cost-breaker.md` and has **not** been applied. Highest-value
> single change beyond the flags: the `*/3` native schedule in
> `market-context-collect-scheduled.mjs` — while `MARKET_CONTEXT_COLLECT_ENABLED`
> is off it is now a pure no-op, but the schedule itself still exists.
>
> _Briefing suggested coins the desk cannot buy — fixed (2026-08-02, local,
> uncommitted, NOT deployed):_ Owner asked for the 2026-08-02 briefing to be
> verified. Its NUMBERS were checked against live Binance data and are correct:
> BTC +0.69% / ETH +0.47% at the stated 05:57:09Z observation (briefing said
> +0.7% / +0.5%), summed volume $9.4B vs $9.3B, median ±1.8% vs ±1.6%, and every
> named mover exists with the stated move (1000RATS +56.6% vs 58.4%, BLESS +49.7%
> vs 49.2%, UAI +39.1% vs 36.7% — drift over the ~35 min between send and check).
>
> **But 11 of the 16 coins it named were FUTURES-ONLY listings** — the entire
> "Strongest momentum" group (1000RATS, BLESS, UAI), two of the three "Closest to
> entry" (AKE, CL), plus BEAT, CAP, BZ, SNDK. This desk is **spot only**; those
> orders cannot be placed. It is a regression from pointing the briefing at the
> canonical context: the Fleet snapshot it used to read came from the local
> worker's SPOT exchangeInfo, while the canonical universe carries both venues and
> a perp can out-rank every spot pair on volume or 24h move.
>
> Fixed: every "coins to watch" group (momentum, flush, RADAR watch, high volume,
> safety-approved) and `topClosest` now draw only from coins with a SPOT row; a
> coin listed on both venues stays eligible even when scored on futures. The count
> excluded is STATED in the message ("Spot-only desk: N market row(s) and M RADAR
> candidate(s) excluded as futures-only listings") — never a silently shorter list.
> Rows with no venue at all (the legacy Fleet path) are unaffected. Replayed over
> the live universe: 441 of 811 rows are futures-only, and the watchlist becomes
> HOME / FRONT / HYPER / BTC / ETH.
>
> Also fixed while replaying: the watchlist deduped on the full SYMBOL, so HOMEUSDT
> and HOMEUSDC both passed and the message printed "HOME" twice with two slightly
> different numbers. It now dedupes on the COIN, across all groups.
>
> _RADAR signal journal — the archive a backtest can honestly use (2026-08-02,
> local, uncommitted, NOT deployed; MIGRATION NOT APPLIED):_ Owner picked "path A"
> — let real RADAR signals accumulate rather than reconstructing them from candles.
>
> **Why it was needed:** nothing remembered what RADAR said. `radar_candidate_state`
> is upserted per (market, symbol) — one row per coin, overwritten every cycle — and
> the per-run history (`radar_run_snapshots` / `radar_run_candidates`) is pruned by
> retention after `MARKET_CONTEXT_RETENTION_RADAR_HOURS` (default **7 days**;
> `MARKET_CONTEXT_RETENTION_ENABLED=true` in production, neither hours flag set).
> Candles can always be re-fetched from a public endpoint; a past verdict cannot.
> That absence is exactly why the backtest MVP had to use a synthetic fixture.
>
> **Sizing, measured on the live universe** (171 candidates/cycle, 480 cycles/day):
> keeping every verdict = ~82,000 rows/day; every actionable row = ~7,200/day;
> recording only STATE ENTRIES = a few hundred/day worst case. So the journal records
> transitions, not snapshots — a coin holding STABILIZATION for six hours is one
> fact, not 120.
>
> **New:** migration `20260802060000_add_radar_signal_journal` (append-only
> `radar_signal_journal`, unique on `(market,symbol,status,computed_at)` so a retried
> publish cannot double-record, `run_id ON DELETE SET NULL`, deliberately NOT pruned).
> Store gains `selectRadarSignalTransitions` (pure), `getRadarStatusIndex`,
> `insertRadarSignals`, `getRadarSignalJournal`, `RADAR_JOURNALED_STATES`
> (DISLOCATION_CONFIRMED and above — WATCH/IGNORE are resting states and would bury
> the archive). The publisher reads the status index BEFORE the state upsert (a
> transition is only knowable against the previous cycle) and records AFTER it; the
> journal is an archive, feeds no gate, and a failure never fails the cycle — it is
> reported as `signalJournalOk:false` rather than looking like "nothing changed".
> The row carries the PLAN (entry zone, stop, hard invalidation, TP1-3) plus evidence
> quality (absorb/reclaim/safety), because a signal without its levels cannot be
> replayed.
>
> **Two more defects found while doing it:**
> - `numberOrNull()` — the helper that writes EVERY RADAR score, level and stop to the
>   database — ran `Number(value)` first, and `Number(null)` is 0. "Not computed" was
>   being stored as a real reading of zero, against the schema's own contract that a
>   NULL score must never read as zero/bearish. 25 call sites. (Fifth instance of this
>   trap in two days.)
> - Every scheduled `morning-briefing` run ended in `NetlifyUserError: Function
>   returned an unsupported value` **after** doing its work — the handler returned the
>   diagnostics object; the runtime accepts only a Response or undefined. Every other
>   scheduled function in the repo already returned one. Also: the provenance log line
>   printed `marketUsable=false` for runs that stopped at a gate and never looked at
>   any data — now logged as "not evaluated".
>
> **Still to do for path A:** apply the migration in production
> (`netlify database migrations apply` — a deploy does NOT apply it), then let the
> archive fill. The reader that turns journal rows into backtest trade plans is
> deliberately NOT built yet: it should be written against real recorded rows, not
> against an imagined shape. Tests: 2216, 0 fail; lint 0 errors.
>
> _RADAR / Cockpit / trading-path audit — 8 defects found and fixed (2026-08-01,
> local, uncommitted, NOT deployed):_ Owner asked for a hard audit of the newly
> built pieces after the stale-briefing find, focused on RADAR, the Cockpit and
> "the bot that trades from RADAR via KuCoin".
>
> **1. There is no KuCoin trading path — at all.** Only
> `scripts/radar/kucoin-public-candles.mjs` (public UTA candle GET, host/path
> allowlisted) and `scripts/radar/run-kucoin-radar-backtest.mjs` (one-shot LOCAL
> CLI). No adapter, credential, order, runner or scheduler exists, and several
> tests actively assert their absence. **RADAR also drives no order path even on
> Binance:** `scripts/auto/auto-trader.mjs` contains zero RADAR references, every
> `AUTO_*` flag is unset in production, and live spot stays hard-locked behind 7
> flags + a single-BTC-symbol micro cap. What RADAR does drive is the Telegram
> ENTRY_READY alert and the UI. The expectation "a coin passes RADAR → the bot buys
> on KuCoin" is not implemented anywhere.
>
> **2. RADAR publish died on EVERY cycle (Postgres 21000).** Live logs: runs
> 3976…4011 all `radar_state_upsert_failed {code:'21000'}` →
> `state_upsert_failed` → `cycle_failed`, `radarOk:false`. Cause: the evaluator's
> candidate object carried no `market`, so `upsertRadarCandidateStates` mapped both
> venues of a dual-listed symbol onto `(spot, SYMBOL)`; `ON CONFLICT (market,symbol)
> DO UPDATE` cannot touch a row twice → cardinality_violation. Both writes shared
> ONE transaction, so the failure **rolled back the run snapshot too**, which is why
> `readCanonicalRadar`'s documented `run_snapshot_fallback` could never fire.
> Consequence: nothing RADAR-related was written for days → canonical alert path
> fail-closed (no ENTRY_READY Telegram at all) and the Cockpit had no verdicts.
> Fixed three ways: candidates now carry `market` (null when the caller's rows have
> no venue — never guessed); `dedupeByVenueSymbol` enforces the conflict key before
> the database sees it (entry-ready first, then higher setup score, collapse
> logged); the state write moved OUT of the run-snapshot transaction so a bad batch
> degrades to a labelled older verdict instead of no verdict. Verified against live
> exchange data: 398 dual-listed symbols, 24 duplicate conflict targets in one real
> batch before the fix → 0 after, both venues preserved (134 futures + 34 spot).
>
> **3. RADAR scored the wrong universe.** `getRadarInputBundle` took the top 1000
> tickers by raw `quote_volume` across ALL quotes — the same bug already fixed in
> `getAtomizedMarketContext`. Measured on the live Binance spot universe (3,670
> stored pairs): only **282 of 1000** rows were USDT/USDC, 718 slots went to
> IDR/TRY/BIDR/JPY/BRL pairs the universe filter rejects anyway, and **774 real
> USD-stable pairs never reached the publisher** (SANDUSDT and hundreds of mid-caps
> — exactly the dislocation population the strategy targets). Now joined to
> `market_instruments` and restricted to `RANKABLE_QUOTE_ASSETS`, with base/quote
> travelling to the evaluator instead of being guessed from the symbol string.
>
> **4. Backtest engine simulated across price domains.** The public-candle MVP
> replayed a SOL fixture (stop 135 / target 145) against BTC-USDT candles: entered
> at 73,939, "hit its take profit" at 144.89, reported **net −499.52 on a 500
> notional (−99.9%) as a take-profit exit**. The CLI was overwriting the fixture's
> `symbolMapping` with whatever market was requested, defeating the mapping
> validation. Engine now vetoes a plan whose levels do not bracket the entry or lie
> outside the dataset's ±50% price band (`levels_not_bracketing_entry`,
> `levels_outside_market_range`) — no position, no PnL; the CLI refuses a fixture
> captured on another market; the report prints `NO TRADE SIMULATED - vetoed: …`
> instead of a bare `trades: 0`; win rate is now measured over CLOSED trades.
>
> **5. Alert staleness bound ignored the canonical source.**
> `loadCanonicalRadarForAlerts` accepted up to `CANONICAL_RADAR_STALE_MS` (6 min =
> 2 collector cycles) but `selectRadarEntryAlerts` was called with no opts and
> re-applied the legacy 120s bound, so a canonical verdict 120–360s old — as fresh
> as a 180s collector can ever make it — was silently `stale_candidate` and every
> alert was suppressed. Bound is now source-aware (`radarStaleBoundMs`).
>
> **6. `Number(null) === 0` — the same trap in three more places** (it also caused
> the briefing's `$0` volumes). Alert gate: `dataFreshnessMs: null` (which is
> exactly "no dated market observation", the live Fleet state for days) became
> "0 ms old = freshest possible" → an undated radar was alertable. Now unknown
> freshness fails CLOSED. `telegramAlertState.cooldownMs: null/''` became a **0 ms
> cooldown**, silently removing the 60-minute per-symbol anti-spam window.
> `MORNING_BRIEFING_HOUR_LOCAL=''` (a normal Netlify state) resolved to hour **0**,
> moving the briefing to midnight. All three now reject null/empty explicitly.
>
> **7. Cockpit asserted a cause it could not know.** A state miss rendered "it is
> outside the measured microstructure budget… a coverage gap, not a rejected setup"
> — but the same 404 is returned when `radar_candidate_state` is EMPTY because the
> publisher is failing (the live case). The endpoint now reports table coverage on
> the miss path (`RADAR_STATE_EMPTY` vs `NOT_SCORED`, with scored count + newest
> age) and the panel renders a publisher outage distinctly from a coverage gap.
> Cache-bust `6k2` → `6k3`.
>
> Everything else audited in the chain held up: `insertAtomicMarketRecords` upserts
> an instrument row for every ticker (so the new JOIN cannot silently drop rows);
> the confirmed-ENTRY_READY gate re-checks every field so the looser `entryReady`
> list in `shapeCanonicalRadarForAlerts` cannot widen it; the Cockpit read reports
> freshness, distinguishes NOT_SCORED from a failed read, and renders UNKNOWN rather
> than 0. Tests: 2205 (was 2182), all pass, `npm run lint` 0 errors. Fixture files
> that were implicitly relying on the fail-open freshness now state their freshness.
>
> _Morning briefing was reporting STALE numbers as today's — fixed (2026-08-01,
> local, uncommitted, NOT deployed):_ Owner reported "the numbers don't add up".
> Verified: they were wrong. The 08:00 Telegram briefing of 2026-08-01 said
> `BTC +0.6% · ETH +0.5% · Regime SUPPORTIVE (score 70) · breadth 53% green`
> plus a five-coin watchlist (ZAMA/ZHIPU/META/MUU/…). BTC's real 24h change at
> that moment was **-1.79%** and ETH **-1.69%** (Binance hourly closes,
> 2026-08-01 06:00Z vs 2026-07-31 06:00Z). **Root cause:** the briefing described
> the legacy Fleet blob — `fleet.autoMarketSnapshot` (posted by the LOCAL worker)
> and `fleet.tradingRadar` (recomputed only when a snapshot lands or a browser
> tab hits `bot.mjs`). Production blob at send time: `autoMarketSnapshot = null`,
> `tradingRadar.updatedAt = 2026-07-30T13:40:01Z`, `source =
> 'no_public_snapshot'`, `marketRegime.btc.change24hPct = 0.58` — i.e. a **1 d
> 16 h old frozen regime block**, printed verbatim as today's tape. The local
> worker had stopped on 2026-07-28 (`logs/local-binance-worker.log`, last line
> `[SNAPSHOT][WARN] … exchangeInfo failed: HTTP 451`). Nothing in the message
> stated an age, so the staleness was invisible; `gatherBriefingData` even
> computed `snapshotAgeIso` and never rendered it.
>
> **Fix (additive, no gate touched):** the briefing now reads the **canonical
> context store** — the same DB the RADAR alert path reads behind
> `RADAR_ALERTS_CANONICAL_SOURCE` (`getAtomizedMarketContext`, injected as
> `loadMarketContext` from `netlify/functions/morning-briefing.mjs`) — and the
> Fleet blob is only a **labelled** fallback. Freshness is checked on two
> independent axes (market observation, RADAR verdict) against
> `MORNING_BRIEFING_MAX_DATA_AGE_MIN` (default **15 min**); an axis past the
> bound or missing is **withheld and named**, never rendered: pulse prints
> `BTC UNKNOWN … Regime UNKNOWN` with the reason, the watchlist prints
> `Withheld — …`, RADAR prints `Candidates tracked: UNKNOWN … not an all-clear`,
> and every message carries a new **section 0 "Data provenance"** (source +
> age + observation timestamp) plus a `⚠ PARTIAL BRIEFING` banner. BTC/ETH now
> come from the canonical ticker row itself and breadth is recounted from those
> rows, so the pulse can never mix ages. Canonical spot+futures duplicates
> collapse to one row per symbol (spot first). `mapCanonicalCandidate` may only
> ever **downgrade** actionability — `ENTRY_READY` comes from the canonical
> `entry_ready` column, never from a payload claim. The Gemini prompt now
> receives a `data_freshness` block and is forbidden from narrating withheld
> numbers. `num()` no longer turns `null` into `0`. Diagnostics + a per-run log
> line report `source / marketUsable / marketAgeMin / reason / radar…`.
> **Consequence to expect:** if the canonical collector is not publishing, the
> morning message will be mostly "withheld" — that is the honest state and the
> log names the broken stage; it no longer invents a tape. Tests: 43 in
> `tests/briefing.morning.test.mjs` (was 28), incl. a replay of the 2026-08-01
> blob asserting the stale numbers cannot appear. Suite green (2156 pass / 0
> fail), `npm run lint` 0 errors.
>
> _Market cap was missing app-wide under the canonical read — now enriched from
> /api/markets (2026-07-27, local, committed, NOT yet on main):_ Reported as "market cap
> missing in the heatmap, on all of them". Root cause is **not** the heatmap: the
> canonical feed is Binance ticker data and `market_ticker_observations` has **no
> market-cap column at all**, so `/api/context` can never supply one and
> `_mapCanonicalTicker` emitted rows without `market_cap` / `market_cap_rank`. With
> `window.RADAR_CANONICAL_CONTEXT_READ = true` (index.html) that blanked market cap
> **everywhere** — heatmap, bubbles, and every market-cap sort — and silently collapsed
> those sorts into arrival order (the canonical query orders by `quote_volume DESC`).
> The heatmap made it worse by *labelling* that order "MC rank #1→#N".
>
> New `_enrichCanonicalWithMarketCap(rows, authHeaders)` runs inside
> `_fetchCanonicalMarkets`: one extra GET to the legacy CoinGecko-backed
> `/api/markets`, matched by base symbol, copying `market_cap` + `market_cap_rank`.
> `market_cap: 0` (how `/api/markets` marks a Binance-only listing with no CG entry) is
> treated as UNKNOWN and **not** copied — absent, never 0. Outcome is recorded on
> `window.__marketCapEnrichment` `{ok, matched, total, reason}`; a failure logs, raises a
> Toast, and leaves rows absent.
>
> The heatmap now derives its ordering from actual coverage: any market cap → sort by
> rank with the capless coins **last** and the header saying how many; zero coverage →
> sort by 24h volume with an **amber** header naming the reason ("feed carries none" /
> "/api/markets failed: HTTP 503"). Missing market cap renders as "no data" in the tile
> tooltip and the detail panel, not as a formatted value. Owner chose enrichment over a
> DB/collector change and chose to keep market cap in the tooltip/detail rather than
> adding a third line to the tiles. The durable fix — carrying market cap in the
> canonical context itself — is still open. Cache-bust `6j7` → `6j8`. Tests: two
> behaviour tests for the enricher (0-is-unknown, failure recorded) plus an
> ordering-honesty test; suite green (1914 pass / 0 fail / 26 skipped).
>
> _HEATMAP redesigned to the v4 tile grid (2026-07-27, on `main`, deployed):_
> The canvas treemap renderer is gone. The HEATMAP tab now renders the **terminal-v4
> design**: a uniform CSS-grid of tiles (symbol above, 24h % below), colour = 24h
> change on v4's four-band palette, ordered by market-cap rank #1 → #N, row-major.
> `_hmGridLayout` / `_hmDraw` / `_hmHit` / `_hmEnsureChrome` and the ResizeObserver
> were deleted — the grid reflows itself and the browser handles scrolling.
> Everything the canvas version offered is kept: search, Top-100/250/500/1000,
> density (roomy/normal/compact → cell + row size), hover tooltip (`.hm-tip`, now
> a child of `#v-heatmap` so the grid's innerHTML rewrite can't wipe it), click →
> `showHeatmapDetail`, and a selection border that survives redraws.
> Tile rows are **explicitly sized** (`grid-auto-rows: var(--hm-row)`) rather than
> `auto` — inside the fixed-height scrolling flex child, auto rows collapsed to a
> single clipped line. Observability: "no market data loaded" (feed never arrived,
> amber + `console.warn`) is now a *different* state from "no coin matches <query>",
> and a missing `price_change_percentage_24h` renders as `—` / "no data" instead of
> `Number(null) || 0` painting it as a real flat 0.0% cell — same fix applied to the
> tooltip and the detail panel. Cache-bust token bumped `6j6` → `6j7`. Tests: the
> canvas-internals assertion in `tests/version-x.test.mjs` was replaced by three tests
> covering the DOM cell markup / escaping / UNKNOWN handling, the touch-pointer
> tooltip guard, and the mobile cell floor; token test updated. Full suite green
> (1910 pass / 0 fail / 26 skipped). No push, no deploy.
>
> _Mobile check (measured in-browser, not estimated):_ 375 px → 5 columns of 68×46 px
> tiles; 320 px → 4 columns of 72×46 px; normal 58×40, compact 48×36. No clipped
> symbols or percentages at any density, no horizontal page overflow, the grid scrolls.
> Two touch fixes came out of it: the hover tooltip is **suppressed on `(hover: none)`
> pointers** (a touch synthesises `mousemove` but never `mouseleave`, so it used to park
> over the tiles) and any tap clears it; the detail panel's ✕ went from a ~22 px to a
> 35×38 px hit area. The panel itself fits at 320 px (280 px wide, ~32 % of the screen)
> and its GO TO SCANNER button is 247×38.
>
> _Venue keying fixed — spot and futures are no longer interchangeable (2026-07-27,
> local-only, uncommitted):_ **Closes the long-standing "known gap, deliberately NOT
> fixed".** Spot and futures are different books, different flow, different depth, but
> the rolling snapshot and the candle snapshot were both keyed by SYMBOL alone. Two
> consequences: (a) at write time one venue's measurement silently replaced the
> other's, and (b) at read time a candidate could be handed the OTHER venue's data —
> a **wrong** execution/reclaim reading, not a missing one. The store had been working
> around (a) with `DISTINCT ON (symbol)`, whose own comment admitted the cause.
>
> Both snapshots now accept venue-qualified keys (`"spot:BTCUSDT"`) alongside bare
> ones, via new exports `rollingKeyFor`/`parseRollingKey`
> (`rolling-microstructure-snapshot.mjs`) and `klinesKeyFor`
> (`klines-snapshot.mjs`). Bare keys stay fully supported — the futures producer and
> the legacy static snapshots emit them, and dropping those would silently lose the
> feeds. `normalizeRow` now preserves `market`, which is what lets a lookup refuse.
>
> Lookups are venue-scoped and **fail closed**: `getFreshRollingMicrostructureForSymbol`
> and `getFreshClosedKlinesForSymbol` take `opts.market`, and when the requested venue
> was not measured they return **null → UNKNOWN** rather than substituting the other
> venue. A bare-keyed row is usable only if it does not claim a different venue. With
> no venue requested and two venues present, the result is null rather than a guess.
> `withRollingMicrostructureSnapshot` and `withComputedStructuralReclaim` pass the
> candidate's own `market.market`.
>
> `getRadarInputBundle` drops `DISTINCT ON (symbol)` — spot and futures are now
> distinct measurements and neither has to be discarded, so `topN` bounds
> MEASUREMENTS rather than symbols (which is what the collector's per-venue budgets
> already produced). `buildKlinesSnapshot` keys by venue too. Coverage diagnostics
> now report each venue under its own key, so a dropped venue can no longer hide:
> `DISTINCT_SYMBOLS` 2 / `COLLAPSED_DUPLICATES` 0 where it used to be 1 / 1.
>
> Tests: new `tests/radar-venue-keying.test.mjs` (9 cases, including the exact bug —
> a spot request against a futures-only snapshot returns null). Four existing tests
> updated to the intentionally-changed keys/behaviour, one renamed from "reported as a
> collapse" to "kept as separate measurements". Full suite green (1881 pass / 0 fail /
> 26 skipped). No push, no deploy.
>
> _Cockpit wired to the canonical DB (2026-07-27, local-only, uncommitted):_ The
> Cockpit previously read **no database at all** — its only endpoints were the
> personal-watch ones, so it worked off whatever copy of the RADAR candidate the
> scanner happened to hold in the browser. New authenticated, GET-only, read-only
> route **`/api/cockpit-radar-state`** (`netlify/functions/cockpit-radar-state.mjs`)
> answers exactly one question — the server's current RADAR verdict for ONE coin —
> straight off the `(market, symbol)` primary key, instead of making the Cockpit pull
> the whole 2000-ticker `/api/context` payload.
>
> Boundaries: `OPTIONS` 204 before auth or DB; non-GET 405; unverified/failed/
> unimportable auth 401 before the store loads; malformed symbol **400** (validated
> `^[A-Z0-9]{2,32}$` at the boundary *and* in the store); an unsupported `market`
> value is dropped rather than trusted; DB failure 503. A coin the server has not
> scored is a distinguishable **404 `NOT_SCORED`** with `found:false` and no `state`
> key — never an empty verdict. Response is an explicit column projection (scores,
> reclaim, absorb, full trade plan) plus `computedAt`/`ageMs`/`freshness`
> (FRESH ≤ 2 collector cycles, else STALE, `UNKNOWN` on an unusable timestamp) — the
> stored `payload` blob is deliberately NOT echoed.
>
> Frontend: new "Server RADAR verdict" block in the Cockpit RADAR focus card
> (`_cpRadarStateSlotHtml` / `_cpRadarStateInnerHtml` / `_refreshCockpitRadarState`),
> 30s cache, 6s abort timeout, one in-flight read per coin. **"Not scored" and "read
> failed" render as different facts** — the former says it is a coverage gap and
> explicitly *not* a rejected setup, the latter says it is a failed read and
> explicitly *not* a "no setup" result. An uncomputed score renders `UNKNOWN`, never
> `0`. Staleness is stated, not left to inference. Display-only: it triggers no
> import, no form fill, no trade action. Cache-bust **`?v=6j2` → `?v=6j3`**.
>
> Tests: `tests/cockpit-radar-state.test.mjs` (11 cases) +
> `tests/frontend.cockpit-radar-state.test.mjs` (6 source guards); full suite green
> (1872 pass / 0 fail / 26 skipped). No push, no deploy.
>
> _Atomized per-symbol RADAR state replaces the run-keyed read (2026-07-27,
> local-only, uncommitted):_ **Fixes the "Strict Absorb OK, then DATA OFF a minute
> later" oscillation.** `radar_run_snapshots` is keyed
> `run_id PRIMARY KEY REFERENCES market_collection_runs`, and the canonical read
> resolved "newest published market run → that run's RADAR result". The collector
> marks a run published at the END of collection
> (`_market-context-store.mjs` `completeCollectionRun`) and only THEN scores it
> (`market-context-collect-background.mjs:38-43`), so between those two moments the
> newest run existed with no RADAR row and the read returned `status: 'PENDING'`.
> The terminal renders canonical only on `READY` and otherwise **silently** fell back
> to the legacy browser-computed Fleet radar, which has no server rolling
> microstructure — hence "DATA OFF" on every row. Both readings were true, about
> different runs.
>
> **New migration `20260727100000_add_radar_candidate_state`** — atomized, indexed,
> one row per coin: `PRIMARY KEY (market, symbol)`, upserted in place, carrying its
> own `computed_at` + `observed_at`. `run_id` is provenance only
> (`ON DELETE SET NULL`), never a dependency, so retention pruning a run can neither
> delete nor orphan current RADAR state. All 12 spec scores, reclaim/absorb status,
> and the full trade plan (entry zone, stop, hard invalidation, TP1–3, position size)
> are real columns, not JSONB; the whole evaluator output is still kept in `payload`
> so nothing is lost. Six indexes: `computed_at DESC`, `symbol`, `status`,
> `(setup_score DESC, execution_score DESC)`, a **partial** index
> `WHERE entry_ready` for the alert path's hot query, and
> `(strict_absorb_confirmed, absorb_status)`.
>
> New store exports: `upsertRadarCandidateStates` (batched multi-row upsert),
> `getRadarCandidateStates` (universe, best setup first), `getRadarCandidateState`
> (**single coin — the read the Cockpit needs**, symbol validated `^[A-Z0-9]{2,32}$`
> before it reaches the DB, spot preferred when a symbol trades on both venues).
> `getAtomizedMarketContext` and `getPublishedRadar` now read via a new
> `readCanonicalRadar`: candidates + freshness from the atomized state, aggregate
> diagnostics (pipeline / funnel / provider status / regime) still from the newest run
> snapshot, which may belong to an earlier run — reported as `diagnosticsRunId`
> rather than hidden, and no longer able to force the whole read to PENDING. The
> publisher writes BOTH (run-keyed history + atomized state) and **fails loudly** if
> the state write fails, because the read path serves that table.
>
> Fail-closed guarantees, each test-covered: a status the V1 machine never produced
> is stored as `'UNKNOWN'` (never coerced into a neighbouring state, never dropped —
> that would lose the coin); missing scores stay `NULL` → UNKNOWN, never `0`; an
> unparseable `POSITION_SIZE_GUIDANCE` stores `NULL` **not** `0`, because `0%` is
> itself a real verdict (`RISK_OFF_BLOCKED`); an empty candidate set writes nothing
> rather than clearing the table; a DB failure returns `DB_UNAVAILABLE` and never
> throws into the publisher.
>
> **Frontend (display-only):** the canonical→Fleet switch is no longer silent — a new
> `_radarLegacySourceNoticeHtml` banner names the active source and the reason, and
> states that "DATA OFF" there is a **missing data source, not a rejected
> absorption**; the switch is also `console.warn`ed. A failed `/api/context` now
> replaces `window.__canonicalContext` with an explicit `failed` marker instead of
> leaving the previous cycle's object rendering as current. Cache-bust
> **`?v=6j1` → `?v=6j2`** (all 11 assets).
>
> Tests: 9 new store cases + 3 new frontend source guards; full suite green
> (1855 pass / 0 fail / 26 skipped). No scoring, gate, threshold, ENTRY_READY,
> Telegram, or trading change. `radar_run_snapshots`/`radar_run_candidates` are
> deliberately untouched — they remain the per-run funnel history.
> **A push auto-applies this migration to production.** No push, no deploy.
>
> _Microstructure budget ranked by dislocation, not liquidity (2026-07-27,
> local-only, uncommitted):_ **Root cause of "RADAR never produces ENTRY_READY".**
> The measurement budget was allocated as `rankByQuoteVolume(tickers).slice(0, topN)`
> — purely by liquidity. Order-book support + flow confirmation are 25% + 25% of
> `EXECUTION_SCORE`, so a coin with no measurement cannot reach the 65 gate. That
> spent every slot on the largest majors, which are precisely the coins that rarely
> produce the setup RADAR looks for (2–3× ATR dislocation + long flush), while the
> mid-caps that actually flushed sat at rank #100–500 and were **never measured** —
> so the entry branch was structurally dead for exactly the population the strategy
> targets. The RADAR was not mis-scoring; it was scoring a population that cannot
> contain the setup.
>
> New pure `rankMicrostructureBudget(tickers, { topN, poolSize, majorSlots })` in
> `_binance-market-context-source.mjs` splits the budget inside the liquid pool:
> `majorSlots` (default 20) reserved for top-liquidity so BTC/ETH context never
> drops, every remaining slot to the deepest 24h **drawdowns**. Only negative moves
> earn a dislocation slot (a pump is not this setup); a missing/unusable
> `priceChangePercent` counts as zero dislocation, so it stays eligible via the
> liquidity slots but never displaces a measured real drop. `poolSize` (default 400)
> bounds tradeability — a pair the universe filter would reject never consumes a
> slot. Deterministic (depth, then symbol), no duplicates, no new external fetch:
> `priceChangePercent` is already in the 24h ticker payload, so this costs **zero
> extra requests**. `rankByQuoteVolume` is unchanged and still ranks multi-timeframe.
> Every cycle now logs `[MARKET_CONTEXT] microstructure_budget`
> (measured / poolCandidates / withDrawdown / deepestDropPct) — the difference
> between "RADAR found no setup" and "RADAR could not have found one".
> New env: `MARKET_CONTEXT_MICROSTRUCTURE_POOL_SIZE`,
> `MARKET_CONTEXT_MICROSTRUCTURE_MAJOR_SLOTS` (both optional, defaults above).
> **Owner action for rollout: set `MARKET_CONTEXT_MICROSTRUCTURE_TOP_N=200`** (was
> effectively 5). Tests: 7 new cases in `tests/binance-market-context-source.test.mjs`;
> full suite green (1840 pass / 0 fail / 26 skipped). No gate, threshold, scoring,
> ENTRY_READY, Telegram, or trading change. No push, no deploy.
>
> **Corrected earlier claim:** a global provider-level `trusted` veto was suspected
> of discarding every symbol's microstructure. It does **not** fire in the publisher
> path — `buildCollectorRollingSnapshot` always supplies `trusted: true`
> (`collector-absorb-bridge.mjs:137`) and the publisher's staleness is
> self-referential, so `trusted` resolves true. Per-symbol `strictReady` is the real
> gate and works (live: `STRICT_READY 47/50`).
>
> **Architecture status against the owner's stated target** (one atomized indexed DB;
> scanner ingests into it and reads indicators from it; RADAR computes/watches
> factors incl. reclaim + absorb from it; Cockpit reads it to work a selected coin;
> the bot later reads it too):
> - **Ingest + storage: DONE.** `20260724190000_replace_context_snapshots_with_atomic_market_records`
>   created 6 atomized tables with 11 indexes (`market_instruments`,
>   `market_ticker_observations`, `market_candles_1m`, `market_order_book_levels`,
>   `market_agg_trades`, `market_microstructure_measurements` + `absorb` JSONB).
> - **RADAR layer: DONE** as of the entry above (atomized per-symbol state).
> - **Scanner read: PARTIAL.** It reads the DB only when
>   `RADAR_CANONICAL_CONTEXT_READ` is on; otherwise `/api/markets`, which is live
>   Binance/CoinGecko, **not** the DB. The fallback is now visible, not silent.
> - **Cockpit read: DONE** — `/api/cockpit-radar-state` + the "Server RADAR verdict"
>   block read the atomized `(market, symbol)` row for the selected coin.
> - **Bot read: NOT WIRED** (`bot.mjs` does not import the market context store).
>   Deliberately deferred by the owner.
>
> **Still open:** (1) The publisher's rolling-snapshot freshness is self-referential
> (`updatedAtMs === nowMs === rollingNowMs` in `_radar-context-publisher.mjs:132-141`
> against the `stale` test in `rolling-microstructure-snapshot.mjs:118`), so the
> snapshot-level staleness check cannot fail by construction; per-row
> `validateTrustedRollingRow` is the real gate and does work.
>
> _GROUND-TRUTH COMMIT STATE (2026-07-27, refreshed):_ Active branch is
> **`integrate/canonical-context`**. The RADAR plumbing rebuild above is committed
> as five commits on top of `91de7ab`: `ada8448` (budget by dislocation),
> `182df98` (venue keying), `3b681ce` (atomized RADAR state + migration),
> `87826fc` (Cockpit DB read + visible source fallback), plus `596b768` docs.
>
> **MERGED AND DEPLOYED (owner-approved).** `origin/main` moved
> `cf426d3` → **`547f79c`** via a `--no-ff` merge of the whole canonical-context
> line (45 commits). Local `main` had 13 divergent pre-reconcile commits; `git
> cherry` proved every one patch-equivalent to a branch commit and
> `backup/pre-reconcile-20260724` preserves them, so `main` was reset to
> `origin/main` before merging. The merged tree is byte-identical to the tested
> branch tree, and the full suite passed on `main` before the push
> (1883 pass / 0 fail / 26 skipped).
>
> **Four additive migrations apply on this deploy:**
> `20260724200000_add_radar_run_results`,
> `20260724220000_add_ticker_multi_timeframe`,
> `20260726180000_add_microstructure_absorb`,
> `20260727100000_add_radar_candidate_state`. All are
> `CREATE TABLE/INDEX/ADD COLUMN … IF NOT EXISTS`; no `DROP`, `TRUNCATE`,
> `DELETE`, or `ALTER COLUMN`, and columns added to existing tables are nullable.
> Every migration blob was verified LF in the commit (a CRLF copy blocks Netlify
> deploys by content hash). **Not yet verified: the migration SQL has never
> actually executed — tests mock the DB, so Netlify applying it on this deploy is
> its first real run.**
>
> Still-uncommitted working-tree edits, unrelated: `.gitignore` (ignore
> `artifacts/backtests/`), `docs/kucoin-architecture.md` (+§14 KuCoin
> public-candle backtest MVP), `.claude/settings.local.json`. **Supersedes every
> older "Current local state" line below that still claims `origin/main =
> d4baac1` / `0 4` / `handoff correction` — those are stale.**
>
> _Terminal restore + collector staleness + tracked-coin notifications
> (2026-07-27, branch `integrate/canonical-context`, pushed):_
>
> **Four canonical-path handoff defects fixed (`893e957`)** — all in what the
> publisher hands the terminal, not in the data. (1) **Safety blank** on nearly
> every coin: the scanner reads `row.safetyStatus` but canonical rows are raw
> atoms with none; `context.mjs` now annotates each ticker via the pure I/O-free
> classifier (SAFE, basis CEX_LISTING), leaving rows unannotated on classifier
> failure rather than failing the read. (2) **1h/4h/12h/7d missing beyond the
> first 300 coins**: the multi-timeframe budget was bounded at 300 while the
> terminal lists ~1000; ceiling raised and those requests now share the SAME
> per-venue pacer as the microstructure reads (two independent pacers would each
> assume the whole allowance). (3) **"No reclaim data" everywhere**: the reclaim
> evaluator looks up source levels under scanner field names `high_24h`/`low_24h`
> but the publisher emitted only `highPrice`/`lowPrice`
> (RECLAIM_DATA_SOURCE_MISSING → SOURCE_DATA_PRESENT once aligned). (4) **Strict
> absorb "DATA OFF" everywhere**: the RADAR staleness check `updatedAtMs > now +
> 60s` used `now` = run START while the data completed ~94s later, so the
> snapshot marked itself stale.
>
> **Two more collector-staleness root causes (same class, one level down):**
> `fa3ab14` — absorption was computed against the run's single `observedAt`
> (stamped only after every symbol is read), so a symbol fetched at the start of
> a paced multi-minute cycle had all its trades fall outside the window, empties
> the sample, and `computeRollingAbsorption` returned nothing (live: STRICT_READY
> → 0, every absorption field missing). Each microstructure row now carries
> `fetchedAtMs` and is measured against ITS own read time; the count of symbols
> whose read time differs materially from cycle end is reported. `1b369d9` —
> `validateTrustedRollingRow` tolerates 60s skew but the paced ~94s cycle made
> end-of-cycle measurements newer than the run's `observed_at`, rejecting every
> symbol as `measurement-stale`; the rolling snapshot is now validated against
> the NEWEST measurement (the moment its data was actually complete). Neither
> surfaced while a cycle took ~20s.
>
> **Tracked-coin awareness notifications (`91de7ab`)** — new `BIG_MOVE` /
> `TAKE_PROFIT` / `STOP_LOSS` Telegram path for watched coins, deliberately a
> SEPARATE scheduled run from `personal-alerts.mjs` so it can never weaken the
> entry gate (that path stays the confirmed-`ENTRY_READY`-only sender). New
> files: `_personal-watch-notifier.mjs`, `_personal-watch-triggers.mjs`,
> `personal-watch-triggers-scheduled.mjs`. **Off unless
> `PERSONAL_WATCH_TRIGGERS_ENABLED` is exactly `'true'`.** A watch record holds
> only `{ symbol, addedAt }` — no stored entry price — so TP/SL levels are read
> from the canonical RADAR candidate and the message says *"level published by
> RADAR"*, never *"your position hit take profit"*. Fail-closed throughout: no
> price / no published level → no trigger; BIG_MOVE skips an absent window rather
> than reading 0%; TP reports the highest level reached (never one message per
> level, never resent); a failed send is not recorded as delivered. Scheduled
> **natively by Netlify** (not an external workflow). Covered by
> `tests/personal-watch-notifier.test.mjs` + `tests/personal-watch-triggers.test.mjs`.
>
> **Docs (no runtime):** `5bf1f3b` adds `docs/trade-execution-architecture.md`
> (proposal grounded in the existing local key-holding worker / worker protocol /
> execution intents / sizing table — nothing built or wired, every gate
> fail-closed). Uncommitted `docs/kucoin-architecture.md` §14 records the
> local-only KuCoin public-candle backtest MVP (Spot + fixedNotional only,
> Futures deferred, artifacts Git-ignored).
>
> _Universe scale-out + alert path (2026-07-26 evening, branch
> `integrate/canonical-context`):_ Goal restated by the owner: an atomized DB
> with indexes, RADAR evaluating the WHOLE universe, and any coin meeting the
> conditions becoming ENTRY_READY and firing a Telegram alert — not just BTC/ETH.
>
> **Why a small universe made the goal unreachable:** EXECUTION_SCORE is 25%
> order-book support + 25% flow confirmation, so a coin with no measured
> microstructure can never reach 65 and therefore never becomes ENTRY_READY.
> Measuring five symbols made the entry/Telegram branch structurally dead for
> every other pair.
>
> **What was rebuilt.** Absorption is computed at COLLECTION time (raw trades and
> candles are already in memory) and stored as one derived `absorb` JSONB per
> measurement. The publisher previously rebuilt it by reading raw trades and
> candles back PER SYMBOL — two round trips each, i.e. 1000 for a 500-symbol
> universe. Candles for all measured symbols now come from one windowed query.
> Raw trades/book levels are kept only for a top-N audit sample
> (`MARKET_CONTEXT_RAW_SAMPLE_TOP_N`, default 10); every measured symbol still
> stores its derived row. The collector runs as a Netlify BACKGROUND function
> (~15 min vs the 30s scheduled ceiling) behind
> `MARKET_CONTEXT_BACKGROUND_ENABLED`; the scheduled function only dispatches to
> it with the worker token (constant-time compare, fail-closed, never logged).
>
> **Binance weight is the real ceiling, not time.** 9 weight per measured symbol
> (klines 2 + depth 5 + aggTrades 2) against 6000/min per IP. Concurrency bounds
> parallelism, not rate, so a rolling-window pacer per venue
> (`MARKET_CONTEXT_WEIGHT_BUDGET_PER_MIN`) now admits work only while the last
> 60s stays under budget. The first 400-symbol cycle returned
> `dataStatus: 'partial'` — the ceiling is empirical, not theoretical.
>
> **Measured results:** 50/venue → `STRICT_READY 47/50`, `absorbMode STRICT`,
> full cycle 23.8s. Depth baselines self-heal in one cycle (a run only has N-1
> depth for symbols the PREVIOUS run measured), and the shortfall is logged.
>
> **Two further defects found and fixed:**
> - `validateRollingTrades` treated OUT-OF-WINDOW trades as corruption. An
>   exchange returns the last N trades where N is a COUNT, so on a quieter symbol
>   that tail predates the window as a matter of course. Both
>   `computeRollingAbsorption` and `tradesValidated` voided the whole measurement
>   over it (live: 4 of 5 symbols rejected). `malformed` is now separate from
>   `outOfWindow`; malformed still voids the sample.
> - `cron-alerts` resolved to a plain object, which Netlify v2 rejects AFTER the
>   cycle has run — and then RETRIES. Three invocations in five seconds were
>   observed for one tick; harmless only because Telegram is hard-disabled, but
>   with sending on those are duplicate-alert attempts.
>
> **Alert path now reads canonical** behind `RADAR_ALERTS_CANONICAL_SOURCE`
> (default OFF). It previously decided from `fleet.tradingRadar`, written by a
> BROWSER session against `/api/markets` — so alerts depended on someone having
> the terminal open, and ran on different data than the canonical RADAR. Enabled
> means authoritative: if the canonical read fails, NOTHING is sent (fail-closed)
> rather than falling back to a snapshot canonical never agreed with. Its
> freshness bound is `CANONICAL_RADAR_STALE_MS` = 2 collector cycles; the 120s
> browser-feed threshold would mark a 3-minute publish stale exactly when fresh.
> Every other entry gate is untouched and applies identically.
>
> **Scanner showed only "DEX" coins** for two independent reasons, both fixed:
> `_mapCanonicalTicker` put the PAIR in `symbol`, but `isOnBinance()` falls back
> to looking up `symbol + 'USDT'` → "BTCUSDTUSDT" matched nothing, so every
> canonical row including Bitcoin rendered as off-Binance with no order book.
> And the READ path still ordered by raw `quote_volume` across mixed quotes, so
> IDR/TRY pairs filled the list. Rows now carry base asset + pair +
> `binance_available`; the read joins `market_instruments` and restricts to
> USD-stable quotes. Ticker limit raised to 1000.
>
> **Still OFF / open:** `RADAR_ALERTS_CANONICAL_SOURCE`, `RADAR_TELEGRAM_ENABLED`,
> universe still stepping up (50 → 200 → target full set), branch not merged to
> `main`. Known gap: `withRollingMicrostructureSnapshot` looks rolling rows up by
> SYMBOL with no venue check, so a spot candidate can receive futures
> microstructure — fixing it means re-keying the absorb pipeline on
> `market:symbol`.
>
> _Canonical-context absorb coverage fixes (2026-07-26, deployed, branch
> `integrate/canonical-context`):_ STRICT absorb was confirming for almost no
> symbol. Two independent root causes, both found by first making the failure
> visible rather than by raising limits.
>
> **(1) The bounded budgets ranked by exchange rate, not liquidity.** 24h
> `quoteVolume` is denominated in the QUOTE asset, and both the microstructure
> top-N and the multi-timeframe top-300 sorted that raw number across mixed
> quotes. IDR (~16k/USD) and TRY pairs therefore outranked every major: a live
> run measured `BTCIDR, USDTIDR, USDCIDR, EULTRY, BTCUSDT`. Those pairs are
> outside the RADAR universe (`QUOTES = USDC|USDT`), so 4 of 5 measured symbols
> could never become candidates. `rankByQuoteVolume` now ranks USDT/USDC-quoted
> pairs only; every ticker is still STORED, only the measurement budget is
> ranked. Coverage went 2/5 junk symbols -> 4/5 majors on the next cycle.
>
> **(2) STRICT trust was all-or-nothing.** `normalizeRollingMicrostructureSnapshot`
> folded per-row `strictReady` into the snapshot-level `trusted` flag, so ONE
> thin symbol declared the whole PROVIDER untrusted and discarded every other
> symbol's genuine measurement. The Absorb spec separates these:
> `ABSORB_PROVIDER_UNTRUSTED` / `ABSORB_DATA_STALE` are global provider
> verdicts, while a symbol with incomplete data is `ABSORB_DATA_UNAVAILABLE`
> with ITS missing fields. `trusted` is now the provider verdict alone. STRICT
> remains fail-closed **per symbol**: a row failing `validateTrustedRollingRow`
> has every trusted field stripped and `strictReady=false`, and the RADAR gate
> (`radarDataQuality`) already required `rollingMicrostructureTrusted` on the
> individual candidate. `ABSORB_MODE` no longer reads STRICT off the provider
> flag — a live provider whose every symbol failed is DEGRADED, not ONLINE.
>
> **Observability added (was the blocker to diagnosing any of this):** the
> publisher logs `[RADAR_ABSORB] coverage` and persists `ABSORB_COVERAGE` into
> `providerStatus` — the supplied -> measured -> distinct -> ready funnel plus
> the validator's per-symbol reason. Rejection reasons now name the failing
> floor/flag (`samples-thin:aggTrades`, `validation-incomplete:klinesValidated`)
> instead of a bare category. A dropped multi-timeframe batch is logged instead
> of `catch { continue }`.
>
> **Known gap, deliberately NOT fixed:** `withRollingMicrostructureSnapshot`
> looks up rolling rows by SYMBOL only, with no venue check, so a spot candidate
> can receive futures microstructure. Fixing it means re-keying the absorb
> pipeline on `market:symbol`. The store-side bundle query now returns one row
> per symbol (deepest venue) so at least no topN slot is wasted on a duplicate.
> Microstructure budget stays at 5 by owner's call, so coverage is effectively
> BTC/ETH plus a stablecoin pair.
>
> _RADAR Focus Candidate human-readability redesign (2026-07-23, local-only on
> top of `c537a47`):_ UI/UX-only restructure of the Trading RADAR Focus card so
> a human reads the trade state in ~10 seconds. No backend scoring, strict
> Absorb, reclaim, ENTRY_READY, Telegram, or producer change; no new fetch (the
> new sections reuse already-computed candidate fields). The default view is now
> a **decision hierarchy**: (1) a dominant decision card `SYMBOL — WATCH ONLY` +
> `Do not enter now.` + one-line "Main reason"; (2) a plain-language **gate
> checklist** with SIX rows — Reclaim / Absorption / Strict Absorb / Live market
> data / Safety / Telegram — where **"Absorption: Not confirmed"** (the concept)
> is a DISTINCT row from **"Strict Absorb: Server data unavailable"** (the data
> layer), Live market data is explicitly **"Available, advisory only"**, and
> Telegram reads **"No — entry gates not confirmed"**; (3) a single **Next
> action** with the fixed caution *"Do not treat live orderbook OK as an entry
> signal."*; (4) **Key levels** (entry/stop/invalidation/targets/timeframe).
> Everything admin/debug/raw — the STALE banner, Trade Readiness, operator
> summary cards, backend + admin price-history, live-microstructure slot,
> pressure zones, a new compact **data-source status matrix**, and all the raw
> Provider/Absorb/Reclaim/Score panels — is now nested inside ONE collapsed
> **`<details class="radar-technical-details">` "Technical details"** accordion
> (per-symbol remembered toggle; the old `radar-advanced-diagnostics` block is
> kept as the nested "Raw diagnostics" group). New helpers:
> `_radarHumanDecisionHtml` / `_radarGateChecklistHtml` / `_radarNextActionHtml`
> / `_radarKeyLevelsHtml` / `_radarDataSourceMatrixHtml` (+ pure
> `_radarReclaimGate` / `_radarReclaimPlain` / `_radarSafetyGate` /
> `_radarDecisionReason`). Matrix table: `Absorb.` column relabeled **"Strict
> Absorb Gate"**, a STALE value now DISPLAYS as **"DATA OFF"** with tooltip
> *"Rolling producer not running. This does not mean absorption is confirmed or
> rejected."* (the `_fleetRadarAbsorbCompact` helper still RETURNS `STALE` —
> only the cell display maps), and the Reclaim NOT-STARTED tooltip now says
> *"Price has not reclaimed the zone yet."* — no value/filtering logic changed.
> Cache-bust **`?v=6i3` → `?v=6i4`**. Tests: new
> `tests/frontend.radar-human-ux.test.mjs` (16 executable checks of the four
> helpers + structure + matrix relabel + display-only guarantee); updated the
> `Raw diagnostics` label guard in `frontend.trading-radar-panel` and the
> `6i4` token guard in `frontend.live-microstructure`. Full suite green (1678
> pass / 0 fail / 26 skipped). No push, no deploy.
>
> _RADAR Focus cleanup + rolling microstructure core (2026-07-23, local-only):_ Follow-up UX cleanup keeps the same display-only boundaries but makes gate status text emoji-free and explicit: `WAIT`, `NO`, `DATA OFF`, `ADVISORY`, `PASS`, or `UNKNOWN`. The strict-Absorb row now says **"Rolling producer not running"** when server rolling data is unavailable; browser/live market data remains **"Available, not an entry signal"**. Technical details remain collapsed by default; the existing delegated, escaped `data-symbol` toggle path is retained. Cache-bust is **`?v=6i4` -> `?v=6i5`** for every versioned asset. A new pure, local-only `scripts/radar/rolling-microstructure-core.mjs` validates/sorts aggTrades and computes fail-closed rolling fields for future strict-Absorb producer work. It has no imports, network, endpoint, scheduler, env, Telegram, or trading wiring, and does **not** make real strict Absorb live. Production still needs a reviewed producer wrapper/runner, `BOT_WORKER_TOKEN`, non-blocked Binance futures egress, and a separately reviewed POST endpoint/wiring.
>
> _Local live-capable rolling-Absorb runtime (2026-07-23, unpushed):_
> `scripts/radar/rolling-microstructure-producer.mjs` remains a one-shot,
> disabled-by-default local wrapper. It may stamp `trusted:true` only when a
> complete 300-second public Binance-futures measurement passes independent
> validation: sorted/validated aggTrades with explicit maker flags, two
> time-separated depth samples, 30+ validated 1m klines, valid `0..1` buy
> dominance, all Strict-Absorb fields, fresh source/sample metadata, and the exact HTTPS public host `fapi.binance.com` (alternate hosts fail before fetch).
> Missing, thin, stale, malformed, untrusted, or incomplete rows are omitted or
> rejected before merge. The producer is still dry-run unless the separately
> opt-in POST flag, token, and control URL are supplied; no scheduler, workflow,
> production configuration, private/signed endpoint, trading, Telegram, or
> gate/ENTRY_READY threshold changed. Token-bearing candidate/POST calls now require
> the exact `https://swingterminalx.netlify.app` control origin or loopback local
> development (`localhost`/`127.0.0.1`, HTTP(S)); malformed, userinfo, path/query,
> scheme, suffix, and arbitrary-host URLs fail before fetch. A valid local row reaches only the existing
> Strict-Absorb gate; Telegram remains subject to all existing independent gates.> _RADAR Focus checklist layout hotfix (2026-07-23, local-only):_ The emoji-free checklist had one right-aligned flex value column, which could split `DATA OFF` and `ADVISORY` vertically. It now uses stable left-aligned grid columns **Gate / Status / Meaning**, with non-wrapping status badges; all wording, gate values, and advisory boundaries remain unchanged. Technical details remain collapsed by default and the STALE explanation remains inside it. Cache-bust is **`?v=6i5` -> `?v=6i6`**. No backend, strict-Absorb runtime, scoring, ENTRY_READY, Telegram, producer, endpoint, or trading change.
>
> _RADAR STALE-vs-advisory wording clarity (2026-07-23, local-only on top of
> `aa22b00`):_ UI copy-only pass — no gate, score, ENTRY_READY, Telegram, or
> producer logic touched. Root confusion: the RADAR Focus card can show the
> top **strict-Absorb STALE banner** (server GATE data — producer off / static
> snapshot stale) at the same time the admin price-history / live-microstructure
> **advisory** sections show a live "Orderbook: Browser live book (OK)" read,
> which read as a contradiction. Fixes: (1) the STALE banner
> (`_radarMicrostructureStatusNote`) now explicitly says this is **SERVER-side
> strict-Absorb GATE data — not the browser/live advisory read shown below**,
> plus a bridge line *"Browser live book can be OK while strict rolling Absorb
> remains STALE. They are different data layers."* (2) Trade Readiness's
> "Missing data:" label is now **"Missing server-gate data:"**. (3) The PH
> admin readiness-verdict disclaimer and its "Orderbook:" row now say
> **"advisory read only"** / **"does not satisfy strict Absorb"** (that
> sub-panel's own long-standing test guard forbids the literal `ENTRY_READY`
> token, so it keeps its existing "server entry gate" phrasing instead). (4)
> The Live Microstructure section (`LIVE_MICRO_ADVISORY_TEXT`, outside that
> guard) now reads **"Advisory read only — does not satisfy strict Absorb and
> does not unblock ENTRY_READY or Telegram."** Cache-bust bumped **`?v=6i2` →
> `?v=6i3`** per standing discipline (any JS/CSS change bumps the token).
> Updated 3 tests whose assertions pinned the OLD wording
> (`frontend.radar-trade-readiness`, `frontend.radar-cockpit-flow`,
> `frontend.live-microstructure`) to the new, intentionally-changed copy. Full
> suite green (1662 pass / 0 fail / 26 skipped). No push, no deploy.
>
> _Live microstructure visibility for RADAR + Cockpit (2026-07-23, local-only
> on top of `f55f766`):_ added a NEW advisory-only, read-only same-origin GET
> Edge route **`/api/microstructure-snapshot`**
> (`apps/edge/netlify/edge-functions/microstructure-snapshot.js`, wired in
> `netlify.toml`) that surfaces the LIVE microstructure the strict rolling-
> absorption producer does not provide: order-book summary + funding rate + open
> interest + an aggregate-trade **taker-flow proxy** (Binance `m` flag: `m===true`
> taker sold, `m===false` taker bought), all from PUBLIC Binance market-data GETs
> routed through our origin. Reuses `resolveOrderbook` (minimal `fetchImpl` DI
> refactor in `lib/binance.js`, behavior-preserving) for the spot↔futures book
> fallback; the book is the gate (404 `SYMBOL_NOT_ON_BINANCE` / 502
> `UPSTREAM_ERROR`). Funding/OI are futures-only → honest `UNSUPPORTED` on spot,
> never faked; liquidation is always `UNKNOWN` (no public feed wired); every leg
> degrades to `UNKNOWN` on failure, never a bearish 0. Response carries
> `advisory_only:true` + `affects_server_gates/strict_absorb/entry_ready/telegram
> = false`. Frontend: new **`#radar-live-microstructure-slot`** (RADAR Focus card)
> and **`#cockpit-live-microstructure-slot`** (Cockpit import panel), a cache/
> deduped fetch helper (`_refreshLiveMicrostructure`, 20s TTL, 6s timeout, fail-
> closed + logged), and an explicit "Advisory only — does not change server gates,
> strict Absorb, ENTRY_READY, or Telegram." line. This is **display-only**: it
> changes NO server gate, strict-Absorb status, ENTRY_READY, scoring, or Telegram
> eligibility, and the existing strict-Absorb STALE banner is untouched. Asset
> cache-bust bumped **`?v=6i1` → `?v=6i2`** (all of index.html). New tests:
> `tests/edge.microstructure-snapshot.test.mjs` (auth/origin fail-closed before
> any fetch, 404 not-listed, futures funding/OI normalized, spot funding/OI
> UNSUPPORTED + futures endpoints never called, flow proxy math + malformed→
> UNKNOWN, liquidation UNKNOWN, advisory flags, source-guard: no POST/worker-
> token/private-endpoint/Telegram) + `tests/frontend.live-microstructure.test.mjs`
> (both slots mounted, advisory wording, single `6i2` token, no inline `<script>`,
> pair resolver keeps quoted pairs / appends USDT to bases). Full suite green
> (1662 pass / 0 fail / 26 skipped). Runtime smoke needs a deploy (Edge runs
> server-side + requires an authenticated Supabase session; not verifiable
> locally). No push, no deploy.
>
> _Cockpit RADAR data-visibility + cache-bust + STALE clarity (2026-07-22,
> local-only on top of `3658a74`):_ QA found the #1 reason the owner "saw no
> visible changes" — the asset cache-bust token `?v=6h8` had NOT been bumped
> since `ce01910`, so with `Cache-Control: max-age=3600` returning browsers kept
> serving OLD cached `terminal.js`/panels for up to an hour. **Fix: bumped all 11
> asset versions `?v=6h8` → `?v=6i1`** (index.html). Any future JS/CSS change MUST
> bump this token. Also proven: the owner's "reclaim STALE" is actually the
> **Absorb** column — strict rolling absorption reads STALE across ALL 495
> candidates because the microstructure producer is OFF
> (`microstructureDiagnostics.microstructureEnabled=false`) and the only static
> snapshot is ~34d old (`staticMicrostructure.receivedAt` 2026-06-18). Reclaim
> itself shows NOT STARTED, not STALE. Fixes (display-only, no gate/score/Telegram
> change): (a) a visible Focus-card banner explaining strict-absorb STALE is a
> system-wide data-source state, not a per-coin signal; (b) Absorb STALE tooltip
> now carries the age/producer context; (c) a new Cockpit "RADAR read" insight
> block in the import panel giving the Cockpit the SAME price-history / market-vs-
> price-history reclaim / strict-vs-history-only absorption / backend PH setup
> support visibility as the RADAR Focus card (reuses the shared
> `radarBackendPriceHistoryModel`; starts no fetch). Full suite green (1640 pass /
> 0 fail / 26 skipped). Runtime UI verify still needs the cache-bust deployed. No
> push, no deploy.
>
> _Orderbook 502 audit (2026-07-22, local-only fix on top of `13dd749`):_ the
> `/api/orderbook` 502s were **NOT** infra/egress — `/api/orderbook` is the Deno
> **Edge** function (`apps/edge/netlify/edge-functions/orderbook.js` →
> `lib/binance.js`) and BTCUSDT/ETHUSDT return real books on spot AND futures.
> Root cause: (B) market selection — LITUSDT has an empty spot book but a live
> futures book, callers ask spot; and (D) unsupported symbol — ANSEMUSDT is on
> neither Binance market (400 -1121 Invalid symbol) but was reported as generic
> "upstream failed". Fix (Edge-only, no frontend change): new `resolveOrderbook`
> does a bounded spot↔futures fallback so futures-only coins return their real
> book, and the route now answers **404 `SYMBOL_NOT_ON_BINANCE`** (honest "not
> listed") vs **502 `UPSTREAM_ERROR`** (genuine fault) instead of one blanket
> 502. Success response adds `requested_market` / `market_fallback` / resolved
> `market` (extra fields; existing callers read only `orderbook`, unaffected).
> Full suite green (1624 pass / 0 fail / 26 skipped). Runtime smoke needs a
> deploy (Edge runs server-side; not verifiable locally). No push, no deploy.
>
> _Current local state:_ the four price-history runtime/doc commits
> (`c26652a` advisory frontend overlay, `3d75047` bounded top-five backend
> context, `d6e047e` max +3 setup support, `d4baac1` handoff) are pushed —
> `origin/main` = `d4baac1`. One **new local-only** commit sits on top:
> **RADAR price-history/orderbook UI consistency** (display-only). It surfaces
> the *server-owned* `priceHistoryContext` + `priceHistoryScoreAdjustment` in
> the Focus card (new "Backend price-history scoring" block) and as a `+N PH`
> tag on the table Setup cell, and source-labels the table Absorb/Reclaim
> tooltips — so the table Setup number, the focus card, and the advisory
> frontend read never silently disagree. It changes **no** gate, score,
> ENTRY_READY, Telegram, or backend behavior; it only reads fields the radar
> already emits. Browser audit confirmed the root cause: the focus card
> followed `radar.selected` (e.g. LITUSDT at rank #107) while backend context
> is attached to the **top-five only**, so the two "price-history" reads
> operated on different candidate sets. `/api/orderbook` returns **502 upstream**
> in production (Netlify→Binance egress — the documented KNOWN CONSTRAINT), so
> the browser-orderbook enrichment cannot succeed; the UI already shows this
> honestly. Full suite green (1610 pass / 0 fail / 26 skipped). No push, no
> deploy. `stash@{0}` is preserved.
---

## 1. How ChatGPT should behave

- **Speak Czech** with the owner. Keep prompts you write *for coding agents*
  (Claude / Fable / Sonnet / Opus / Codex) **in English**.
- Be **direct, practical, not verbose**. Concise but complete — no filler.
- Act as a **critical CTO / risk partner**, not a cheerleader.
- **Do not blindly approve** AI agent reports. Require **evidence** from code,
  git, tests, or logs before you agree something is done.
- When reviewing a Claude/Fable report, give one of: **APPROVE / BLOCK /
  FOLLOW-UP PROMPT** (see §15).
- Clearly **distinguish production facts from assumptions**. If you don't know,
  say "unknown" — never invent project state.
- **Never** suggest a push or deploy unless the owner has explicitly approved it.
- This is a **real-money-adjacent trading codebase**. Bias toward safety: when in
  doubt about a trading / order / gate change, treat it as high-risk.

## 2. Model routing rules

| Model | Use for |
| --- | --- |
| **Sonnet** | Focused bugfix, copy/UI tweak, single test, small self-contained implementation. |
| **Opus** | Architecture / risk / security review, trading-gate or auth review, "is this safe to ship" calls. |
| **Fable** | Large multi-module work, migrations, product/system refactors, long autonomous sessions, repo-wide docs/process. |

Defaults:
- **Repo-wide docs / process / migrations → Fable.**
- **Small production bugfix → Sonnet.**
- **Pre-implementation risk/security review → Opus** (or **Fable** if the scope is
  large). Anything touching **orders / live trading / auth / gates** should get an
  Opus-style review before merge regardless of who implements it.

## 3. Project identity

- **Product:** *Swing Terminal Version X* (HTML `<title>`; workspace/package name
  `swing-terminal-workspace`).
- **What it is:** a browser-based **crypto swing-trading terminal** — a
  single-page web app plus serverless backends. It scans the market, surfaces
  actionable setups (**Trading RADAR**), lets the user plan/track trades
  (**Cockpit**), and can run a **local, gated Binance Spot bot** (testnet by
  default, live spot hard-locked behind many gates).
- **Primary user:** the owner / operator (and admin-allowlisted accounts). This is
  an operator tool, not a mass-market SaaS with a billing funnel.
- **Delivery surface:** the web terminal + optional **Telegram alerts** for
  confirmed RADAR `ENTRY_READY` setups and a daily morning briefing.
- **Production:** deployed on **Netlify** at `https://swingterminalx.netlify.app`.
  A separate **ingest** service runs on **Fly.io** (`apps/ingest`). Durable state
  is **Netlify Blobs** (product data) plus a new **Netlify Database (Postgres)**
  foundation — observability (in production) and, in local unpushed commits,
  a market price-history store (see §10). Auth is **Supabase JWT** —
  unchanged, Supabase holds no product data.
- **Local repo path (owner machine):**
  `C:\Users\Ales\Desktop\Bots\terminal crypto\terminal-X`
- **Current local state (2026-07-27):** active branch
  **`integrate/canonical-context`**, HEAD **`91de7ab`**, **pushed** (origin in
  sync). Deployed **`origin/main` = `cf426d3`**; the canonical-context line is
  **NOT merged to `main`**. Uncommitted working edits: `.gitignore`,
  `docs/kucoin-architecture.md`, `.claude/settings.local.json`. **Do not assume
  any branch commit is live** — only what is on `origin/main` is deployed.
- **Read-first docs** (see §4).

## 4. Mandatory repo read order for new coding-agent sessions

Paste this to a new Claude/Fable/Codex session before it touches code:

> First read `AGENTS.md` and this repo's `docs/` before touching code. For a
> trading / worker / order task, read `docs/LIVE-SPOT-RUNBOOK.md`,
> `docs/worker-launcher.md`, and `docs/bot-fleet.md`. For a RADAR / microstructure
> task, read `docs/radar-microstructure.md` and
> `docs/radar-rolling-microstructure-design.md`. Do not rediscover the whole repo
> from scratch unless these docs are clearly stale. This is a real-money-adjacent
> trading codebase — additive, fail-closed changes only; never relax a safety gate.

Doc map:
- `AGENTS.md` — agent workflow + the rule that this handoff must be kept updated.
- `docs/bot-fleet.md` — Bot Fleet control plane (auth, routes, data model, regime).
- `docs/LIVE-SPOT-RUNBOOK.md` — live Spot enablement, micro caps, emergency stop.
- `docs/worker-launcher.md` / `docs/worker-install.md` — the on-demand local worker.
- `docs/radar-microstructure.md` — provider-backed static microstructure (the
  fail-closed `MARKET_DATA_PROVIDER=none` default, the "451" story).
- `docs/radar-rolling-microstructure-design.md` — **design only, not implemented.**
- `docs/error-observability.md` — the client error log (`errors()` in devtools),
  the machine-enforced error-observability ESLint rules, and the
  `eslint-suppressions.json` debt baseline. Read before touching any failure
  path or adding a `<script>` to `index.html`.
- `docs/native-auth.md` — own-database accounts (`app_users`), scrypt passwords,
  the terminal's own access tokens, the admin user-management endpoint, the
  revocation tradeoff, and the step-by-step rollout order. **Read before
  touching anything auth-related.** Backend done + default-off; the browser
  still signs in through Supabase.

## 5. Git / deploy guardrails

- **No push** without explicit owner approval.
- **No deploy** (Netlify / Fly.io) without explicit owner approval.
- **Never `git add .`** — stage only explicitly named files.
- Branch from current `main`; use a `feat/…` / `fix/…` / `docs/…` name.
- **Commit only after tests pass** (`npm test`).
- Merge pattern (only after review + approval):
  ```powershell
  git checkout main
  git merge --no-ff <branch>
  # push ONLY if the owner approved:
  git push origin main
  ```
- **Netlify** auto-builds from the connected branch on push — so a push to the
  deploy branch *is* a deploy. Treat push and deploy as the same risk.
- **Fly.io** (`apps/ingest`) deploys are separate and manual — never trigger
  without approval.
- After an approved push, verify: `git log --oneline origin/main -5` matches local
  and the Netlify deploy went green.

## 6. Current product surface (web terminal tabs)

Tabs rendered in `apps/edge/public/index.html` (function `sv(...)` switches views):

- **SCANNER** — default view; market-wide scan / signals. Carries one
  advisory-only column, **Lead Score** (0–100 + LOW/MED/HIGH/EXTREME/UNKNOWN),
  reading how strongly futures/perp pressure looks to be leading the spot move.
  Advisory context, never a gate — see §8.
- **TRADING RADAR** — the actionable pipeline; `ENTRY_READY` candidates,
  positioning/pressure-zone/trade-readiness context panels.
- **COCKPIT** — manual trade planning/review; imports a selected RADAR candidate
  (explicit selection required), trader context checklist, market-wide funding
  context, and a **Personal Alerts card** (connect/disconnect a personal Telegram
  chat id and manage selected-symbol watches; backend delivery is prepared but
  disabled by default behind system safety settings; see §9).
- **TOP CHARTS · SECTORS · HEATMAP · MOVERS · CALENDAR** — market data views.
- **BOT FEED** — the paper/testnet bot control surface (START/STOP BOT, live-spot
  readiness panel). Labeled "Paper Trading Sandbox".
- **ALERTS · LIVE FEED · REGIME · GECKO** — alerts, live event feed, market-regime
  view, and the CoinGecko Highlights panel (GECKO).
- **MANUAL** — interactive "every signal explained" manual.

**Tab order is user-customizable** (order only). A "⇄ TABS" control at the right
of the tab bar turns on reorder mode, where each tab gets ◀/▶ buttons; the order
is saved per browser in `localStorage['terminalX.tabOrder.v1']` and a RESET
button restores the shipped order. Every tab carries a canonical `data-view` id
matching the id passed to `sv()`. This is navigation personalization ONLY — it
creates no views, no duplicate tabs, no workspaces and no parallel mounted
panels, and `sv(view, el)` remains the single view switcher.

There is **no** hidden broker-command system, no chat command palette to a bot,
no subscription/paywall UI. Access control is per-user via Supabase JWT + an admin
email allowlist (§9), not a billing tier.

## 7. Trading safety & gates (this project's equivalent of "billing state")

> The safety model — not billing — is the thing you must never casually change.

- **Testnet Spot only by default.** Live trading is **hard-locked** and only opens
  through many stacked gates (see `docs/LIVE-SPOT-RUNBOOK.md`).
- **Spot only.** No futures/margin/leverage/borrow/repay, no SAPI/DAPI/FAPI, no
  withdrawals — none of these execution paths exist anywhere.
- **Netlify never holds Binance signing secrets and never signs orders.** The
  **local worker** (`scripts/local-binance-worker.mjs`) is the *only* process that
  signs Binance orders. Keys live only in a gitignored `.env.worker` on the
  operator's machine.
- **Live micro caps** (initial live phase): single symbol `BTCUSDC` **or**
  `BTCUSDT`; `LIVE_MAX_POSITION_USD` ~$6 (minNotional buffer; prefer $8–$10 for a
  clean round-trip), `LIVE_MAX_DAILY_LOSS_USD=5`, `LIVE_MAX_DAILY_TRADES=3`,
  `LIVE_MAX_OPEN_POSITIONS=1`. The worker independently re-checks every cap and the
  real minNotional at execution (defense in depth).
- **Config hard-validation** (control plane): `maxTradeUsd ≤ 10` (testnet phase),
  `maxOpenPositions ∈ [1,5]`, `allowLive` forced `false` unless the full live
  enable flow runs.
- **Market regime gate:** `RISK_ON | NEUTRAL | RISK_OFF | CRASH`. **CRASH**
  hard-blocks entries; RISK_OFF is advisory.
- **Kill switch:** `BOT_GLOBAL_KILL_SWITCH=true` and the **EMERGENCY STOP ALL LIVE
  SPOT** admin action block new entries and force-close.
- **Lifecycle:** STOP = stop entries + close positions + exit worker. PAUSE = stop
  entries, worker stays alive. A failed close reports `WORKER_CLOSE_FAILED` and the
  worker never exits while a position is open.
- **Do not** relax, bypass, or "temporarily disable" any of the above. Changes here
  must be additive and fail-closed.

## 8. RADAR & alerting current state (this project's equivalent of "delivery gating")

- **RADAR `ENTRY_READY` is single-sourced** from the V1 actionability logic in
  `scripts/radar/trading-radar.mjs`. Scanner-only rows (no execution
  microstructure) can **never** become `ENTRY_READY` or Telegram-eligible.
- **Telegram alerts are locked down.** The legacy relay `/api/telegram`
  (`netlify/functions/telegram.mjs`) is **disabled → returns HTTP 410**.
  `cron-alerts.mjs` may send the global alert only for a fully confirmed RADAR
  `ENTRY_READY` (60-min cooldown, 120s staleness cutoff, gated by
  `RADAR_TELEGRAM_ENABLED === 'true'`). `personal-alerts.mjs` is the only
  personal sender; it imports that same confirmed selector and remains off unless
  `PERSONAL_ALERTS_ENABLED === 'true'`, with durable per-user watch/dedup state.
  Both paths fail closed. No other function may send a trade alert.
- **Morning briefing** (`netlify/functions/morning-briefing.mjs`) is a separate,
  informational daily Telegram message (own gate `MORNING_BRIEFING_TELEGRAM_ENABLED`,
  DST-aware hourly cron + once-per-local-day dedup). It is **not** a trade signal.
  It reads the **canonical context store** (Fleet blob is a labelled fallback) and
  states its data source + age in section 0 of every message. Anything older than
  `MORNING_BRIEFING_MAX_DATA_AGE_MIN` (default 15 min) is **withheld with a named
  reason** — the briefing may never present cached numbers as the current tape
  (see the 2026-08-01 entry at the top of this file).
- **Static microstructure overlay** (`docs/radar-microstructure.md`): production
  default `MARKET_DATA_PROVIDER=none` → **zero external calls**, UI shows "provider
  unavailable" (fail-closed). `binance-public` is a **local-only diagnostic**
  (Binance public fapi is region-blocked 451 from Netlify/GitHub egress). **There
  is no production microstructure scheduler/cron** — do not add one.
- **Scanner detail live book:** authenticated users can read the live Binance
  Spot/Futures depth through `/api/orderbook`; it is a UI-only, server-side
  proxy with short per-isolate caching, clear inline errors and no trading or
  RADAR-gate effect. The selected detail panel updates its changing values in
  place on scanner refresh; its order-book rows and green/red bid/ask signal
  flow poll independently, so the panel does not disappear and rebuild.
- **Rolling microstructure** (`docs/radar-rolling-microstructure-design.md`) is
  **design only, not implemented.** The gate already reads its field names and
  fails closed when absent.

## 9. Auth / admin / personal-watch current state (this project's equivalent of "support/admin")

- **Identity:** Supabase JWT (`Authorization: Bearer …`), verified in
  `netlify/functions/_auth.mjs` (HS256 via `SUPABASE_JWT_SECRET`, or ES256/RS256
  via project JWKS). `getIdentity()` → `{ ok, verified, userId, email, orgId,
  authMode, reason }`. Raw tokens are never logged.
- **Admins:** `BOT_ADMIN_EMAILS` allowlist. Cross-user control (stop/pause/close
  another user's session) and org-wide visibility **require `verified === true`** —
  never available in decode-only mode.
- **`AUTH_DECODE_ONLY=true` is dev-only and NOT production-safe** — must be
  false/unset in production (any unverifiable token → 401). It also cannot reach
  account management: `/api/admin-users` requires `verified === true`.
- **Native (own-database) auth — backend DONE, DEFAULT OFF (local, unpushed).**
  A second, additive identity source alongside Supabase, so the owner can manage
  the handful of real users from the terminal. Full detail + rollout order in
  `docs/native-auth.md`; the essentials:
  - Accounts live in `app_users` (Netlify/Neon), passwords are **scrypt** via
    Node's built-in `crypto` (no new dependency). **Supabase's bcrypt hashes are
    NOT migrated** — the owner sets fresh passwords through the admin page.
  - Gated behind `NATIVE_AUTH_ENABLED === 'true'` **and** a ≥32-char
    `AUTH_JWT_SECRET`. With the flag off, a native token is refused and every
    existing path behaves exactly as before. Both sources are accepted while the
    flag is on, so the cutover cannot lock the owner out and reverts via one env
    var.
  - **`app_users.role` grants NOTHING.** Admin is still `BOT_ADMIN_EMAILS` only.
    A `role` claim in a user-held token is ignored. There is deliberately **no
    bootstrap secret** — the first native accounts are created via
    `/api/admin-users` using the owner's existing Supabase admin session.
  - Endpoints: `/api/auth-login`, `/api/auth-refresh`, `/api/admin-users`.
    Login is **non-enumerable** (unknown email / wrong password / disabled /
    locked → byte-identical 401, same scrypt cost). Lockout is 8 attempts →
    15 min, and is *not* disclosed to the client — read it on the admin page or
    in `app_user_audit`. A DB outage is a 503, never "invalid credentials".
  - **Revocation:** verification is stateless (no DB read on the hot path), so
    disable/reset takes effect at the user's next **refresh** (≤ 1 token TTL,
    default 60 min). For immediate global revocation, rotate `AUTH_JWT_SECRET`.
  - **Browser side DONE too:** `js/auth-client.js` (`window.AuthClient`) is the
    façade every token read goes through, and it is **self-configuring** — it
    posts to `/api/auth-login` and falls back to Supabase on
    `503 NATIVE_AUTH_DISABLED`, so one build works on both sides of the cutover.
    Refresh at 75% of TTL; a 503 keeps the token and retries, a 401 signs out and
    clears storage. `js/admin-users-panel.js` is the 👤 UŽIVATELÉ header button
    (admin-only in the UI; the real gate is server-side) plus the forced
    password-change dialog. `/api/auth-change-password` requires the CURRENT
    password even with a valid token, and returns a replacement token because the
    change bumps `token_version`.
  - **LIVE IN PRODUCTION since 2026-07-28** (merged to `main` as `e08fd63`).
    `AUTH_JWT_SECRET` set (all contexts, 64 chars), `NATIVE_AUTH_ENABLED=true`,
    all 10 migrations applied (0 pending). Both sources are accepted, so existing
    Supabase logins keep working. Rollback = unset `NATIVE_AUTH_ENABLED` +
    redeploy. Verified from production: unknown-account login →
    `401 INVALID_CREDENTIALS` (proves `app_users` exists and was queried),
    unauthenticated `/api/admin-users` → `401`.
  - 🆕 **Device sessions — 8h per device, added 2026-08-20 (local, on
    `fix/netlify-emergency-cost-breaker`, NOT yet pushed/deployed).** Problem: a
    page reload could cost a password. Access tokens live 60 min and
    `/api/auth-refresh` refused to touch an expired one, so a tab closed over
    lunch or a resumed laptop landed on the login gate. Fix: a login now stamps
    `sid` (session id) + `sxp` (absolute deadline = login + `SESSION_TTL_SECONDS`,
    **default 8h**, clamped to access-TTL … 7 days) into the token.
    `/api/auth-refresh` re-mints the short access token inside that window,
    **carrying `sid`/`sxp` forward unchanged** (a refresh can never extend the
    deadline) and **tolerating an already-expired `exp`** — that tolerance is the
    whole point and it lives ONLY in the new `verifyRefreshableToken()`. Every API
    path still calls `verifyAccessToken()`, which never accepts an expired token,
    `exp` is capped at `sxp`, refresh keeps its DB check (status +
    `token_version`), and the **Deno edge verifier enforces `sxp` too** (parity
    test would fail otherwise). Browser (`js/auth-client.js`): the deadline is
    persisted and checked LOCALLY, so an ended session is dropped with **no
    request** and a toast naming the reason; an expired token inside a live window
    triggers a silent refresh instead of a sign-out. **Cost fix in the same
    change:** a stored token the server confirmed < 15 min ago is adopted on load
    **without** calling `/api/auth-refresh` (that endpoint reads Postgres, and
    Netlify bills DB compute per hour AWAKE — confirming on every reload woke the
    DB for no new information). Still strictly tighter than the existing worst
    case (a running tab re-confirms only at 75% of a 60-min token ≈ 45 min), so
    revocation is unchanged in practice. **Backwards compatible both ways:**
    legacy tokens without `sxp` keep verifying to their `exp`, get NO tolerance,
    and are upgraded on their next refresh; a browser talking to a server that
    answers without `sessionExpiresAt` reads that as "no deadline known", never as
    expired — so a rollback does not lock anyone out. Also fixed the
    `Number('')===0` trap in both TTL readers (a blank env var means *unset*, not
    a 60-second token / an instantly-dead session) and a **1-in-4 flaky
    assertion** in `tests/auth.edge-native-jwt.test.mjs` (flipping the LAST
    base64url char of a 32-byte HMAC can decode to the same bytes, so a valid
    signature legitimately verified and the test failed at random). Guards:
    `tests/auth.native-jwt.test.mjs` (+13), `tests/auth.refresh-endpoint.test.mjs`
    (rewritten expiry contract, +6), `tests/auth.edge-native-jwt.test.mjs` (+4),
    `tests/frontend.auth-client.test.mjs` (+9). **Cache-bust `6l4 → 6l5`
    included — the change is deploy-safe.** `netlify.toml` sets `max-age=3600` on
    `/*.js`, so without the bump a returning tab would keep the OLD
    `auth-client.js` for up to an hour — and the old client is exactly the code
    that drops an expired token and shows the login form, i.e. the bug being
    fixed. All 16 versioned assets in `index.html` carry `6l5`, and the two tests
    that pin the exact token were updated with it
    (`tests/frontend.canonical-context-cutover.test.mjs` and the cache-token
    assertion in `tests/frontend.arkham-intel-panel.test.mjs` — that file's
    Arkham assertions and the Arkham modules themselves are untouched).
    Nothing to set in Netlify — 8h is the default; `SESSION_TTL_SECONDS` only
    needs setting to choose something else.
  - 🩹 **Post-cutover bug, fixed 2026-08-03 (`fix/native-session-ai-401`, local,
    unpushed): AI was unusable for native-only accounts.** `js/ai-analysis.js`
    was the ONE frontend module still reading
    `window.__supabase.auth.getSession()` directly instead of `AuthClient`. An
    account created in the admin panel has **no Supabase session at all**, so
    every AI action (coin analysis, briefing, market briefing) got `null` there
    and rendered a client-side `401 Neautorizovaný přístup` — whose branch then
    called `window.location.reload()`, bouncing the user to the login gate every
    time they pressed an AI button. Scanner / RADAR / admin panel worked
    throughout (they go through `AuthClient`), and an owner still holding a
    legacy Supabase session could not reproduce it. Three fixes:
    (1) `getAccessToken()` in `ai-analysis.js` now goes through `AuthClient`
    (Supabase only as fallback) and logs + `ErrorLog.record()`s a missing token;
    (2) the 401 branch reloads **at most once per page** and **never** for a
    locally-detected missing token (`renderError(..., { reload: false })`);
    (3) `auth-client.js` `clearNative()` now emits the mode that *ended*
    (`'native'`) instead of the already-nulled one — `terminal.js`'s
    `AuthClient.onChange` handler returns early unless `mode === 'native'`, so a
    session ending mid-use previously left the app looking signed in while every
    request 401'd. Guards: `tests/ai.frontend-diagnostics.test.mjs` (token source
    + no reload loop) and `tests/frontend.auth-client.test.mjs` (the ended mode
    is announced). Cache-bust `6k3 → 6k4`.
  - ⚠️ **`netlify database migrations apply` MUST be run by hand.** Netlify does
    NOT apply migrations on deploy despite its CLI saying so — after a successful
    deploy, 9 were still pending. The command's own "applies to the local
    database" text is also wrong: linked, it applied to production. Always verify
    `netlify database status` shows 0 pending, then probe a real endpoint.
    (Also: `netlify env:list` shows the *dev* context — use
    `env:get NAME --context production`.)
  - Remaining: a tier decision for native users (`getTier()` resolves a native
    non-admin to `free`); removing Supabase entirely (CDN script,
    `_FALLBACK_SUPABASE` hardcoded anon key, both verifier branches) once native
    auth is proven in production.
- **Personal watch — Phase 1 backend (live, merged to `main`):**
  `netlify/functions/cockpit-personal-watch-settings.mjs` +
  `_personal-watch-store.mjs` expose `/api/cockpit-personal-watch-settings`
  (OPTIONS/GET/POST/DELETE) so a logged-in user can store/read/remove a
  **Telegram chat id** (validated digits-only, length 5–20). Auth is the
  shared `getIdentity()`; records are keyed by the **token `userId` only**
  (body can't hijack ownership); persisted in **Netlify Blobs** with an
  in-memory fallback. Responses return only a **masked** chat id + connected
  boolean + timestamp — **never the raw value**. A ~10 KB request-body cap
  fails closed before JSON parse. Covered by
  `tests/cockpit-personal-watch-settings.test.mjs` (14 tests).
- **Personal watch — Phase 2 UI settings wiring (merged/live):** a "Personal
  Alerts" card in Cockpit
  (`apps/edge/public/js/personal-watch.js` pure module +
  `apps/edge/public/js/terminal.js` wiring) lets the user Connect/Disconnect
  their Telegram chat id against the Phase 1 endpoint above, using the
  shared `_getAuthHeaders()`. The raw id is **write-only** in the UI — never
  stored in `localStorage`/`sessionStorage`/durable JS state, cleared from
  the input only after a confirmed successful save, and only the server's
  masked value is ever rendered. Covered by `tests/personal-watch-client.test.mjs`
  (pure-module unit tests) and `tests/frontend.personal-watch.test.mjs`
  (source guards).
- **Personal watch — Phase 3 symbol watch-list (merged/live):** a sibling
  endpoint
  `/api/cockpit-personal-watch-list` (`netlify/functions/
  cockpit-personal-watch-list.mjs`, OPTIONS/GET/POST/DELETE) + store helpers on
  the same per-user record let a user manage a **selected-symbol watch-list**
  ("notify me when this symbol reaches a confirmed RADAR entry setup"). Symbols
  validated `^[A-Z0-9]{2,20}$` (trim+uppercase),
  deduped, **server-assigned `addedAt`**, capped at `MAX_WATCHES_PER_USER = 25`;
  token-`userId` ownership; responses carry **symbols only, never a chat id**;
  adding/removing a watch never touches the chat id. Cockpit card gains a watch
  sub-section (input + removable chips) wired via `_getAuthHeaders()`. Covered by
  `tests/personal-watch-list.test.mjs`, extended `tests/personal-watch-client.test.mjs`,
  and `tests/frontend.personal-watch-list.test.mjs`. There are still no custom
  conditions or "watch all" mode. **Follow-up:** no per-endpoint rate limiting.
- **Personal watch — Phase 4 sender (local branch,
  `feat/personal-watch-alert-sender`):** `netlify/functions/personal-alerts.mjs`
  is a scheduled, disabled-by-default fan-out of the same confirmed/fresh
  `ENTRY_READY` selection exported by `cron-alerts.mjs`. It sends only when
  `PERSONAL_ALERTS_ENABLED === 'true'`, the internal scheduler secret/header
  authenticates, a Telegram token exists, Netlify Blobs can durably enumerate
  recipients and persist dedup state, and the user has a
  saved personal chat id plus a matching selected-symbol watch. Per-user/symbol
  60-minute cooldown + setup-hash dedup, an ETag-conditional per-symbol
  reservation against overlapping runs, caps of 5/user and 100/run,
  aggregate-only logs/responses, and mark-after-success behavior are covered by
  `tests/personal-alerts.test.mjs`. `next_run` is metadata only; public HTTP
  requests without the scheduler secret/header cannot trigger fan-out. Memory
  fallback, missing state/token, missing scheduler auth, and Telegram failures
  send nothing or fail closed. Production remains OFF; this branch is local
  only and requires security review before push/deploy/enable.
- **Personal watch — Phase 5 external scheduler (local branch,
  `feat/personal-alerts-external-scheduler`):** `personal-alerts.mjs` no
  longer declares a native Netlify `config.schedule` — Netlify's native
  scheduled trigger cannot attach the `x-terminal-scheduler-secret` header
  the function requires, so leaving it in place would have made real sending
  permanently unreachable (every native invocation would 401). The approved
  scheduler is now `.github/workflows/personal-alerts.yml`, a GitHub Actions
  `workflow_dispatch` + 5-minute `schedule` job that `POST`s the function URL
  with `x-terminal-scheduler-secret` sourced from the GitHub secret
  `PERSONAL_ALERTS_SCHEDULER_SECRET`; it no-ops (`exit 0`) if that secret
  isn't configured and never echoes it. The handler also now requires the
  request method to be `POST` (in addition to the header) before reaching
  fan-out when enabled — a direct `GET` is rejected even with a correct
  header. `next_run` is still never trusted as auth. This is scheduler
  plumbing only: `PERSONAL_ALERTS_ENABLED` remains absent/unset in
  production, no env values changed, and first real send still requires a
  separate enablement runbook + owner approval. Covered by
  `tests/personal-alerts.test.mjs` (new gate tests) and
  `tests/personal-alerts-scheduler-workflow.test.mjs` (workflow source
  guards). Production remains OFF; this branch is local only and requires
  review before push/deploy.
- **Personal watch — Phase 5F diagnostic test-send (local branch,
  `feat/personal-alerts-diagnostic-send`):** a second, fully separate
  function `netlify/functions/personal-alerts-diagnostic.mjs` lets the owner
  send one manual Telegram delivery test to a single already-connected
  test account, without waiting for (or forcing) a real RADAR
  confirmed-entry alert. It shares nothing with the real sender: its own
  enable flag `PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED` (must be exactly
  `'true'`), its own secret `PERSONAL_ALERTS_DIAGNOSTIC_SECRET` /
  header `x-terminal-diagnostic-secret`, and its own server-only target,
  `PERSONAL_ALERTS_DIAGNOSTIC_TARGET_USER_ID` (never printed, never
  returned, never accepted from a request body). It reads exactly one
  target user's record via a new single-key durable lookup
  (`getPersonalWatchRecordForDiagnostic` in `_personal-watch-store.mjs`,
  additive-only, no existing export changed) — never an enumeration of all
  recipients — and requires that target to have a saved chat id and
  **exactly one** watched symbol before sending. It never imports/calls the
  RADAR selector, never reads/writes the RADAR fleet, and never touches the
  real sender's dedup/cooldown/sent state. The manual trigger is
  `.github/workflows/personal-alerts-diagnostic.yml`, `workflow_dispatch`
  only — no schedule — which no-ops if its GitHub secret is unset. Covered
  by `tests/personal-alerts-diagnostic.test.mjs` (28 tests) and
  `tests/personal-alerts-diagnostic-workflow.test.mjs` (13 tests). No
  production env changed; `PERSONAL_ALERTS_ENABLED` and the new diagnostic
  flag both remain unset. Production remains OFF; this branch is local
  only and requires review before push/deploy.
- **Personal watch diagnostic target helper (merged/live):** the authenticated
  Cockpit endpoint `/api/cockpit-personal-watch-diagnostic-target` returns the
  current user's exact backend `identity.userId` as a copy-only value plus
  aggregate `hasChat` / `watchCount` / `exactlyOneWatch` status. It reads only
  that user's single record and never returns chat IDs, secrets, or records.
  The Personal Alerts UI copies the value through the browser clipboard without
  rendering it. The diagnostic target is never a Telegram chat ID, email, name,
  JWT token, storage key, or masked ID; keep diagnostic sending disabled while
  configuring it, enable it for one attended workflow run only, then disable it.
- **Personal watch diagnostic Telegram failure classification (this branch,
  `feat/personal-alerts-telegram-failure-classification`):** the diagnostic
  sender (`netlify/functions/personal-alerts-diagnostic.mjs`) previously
  collapsed every Telegram send failure into a single
  `error: 'DIAGNOSTIC_TELEGRAM_FAILED'` with no further detail, which made a
  real failed test-send (invalid/revoked token, bot blocked, bad chat id,
  rate limit, Telegram 5xx, network/timeout) impossible to diagnose from the
  response alone. `sendDiagnosticTelegram` now classifies non-2xx HTTP
  responses (using the status and Telegram's own `error_code`/`description`,
  the latter only inspected internally for keyword matching and never
  forwarded) and network/timeout exceptions into a fixed, allowlisted set of
  codes. On failure, `runDiagnosticSend`'s response additively includes
  `telegramFailureKind`, `telegramHttpStatus`, `telegramApiErrorCode`, and
  `telegramApiDescriptionCode` alongside the existing `error` field — never
  the token, chat id, user id, raw request URL, raw Telegram description, or
  a raw Personal Watch record. A successful send is unchanged (`sent:1`, no
  classification fields). This does not change the real sender
  (`personal-alerts.mjs`), the diagnostic target lookup, or any enable flag.
  See `docs/personal-watch-design.md` for the full status→code table and
  owner-action guidance. Covered by extended cases in
  `tests/personal-alerts-diagnostic.test.mjs` (41 tests total). Production
  remains OFF; this branch is local only and requires review before
  push/deploy.
- **Personal watch — Phase 5G rollout allowlist (this branch,
  `feat/personal-alerts-allowlist-rollout`):** before the first real
  production rollout, the normal sender (`personal-alerts.mjs`) now also
  requires a new env, `PERSONAL_ALERTS_ALLOWED_USER_IDS` (comma/newline/space
  separated raw backend `identity.userId` values), whenever
  `PERSONAL_ALERTS_ENABLED === 'true'`. Absent/empty fails closed
  (`PERSONAL_ALERTS_ALLOWLIST_EMPTY`, `sent:0`, no Telegram call). A
  wildcard/global value (`*`, `all`, `any`, `wildcard`, `everyone`) anywhere
  in the list is invalid and also fails closed
  (`PERSONAL_ALERTS_ALLOWLIST_INVALID`) — wildcard/"all" mode is
  intentionally unsupported this phase. A recipient's raw `userId` must be on
  the parsed allowlist before the existing watch/chat-id checks, before
  per-user/global caps, and before any Telegram send attempt; disallowed
  recipients are counted only (`recipientsSkippedByAllowlist`), never
  logged/returned by id. The response adds only counts —
  `allowlistEnabled`, `allowedRecipientsConfigured`,
  `recipientsSkippedByAllowlist` — never the raw allowlisted or skipped ids.
  This does **not** change the diagnostic sender, the diagnostic target
  helper, RADAR scoring/gates, or trading/Binance behavior; the existing
  confirmed `ENTRY_READY` selection, caps, dedup/cooldown/reservation state,
  and scheduler secret/header gate are all unchanged. First rollout runbook:
  set `PERSONAL_ALERTS_ALLOWED_USER_IDS` to the owner's own backend user id
  only (via the diagnostic target helper's copy action — never typed/pasted
  into chat, logs, or issues), verify, and only then separately enable
  `PERSONAL_ALERTS_ENABLED=true`. Covered by extended cases in
  `tests/personal-alerts.test.mjs`. Production remains OFF; this branch is
  local only and requires review before push/deploy.
- There is **no** broker support inbox, no `/reply` command, no `/admin_summary`.
  Don't invent them.

## 10. Data / worker / routing basics

- **Frontend:** static site in `apps/edge/public` (`index.html`, `js/terminal.js`
  + panel modules).
- **Deno edge functions** (`apps/edge/netlify/edge-functions`, wired in
  `netlify.toml`): `/api/markets`, `/api/analyze`, `/api/briefing`,
  `/api/market-briefing`, `/api/regime`, `/api/news`, `/api/config`,
  `/api/funding-divergence`, `/api/sniper-detect`, `/api/coingecko-highlights`.
- **Node Netlify functions** (`netlify/functions`): `bot.mjs` (Bot Fleet control
  plane — sessions, intents, results, regime, radar candidates/microstructure),
  `cron-alerts.mjs`, disabled-by-default `personal-alerts.mjs`,
  `morning-briefing.mjs`, `radar-microstructure-refresh.mjs` (token-protected,
  no schedule), `telegram.mjs` (disabled/410), plus `_auth`, `_fleet-store`,
  `_market-regime`, and `_personal-watch-store`.
- **Ingest service** (`apps/ingest`, Fly.io): Binance feed aggregator + paperbot.
- **Local worker** (`scripts/local-binance-worker.mjs`): launched on demand via the
  `swingworker://` URL protocol from the BOT FEED tab; heartbeats, polls its
  session-scoped intent, executes MARKET BUY/SELL, reports results/positions.
- **Durable store:** Netlify Blobs (fleet doc + per-user personal-watch);
  in-memory fallback when Blobs unavailable (fallback is close-only for live).
- **Do not** casually touch worker/execution/routing/scraping paths — data-source
  degradation must fail closed and never crash or relax a gate.
- **Netlify Database / Postgres — observability foundation (Phase 2B,
  `294c72e`, live in production) + market price-history foundation (LOCAL,
  UNPUSHED):**
  - Netlify Database is **enabled** for this project; native migrations live in
    `netlify/database/migrations/` and **auto-apply on every deploy** — a push
    to `main` is both a deploy *and* a production schema migration. Treat any
    future migration with the same care as a push/deploy approval.
  - Production migration `20260720081238_init-observability-tables` is
    **applied** (confirmed via the Netlify API post-deploy). It created exactly
    two tables, **`system_events`** and **`ingest_runs`** — structured logging
    / ingest-run tracking only. No `schema_migrations` table (Netlify already
    tracks applied migrations in its own `netlify.migrations` ledger).
  - `netlify/functions/_db.mjs` exports `getDb()` (lazy `@netlify/database`
    connection, cached) and a test-only `closeDbForTests()`. It is imported
    by `_observability.mjs` and (locally) `_price-history.mjs` — always
    lazily; nothing queries the DB at import time.
  - `tests/db.connection.test.mjs` and `tests/db.schema.test.mjs` prove the
    schema and connection helper; they **skip gracefully** when no local
    Netlify dev DB is reachable (never require/fall back to production).
  - **Phase 2B changed no product behavior.** It only established the
    observability tables; market data, RADAR, reclaim/absorption, alerts, and
    Supabase auth were untouched.
  - **Phase 2C DB-backed observability is production-verified** on `1f03fe1`:
    the homepage smoke returned 200 and the unauthenticated admin smoke
    returned 401. Its only route is `/api/admin-observability`; do not smoke
    `/.netlify/functions/admin-observability`. (A second admin route,
    `/api/admin-price-history`, exists in local unpushed commits — see the
    price-history block below.)
  - The endpoint is admin-only, GET-only, and read-only. Non-GET requests
    return 405; unauthenticated or auth-import/parser failures return 401;
    forbidden identities return 403; and an observability/DB import or read
    failure after verified-admin authorization returns safe 503. It has no
    diagnostic write path, migration, market-data, RADAR, alert, Telegram,
    trading, or Supabase-auth behavior change.
  - **Start Phase 2D only after this Phase 2C documentation sync.**
  - **Phase 2D first safe runtime wiring:** the authenticated, read-only Cockpit
    diagnostic-target helper writes sanitized warning events only for a missing
    personal-watch store (`cockpit_diagnostic_store_unavailable`) or incomplete
    diagnostic setup (`cockpit_diagnostic_target_incomplete`). Writes are
    best-effort and cannot change the endpoint response; no user/chat ids, raw
    errors, trading, RADAR, alerts, Telegram, or Supabase-auth behavior changed.
  - **Market price-history foundation (LOCAL, UNPUSHED — commits `99e011a`,
    `65d777e` + follow-up):**
    - New migration `20260720130902_add-market-price-history` creates
      **`market_price_snapshots`** (one row per sample batch) and
      **`market_price_points`** (one row per coin per snapshot, FK cascade,
      unique `(snapshot_id, symbol)`). It will **auto-apply on the next push
      to `main`** — treat that push as a production schema migration.
    - `netlify/functions/_price-history.mjs`: normalize + write/read helpers.
      Parameterized SQL only; invalid numbers become `null` (never invented);
      duplicate symbols in one batch are deduped (first occurrence wins) so
      `inserted`, snapshot `coin_count`, and `duplicates` are truthful actual
      DB counts; per-row `raw_meta` is allowlist-sanitized and size-bounded
      (never the raw external API payload); DB-unavailable returns stable
      `{ ok:false, reason }`, never throws.
    - `netlify/functions/_price-history-writer.mjs`: best-effort wrapper,
      **disabled by default** — writes only when
      `PRICE_HISTORY_WRITE_ENABLED === 'true'` (exact string; flag is NOT
      set anywhere). Disabled → `{ ok:true, skipped:true }` with no DB
      touch. Enabled-but-failed → stable result + one `console.warn` with
      reason code/source/row-count only (no raw errors, rows, or secrets);
      it can never throw into or break a caller.
    - `/api/admin-price-history` (`admin-price-history.mjs`): GET-only,
      admin-only (verified Supabase JWT + admin allowlist, same gate as
      `/api/admin-observability`), read-only; bounded `limit` (max 200),
      optional `symbol` filter; no `raw_meta` in responses; 401/403/405/503
      error boundaries mirror admin-observability.
    - **Admin-triggered collector wired (LOCAL, UNPUSHED):**
      `/api/admin-price-history-collect` (`admin-price-history-collect.mjs`)
      is the dedicated Node collector — POST-only, verified-admin-only,
      **disabled by default** behind `PRICE_HISTORY_COLLECT_ENABLED === 'true'`
      (exact string; flag is NOT set anywhere). Disabled → no fetch, no DB,
      `{ ok:true, collected:false, skipped:true, reason:'COLLECT_DISABLED' }`.
      Enabled → fetches same-origin `/api/markets` (static path, no forwarded
      query string or auth header) and hands the rows to
      `writeMarketSnapshotIfEnabled`, which still needs
      `PRICE_HISTORY_WRITE_ENABLED === 'true'` to persist — so both flags
      must be on for a real write. `/api/markets` stays Deno Edge and
      untouched; `bot.mjs` remains off-limits as a wiring point.
    - **RADAR valuation bands — oversold / overbought (LOCAL, implemented,
      advisory-only).** New pure engine `scripts/radar/valuation-bands.mjs`
      answers "is this coin stretched cheap or stretched expensive **relative to
      its own recent behaviour**". Two independently-scored layers:
      (a) *momentum* — weighted 1h/4h/12h/24h/7d stretch, volatility-normalized
      by `atrPct` when known, plus a bounded ±12-point BTC-relative nudge;
      attached by `trading-radar.mjs` to **every** candidate as the context-only
      `candidate.valuation`, alongside `pressureZones` / `positioningContext` /
      `tradeReadiness`. (b) *stored history* — from `market_price_points`: range
      percentile (0.45), sampled Wilder RSI (0.35), z-score (0.20), merged for
      the top **40** ranked candidates by
      `netlify/functions/_radar-valuation-context.mjs` using **one** batched read
      (`listRecentPricePointsForSymbols`, `ROW_NUMBER() OVER (PARTITION BY
      symbol …)`, hard-capped 60 symbols × 200 points). Score runs **−100
      oversold … 0 fair … +100 overbought**; bands `DEEPLY_OVERSOLD` /
      `OVERSOLD` / `FAIR` / `OVERBOUGHT` / `DEEPLY_OVERBOUGHT` / `UNKNOWN`.
      **It is NOT a fundamental valuation and NOT an entry signal**: every block
      carries `isEntrySignal:false` / `affectsGate:false` /
      `affectsTelegram:false`, the enrichment provably touches only
      `candidate.valuation`, and it runs AFTER the Telegram-eligibility restore
      so it cannot reach any gate, score, Absorb, Reclaim, `ENTRY_READY`, or
      alert path. Fail-closed: no usable input → `UNKNOWN` with a null score
      (never `OVERSOLD`, which reads as "cheap, buy"); a flat window is
      `FLAT_WINDOW` not `FAIR`; DB failure keeps the momentum-only band and is
      visible in `radar.valuationSummary.historyUnavailableReason` + a
      `console.warn`. UI: new **Value** column + Oversold/Overbought filter chips
      + a Focus-card valuation panel + a coverage line in `terminal.js`, display
      models in `price-history-signals-panel.js`, cyan/amber `.radar-val-pill*`
      styles (deliberately not the green/red gate colours), asset token bumped
      `6k4 → 6k5`. No new external fetch, no scheduler, no migration. Detail:
      `docs/radar-valuation-bands.md`.
    - `netlify/functions/_price-history-signals.mjs` provides pure reclaim and
      absorption classification over stored points. `bot.mjs` uses a bounded
      two-pass RADAR refresh: rank without history, read only the first-pass top
      five, then re-evaluate matched rows. An `OK` context can add at most +3
      to `SETUP_SCORE` (+2 confirmed history reclaim only when existing reclaim
      is not explicitly failed; +1 confirmed medium-or-higher confidence
      `history_only` absorption). It never supplies execution data, Flow, OI,
      Funding, safety, strict rolling Absorb, or a bypass for any existing gate.
      All unavailable/unknown/non-confirmed context is explicit and scores zero.
      `telegramEligible` is restored from the first pass, so this context cannot
      create Telegram delivery. No browser orderbook, external fetch, scheduler,
      credential, private endpoint, trading path, or alert sender was added.
    - Authenticated RADAR wiring remains visible and cached per focused base pair;
      `DB_UNAVAILABLE` renders as an explicit degraded/unavailable status with
      unknown signal lines, while HTTP 200 `NO_HISTORY` / `INSUFFICIENT_HISTORY`
      remain waiting states. Generic HTTP/network failures remain `FETCH_ERROR`.
  - **Scheduled price-history collection (LOCAL, UNPUSHED, branch
    `feat/price-history-scheduler`) — production-risk-reviewed, not yet
    enabled:**
    - **Why a second collector:** `admin-price-history-collect.mjs` forwards
      the caller's Supabase JWT to `/api/markets`, which requires a
      cryptographically verified user session
      (`apps/edge/netlify/edge-functions/lib/security.js` `verifyAuth`) — an
      unattended scheduler can never present one without storing a live user
      credential or a service-role key, both rejected as unacceptable. The
      scheduled path instead fetches CoinGecko's public `/coins/markets`
      pages directly (`netlify/functions/_coingecko-markets-source.mjs`,
      approved for this implementation) — no auth, no key, same public
      upstream `/api/markets` itself calls.
    - `netlify/functions/price-history-collect-scheduled.mjs`
      (`/api/price-history-collect-scheduled`, POST-only) — own scheduler
      secret/header (`x-price-history-scheduler-secret` /
      `PRICE_HISTORY_SCHEDULER_SECRET`, timing-safe compare, never
      personal-alerts' secret, never `next_run`-as-auth). Gates in order:
      auth → `PRICE_HISTORY_SCHEDULE_ENABLED` → `PRICE_HISTORY_COLLECT_ENABLED`
      → a DB-backed min-spacing guard (`getLatestSnapshotAt`, default 540s,
      never 0) → the CoinGecko fetch → `PRICE_HISTORY_WRITE_ENABLED`. All
      flags are unset in this phase, so nothing fetches or writes. Unlike the
      admin collector, a write that is attempted and fails returns a
      **non-2xx** status (503 DB_UNAVAILABLE / 502 otherwise) so an
      unattended GitHub Actions job goes red instead of staying green on a
      dead DB.
    - `netlify/functions/price-history-prune-scheduled.mjs`
      (`/api/price-history-prune-scheduled`, POST-only) — same scheduler
      secret; gated by `PRICE_HISTORY_PRUNE_ENABLED` +
      `PRICE_HISTORY_RETENTION_DAYS` (missing/invalid/≤0 deletes nothing).
      Deletes only from `market_price_snapshots` in bounded batches (points
      cascade via the existing FK) — never an unbounded DELETE.
    - `netlify/functions/_price-history.mjs` changed additively: point
      inserts now batch into ~200-row multi-row `VALUES` statements instead
      of one query per row (a 975-coin write was ~975 sequential
      round-trips, close to certain to exceed Netlify's function timeout —
      this was the blocking finding of the risk review); new optional
      `storeRawMeta:false` (scheduled path's default) stores `{}` instead of
      each row's sanitized `raw_meta`, since nothing downstream reads it; new
      `getLatestSnapshotAt` / `pruneSnapshotsOlderThan` exports. Behavior for
      every existing caller is unchanged.
    - New migration `20260721090000_add-price-history-schedule-guard` adds a
      **partial** `UNIQUE` index on `(source, date_trunc('minute', sampled_at
      AT TIME ZONE 'UTC'))`, scoped `WHERE source = 'scheduled_price_history'`
      — makes a double-fire duplicate *scheduled* snapshot structurally
      impossible at the DB level, on top of the application-level spacing
      guard. Scoped deliberately, not global: the manual admin collector
      (source `admin_price_history_collect`) stays completely unconstrained,
      and because `'scheduled_price_history'` is a source value no existing
      row uses, the index matches zero current rows by construction — no
      production collision pre-check is needed before this deploys. Additive
      only; will auto-apply on the next push to `main` alongside the still-
      pending `20260720130902_add-market-price-history` migration.
    - Two new external-scheduler GitHub Actions workflows
      (`.github/workflows/price-history-collect.yml`,
      `price-history-prune.yml`) — `workflow_dispatch`-only for now; their
      `schedule:` triggers are present but **commented out** (rollout
      requires the owner to uncomment them deliberately after the flag-by-flag
      enablement sequence in `docs/price-history-scheduler.md`).
    - **Pre-enablement blockers C1/C3 — fixed (branch
      `fix/price-history-scheduler-preenablement-blockers`, LOCAL,
      UNPUSHED).** Neither was ever reachable in production (every flag
      still unset). C1: an empty/non-array/error-envelope CoinGecko page
      could write an empty snapshot as if it were a success and suppress
      the next real collection — fixed in both
      `_coingecko-markets-source.mjs` (non-array and premature-empty pages
      are now failed pages, never a silent success) and
      `price-history-collect-scheduled.mjs` (independent zero-rows refusal
      before any write, defense in depth). C3: invalid retention on the
      pruner returned HTTP 200 instead of failing the CI job — now returns
      400. C2 (a unique-constraint hit surfacing as `DB_UNAVAILABLE`) is
      still open, optional polish only. Full detail and test coverage in
      `docs/price-history-scheduler.md`'s "Known issues — status" section.
    - No RADAR/ENTRY_READY/trading/alert/Telegram/UI behavior changed. See
      `docs/price-history-scheduler.md` for the full rollout/rollback plan
      and env-flag reference.

## 11. Known completed work / recent milestones

From current git history (most recent first, condensed — see `git log` for full):

- **STALE_EXPIRED frontend UX (LOCAL, UNPUSHED, second commit on
  `fix/canonical-store-consumer-freshness-guards`)** — the server-side expiry
  works, but production presented it as a fault: a red *"Canonical context
  unavailable — Falling back to /api/markets — HTTP 503 —
  {"ok":false,"reason":"STALE_EXPIRED",…}"* card with the raw JSON pasted in.
  Two independent defects behind that one card:
  - **Raw JSON in the toast.** The generic branch threw
    `'HTTP ' + status + ' — ' + body.slice(0,120)`. New pure `_safeHttpReason()`
    emits at most ONE short named field (`reason` / `error` / `detail`, ≤120
    chars) or nothing — never the body, never JSON punctuation. Applied to BOTH
    the canonical read and the /api/markets failure toast.
  - **A red `errors()` entry once per 60s tick.** `js/error-log.js`'s global
    fetch interceptor records EVERY non-2xx, and 503 ⇒ `level:'error'` — so the
    expected expiry became a recurring red entry regardless of which toast fired,
    burying real failures. The interceptor now skips a response our own server
    has stamped `X-Context-Stale: expired`. Deliberately narrow: exact header and
    exact value only, any other value still records, unreadable/absent headers
    still record (fails toward visibility), and the CONSUMER still reports the
    outcome it can actually see — INFO when the live fallback succeeds, a RED
    error naming BOTH sources when it does not. Nothing is swallowed.
  - Classification now prefers the response HEADER over the body, so a truncated
    or unparseable body cannot turn an expected expiry into a scary failure; age
    falls back to `X-Context-Age-Ms`.
  - Wording: `Canonical context stale — Using live /api/markets — published run
    expired (28h old).` at INFO. The genuine-failure red toast is unchanged.
  - Touched: `apps/edge/public/js/terminal.js`,
    `apps/edge/public/js/error-log.js`, `apps/edge/public/index.html`
    (cache-bust `6m4 → 6m5` — frontend assets changed, so the bump is required);
    new `tests/frontend.stale-expired-ux.test.mjs` (18, incl. the REAL error-log
    IIFE run against a mock window); two obsolete wording assertions and five
    cache-token assertions advanced. Suite 2,724 tests / 2,698 pass / 0 fail /
    26 skipped; eslint 0 errors / 163 warnings. No server, gate, trading,
    Telegram, env, collector, migration or scheduler change.
  **NOT pushed, NOT deployed — awaiting owner review.**
- **Canonical store consumer freshness guards (LOCAL, UNPUSHED, branch
  `fix/canonical-store-consumer-freshness-guards`)** — follow-up to the
  `/api/context` hard expiry. Audited every consumer that reads the canonical
  store DIRECTLY and could therefore bypass the endpoint's 30-minute budget.
  Full table in `docs/canonical-context-expiry.md` §3.
  - **Exactly three direct `getAtomizedMarketContext` callers** —
    `context.mjs` (gated, 503), `_personal-watch-notifier.mjs`,
    `morning-briefing.mjs` — plus a **fourth canonical consumer the earlier
    report missed**: `cron-alerts.mjs` via `getPublishedRadar` (the Telegram
    ENTRY_READY path).
  - **Only ONE real hole: `_personal-watch-notifier.mjs`.** It notifies on PRICE
    (big move / take-profit / stop broken) and `evaluateWatchTriggers` receives
    **no timestamp at all**, so it cannot self-protect — a 28h run would have
    sent "your stop broke" off a day-old price. FIXED: it now passes
    `maxAgeMs: PERSONAL_WATCH_MAX_CONTEXT_AGE_MS` (30 min, the same constant as
    `CONTEXT_HARD_MAX_AGE_MS`, asserted equal) with the same `nowMs` clock the
    triggers and cooldowns use, and returns `CONTEXT_STALE_EXPIRED` **before**
    reading recipients and before any `sendMessage`. Reported separately from a
    read FAILURE (`CONTEXT_UNAVAILABLE`) so an aged run is not mistaken for a
    database problem.
  - **`morning-briefing.mjs` was already fail-closed and STRICTER** — this
    corrects the previous report, which listed it as unguarded. `buildMarketContext`
    applies its own `DEFAULT_MAX_DATA_AGE_MS = 15 min` and marks the axis
    `MARKET_STALE`; `gatherBriefingData` then does
    `markets = marketFresh ? ctx.markets : []`, so a stale axis contributes
    NOTHING to the message. Left unchanged on purpose — adding `maxAgeMs` to its
    store read would only flip the reported provenance from canonical to the
    frozen Fleet fallback with no safety gain. Pinned by test instead.
  - **`cron-alerts.mjs` was already fail-closed** — `CANONICAL_RADAR_STALE_MS`
    = 6 min, `RADAR_STALE` refusal before any alert. Pinned by test.
  - **Internal producers** (`_radar-context-publisher.mjs`,
    `_market-context-collector.mjs`) stay flag-disabled no-ops.
  - A test **enumerates every direct caller and fails if a new one appears**, so
    the next consumer cannot be added without a freshness decision.
  - No Telegram message is sent by any test (every sender is a recording stub).
    Telegram credentials, sender resolution and message shape untouched; no
    trading, RADAR gate, env, collector, migration, scheduler, package or
    frontend change — so **no cache-bust bump** (token stays `6m4`).
  - Touched files: `netlify/functions/_personal-watch-notifier.mjs`,
    `docs/canonical-context-expiry.md`, new
    `tests/canonical-store-consumer-guards.test.mjs` (18), and one obsolete
    scope assertion in `tests/canonical-context-expiry.test.mjs` updated (it
    had pinned "personal-watch is deliberately NOT gated", which this branch
    intentionally changes). Suite 2,706 tests / 2,680 pass / 0 fail / 26
    skipped; eslint 0 errors / 163 warnings.
  **NOT pushed, NOT deployed — awaiting owner review.**
- **Canonical context hard expiry — ROOT CAUSE (LOCAL, UNPUSHED, branch
  `fix/canonical-context-expiry-root-cause`)** — `/api/context` was still
  serving a 28-hour-old "canonical" run as a normal 200 body. The browser
  refusing it (shipped earlier) was a second line of defence; this closes the
  first. **Full write-up: `docs/canonical-context-expiry.md`.**
  - **Root cause, three parts, all true at once.** (1) Nothing publishes:
    `MARKET_CONTEXT_COLLECT_ENABLED=false` in production — the emergency cost
    breaker, **deliberate** (Postgres is billed per GB-hour awake and the
    collector's `*/3` schedule sits under the 5-minute sleep timer). The
    collector is **disabled, not broken**: it returns
    `{ok:true,skipped:true,reason:'COLLECT_DISABLED'}` before importing a
    module, connecting or fetching. (2) `getAtomizedMarketContext()` asks for
    *the newest PUBLISHED run* with **no age predicate**, so with nothing
    publishing that is the same row forever. (3) `freshness`
    (`FRESH|STALE|MISSING`) was a **label computed after the read, never a
    gate** — the body went out with 200 either way. Verified production env
    read-only: `MARKET_CONTEXT_COLLECT_ENABLED=false`,
    `MARKET_CONTEXT_RADAR_ENABLED=false`, `MARKET_CONTEXT_BACKGROUND_ENABLED=false`,
    `DB_READS_ENABLED` unset, `CONTEXT_READ_CACHE_MS=180000`.
  - **Decision: option A** (publisher intentionally disabled ⇒ the endpoint must
    fail closed server-side). No env change, no collector re-enable, no
    migration, no scheduler change.
  - **`_market-context-store.mjs`** — `getAtomizedMarketContext()` takes an
    **opt-in** `maxAgeMs` (+ injectable `now`), default `null` = previous
    behaviour byte-for-byte. When set, the run's age is checked immediately
    after the run row is read and **before** the ticker/microstructure queries,
    returning `{ok:false, reason:'STALE_EXPIRED', staleExpired:true, ageMs,
    maxAgeMs, observedAt}`. Fails closed on an unparseable `observed_at` (that
    path used to throw inside `new Date(...).toISOString()` and get swallowed as
    `DB_UNAVAILABLE` — a phantom outage hiding an expired run; now guarded). The
    store's own `freshness` label now uses the same injected clock as the gate so
    label and gate can never disagree. **Cost: strictly cheaper** — an expired
    read skips the two expensive queries (up to 2,000 tickers + 600
    microstructure rows) and adds **no** query on the healthy path.
  - **`context.mjs`** — new `CONTEXT_HARD_MAX_AGE_MS = 30 min` (equal to
    `HARD_MAX_MARKET_AGE_MS` in `js/freshness-badge.js`, asserted by test, so
    client and server draw the line in the same place). An expired run answers
    **`503`** with `{ok:false, reason:'STALE_EXPIRED', stale_expired:true,
    age_ms, max_age_ms, observedAt, detail}` and headers `X-Context-Stale:
    expired` / `X-Context-Age-Ms` / `X-Context-Observed-At` (added to
    `Access-Control-Expose-Headers`). **No ticker, microstructure or RADAR row is
    included, by construction.** The verdict is memoized like a success (global +
    monotonic), and a **memo hit replays the same 503** with the age recomputed
    from `observedAt` so it can never under-report. A real `DB_UNAVAILABLE` stays
    its own distinct 503; auth still 401s first; the `DB_READS_ENABLED=false`
    master switch still wins with its 200 + reason.
  - **`terminal.js`** — recognises `503 STALE_EXPIRED` as the **expected**
    degraded state (tags `canonicalDegraded`), so it reports as INFO and falls
    back to the live `/api/markets` read; a genuine 401/503/network failure still
    gets a red toast.
  - **Deliberately NOT gated (owner decision, documented):**
    `_personal-watch-notifier.mjs` (feeds **Telegram** alerts) and
    `morning-briefing.mjs` both call the same store read and neither has any
    freshness guard of its own — they would read the same 28h run. Because
    `maxAgeMs` defaults off they are untouched here. Recommended follow-up:
    gate personal-watch so alerts fail closed on stale data — but that is a
    behaviour change to an alerting path and needs its own review.
  - Touched files: `netlify/functions/context.mjs`,
    `netlify/functions/_market-context-store.mjs`,
    `apps/edge/public/js/terminal.js`, `apps/edge/public/index.html`
    (cache-bust `6m3 → 6m4`); new `docs/canonical-context-expiry.md` and
    `tests/canonical-context-expiry.test.mjs` (23); five existing cache-token
    assertions advanced. Suite 2,688 tests / 2,662 pass / 0 fail / 26 skipped;
    eslint 0 errors / 163 warnings (identical to baseline — one `no-useless-assignment`
    I introduced was fixed rather than suppressed, which had unmasked 8
    pre-existing suppressed ones as errors).
  **NOT pushed, NOT deployed — awaiting owner review.**
- **Post-deploy freshness diagnostics cleanup (LOCAL, UNPUSHED, branch
  `fix/post-deploy-reliability-cleanup`)** — follow-up to the P0-P2 deploy
  (`f1eefde`), which is confirmed working in production (`REFRESH` →
  `outcome: rebuilt · upstream_status: ok · served_from: live`). Three
  leftovers, no behaviour regression:
  - **Canonical fallback noise.** Every boot logged *and red-toasted*
    `[CANONICAL] /api/context read failed` because the published run is ~27h
    old. That is the EXPECTED state of a store whose publishing collector is
    deliberately off, and the terminal has a working answer (the live
    `/api/markets` read) — so a red toast on every boot only teaches the owner
    to ignore toasts. The refusal now carries a tag (`err.canonicalDegraded`),
    and the caller splits the two cases: an EXPECTED aged run is
    `Toast.info('Canonical context stale', 'Using live /api/markets — …')` plus
    a `console.warn`, which — because `toast.js` forwards only `error`/`warn`
    to `ErrorLog` — adds **no entry to `errors()`**. A GENUINE failure
    (401/503/network/parse) keeps its `console.warn` + red toast, unchanged.
    The aged rows are still REFUSED in both cases. If the live read then fails
    too, the market-failure toast names the combination outright
    (*"Canonical context is also unusable (…) — no usable market source right
    now"*) plus a `console.error`, so downgrading the notice cannot make a real
    outage quieter. The RADAR panel now says `/api/context is STALE — …; the
    live /api/markets feed is in use` for the degraded case instead of
    `failed`.
  - **RADAR scanner-context post — PROVED, not asserted.** The five blocking
    conditions are now checked and named separately (no market read yet /
    `ok:false` / no `generatedAt` / hard-stale-unavailable / soft-stale),
    each returning with its own reason, evaluated in the same tick as the post
    with no `await` in between, and BEFORE the throttle so the operator is
    never told "throttled" when the data is the real problem. A post now logs a
    proof object — `{market_fresh, source, age_ms, generated_at, rows,
    rows_available, trigger}` — and the completion line repeats it; a skip logs
    `{market_fresh:false, skipped_reason}`. Both are readable from
    `window.__lastRadarContextPostProof`. The 45s throttle is unchanged and
    still uncancellable; the 500-row cap is unchanged. **The gate is executed
    in tests**, not just pattern-matched: `pushScannerContextToRadar` is lifted
    out of the bundle and run with stubs, proving fresh→POST and each unfit
    state→BLOCKED. No RADAR gate, ENTRY_READY rule, Telegram field or order
    path touched.
  - **Quirks mode — attributed, no code change.** `index.html` starts with
    `<!DOCTYPE html>` (no BOM, no leading bytes) and production **measured**
    `document.compatMode === 'CSS1Compat'`, i.e. standards mode. The app also
    has no `document.write`, no `document.open`, and no `srcdoc` iframe, so it
    cannot create a second doctype-less document. The browser's "backward
    compatibility mode" report therefore comes from another frame on the page
    (extension or embedded third-party iframe), not from this document. Tests
    pin all of it.
  - Touched files: `apps/edge/public/js/terminal.js`,
    `apps/edge/public/index.html` (cache-bust `6m2 → 6m3`); new
    `tests/post-deploy-freshness-diagnostics.test.mjs` (25); four existing
    cache-token assertions advanced. Suite 2,665 tests / 2,639 pass / 0 fail /
    26 skipped; eslint 0 errors / 163 warnings. Nothing outside `apps/` and
    `tests/` changed — no env, migration, package, scheduler or workflow.
  **NOT pushed, NOT deployed — awaiting owner review.**
- **Production reliability P0-P2 hotfix (LOCAL, UNPUSHED, branch
  `fix/production-reliability-p0-p2`)** — after the manual-refresh freshness
  hotfix the browser still showed: REFRESH returning `age_ms 93382647` (~25.9 h)
  with `force_outcome: null`, a stream of failed Supabase
  `token?grant_type=refresh_token` posts, a foreground RADAR context POST every
  45 s, `[TAB-ORDER] tab-order.js not loaded`, and a recurring `/api/analyze`
  400.
  - **P0 root cause — the click never reached `/api/markets` at all.**
    `index.html` sets `window.RADAR_CANONICAL_CONTEXT_READ = true`, so
    `fetchData()` reads the canonical **`/api/context`** store first. That
    endpoint is DB-backed, answers 200 instantly with the last *published* run,
    and the publishing collector is deliberately OFF — so it returned a
    25.9-hour-old snapshot. `?force=1` was never sent, no `X-Force-Refresh`
    header ever came back (hence `force_outcome: null`), and every cache-layer
    fix from the previous hotfix was irrelevant because that code path never
    executed. Fix: a **forced** read now bypasses the canonical store entirely
    (`const _canonical = _canonicalContextEnabled() && !force`) and goes
    straight to `/api/markets?force=1`. `/api/context` is still never given a
    force flag, so a click still cannot wake Postgres.
  - **P0 second cause — `Access-Control-Expose-Headers` was missing** on
    `/api/markets`, so a cross-origin reader could not read *any* of the
    freshness/force headers. Added, listing only non-secret diagnostics
    (`X-Served-From`, `X-Stale`, `X-Stale-Reason`, `X-Generated-At`, `X-Age-Ms`,
    `X-Force-Refresh`, `X-Force-Refresh-Retry-After-Ms`, `X-Upstream-Status`,
    `X-Tier`, `X-Markets-Schema`).
  - **P0 — a forced read can no longer report a null outcome.** New
    `X-Force-Refresh: upstream-failed` on the last-good fallback AND on the 502
    (repeated in the 502 body as `forceOutcome`), plus `X-Upstream-Status`
    (`ok` / `rebuild-failed-serving-last-good` / `rebuild-failed-no-snapshot`).
    In the browser, a forced read with an unreadable header records
    `unknown-force-header-unreadable` instead of `null`, and says so.
  - **P0 — new HARD age ceiling `HARD_MAX_MARKET_AGE_MS = 30 min`** (edge
    `lib/freshness.js` + browser `js/freshness-badge.js`, kept in sync and
    asserted equal by a test). Past it the dataset is not "stale market data",
    it is **not market data**: the source badge goes red `UNAVAILABLE`, a
    `MARKET DATA UNAVAILABLE — <reason>` banner is painted above the scanner,
    and the table + detail panel are hard-dimmed. A canonical read that comes
    back beyond the ceiling is treated as a **failed** read, so the existing
    honest fallback runs (visible toast, `__canonicalContext.failed = true`,
    legacy `/api/markets` feed). A 25.9 h book can no longer be replayed as
    scanner truth. Fails closed: unknown age / failed fetch → unavailable.
  - **P1 Supabase refresh spam.** The compatibility client was created with the
    SDK defaults, so it adopted a leftover `sb-<ref>-auth-token` from the
    pre-native era and ran its own refresh loop against a dead refresh token.
    When native auth is the active source the client is now created with
    `autoRefreshToken:false, persistSession:false, detectSessionInUrl:false`,
    and the stale `sb-*-auth-token` keys (that exact pattern only) are removed.
    When native auth is NOT active the SDK defaults are untouched, so a legacy
    Supabase-only user is unaffected. Supabase is **not** removed, no user
    migrated, `js/auth-client.js` **not modified**.
  - **P1 RADAR foreground context POST.** It posted up to 500 scanner rows on
    every refresh cycle behind a 45 s window that any UI action could reset by
    nulling `window.__lastRadarContextPush` — and while the market read was
    25.9 h stale it was posting *that book* as current scanner truth. The
    freshness gate and the throttle now live **inside**
    `pushScannerContextToRadar()`: stale or unavailable market data ⇒ no post,
    with the reason on `window.__lastRadarContextPostStatus` and in the
    console; the 45 s floor is unchanged and no caller can reset it. Row cap
    stays 500 (the server's own limit). **No RADAR gate, ENTRY_READY rule,
    Absorb rule or Telegram field was touched.** Note for the operator: the
    stale gate uses the existing `MARKET_MAX_AGE_MS = 180 s` budget, so if the
    canonical collector is ever re-enabled on its ~3 min publish cadence this
    path will report itself blocked — the reason is printed, and the budget is
    the thing to revisit, not the gate.
  - **P1 boot order.** The native session restore was a bare IIFE running during
    `terminal.js`'s own evaluation. A stored, still-valid token is adopted with
    no network round trip, so the whole app booted mid-parse: above
    `const DEFAULT_COLUMN_ORDER` (TDZ) and before the deferred ES modules had
    executed (`window.__tabOrder` absent ⇒ the saved tab order silently
    discarded). Now gated on `DOMContentLoaded` when the document is still
    parsing, `queueMicrotask` otherwise, and `initTabOrder()` retries once at
    `DOMContentLoaded` instead of concluding the module is missing.
  - **P2 `/api/analyze` 400 was AUTOMATIC.** The 5-minute news loop POSTed
    `symbol: '__NEWS_SCORING__'`; `/api/analyze` is a per-symbol endpoint and
    `normalizeBinanceSymbol` rejects underscores, so it answered
    `400 Invalid symbol format` every time and the code then fell through to
    the keyword heuristic anyway — the batch headline-scoring contract that
    payload assumed was never implemented server-side. The call is removed (the
    feed renders exactly as before, from the heuristic that was already doing
    the work) and the unavailability is logged once. The user-click path gets a
    calm `400` branch: warn level, endpoint's own short reason only, no prompt
    / model / key / payload echoed.
  - **P2 doctype.** `index.html` already begins with `<!DOCTYPE html>` (no BOM,
    no leading bytes) — verified, nothing to fix; a regression test now pins it
    and also forbids `document.write` / `srcdoc` pages.
  - Touched files: `apps/edge/netlify/edge-functions/lib/freshness.js`,
    `apps/edge/netlify/edge-functions/markets.js`,
    `apps/edge/public/js/terminal.js`, `apps/edge/public/js/freshness-badge.js`,
    `apps/edge/public/js/ai-analysis.js`, `apps/edge/public/index.html`
    (cache-bust `6m1 → 6m2`), `apps/edge/public/css/terminal.css`; new
    `tests/production-reliability-p0-p2.test.mjs` (45). No env var, no
    migration, no scheduler/cron/workflow, no `package.json`, no
    trading/order/Binance-signing/Telegram path, no Arkham file.
  **NOT pushed, NOT deployed — awaiting owner review.**
- **Manual REFRESH market-freshness hotfix (LOCAL, UNPUSHED, branch
  `fix/manual-refresh-freshness`)** — the top-bar REFRESH button could not
  produce fresh data, and a stale dataset still rendered confident per-coin
  numbers. Root cause was three independent cache layers with no force path
  plus a servedFrom-only staleness test:
  1. `fetchData()` issued a plain `fetch('/api/markets')`, answerable from the
     **browser HTTP cache** and from the **Netlify CDN entry**
     (`public, s-maxage=30, stale-while-revalidate=60`), so a click inside that
     window returned byte-identical frozen bytes.
  2. `/api/markets` had no way to be told "rebuild": a force click could not
     bypass the 30 s in-isolate `_responseCache`, and the **stale last-good
     fallback was itself sent with `public, s-maxage=30` and only
     `Vary: Origin`** — so a frozen body got parked in the CDN and replayed
     (across tiers).
  3. `doRefresh()`'s in-flight dedupe attached a user click to whatever
     background tick was already running — i.e. to a cache read.
  4. Staleness was `servedFrom !== 'live'` only, with **no age test**, so an
     aged snapshot could still wear the green LIVE badge, and the detail panel
     showed e.g. a 48-minute-old `+35.20%` (VELVET) exactly like a live number.
  Fix, additive and reversible: `?force=1` / `X-Force-Refresh: 1` on the
  **public market read only** (parsed *after* origin + auth, so it can never
  skip a gate) → edge skips its response cache, rebuilds via the existing
  `buildMarketsBodyDeduped()` singleton, answers `no-store`, and reports the
  outcome as `X-Force-Refresh: rebuilt|throttled`; forced rebuilds are bounded
  by `FORCE_REBUILD_MIN_INTERVAL_MS = 10 s`. The stale fallback is now
  `no-store` + `Vary: Authorization, Origin`. New age budget
  `MARKET_MAX_AGE_MS = 180 000` (`freshnessVerdict`, `X-Stale-Reason`) is
  enforced **in the browser** on every paint, because CDN/isolate delay is
  added after the header is written. Stale mode degrades honestly: prominent
  `STALE` badge, amber timestamp, a detail-panel banner, dimmed SIGNAL / SCORE
  / PANIC / lead-score, 24h % rendered `STALE`, and an unreported 24h rendered
  `UNKNOWN` (new `_c24Known` flag — never a fabricated `0.00%`, never derived
  from the 24h range or the current price). Button gets a loading state; a
  refresh that comes back still stale says so. **Cost posture unchanged**: no
  DB-heavy read is ever forced (`/api/context` gets no force flag), no
  collector re-enabled, no price-history write, background cadences untouched
  (60 s steady state / 10 s emergency). Touched files:
  `apps/edge/netlify/edge-functions/lib/freshness.js`,
  `apps/edge/netlify/edge-functions/markets.js`,
  `apps/edge/public/js/freshness-badge.js`,
  `apps/edge/public/js/terminal.js`, `apps/edge/public/index.html`
  (cache-bust `6l5 → 6m1`), `apps/edge/public/css/terminal.css`; new tests
  `tests/backend.markets-force-refresh.test.mjs` (19) and
  `tests/frontend.manual-refresh-freshness.test.mjs` (31).
  **NOT pushed, NOT deployed — awaiting owner review.**
- **Arkham Intel skeleton (LOCAL, UNPUSHED, branch `feat/arkham-intel-skeleton`)**
  — advisory on-chain entity intelligence (Arkham, `api.arkm.com`), **disabled by
  default and NOT deployed**. Full research + design in
  `docs/arkham-intel-integration.md`: access is request/trial-based (not
  self-serve); subscriptions are credit-based and publicly "start at $100" but no
  per-tier or per-credit USD price is public; billing is per-call **and per-row**
  (a loose `/transfers` query is an unbounded bill) and WebSocket v2 charges **2
  credits per delivered transfer**, so no stream is used; heavy endpoints
  (transfers, token data, search, counterparties, flow, batch) are capped at **1
  req/s**, which rules out any fan-out over a coin list. Auth is an `API-Key:`
  header. New: `netlify/functions/_arkham-client.mjs` (single-host allowlist,
  bounded, **no retry**, per-instance credit guard, key never logged/returned) and
  `netlify/functions/arkham-token-intel.mjs` → `/api/arkham-token-intel?symbol=…`,
  auth-gated the same way as `/api/cockpit-radar-state`, answering HTTP 200
  `DISABLED` / `NOT_CONFIGURED` / `COST_CAPPED` / `IDENTITY_UNRESOLVED` with **no
  external call**. Defaults are all off: `ARKHAM_ENABLED=false`,
  `ARKHAM_DAILY_CREDIT_CAP=0`, `ARKHAM_CACHE_TTL_HOURS=24`,
  `ARKHAM_MAX_SYMBOLS_PER_REQUEST=1` — **none of these env vars has been set**.
  UI: a disabled "Arkham Intel" placeholder card in the Cockpit RADAR focus panel
  that never fetches on render; its only request is one manual "Check Arkham Intel
  status" button. **Advisory only** — nothing touches RADAR, `ENTRY_READY`, strict
  Absorb, Reclaim, Telegram, alerts, Scanner ranking/Lead Score/sorting,
  valuation, the gate checklist, or any order path, and
  `tests/arkham.safety.test.mjs` walks the source tree to keep it that way. No
  scheduler, no cron, no background collector, no WebSocket, no new dependency, no
  migration. Arkham's API Terms licence use to **internal business purposes** and
  forbid redistribution to third parties, which is a second, independent reason
  Arkham data may never reach Telegram or any public artifact. Blocking item
  before it may ever be enabled: the in-memory credit guard counts per warm
  instance, so it must be replaced by a durable Netlify Blobs counter first (see
  the checklist in the doc).
- **Netlify credit-drain fix (LOCAL, UNPUSHED, branch `fix/netlify-credit-drain-audit`)**
  — full audit in `docs/netlify-cost-audit.md`. Root cause: `connectStream()`
  takes the dead-infra branch (`LEGACY_FLY_STREAM_ENABLED === false`, the Fly.io
  WS is decommissioned) and called `_enableAggressivePoll()` — the **10s
  emergency cadence** — whose only disable path is the WS `onopen` handler that
  can never run in this build. So every open tab ran a full `doRefresh()` every
  10 seconds forever, including in a hidden background tab: `/api/context`
  (a Node function doing **four Postgres queries**, up to 2,000 ticker + 600
  microstructure rows, `no-store`) plus `/api/markets` plus `/api/regime`.
  ~8,600 Postgres reads/day/tab, which is the database-compute, functions-compute
  and bandwidth bill at once, and it kept the database from ever idling.
  Secondary: `_stopFleetPoll()` was **never called anywhere**, so one visit to
  the BOT or RADAR view left `/api/bot/fleet` polled every 4s for the rest of
  the session; and `/api/orderbook` polled every 1.5s in hidden tabs.
  Fixes: a poll cost governor (`_pageIsActive()` / `_pollTickAllowed()`) that
  defers every *recurring* tick while the tab is hidden, counts and logs the
  skips on `window.__pollGovernor`, and does one catch-up refresh on
  `visibilitychange`; a 60s steady-state cadence (`_enableRestPoll()`,
  `STREAM_REST_POLL_DEFAULT_MS`, override floored at the emergency cadence)
  replacing the 10s one; in-flight dedupe in `doRefresh()` (body moved to
  `_doRefreshCore()`); and `_stopFleetPoll()` now actually called when neither
  owning view is open. Backend: `/api/context` gained a 30s in-function read
  memo (ceiling 180s, `CONTEXT_READ_CACHE_MS=0` disables) plus concurrent-read
  coalescing — safe because the read takes **no identity input**, auth is still
  enforced before the memo, `freshness` is **recomputed on every serve** so a
  memo can never claim FRESH once stale, and failures are never memoized or
  masked. Untouched on purpose: trading/order path, ENTRY_READY, Telegram,
  `cron-alerts.mjs`, auth, every env var, every migration. Env/dashboard
  recommendations are written up but **not applied** — the highest-value one is
  verifying database scale-to-zero/autosuspend in the Netlify dashboard.
- **Customizable top tab order (LOCAL, UNPUSHED, branch `feat/custom-tab-order`)**
  — the 14 main nav tabs can be reordered and the order persists per browser in
  `localStorage['terminalX.tabOrder.v1']`. Resolution lives in the pure
  `apps/edge/public/js/tab-order.js`: unknown/stale/duplicate saved ids are
  dropped and tabs missing from a saved order are appended, so a customized user
  still receives a newly shipped tab. Reorder mode injects ◀/▶ buttons (works on
  desktop and touch; their handler stops propagation so moving never switches
  view), plus a RESET that clears the key. Reordering moves the EXISTING nodes
  with `appendChild`, so a tab can never be duplicated and the active tab keeps
  its `.on` class and its view. Order-only personalization: no new views, no
  workspaces, no parallel mounted panels; `sv(view, el)` is untouched and remains
  the single switcher. Also fixed three call sites that grabbed "the first tab"
  and assumed it was SCANNER — with a reordered bar that highlighted the wrong
  tab and could resolve the wrong view via its `data-target`. Asset token → `6l1`.
- **Advisory Scanner "Lead Score" (LOCAL, UNPUSHED, branch
  `feat/scanner-lead-score`)** — one new Scanner column scoring 0–100 /
  LOW·MED·HIGH·EXTREME·UNKNOWN for "is the futures side leading the spot move?".
  Pure model in `apps/edge/public/js/scanner-lead-score.js` (no DOM, no fetch,
  no globals but its own export bridge). Six optional components: futures/spot
  premium, futures/spot 24h volume, futures-vs-spot 24h move, OI change,
  funding, taker flow. **No new external fetch:** `/api/markets` already pulled
  both the spot and futures Binance tickers and threw one away, and the
  canonical `/api/context` feed already carried a row per venue that
  `_dedupeCanonicalByBase` collapsed — both now keep the discarded side in an
  additive `_leadVenue` snapshot. Fails closed: UNKNOWN without at least one
  futures-vs-spot comparison, missing components are listed in the cell
  tooltip, thin/conflicting evidence is damped and capped (one component can
  never exceed MED; EXTREME needs ≥3 components, ≥2 of them strong, and no
  contradiction). Funding comes only from the real `/api/funding-divergence`
  feed — never the dead `_funding: 0` / `_takerRatio: 0.5` placeholders.
  **Advisory only:** not sortable, not the default sort, and absent from
  RADAR/`ENTRY_READY`/gates/Telegram/alerts/auto-trader/cockpit/order paths
  (asserted in `tests/frontend.scanner-lead-score.test.mjs`).
  `MARKETS_SCHEMA_VERSION` → `v7_2_venue_split`; asset token → `6k8`.
- **Native auth backend, phase 2 (LOCAL, UNPUSHED, branch
  `feat/native-auth-foundation`: `98c958d` → `47c09b8` → `19eaf15`)** — auth
  moved off Supabase into the Netlify/Neon DB, **complete on the backend and
  disabled by default**; the browser still signs in through Supabase, so the
  terminal UI switch is the remaining piece. New: `app_users` +
  `app_user_audit` migration, `_password.mjs` (scrypt via node:crypto, no new
  dependency, self-describing hash so cost can be raised later),
  `_native-jwt.mjs` + a second Deno-edge verifier kept byte-compatible by a
  cross-runtime test, `_user-store.mjs`, and three endpoints
  (`/api/auth-login`, `/api/auth-refresh`, `/api/admin-users`).
  **Passwords are NOT migrated** — Supabase's are bcrypt and Node has no native
  bcrypt, so the owner sets fresh ones via the admin page.
  Gated behind `NATIVE_AUTH_ENABLED === 'true'` + a ≥32-char `AUTH_JWT_SECRET`;
  with the flag off a native token is refused and Supabase is untouched
  (asserted, not assumed). Both sources work while the flag is on, so the
  cutover is reversible by one env var.
  **Authorization did not change:** `app_users.role` grants nothing — admin
  stays `BOT_ADMIN_EMAILS` only, and `/api/admin-users` additionally requires
  `identity.verified === true`. That also solves the first-account problem with
  no bootstrap secret: the owner creates native accounts using their existing
  Supabase admin session.
  Verification is stateless (no DB read on the hot path); revocation is
  therefore disable/reset → effective at the next refresh (≤ 1 TTL), or rotate
  `AUTH_JWT_SECRET` for immediate global revocation. Login is deliberately
  non-enumerable: unknown email / wrong password / disabled / locked all return
  a byte-identical 401. See §9 and `docs/native-auth.md` for the rollout order.
- **Error observability + static analysis, phase 1 (LOCAL, UNPUSHED, branch
  `feat/error-observability-lint`)** — three things:
  1. **A production bug found and fixed.** `normalizeOpenPositionsSummary()`
     in `netlify/functions/bot.mjs` read `body.mode` from a module-scope
     helper where the request `body` is not in scope, so **every
     `worker-heartbeat` that actually carried an open position threw
     `ReferenceError: body is not defined` and answered 500** (reproduced
     directly). The worker logs that HTTP failure and continues, so the
     control plane silently lost track of open positions. Every pre-existing
     heartbeat test passed `openPositions: []`, which is why it was never
     caught. Fixed by passing `reportedMode` in explicitly, fail-closed (only
     an explicit `'live_spot'` counts as live). The record's `testnet` flag
     was also hardcoded `true`; that is worse than the crash, because the
     worker hydrates backend records and then branches on `pos.testnet` when
     closing — a live position labelled testnet gets a **simulated** paper
     close, reporting the position closed while real money stays exposed. It
     now tracks `mode`. Regression coverage:
     `tests/bot.open-position-report.test.mjs`. Also removed two duplicate
     object keys in `bot.mjs` (`candidate`, `stopRequested` — both identical
     expressions, so no behaviour change) and a real `TypeError` risk in
     `terminal.js` where `|| ''` only guarded the spot branch of a ternary.
  2. **Central client error log** — `apps/edge/public/js/error-log.js`, loaded
     first in `index.html`. A `window.fetch` interceptor records every non-OK
     response and network failure; `toast.js` forwards all ~67 existing
     `Toast.error/warn` call sites. Owner types **`errors()`** in devtools for
     a table of every failure with its reason. URLs are redacted (tokens),
     response bodies are never read, repeats fold into a counter.
  3. **Static analysis** — ESLint 10 + `tools/eslint/repo-contract-plugin.mjs`,
     which turns the non-negotiable rules into build errors
     (`no-silent-catch`, `no-indistinguishable-catch-return`,
     `no-sensitive-log`). `npm run lint` is now a required gate alongside
     `npm test`; `.github/workflows/static-analysis.yml` runs both.
     241 pre-existing violations are held in `eslint-suppressions.json` so
     the gate applies to new code; `npm run lint:debt` reports the remainder
     (154 silent catches, 126 of them in `terminal.js`). **No secret-logging
     violations exist in the repo** — that rule found zero real hits.
     Full detail: `docs/error-observability.md`.
- **Price-history RADAR chain (LOCAL, UNPUSHED — `c26652a` → `3d75047` → `d6e047e`)** — advisory frontend readiness overlay; bounded top-five backend context; then a max +3 setup-only score support. Unknown/degraded context is zero; Flow/OI/Funding, safety, failed reclaim, strict rolling absorption, all existing gates, and baseline Telegram eligibility remain required/unchanged. Runtime safety review passed; no fetch, scheduler, credential, private endpoint, orderbook input, trading path, or alert sender was added.
- **Scheduled price-history collection (LOCAL, UNPUSHED, branch
  `feat/price-history-scheduler`)** — production-risk review completed
  (GO), then implemented: two new POST-only, own-scheduler-secret Node
  functions (`price-history-collect-scheduled.mjs`,
  `price-history-prune-scheduled.mjs`), a batched-insert + `storeRawMeta`/
  `getLatestSnapshotAt`/`pruneSnapshotsOlderThan` update to
  `_price-history.mjs`, a new duplicate-snapshot DB guard migration, and
  two GitHub Actions workflows with their `schedule:` triggers commented
  out. Every new flag defaults off; nothing fetches CoinGecko or writes to
  the DB until the owner enables each flag in the documented order. See §10
  and `docs/price-history-scheduler.md`.
- **Market price-history collector + orderbook context wired (LOCAL,
  UNPUSHED)** — admin-only, POST-only `/api/admin-price-history-collect`
  fetches same-origin `/api/markets` and forwards rows to the existing
  writer; both `PRICE_HISTORY_COLLECT_ENABLED` and `PRICE_HISTORY_WRITE_ENABLED`
  default off, so nothing fetches or persists without both flags set. A new
  `_orderbook-client.mjs` Node bridge lets `/api/admin-price-history-signals`
  use the authenticated `/api/orderbook` Deno route as best-effort context
  (`orderbookUsed`/`orderbookReason` degrade safely on any failure). No
  trading, RADAR gates, ENTRY_READY, alerts, Telegram, or Supabase auth
  behavior changed. A push still auto-applies the pending migration.
- **Cockpit market maps overhaul/polish (LOCAL, UNPUSHED — `…bd0306f`)** —
  interactive market panels/maps UI work; bubbles-overlap polish intentionally
  deferred. The deferred heatmap design work was done later: the canvas treemap
  was replaced by the terminal-v4 uniform tile grid (see the dated entry at the
  top of this file).
- **Database foundation (Phase 2B, `294c72e`, pushed/deployed)** — Netlify
  Database enabled; first migration creates `system_events` + `ingest_runs`
  only; unused `_db.mjs` connection helper; DB tests skip gracefully without
  a local dev DB. Trading bot, RADAR, alerts, and Supabase auth untouched.
  See §10 for the full state and the migration-auto-apply-on-push warning.
- **RADAR positioning context** — long/short positioning context parser + wiring,
  context-only positioning readiness, source guards (`edba29b`…`9fd340f`).
- **RADAR ↔ Cockpit import hardening** — explicit RADAR selection required for
  import, entry-type mapping, panel overflow fixes (`80747d9`, `0d9d9ac`,
  `2cea482`).
- **RADAR summary-first detail + context panels** — Trade Readiness summary,
  Pressure Zones proxy (`68dd1ac`, `1dfb0a1`, `a82ff05`, `b615cdf`).
- **Cockpit** — market-wide funding context, trader context review checklist,
  safe manual-trade validation (`a98ab04`, `fcdae41`, `eb77511`).
- **GECKO** — CoinGecko Highlights panel + edge function + parsing/layout fixes
  (`8f16c69` and the `fix(gecko): …` series).
- **RADAR microstructure** — provider abstraction + fail-closed `none` default,
  rolling absorb pipeline (design), klines snapshot → reclaim pipeline.
- **Bot Fleet + Live Spot** — multi-user testnet control plane, gated live-spot
  micro-cap path, on-demand local worker + install/pairing flow.
- **Frontend safety** — observation-only change digest, gecko degraded/stale
  handling, AI-format XSS hardening, url-safety.

Keep this as operational memory, not a full changelog.

## 12. Known decisions / rejected ideas

- **No production microstructure scraping cron.** Binance public fapi is 451
  region-blocked from Netlify/GitHub egress; the team will **not** chase
  proxies/extra servers/Render to work around it. `MARKET_DATA_PROVIDER=none` is
  the intended production default.
- **Existing Binance scope remains Spot only** — no Binance futures, margin,
  leverage, or withdrawals. KuCoin EU Spot + Futures is a separate,
  documentation-first, backtest/paper-first direction and remains LIVE_LOCKED
  until a later explicit owner approval; see docs/kucoin-architecture.md.
- **KuCoin EU bot direction (documentation only):** target Spot + Futures and
  USDT + USDC; Alpaca is dropped. Start from server-side Trading RADAR V1 gates,
  then backtesting and simulated/paper trading. Normal users need no local
  worker; Netlify is UI/control plane, not an always-on Futures daemon. Initial
  Telegram is notification-only; no IP rotation/bypass and no Telegram commands.
- **RADAR backend-field mapping complete (documentation only):** docs/trading-radar-backend-field-mapping.md verifies that V1 STATUS plus actionability, allRadarConditionsPassed, gates, safety, freshness, and levels are the future source of truth. Matrix labels, UI summaries, and advisory context cannot drive a TradeIntent; stale/unknown strict Absorb is never positive automated-entry evidence. No current RADAR or Telegram behavior changed.
- **Pure future TradeIntent prerequisite validator (local-only):** scripts/radar/trade-intent-candidate-validation.mjs validates an already-produced RADAR candidate only. It has no imports, fetches, client/worker/Telegram/order wiring, or clock fallback; callers must supply the time and a supported normalized symbol/product mapping. It fails closed on non-V1 readiness, safety/gate/level/freshness failures, advisory data, invalid reclaim, and non-fresh strict Absorb. No current RADAR or Telegram behavior changed.
- **Versioned historical candidate replay fixtures (test-only):** `tests/fixtures/radar-trade-intent-candidates.mjs` provides sanitized, in-memory V1 candidate snapshots with an explicit capture clock, fixture/schema versions, mappings, and expected stable validator reason codes. The replay contract is deterministic and local-only; it introduces no historical data fetch, backtest engine, runtime wiring, or RADAR/Telegram behavior change.
- **Historical-data ingestion contract (pure/local-only):** `scripts/radar/historical-data-contract.mjs` plus `docs/historical-data-contract.md` define versioned UTC-aligned historical candle provenance and validation for future RADAR backtests. Depth and missing Futures evidence stay `UNKNOWN`; strict Absorb/actionability remain `NOT_RECONSTRUCTABLE` unless a compatible stored V1 candidate is supplied. No fetch, persistence, adapter, scheduler, backtest engine, or RADAR/Telegram runtime behavior was added.
- **RADAR backtest skeleton (pure/local-only):** `scripts/radar/radar-backtest-engine.mjs` replays one supplied validated historical candidate fixture against supplied candle data, with explicit costs and a deterministic event trail. It remains a long-only single-position simulator: no fetching, persistence, adapter, runner, paper/live execution, orders, or current RADAR/Telegram runtime wiring. Strict Absorb/actionability still require the stored V1 candidate evidence; Futures are capped at 2x isolated and default to 1x.
- **Backtest sizing/fill/accounting contract (pure/local-only):** `docs/backtest-simulation-contract.md` and the backtest engine now define deterministic fixed-notional, percent-equity, and stop-risk sizing; conservative fills/costs; sequential positions; separate USDT/USDC ledgers; equity curves; and risk veto reason codes. It remains simulated-only: no fetch, persistence, adapter, scheduler, runner, orders, or RADAR/Telegram runtime wiring. Futures stays isolated, 1x default, 2x maximum, with unknown liquidation reported rather than inferred.
- **Synthetic portfolio scheduling scenarios (test-only):** `tests/fixtures/radar-portfolio-scenarios.mjs` defines versioned multi-symbol fixture cases. `runRadarPortfolioBacktest` sorts by timestamp, priority, symbol, then fixture ID and carries only simulated balances/daily loss/open-position state. It has no market-data integration or runtime wiring; stale evidence fails before sizing/fill.
- **Synthetic portfolio edge-case contract (test-only):** tests/fixtures/radar-portfolio-edge-scenarios.mjs and tests/radar-portfolio-edge-scenarios.test.mjs define versioned partial-fill, candle-gap, UTC daily-boundary, funding-evidence, dataset-end, quote-loss-scope, global-loss, and fill-time freshness cases. The pure engine cancels unfilled entry remainder, marks a partial-exit remainder at supplied dataset end, rejects gaps without optimistic fills, reports missing funding as funding_unknown, and never changes RADAR/Telegram/live behavior.
- **KuCoin public-candle backtest MVP (local-only):** scripts/radar/kucoin-public-candles.mjs and scripts/radar/run-kucoin-radar-backtest.mjs provide a one-shot Spot candle fetch/cache/normalization/validation/backtest/report flow using only the exact public KuCoin HTTPS candle endpoint. It has no auth headers, private calls, credentials, orders, adapters, scheduler, persistent runner, Telegram, or live wiring. The report labels RADAR actionability and Strict Absorb as supplied fixture evidence only, not reconstructed historical truth; generated artifacts/cache are Git-ignored. Futures remains deferred pending separate evidence mapping.
- **No live trading by default** — live is opt-in, admin-only, micro-cap, gated.
- **STOCKS is a SEPARATE project** (`stock-terminal-X`), *not* a mode/page inside
  this terminal. Do not add stock features here. _(From project memory; verify if
  it becomes relevant.)_
- **No Stripe / billing / referral / broker-command system** — that belongs to the
  unrelated realitni_bot project, not here.

## 13. Current / likely next priorities

_(Grounded in git + docs; do not over-invent.)_

- Keep this handoff **and** `AGENTS.md` / `docs/` synchronized after behavior
  changes (§16).
- **Current local state:** branch `integrate/canonical-context` (HEAD `91de7ab`,
  pushed) carries the whole canonical-context line; **`origin/main` = `cf426d3`**
  is deployed and the branch is **not merged**. Next step is owner review + merge
  approval — a merge/push to `main` auto-applies all still-pending migrations
  (price-history + the `20260724…`/`20260726…` market-context/absorb set) to
  production. Keep `RADAR_ALERTS_CANONICAL_SOURCE`, `RADAR_TELEGRAM_ENABLED`, and
  `PERSONAL_WATCH_TRIGGERS_ENABLED` unset until a separate enablement approval.
- **Next DB phase:** the scheduled collector/pruner (branch
  `feat/price-history-scheduler`) is implemented and tested but **not
  enabled** — follow `docs/price-history-scheduler.md`'s flag-by-flag
  rollout (secret → `workflow_dispatch` disabled-checks → `SCHEDULE` →
  `COLLECT` → `WRITE` → cron at 30min soak → 15min → prune) before any
  `schedule:` cron is uncommented. The analytics layer remains
  admin-debug/context-only throughout.
- Continue RADAR **positioning / pressure-zone / trade-readiness** context work
  (the active line of commits) — additive, context-only, fail-closed.
- Security-review Personal Watch Phase 4 before any push/deploy, and keep
  `PERSONAL_ALERTS_ENABLED` unset/false until a separate enablement approval.
- Rolling microstructure remains **design-only** until real measurement can be
  honestly sourced — do not ship a producer that fabricates fields.
- Verify production behavior after any approved Netlify deploy.
- **Standing warnings from Phase 2B:** a push to `main` auto-applies any
  pending Netlify Database migration to production — review migrations with
  the same care as the deploy itself. Do not write market data, do not
  implement reclaim/absorption, and do not remove/migrate Supabase auth as
  side effects of DB work. Trading bot stays frozen and untouched throughout.

## 14. Runbook snippets (safe, sanitized — use placeholders)

```powershell
# Run the full test suite (Node's built-in test runner)
npm test

# RADAR microstructure producer — LOCAL diagnostic ONLY (public data, no keys).
# Production default is provider=none (zero external calls); do not schedule this.
$env:MARKET_DATA_PROVIDER='binance-public'
node scripts/radar/radar-microstructure-producer.mjs

# Live Spot preflight (operator machine, .env.worker loaded). Never prints secrets.
npm run bot:worker:live-preflight

# Verify no futures/margin/withdraw execution paths leaked in:
Select-String -Path .\scripts\local-binance-worker.mjs,.\netlify\functions\bot.mjs,.\apps\edge\public\js\terminal.js `
  -Pattern "/fapi|/dapi|/sapi|withdraw|borrow|repay|leverage|margin|futures" -CaseSensitive:$false

# Inspect stored RADAR microstructure / provider status (needs worker token):
#   GET https://swingterminalx.netlify.app/api/bot/radar-microstructure
#   Header: x-bot-worker-token: <CONTROL_PLANE_WORKER_TOKEN>
```

Use placeholders like `<session_id>`, `<worker_token>`, `<chat_id>` — never real
values. Secrets live only in `.env.worker` (gitignored) and Netlify env, never in
code, URLs, or this file.

## 15. How to process a Claude / Fable report

1. Check the claimed **branch**, **commit hash**, and **files changed** — do they
   match the task?
2. Confirm **no push / no deploy** happened without approval (`git log
   origin/main` unchanged unless approved).
3. Confirm **tests were actually run** and pass (`npm test`) — don't trust "all
   green" if the baseline differs; ask for the actual output.
4. Compare the change against the **acceptance criteria** and the **safety rules**
   (§5, §7). Any gate relaxation, new external fetch, new scheduler, or new signing
   path is a red flag → **BLOCK**.
5. Check for **contradictions** (e.g. "additive only" but a gate/threshold moved;
   "docs only" but runtime files changed).
6. **APPROVE** only with evidence. Otherwise **BLOCK** and produce a concrete
   **follow-up prompt** (English) telling the agent exactly what to fix/prove.

## 16. How future AI agents MUST update this file

**This is a hard rule.** Every future AI task must update
`CHATGPT_SESSION_HANDOFF.md` if it changes any of:

- product behavior or terminal tabs / UX
- trading gates, caps, live-spot enablement, or the kill switch
- RADAR `ENTRY_READY` logic, Telegram alerting, or microstructure provider behavior
- auth / admin allowlist / personal-watch behavior
- backend routes, functions, or the worker protocol
- durable store / data model / state
- accepted or rejected product decisions
- current priorities or major known risks
- model-routing / workflow rules

If a task does **not** touch any of these, the final report must say explicitly:

> `CHATGPT_SESSION_HANDOFF.md` update not needed because …

When you *do* update it, also update the relevant `docs/` (and `AGENTS.md` if the
workflow changed). **If behavior changed and this handoff was not updated, the task
is not complete.** Keep this file **concise, current, and uploadable** — it is
ChatGPT-facing project memory, not a code dump.

## 17. Quick-start message for a new ChatGPT session (copy-paste, Czech)

> Přečti si nahraný `CHATGPT_SESSION_HANDOFF.md` a pokračujeme v práci na Swing
> Terminal X podle něj. Ber ho jako aktuální projektovou paměť. Když bude něco v
> rozporu s novějšími logy / kódem / git historií, upozorni mě. Nemusíš znovu
> vysvětlovat základy. Tohle NENÍ realitní bot — žádné Stripe, billing ani
> referral kódy tu nejsou.

> _Rolling producer candidate-load and empty-POST hardening (2026-07-23, local-only):_ `rolling-microstructure-producer.mjs` now takes explicit `--symbols` / `WORKER_RADAR_ROLLING_SYMBOLS` when supplied; otherwise it safely reads the existing worker-token-protected `GET /api/bot/radar-candidates` and accepts only valid futures targets (no Alpha-only or spot-only coercion). Candidate fetch failure, zero candidates, invalid/thin/untrusted rows, missing config, and public Binance 451 all fail closed and **do not POST**, so a valid stored rolling snapshot cannot be overwritten by an empty/untrusted result. A trusted row is still required before the existing POST; token values are never logged. GitHub-hosted Actions remains unsuitable because fapi egress can 451; no runner, scheduler, Telegram, trading, private endpoint, or deploy is added. A future runner must be local/VPS with verified egress, explicit enablement, and freshness monitoring.
> _RADAR valuation bands — oversold / overbought (2026-08-04, local-only):_ the
> RADAR now states, per coin, whether it is stretched **cheap or expensive
> relative to its own recent range** — a new `Value` column with a signed −100…+100
> score, Oversold/Overbought filter chips, and a Focus-card panel showing the
> evidence (range percentile, sampled RSI, z-score, deviation from the window
> mean, timeframes used). Two layers: a momentum read on every candidate
> (volatility-normalized when `atrPct` is known) and a stored-history read from
> `market_price_points` for the top 40 ranked candidates via **one** batched
> Postgres statement. It is deliberately **not** a fundamental valuation and
> **not** an entry signal: `isEntrySignal:false` / `affectsGate:false` /
> `affectsTelegram:false` on every block, a test asserts enrichment leaves every
> other candidate field byte-identical, and it runs after the Telegram-eligibility
> restore. Fail-closed throughout — no usable data is `UNKNOWN` with a null score
> (never `OVERSOLD`), a flat window is `FLAT_WINDOW` not `FAIR`, a flat series has
> no RSI (`null`, not the conventional 50), and a DB outage keeps the momentum band
> while surfacing its reason in `radar.valuationSummary` plus a `console.warn`.
> No new external fetch, scheduler, cron, credential, migration, or trading path.
> Asset cache-bust token `6k4 → 6k5`. Full suite green (2280 pass / 0 fail /
> 26 skipped), `npm run lint` 0 errors. No push, no deploy. Detail:
> `docs/radar-valuation-bands.md`.

> _CoinGecko highlights: an unknown 24h direction is UNKNOWN, never a gain
> (2026-08-19, local-only, branch `fix/coingecko-highlights-unknown-direction`):_
> The highlights scraper reads CoinGecko list HTML, where the minus sign is often
> absent from the visible text and the direction lives only in a colour class,
> brand hex, or arrow glyph. `detectChangeDirection()` already refused to guess a
> direction from words in a coin name and returns 0 when it cannot tell — but the
> parser started from `sign = 1`, so an unrecognised **-27% was published as
> +27%**, silently and in the most favourable direction. It now fails closed: a
> percent magnitude with no trusted direction leaves `change24hPct` null and
> `change24hText` empty, sets `change24hDirectionUnknown` on the row, counts it in
> the section's `unknownDirectionCount`, and raises a `CHANGE_DIRECTION_UNKNOWN`
> warning in the parser response (`parserVersion` 1 → 2); such rows count as
> MISSING 24h coverage, so the existing "partial data" badge fires. The render path
> already colours only numeric values and dashes empty text, so the row shows as a
> muted em dash rather than green — no frontend change was needed and none was
> made, so no asset cache-bust is required. The section heading (Top Gainers /
> Top Losers) is deliberately **not** adopted as a direction source; that would be
> a new trust assumption, not a fix. Diagnostics only — no RADAR, alerting, or
> trading path consumes this data. Verified in a clean detached worktree at the
> hotfix commit with the unrelated Arkham WIP absent: full suite 2436 pass / 0 fail
> / 26 skipped, `npm run lint` 0 errors, `git diff --check` clean. No push, no
> deploy.
