# AGENTS.md — Working agreement for AI coding agents

This repo is **Swing Terminal Version X** (`swing-terminal-workspace`): a crypto
swing-trading terminal (web SPA + Netlify edge/Node functions + a Fly.io ingest
service + an on-demand local Binance worker). It is **real-money-adjacent**.

Read this before touching code. It is the workflow contract; the deep technical
detail lives in `docs/` and in `CHATGPT_SESSION_HANDOFF.md`.

## Read order

1. `CHATGPT_SESSION_HANDOFF.md` — the compact project brain (identity,
   architecture, safety model, decisions, priorities). Read it first.
2. `docs/` for the subsystem you're touching:
   - Trading / worker / orders → `docs/LIVE-SPOT-RUNBOOK.md`,
     `docs/worker-launcher.md`, `docs/worker-install.md`, `docs/bot-fleet.md`.
   - RADAR / microstructure → `docs/radar-microstructure.md`,
     `docs/radar-rolling-microstructure-design.md` (design only).

Do not rediscover the whole repo from scratch unless these are clearly stale.

## Safety rules (non-negotiable)

- **Additive, fail-closed changes only.** Never relax, bypass, or "temporarily
  disable" a trading/auth/microstructure gate.
- **Netlify never signs Binance orders and never holds signing secrets.** Only the
  local worker signs. No `/sapi`, `/fapi`, `/dapi`, withdraw, borrow, margin,
  leverage, or futures execution — ever.
- **No new external fetch and no new scheduler/cron** without an explicit,
  reviewed reason (see the microstructure "451" story). Production microstructure
  default is `MARKET_DATA_PROVIDER=none`.
- **Approved exception — scheduled price-history collection
  (`feat/price-history-scheduler`):** a direct, public, unauthenticated
  fetch of CoinGecko's `/coins/markets` from
  `netlify/functions/_coingecko-markets-source.mjs` is approved, reviewed,
  and implemented — this is the same public upstream `/api/markets` itself
  calls, GET-only, no key, no auth. It exists because `/api/markets`
  requires a cryptographically verified Supabase user JWT
  (`apps/edge/netlify/edge-functions/lib/security.js` `verifyAuth`), which
  an unattended scheduler can never present without storing a live user
  credential or a service-role key — both rejected. The two new scheduled
  functions (`price-history-collect-scheduled.mjs`,
  `price-history-prune-scheduled.mjs`) follow the same external-scheduler
  doctrine as `personal-alerts.mjs` below: **own secret, own header**
  (`PRICE_HISTORY_SCHEDULER_SECRET` / `x-price-history-scheduler-secret`,
  timing-safe compare) — never `personal-alerts.mjs`'s
  `PERSONAL_ALERTS_SCHEDULER_SECRET` / `x-terminal-scheduler-secret`, and
  never Netlify's native `config.schedule` trigger (same reason: it cannot
  attach an unforgeable header, and a `next_run` body field is never
  authentication). Every gate flag
  (`PRICE_HISTORY_SCHEDULE_ENABLED`, `PRICE_HISTORY_COLLECT_ENABLED`,
  `PRICE_HISTORY_WRITE_ENABLED`, `PRICE_HISTORY_PRUNE_ENABLED`) defaults
  off, and both GitHub Actions workflows
  (`.github/workflows/price-history-collect.yml`,
  `price-history-prune.yml`) ship with their `schedule:` trigger commented
  out — see `docs/price-history-scheduler.md` for the full rollout order.
  No RADAR/ENTRY_READY/trading/alert/Telegram/UI behavior is touched by any
  of this.
- **Telegram** may only be sent from `netlify/functions/cron-alerts.mjs`
  (global confirmed RADAR `ENTRY_READY`), `morning-briefing.mjs`,
  `netlify/functions/personal-alerts.mjs` (personal confirmed RADAR
  `ENTRY_READY` fan-out), and `netlify/functions/personal-alerts-diagnostic.mjs`
  (manual, single-recipient delivery test only — see below). The personal
  sender must remain disabled by default behind `PERSONAL_ALERTS_ENABLED
  === 'true'`, must reuse the confirmed gate exported by `cron-alerts.mjs`,
  require the configured scheduler secret/header for invocation, and must
  never log or return raw chat ids. Request bodies, including `next_run`,
  are metadata only and never authentication. No new sender may bypass
  that gate.
