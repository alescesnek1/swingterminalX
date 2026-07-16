# Cockpit Personal Alerts — Phased Design

Personal Watch is a per-user, opt-in channel for delivering *personalized*
alerts to a user's own Telegram DM, separate from the existing global RADAR
broadcast (`cron-alerts.mjs`). It is being built in small, independently
reviewed phases. This document tracks what exists today and what is
deliberately deferred.

## Phase 1 — Backend CRUD (done, merged, live)

- `netlify/functions/cockpit-personal-watch-settings.mjs` +
  `netlify/functions/_personal-watch-store.mjs`.
- `/api/cockpit-personal-watch-settings` — `GET` / `POST` / `DELETE`, Supabase
  Bearer auth required (`getIdentity()`), 401 otherwise.
- Stores one Telegram chat id per user, keyed by **token `userId` only**
  (request body can never control ownership).
- Persistence: Netlify Blobs, in-memory fallback when Blobs is unavailable.
- Public responses return only a **masked** chat id + connected boolean +
  timestamp — the raw id is never returned.
- Validation: trimmed, digits-only, length 5–20 (personal/direct ids only;
  negative group/channel-style ids are rejected).
- Covered by `tests/cockpit-personal-watch-settings.test.mjs`.

## Phase 2 — Cockpit UI settings wiring (done, merged, live)

**Scope: UI settings wiring only.** Adds a "Personal Alerts" settings card to
Cockpit (`#view-cockpit` / `.cockpit-shell`) that talks to the Phase 1
endpoint above. **No backend behavior changed.**

- `apps/edge/public/js/personal-watch.js` — pure, DOM-free module: client-side
  validation mirroring the backend, and a render-model shaper that reads only
  the server's `telegramConnected` / `telegramChatIdMasked` /
  `telegramChatIdUpdatedAt` fields. It cannot surface a raw chat id even if
  one were ever accidentally present in a response.
- `apps/edge/public/js/terminal.js` — DOM wiring: `GET` on Cockpit tab open,
  `POST` on Connect, `DELETE` on Disconnect, all via the existing shared
  `_getAuthHeaders()` (Supabase session token). 401 is handled as a
  signed-out state; 400 validation errors are shown inline.
- The raw chat id typed into the input is **write-only**: it is never stored
  in `localStorage`/`sessionStorage`/durable JS state, and the input is
  cleared **only after a confirmed successful save**. Every render of the
  card uses the server's masked value only.
- UI copy is explicit and unambiguous:
  - *"Personal alerts are prepared. Delivery is controlled by system safety settings."*
  - *"Personal direct chat IDs only. Group/channel IDs are not supported yet."*
- **This phase adds no Telegram-send path.** Nothing in the frontend calls
  the Telegram API, references a bot token, or reaches
  `netlify/functions/telegram.mjs` / `cron-alerts.mjs` /
  `morning-briefing.mjs`. Those files are untouched.
- Tests: `tests/personal-watch-client.test.mjs` (pure module unit tests) and
  `tests/frontend.personal-watch.test.mjs` (source guards on the shipped
  `terminal.js` / `index.html` / `personal-watch.js`).

### Explicit non-goals of Phase 2

- No Telegram sending.
- No watch-list (symbol/condition) management — the store's `watches: []`
  field is untouched and has no UI or endpoint yet.
- No group/channel chat IDs.
- No changes to RADAR `ENTRY_READY`, `cron-alerts.mjs`,
  `morning-briefing.mjs`, trading gates, or any Binance/order/execution/worker
  path.

## Phase 3 — Symbol watch-list management (done, merged, live)

**Scope: selected-symbol watch-list CRUD only, still no sending.** Uses the
`watches: []` array already reserved on each per-user record.

