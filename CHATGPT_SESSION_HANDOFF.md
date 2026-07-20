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
> _Last synced to repo state: `main` @ `294c72e` (`feat(db): add
> observability database foundation`, Phase 2B — pushed and deployed to
> production; see §10 and §11). Update the commit ref whenever this file is
> re-synced._

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
  foundation for observability only (see §10). Auth is **Supabase JWT** —
  unchanged, Supabase holds no product data.
- **Local repo path (owner machine):**
  `C:\Users\Ales\Desktop\Bots\terminal crypto\terminal-X`
- **Current `main` at time of writing:** `294c72e` (`feat(db): add
  observability database foundation`) — Phase 2B, pushed and deployed.
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
- **Netlify Database / Postgres — observability foundation only (Phase 2B,
  `294c72e`, live in production):**
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
    connection, cached) and a test-only `closeDbForTests()`. **No product
    function imports it yet** — it is unused infrastructure, wired to nothing.
  - `tests/db.connection.test.mjs` and `tests/db.schema.test.mjs` prove the
    schema and connection helper; they **skip gracefully** when no local
    Netlify dev DB is reachable (never require/fall back to production).
  - **Phase 2B changed no product behavior.** It only established the
    observability tables; market data, RADAR, reclaim/absorption, alerts, and
    Supabase auth were untouched.
  - **Phase 2C DB-backed observability is production-verified** on `1f03fe1`:
    the homepage smoke returned 200 and the unauthenticated admin smoke
    returned 401. The only route is `/api/admin-observability`; do not smoke
    `/.netlify/functions/admin-observability`.
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
  - **Do not** write market data, implement reclaim/absorption, or remove/
    migrate Supabase auth as part of this DB work yet — those are separate,
    later phases with their own review.

## 11. Known completed work / recent milestones

From current git history (most recent first, condensed — see `git log` for full):

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
- **No futures / margin / leverage / withdrawals** — Spot only, permanently.
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
- **Next recommended phase: Fáze 2C** — the first safe DB-backed write path
  (e.g. structured logging actually writing to `system_events`) and/or an
  admin-only log viewer reading it. Small, additive, still no market data,
  no reclaim/absorption, no auth change, no trading-bot change.
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