- **`personal-alerts.mjs` must not use Netlify's native scheduled-function
  trigger** (`export const config = { schedule: ... }`) unless the platform
  can attach an unforgeable auth signal to that trigger — it currently cannot
  (native scheduled invocations identify themselves only via a `next_run`
  body field, which is not trustworthy as auth). The approved scheduler is
  the external GitHub Actions workflow `.github/workflows/personal-alerts.yml`
  (or an equivalent external caller), which must attach the
  `x-terminal-scheduler-secret` header from a GitHub/CI secret on every
  invocation. **No sender may ever trust request body fields (including
  `next_run`) as authentication.**
- **`personal-alerts.mjs` requires a rollout allowlist before it may send.**
  In addition to `PERSONAL_ALERTS_ENABLED === 'true'`, the normal sender now
  requires `PERSONAL_ALERTS_ALLOWED_USER_IDS` (comma/newline/space separated
  raw backend `identity.userId` values) to be set and non-empty. Missing or
  empty fails closed with `reason: "PERSONAL_ALERTS_ALLOWLIST_EMPTY"`. A
  wildcard/global value (`*`, `all`, `any`, `wildcard`, `everyone`) anywhere
  in the list is invalid and fails closed with
  `reason: "PERSONAL_ALERTS_ALLOWLIST_INVALID"` — **wildcard/"all" mode is
  intentionally unsupported.** Only recipients whose raw `userId` is in the
  parsed allowlist are ever considered for a send; this check runs before
  the watch/chat-id checks, before caps, and before any Telegram call. The
  response only ever returns counts (`allowlistEnabled`,
  `allowedRecipientsConfigured`, `recipientsSkippedByAllowlist`) — **never
  the raw allowlisted or skipped user ids.** This gate applies only to the
  normal sender; it does not apply to `personal-alerts-diagnostic.mjs`,
  which already targets exactly one server-configured user via its own
  separate, unrelated path. First rollout: set
  `PERSONAL_ALERTS_ALLOWED_USER_IDS` to the owner's own backend user id
  (obtained via the diagnostic target helper's copy action, never typed or
  guessed) and verify before separately enabling `PERSONAL_ALERTS_ENABLED`.
- **`personal-alerts-diagnostic.mjs` is a manual delivery-test path, not a
  second alert engine.** Rules specific to it:
  - **Do not use diagnostic send as a substitute for real alert
    eligibility.** It must never read/write the RADAR fleet, never import
    or call the RADAR confirmed-entry selector, and never touch the real
    sender's dedup/cooldown/sent state.
  - **Do not add a `schedule` to its workflow**
    (`.github/workflows/personal-alerts-diagnostic.yml` must stay
    `workflow_dispatch`-only, forever).
  - **Do not allow a request body to pick the target user or a chat id.**
    The diagnostic target must come from server-side env only
    (`PERSONAL_ALERTS_DIAGNOSTIC_TARGET_USER_ID`), never from the request.
  - It must use its own enable flag
    (`PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED`) and its own secret/header
    (`PERSONAL_ALERTS_DIAGNOSTIC_SECRET` /
    `x-terminal-diagnostic-secret`) — never the real sender's
    `PERSONAL_ALERTS_ENABLED`, `PERSONAL_ALERTS_SCHEDULER_SECRET`, or
    `x-terminal-scheduler-secret`.
  - It must load exactly one target record via a single-key lookup, never
    an enumeration of all recipients, and must never log or return a raw
    chat id or raw user id.