- **Store** (`netlify/functions/_personal-watch-store.mjs`): `validateWatchSymbol`
  (2–20 uppercase letters/digits, trims+uppercases, rejects spaces/punctuation/
  slashes/injection), `listPersonalWatches`, `addPersonalWatch`,
  `removePersonalWatch`, `publicPersonalWatchList`, and `MAX_WATCHES_PER_USER = 25`.
  Watch shape `{ symbol, addedAt }` with a **server-assigned** `addedAt`; symbols
  are deduped; adding beyond the cap is a validation error; removing a missing
  symbol is idempotent. Adding/removing a watch **never** touches `telegramChatId`.
- **Endpoint** (`netlify/functions/cockpit-personal-watch-list.mjs`):
  `/api/cockpit-personal-watch-list` — OPTIONS→204, GET (list), POST `{ symbol }`
  (add), DELETE `{ symbol }` (remove). Shared `getIdentity()`; ownership is the
  **token `userId` only** (body can't hijack). Invalid JSON / invalid symbol /
  cap-exceeded → 400. Response `{ ok, watches:[{symbol,addedAt}], count, max }` —
  **no chat id, masked or raw.** No outbound `fetch`.
- **Frontend**: the Cockpit "Personal Alerts" card gains a watch sub-section
  (symbol input reusing the `cockpit-symbol-list` datalist, Add, removable chips).
  GET on Cockpit tab open; POST/DELETE on user action via `_getAuthHeaders()`;
  paint-only on refresh ticks (no network spam); nothing kept in browser storage.
  Pure helpers in `personal-watch.js` (`validateWatchSymbolClient`,
  `normalizeWatchSymbol`, `personalWatchListRenderModel`).
- **Tests**: `tests/personal-watch-list.test.mjs` (backend),
  `tests/personal-watch-client.test.mjs` (pure client, extended),
  `tests/frontend.personal-watch-list.test.mjs` (source guards).

### Explicit non-goals of Phase 3

- **No Telegram sending** (no send path anywhere).
- **No custom conditions / thresholds** — a watch is symbol-only; the "condition"
  is the frozen confirmed-entry gate applied later.
- **No "watch all ENTRY_READY" mode.**
- No group/channel chat IDs.
- No changes to `cron-alerts.mjs`, `morning-briefing.mjs`, the RADAR gate,
  scoring, thresholds, or any Binance/order/execution/worker path.

## Phase 4 — Disabled-by-default personal alert sender (implemented locally)

Phase 4 adds `netlify/functions/personal-alerts.mjs`, a scheduled per-user
fan-out. It does **not** create or score signals. The function imports
`selectRadarEntryAlerts`, `setupHash`, and `RADAR_TELEGRAM_COOLDOWN_MS` from
`cron-alerts.mjs`; that selector owns the shared `RADAR_STALE_MS` check. Only the existing fully
confirmed, fresh RADAR `ENTRY_READY` selection can reach fan-out. The global
RADAR sender and morning briefing behavior are unchanged.

Safety and delivery contract:

- Delivery is **off by default**. Sending is possible only when
  `PERSONAL_ALERTS_ENABLED=true` exactly, the configured scheduler secret is
  presented in `x-terminal-scheduler-secret`, and the existing `TG_BOT_TOKEN`
  is available. No production environment value is changed by this phase.
- `PERSONAL_ALERTS_SCHEDULER_SECRET` plus the matching internal scheduler
  header is required before fan-out. Public HTTP requests are rejected even
  when they include a forged `next_run`; `next_run` is schedule metadata only,
  never authentication.
- A recipient must have a valid saved personal chat id and an explicit matching
  symbol in `watches`. There is no watch-all mode and no custom condition path.
- Scheduled delivery enumerates the existing per-user records from Netlify
  Blobs. Memory fallback remains available to management endpoints, but the
  sender refuses to send unless enumeration and per-user state are durable.
- Dedup state stays on the same record under
  `personalAlertState.sent[SYMBOL] = { lastSentAt, hash }`. Before sending, an
  ETag-conditional write acquires `personalAlertState.pending[SYMBOL]`; an
  overlapping run skips that user/symbol. Telegram success converts the
  reservation to `sent`; failure clears it and records only a bounded error
  code. A crashed reservation expires after the shared 60-minute cooldown. The sender never marks
  an alert sent before Telegram reports success.
- Cooldown is the shared 60-minute constant per user + symbol. An unchanged
  setup hash is not re-sent. Fan-out is capped at 5 sends per user and 100 total
  sends per run; failures are isolated per user.
- Responses and aggregate logs contain counts and safe codes only, never raw
  chat ids, user ids, tokens, or Telegram response bodies. Manual HTTP requests
  cannot provide a symbol/chat id to trigger delivery and are rejected while
  sending is enabled unless they have the scheduled invocation shape.
- The Cockpit copy says delivery is prepared but controlled by system safety
  settings. The settings and watch-list public response contracts are unchanged;
  alert state is backend-only.

Safe enablement later requires a separate reviewed production change: verify
Netlify Blobs durability, configure the scheduler to send the matching secret
header without exposing it to public callers, verify the Telegram token, then
set `PERSONAL_ALERTS_ENABLED=true`. Do not place real secrets or chat ids in
code, docs, URLs, tests, or logs. Turning the gate off, leaving the scheduler
secret unset, or omitting the header sends zero.

## Phase 5 — External authenticated scheduler (implemented locally)

**Native Netlify scheduled functions are not used for `personal-alerts.mjs`.**
`personal-alerts.mjs` used to declare `export const config = { schedule: '*/5 * * * *' }`,
registering it as a native Netlify scheduled function. That trigger has been
removed.

**Why:** a native Netlify scheduled invocation cannot attach a custom request
header — it identifies itself only by a `next_run` field in the POST body.
`personal-alerts.mjs` requires the `x-terminal-scheduler-secret` header to
authenticate before any fan-out, and deliberately never trusts `next_run` as
authentication (a public, unauthenticated signal must never be able to
trigger a Telegram send). With the native schedule in place, every 5-minute
invocation would have arrived without that header, hit a hard 401, and
production sending would be permanently unreachable — dead code with 401 log
noise, not a security hole, but not workable either.

**Approved scheduler path:** `.github/workflows/personal-alerts.yml`, a
GitHub Actions workflow (`workflow_dispatch` + `schedule: "*/5 * * * *"`)
that `POST`s `https://swingterminalx.netlify.app/.netlify/functions/personal-alerts`
with the `x-terminal-scheduler-secret` header, sourced from the GitHub
repository secret `PERSONAL_ALERTS_SCHEDULER_SECRET`. It no-ops safely
(`exit 0`, no HTTP call) when that GitHub secret is not configured, and never
echoes/prints the secret value. This is the only approved caller; there is no
other production scheduler for this function.

`personal-alerts.mjs`'s handler now also requires the request **method** to be
`POST` (in addition to the header) before it will reach the fan-out pipeline
when `PERSONAL_ALERTS_ENABLED === 'true'` — a direct `GET`, even with a
correct header, is rejected with a clean `401` and never runs fan-out. This is
additional defense in depth; the external scheduler always POSTs.

**This phase changes nothing about activation.** Real sending still requires,
separately and all together:
- `PERSONAL_ALERTS_ENABLED === 'true'` exactly, set intentionally in Netlify
  production env (still absent/unset as of this phase).
- The Telegram bot token (`TG_BOT_TOKEN`) configured in Netlify env.
- The GitHub secret `PERSONAL_ALERTS_SCHEDULER_SECRET` configured to match the
  Netlify env value of the same name.

Sending remains off until `PERSONAL_ALERTS_ENABLED` is intentionally enabled
by the owner. **Do not** trust `next_run` for auth, weaken or bypass the
scheduler-secret check, add a watch-all mode, add custom conditions, or
change RADAR thresholds/gates to force a signal. The first real send still
requires a separate, dedicated enablement runbook and explicit owner
approval — this phase is scheduler plumbing only, not an enablement.

## Phase 5F — Diagnostic test-send (implemented locally)

A second, completely separate function,
`netlify/functions/personal-alerts-diagnostic.mjs`, lets the owner send a
single manual Telegram delivery test to one already-connected Personal
Watch account, without waiting for (or forcing) a real RADAR confirmed-entry
alert.

**This is not the real alert sender and shares nothing with it:**
- It does not import or call the RADAR confirmed-entry selector, does not
  read or write the RADAR fleet, and cannot fan out to more than one user —
  it reads exactly one server-configured target user's record via a
  single-key durable lookup (`getPersonalWatchRecordForDiagnostic` in
  `_personal-watch-store.mjs`), never an enumeration of all recipients.
- It does not touch the real sender's dedup/cooldown/sent state
  (`personalAlertState`) at all.
- It uses its own enable flag, its own secret, and its own header — entirely
  distinct from the real sender's enable flag and scheduler secret/header.
- The request body is never read for auth or for target selection; the
  target user id comes only from server-side Netlify env, set by the owner.

**Required Netlify env** (all separate from the real sender's env):
- `PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED` — must be exactly `'true'` for a
  real send; anything else (including absent) returns a clean disabled
  response and sends zero.
- `PERSONAL_ALERTS_DIAGNOSTIC_SECRET` — compared timing-safely against the
  `x-terminal-diagnostic-secret` request header.
- `PERSONAL_ALERTS_DIAGNOSTIC_TARGET_USER_ID` — the one target user id,
  server-side only; never printed, never returned, never accepted from a
  request body. It must be the raw backend `identity.userId`, not a Telegram
  chat ID, email, name, JWT token, storage key, or masked ID.
- The authenticated Cockpit helper
  (`/api/cockpit-personal-watch-diagnostic-target`) returns only the current
  user ID for copy-only configuration and safe aggregate watch status. Copy
  the exact value directly into Netlify; never paste it into chat, logs, or
  issues.
- Keep diagnostic sending disabled while configuring the target. Enable
  `PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED` only for one attended workflow
  run, then disable it again.
- The existing `TG_BOT_TOKEN` (shared with the real sender).

**Approved trigger:** `.github/workflows/personal-alerts-diagnostic.yml`,
`workflow_dispatch` only — **no `schedule`, ever**. It `POST`s the diagnostic
URL with `x-terminal-diagnostic-secret` from the GitHub secret
`PERSONAL_ALERTS_DIAGNOSTIC_SECRET`, and no-ops (`exit 0`, no HTTP call) if
that GitHub secret is not configured.

**Fail-closed gates, in order:** send-enable flag exactly `'true'` →
diagnostic secret configured → target user id configured → `TG_BOT_TOKEN`
configured → durable store available → target record found → target has a
saved chat id → target has **exactly one** watched symbol → Telegram send
succeeds. Any failure returns a clean, aggregate-only JSON reason
(`DIAGNOSTIC_DISABLED`, `DIAGNOSTIC_AUTH_REQUIRED`,
`DIAGNOSTIC_SECRET_NOT_CONFIGURED`, `DIAGNOSTIC_TARGET_NOT_CONFIGURED`,
`DIAGNOSTIC_TOKEN_MISSING`, `DIAGNOSTIC_STORE_UNAVAILABLE`,
`DIAGNOSTIC_TARGET_NOT_FOUND`, `DIAGNOSTIC_TARGET_NO_CHAT`,
`DIAGNOSTIC_TARGET_WATCH_COUNT_NOT_ONE`, `DIAGNOSTIC_TELEGRAM_FAILED`) and
`sent:0`; `sent:1` only after a genuine Telegram API success.

The diagnostic message text explicitly says it is only a delivery test, with
no market signal and no trading action — it can never be mistaken for a real
RADAR alert. **Diagnostic send must never be used as a substitute for real
alert eligibility, must never bypass RADAR for normal alerting, must never
change RADAR thresholds/gates, must never trigger trading/execution, and
should be disabled again (`PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED` unset or
not `'true'`) immediately after one test.** No chat ids, user ids, or
secrets are ever printed in responses, logs, docs, issues, or prompts.

Covered by `tests/personal-alerts-diagnostic.test.mjs` and
`tests/personal-alerts-diagnostic-workflow.test.mjs`.

### Diagnostic Telegram failure classification (implemented locally)

When the diagnostic send reaches Telegram but the send itself fails, the
response adds safe, allowlisted classification fields alongside the existing
`error: "DIAGNOSTIC_TELEGRAM_FAILED"` — `telegramFailureKind`,
`telegramHttpStatus`, `telegramApiErrorCode`, `telegramApiDescriptionCode`.
These fields are present **only on failure**; a successful send (`sent:1`)
never carries them. Classification never leaks the token, chat id, user id,
the raw Telegram request URL, a raw Telegram `description` string, or a raw
Personal Watch record — Telegram's own `description` text is inspected only
internally to pick one of a fixed set of description codes, then discarded.

Classification (`sendDiagnosticTelegram` in
`netlify/functions/personal-alerts-diagnostic.mjs`):

| Condition | `telegramFailureKind` | `telegramApiDescriptionCode` |
| --- | --- | --- |
| HTTP 401 | `TELEGRAM_UNAUTHORIZED` | `BOT_TOKEN_INVALID_OR_REVOKED` |
| HTTP 403 | `TELEGRAM_FORBIDDEN` | `BOT_BLOCKED_OR_CHAT_NOT_STARTED` |
| HTTP 400, chat-not-found-like | `TELEGRAM_BAD_REQUEST` | `CHAT_NOT_FOUND_OR_INVALID` |
| HTTP 400, message/entity-like | `TELEGRAM_BAD_REQUEST` | `MESSAGE_TEXT_INVALID` |
| HTTP 400, other | `TELEGRAM_BAD_REQUEST` | `BAD_REQUEST` |
| HTTP 429 | `TELEGRAM_RATE_LIMITED` | `RATE_LIMITED` |
| HTTP 5xx | `TELEGRAM_SERVER_ERROR` | `TELEGRAM_SERVER_ERROR` |
| Fetch timeout/abort | `TELEGRAM_TIMEOUT` | `NETWORK_TIMEOUT` |
| Other network/fetch exception | `TELEGRAM_NETWORK_ERROR` | `NETWORK_ERROR` |
| Unknown non-2xx | `TELEGRAM_API_ERROR` | `UNKNOWN_TELEGRAM_API_ERROR` |

Owner actions per kind:
- `TELEGRAM_UNAUTHORIZED` — verify/replace `TG_BOT_TOKEN`.
- `TELEGRAM_FORBIDDEN` — open the bot chat and send `/start`; unblock the bot.
- `TELEGRAM_BAD_REQUEST` / `CHAT_NOT_FOUND_OR_INVALID` — reconnect/save the
  Telegram chat id using the production bot.
- `TELEGRAM_RATE_LIMITED` — wait and retry once.
- `TELEGRAM_SERVER_ERROR` / `TELEGRAM_NETWORK_ERROR` / `TELEGRAM_TIMEOUT` —
  retry later.

This is diagnostics-only: it does not change the successful-send path, the
real sender (`personal-alerts.mjs`), the diagnostic target lookup, or any
enable-flag behavior. No raw token, chat id, or user id should ever be
pasted into chat, logs, or issues when reporting a `telegramFailureKind`.
Covered by extended cases in `tests/personal-alerts-diagnostic.test.mjs`.

## Non-blocking open decision

**Group/channel chat IDs** are out of scope through at least Phase 3.
Default: personal/direct IDs only, unless the owner decides otherwise for a
later phase.
