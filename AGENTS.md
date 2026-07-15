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
- **Telegram** may only be sent from `netlify/functions/cron-alerts.mjs`
  (global confirmed RADAR `ENTRY_READY`), `morning-briefing.mjs`, and
  `netlify/functions/personal-alerts.mjs` (personal confirmed RADAR
  `ENTRY_READY` fan-out). The personal sender must remain disabled by default
  behind `PERSONAL_ALERTS_ENABLED === 'true'`, must reuse the confirmed gate
  exported by `cron-alerts.mjs`, require the configured scheduler secret/header
  for invocation, and must never log or return raw chat ids. Request bodies,
  including `next_run`, are metadata only and never authentication.
  No new sender may bypass that gate.
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
- **No secrets / keys / tokens / customer PII** in code, docs, URLs, or commits.

## Git / deploy

- **No push, no deploy** (Netlify or Fly.io) without explicit owner approval. A
  push to the deploy branch *is* a deploy.
- **Never `git add .`** — stage only explicitly named files.
- Branch from `main` (`feat/…`, `fix/…`, `docs/…`).
- **Commit only after `npm test` passes.**

## Tests

- `npm test` runs Node's built-in runner over `tests/**/*.test.mjs`.
- Add tests next to the existing ones (`node:test` + `node:assert/strict`, `.mjs`).

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