- **Diagnostic target setup:** `PERSONAL_ALERTS_DIAGNOSTIC_TARGET_USER_ID` must be the raw backend `identity.userId`, never a Telegram chat ID, email, name, JWT token, storage key, or masked ID. Use the authenticated Cockpit helper to copy the exact current-user value directly into Netlify; never paste it into chat, logs, or issues. Keep diagnostic sending disabled while configuring it, enable it only for one attended workflow run, then disable it again.
- **Diagnostic Telegram failure classification:** on a diagnostic send
  failure the response may add `telegramFailureKind`, `telegramHttpStatus`,
  `telegramApiErrorCode`, and `telegramApiDescriptionCode` — a fixed,
  allowlisted set of codes only (see `docs/personal-watch-design.md`). Never
  add a field carrying the token, chat id, user id, a raw Telegram request
  URL, a raw Telegram `description` string, or a raw Personal Watch record.
  These fields must never appear on a successful send. Common owner actions:
  `TELEGRAM_UNAUTHORIZED` → verify/replace `TG_BOT_TOKEN`;
  `TELEGRAM_FORBIDDEN` → open the bot chat and send `/start` (unblock the
  bot); `TELEGRAM_BAD_REQUEST` / `CHAT_NOT_FOUND_OR_INVALID` →
  reconnect/save the Telegram chat id using the production bot;
  `TELEGRAM_RATE_LIMITED` → wait and retry once; `TELEGRAM_SERVER_ERROR` /
  `TELEGRAM_NETWORK_ERROR` / `TELEGRAM_TIMEOUT` → retry later. As always, no
  raw token/chat ID/user ID should ever be pasted into chat, logs, or
  issues.
- **Native auth (own-database accounts) is additive and default-off.** The
  `app_users` path is gated behind `NATIVE_AUTH_ENABLED === 'true'` plus a
  ≥32-char `AUTH_JWT_SECRET`; with the flag off, a native token is refused and
  the Supabase path is untouched. Rules that must not be relaxed:
  **`app_users.role` grants nothing** — admin authority stays exclusively
  `BOT_ADMIN_EMAILS` via `_auth.mjs` `isAdmin()`, and `/api/admin-users` also
  requires `identity.verified === true` so `AUTH_DECODE_ONLY` can never reach
  account management. Never accept a `role` claim from a user-held token as
  authorization. Never add a bootstrap/backdoor secret that creates accounts —
  the first native accounts are created through `/api/admin-users` using the
  owner's existing (Supabase) admin session. Never log or return a password,
  hash, or token; a generated password is shown once in the response and never
  written to `app_user_audit`. Keep the two verifier implementations
  (`netlify/functions/_native-jwt.mjs` and
  `apps/edge/netlify/edge-functions/lib/native-jwt.js`) byte-compatible — the
  cross-runtime test exists because a drift means half the API accepts a token
  the other half rejects. See `docs/native-auth.md`.
- **No secrets / keys / tokens / customer PII** in code, docs, URLs, or commits.

## Error observability (non-negotiable)

Failures must be **visible and logged** — never silently swallowed. The owner
must always be able to tell that something broke and what broke.

- **Every fetch / external call that can fail must both (a) surface a specific,
  visible error in the UI where the user is looking, and (b) be logged**
  (client: `console.warn`/`console.error` with context; edge/Node functions:
  `console.*` so it lands in Netlify function logs). No empty `catch {}` that
  hides the failure.
- **Distinguish "no data" from "fetch failed."** A genuinely empty result and a
  broken request must render differently — a blank / "no data" state must never
  stand in for an error the user can't see.
- **Log enough context to diagnose:** what failed (endpoint / symbol / venue),
  the status or error name, and the fallback taken — but still **never** log
  secrets, tokens, chat/user IDs, or PII (see the rules above).
- **Data-source fallbacks must be honest, not silent.** Binance→CoinGecko
  fallback is allowed *behaviour*, but the active source (Binance vs CoinGecko,
  spot vs futures) must be visible in the UI, and any *unexpected* upstream
  failure behind the fallback must still be logged.
- **Order book specifically:** a failure to load the book must show the user a
  clear reason (blocked / unavailable / upstream error) and log it — it must
  never appear as an empty or "loading…" box that silently never resolves.
