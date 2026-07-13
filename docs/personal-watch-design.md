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

## Phase 2 — Cockpit UI settings wiring (done, this doc's branch)

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
  - *"Saved for future personal alerts — alerts are not active yet."*
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

## Phase 3 (future, separate review) — Watch-list management

Backend + UI for a user-chosen symbol/condition list (the `watches: []`
field already reserved in the store's record shape). Still **no sending**.

## Phase 4 (future, separate review) — Personal alert sending

The only phase allowed to introduce a Telegram-send path. Requirements
carried forward from Phase 1/2, non-negotiable:

- The trigger must be the **same confirmed RADAR `ENTRY_READY` gate**
  `cron-alerts.mjs` already uses (`isConfirmedRadarEntryReady`) — personal
  alerts are a **per-user fan-out of an already-confirmed event**, never a
  new scoring/evaluation path and never a way to bypass the gate.
- Sending must live in a **new, dedicated, reviewed backend function** (or an
  explicit extension of `cron-alerts.mjs`), added to the "only these
  functions may call Telegram" allowlist in `AGENTS.md`. It must never live
  in the settings function or the frontend.
- Reuse the existing per-symbol 60-minute cooldown and 120s staleness
  guards, plus a new per-user×per-symbol dedup key and a per-user rate cap,
  fail-closed if the dedup store is unavailable.
- Re-verify cross-user isolation end-to-end once a real send path exists.

## Non-blocking open decision

**Group/channel chat IDs** are out of scope through at least Phase 3.
Default: personal/direct IDs only, unless the owner decides otherwise for a
later phase.
