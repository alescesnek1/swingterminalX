# CLAUDE.md — entry point for Claude Code

The full working agreement for this repo lives in **[`AGENTS.md`](AGENTS.md)** and
the project brain in **`CHATGPT_SESSION_HANDOFF.md`**. Read `AGENTS.md` first —
it is the canonical, non-negotiable contract (safety model, git/deploy rules,
tests, handoff upkeep). This file only highlights rules that must never be
missed.

## Error observability (non-negotiable)

Failures must be **visible and logged** — never silently swallowed. The owner
must always be able to tell that something broke and what broke.

- **Every fetch / external call that can fail must both (a) surface a specific,
  visible error in the UI where the user is looking, and (b) be logged**
  (client: `console.warn`/`console.error` with context; edge/Node functions:
  `console.*` so it lands in Netlify function logs). No empty `catch {}` that
  hides the failure.
- **Distinguish "no data" from "fetch failed."** A blank / "no data" state must
  never stand in for an error the user cannot see.
- **Order book, market data, and any Binance/CoinGecko/upstream call** must show
  a clear failure reason to the user and log it — an order book that fails must
  never appear as an empty or perpetual "loading…" box.
- **Data-source fallbacks must be honest:** Binance→CoinGecko fallback is allowed
  behaviour, but the active source (Binance vs CoinGecko, spot vs futures) must
  be visible in the UI, and unexpected upstream failures behind the fallback
  must still be logged.
- **No `catch { return 0 }` or similar** where the fallback value is
  indistinguishable from real data.
- **Missing/failed data must be `UNKNOWN` — never a bearish/SELL signal.**
  Trading and alert logic fails closed on missing data, never proceeds as if
  it were bearish.
- Never log secrets, tokens, chat/user IDs, or PII (see `AGENTS.md`).

See `AGENTS.md` → **"Error observability (non-negotiable)"** for the full text.