- **No `catch { return 0 }` (or `return false` / `[]` / `null`) where that value
  is indistinguishable from a genuinely valid result.** A caught error must
  return a value the caller can tell apart from real data — never silently
  collapse into a number/boolean/array that looks legitimate downstream.
- **These rules are now machine-enforced — do not work around the linter.**
  `tools/eslint/repo-contract-plugin.mjs` turns three of them into ESLint
  errors: `repo-contract/no-silent-catch`,
  `repo-contract/no-indistinguishable-catch-return`, and
  `repo-contract/no-sensitive-log`. **`npm run lint` must pass before you
  commit, alongside `npm test`.** Pre-existing violations live in
  `eslint-suppressions.json` (see `npm run lint:debt`); that baseline is for
  *existing* debt only — **never add a new entry to it to get a fresh
  violation past the gate.** If a rule is genuinely wrong for one site, use
  `// eslint-disable-next-line <rule> -- <written reason>`; a disable without
  a reason is a review failure. Full detail: `docs/error-observability.md`.
- **Client failures must reach the central error log.** Any new client-side
  failure path must either go through `Toast.error` / `Toast.warn` (which
  forwards automatically) or call `window.ErrorLog.record(...)`. Never remove
  `apps/edge/public/js/error-log.js` from the top of `index.html` — it must
  load before every other script so its `window.fetch` interceptor is in
  place before the first request. Owner-facing lookup is `errors()` in
  devtools.
- **Missing or failed data must render as `UNKNOWN` — never as a bearish/SELL
  signal or any other trading label.** A computed score, panic indicator, or
  signal that could not be computed (missing inputs, thrown error) must never
  fall through to a default that a user could mistake for a real reading.
  Trading- and alert-relevant logic must **fail closed**: on missing/degraded
  data, block the action or mark it unknown — never proceed as if the data
  were bearish, bullish, or otherwise actionable.

## Git / deploy

- **No push, no deploy** (Netlify or Fly.io) without explicit owner approval. A
  push to the deploy branch *is* a deploy.
- **Never `git add .`** — stage only explicitly named files.
- Branch from `main` (`feat/…`, `fix/…`, `docs/…`).
- **Commit only after `npm test` passes.**

## Tests

- `npm test` runs Node's built-in runner over `tests/**/*.test.mjs`.
- Add tests next to the existing ones (`node:test` + `node:assert/strict`, `.mjs`).

## Static analysis

- **`npm run lint` must pass before every commit** (same bar as `npm test`).
  Exit 1 = a new violation. Exit 2 = a suppressed violation was fixed but its
  baseline entry is stale → run `npm run lint:prune` and commit the smaller
  baseline.
- `npm run lint:debt` prints what `eslint-suppressions.json` is still holding
  back, by rule and by file. Never grow that baseline to pass a new violation.
- `eslint.config.mjs` covers three runtimes (Deno edge / Node / browser). A new
  file added to `index.html` must go in the matching browser block — classic
  `<script>` vs `<script type="module">` — or it will fail to parse.
- Detail and rationale: `docs/error-observability.md`.

## MANDATORY: keep the ChatGPT handoff current

`CHATGPT_SESSION_HANDOFF.md` is ChatGPT-facing project memory the owner uploads
into fresh sessions. Every task must maintain it:

- **If your change affects** product behavior, terminal tabs/UX, trading gates or
  caps, live-spot enablement, the kill switch, RADAR `ENTRY_READY` / Telegram
  alerting / microstructure provider behavior, auth / admin / personal-watch,
  backend routes / functions / worker protocol, durable store / data model,
  accepted/rejected decisions, current priorities, major risks, or
  model-routing/workflow rules → **update `CHATGPT_SESSION_HANDOFF.md`** (and the
  relevant `docs/`).
- **If it does not**, your final report must state:
  `CHATGPT_SESSION_HANDOFF.md` update not needed because …
- **If behavior changed and the handoff was not updated, the task is not
  complete.**

Keep the handoff concise, current, and uploadable — not a code dump.

## Final report must include

Branch · commit hash · files changed · tests/checks run (with real output) ·
confirmation of **no push / no deploy** · the handoff-update line above.
