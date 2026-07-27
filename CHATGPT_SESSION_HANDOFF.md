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

- **SCANNER** — default view; market-wide scan / signals.
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
  false/unset in production (any unverifiable token → 401).
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