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


## Non-blocking open decision

**Group/channel chat IDs** are out of scope through at least Phase 3.
Default: personal/direct IDs only, unless the owner decides otherwise for a
later phase.
