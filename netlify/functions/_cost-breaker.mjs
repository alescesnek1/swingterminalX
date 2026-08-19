// Emergency Netlify cost breaker — one place that decides whether a
// database-touching path may spend anything at all.
//
// WHY THIS EXISTS: Netlify database compute is billed per GB-hour of an AWAKE
// database. The production database is configured to sleep after 5 minutes of
// inactivity, so ANY recurring touch at a cadence under 5 minutes keeps it
// permanently awake and bills continuously even when the queries themselves
// are cheap. Database compute reached 920.63 GB-hours / 9,206.3 credits — the
// single largest line on the bill — which is a *sleep* problem at least as much
// as a query-cost problem.
//
// THE CONTRACT: "disabled" here means NOTHING happens. No @netlify/database
// import, no pool.connect(), no upstream fetch, no write, no expensive read.
// A disabled path answers with a normal 2xx JSON body that names its reason,
// so an unattended scheduler does not retry-storm and a browser panel does not
// paint a spinner forever. It is never a 500.
//
// FAIL-CLOSED: every gate requires the env var to be EXACTLY the string
// 'true'. Unset, blank, '1', 'TRUE', 'yes' — all mean OFF. Missing data
// therefore degrades to UNKNOWN, never to a fabricated value and never to a
// bearish/SELL reading (see AGENTS.md, "Missing/failed data must be UNKNOWN").
//
// WHAT THIS FILE MUST NEVER DO: it holds no trading, order, signing, Telegram,
// ENTRY_READY, RADAR-gate or auth logic, and it must never be used to relax
// one. It only ever *subtracts* work. Importing it has zero side effects: no
// env var is read and no connection is opened at import time.

// ── Master lever ────────────────────────────────────────────────────────────
// A single owner-operated panic switch. Set DB_READS_ENABLED=false to force
// EVERY breaker-guarded path off at once, regardless of the narrower flags
// below. Unset (the normal state) leaves the narrow flags in charge, so the
// core terminal keeps working; the master switch is the "stop the bill now,
// accept a degraded UI" lever.
//
// Note the asymmetry, which is deliberate: only the exact string 'false'
// engages it. A typo can never silently engage a total blackout, and a typo
// can never silently disengage one either, because 'true' is not what turns the
// narrow gates on — each narrow flag is read on its own.
export const COST_BREAKER_MASTER_ENV_FLAG = 'DB_READS_ENABLED';

// ── Narrow gates ────────────────────────────────────────────────────────────
export const PRICE_HISTORY_SCHEDULE_ENV_FLAG = 'PRICE_HISTORY_SCHEDULE_ENABLED';
export const PRICE_HISTORY_COLLECT_ENV_FLAG = 'PRICE_HISTORY_COLLECT_ENABLED';
export const PRICE_HISTORY_WRITE_ENV_FLAG = 'PRICE_HISTORY_WRITE_ENABLED';
export const PRICE_HISTORY_PRUNE_ENV_FLAG = 'PRICE_HISTORY_PRUNE_ENABLED';
// Non-critical historical reads: the price-history panels, the advisory
// oversold/overbought valuation layer, and the admin history diagnostics.
// Default OFF — none of these is required for the terminal to be usable, and
// each one is a Postgres round trip a browser can trigger repeatedly.
export const PRICE_HISTORY_READS_ENV_FLAG = 'PRICE_HISTORY_READS_ENABLED';
export const MARKET_CONTEXT_COLLECT_ENV_FLAG = 'MARKET_CONTEXT_COLLECT_ENABLED';

// ── Disabled-reason strings (safe to log and to return to a client) ─────────
// Stable short codes only. Never a message, never a connection string, never a
// token, chat id, email, or any other user data.
export const REASON_PRICE_HISTORY_DISABLED = 'PRICE_HISTORY_DISABLED';
export const REASON_MARKET_CONTEXT_COLLECT_DISABLED = 'MARKET_CONTEXT_COLLECT_DISABLED';
export const REASON_DB_HISTORY_READS_DISABLED = 'DB_HISTORY_READS_DISABLED';
export const REASON_COST_BREAKER_DISABLED_PATH = 'COST_BREAKER_DISABLED_PATH';

export const COST_BREAKER_REASONS = Object.freeze([
  REASON_PRICE_HISTORY_DISABLED,
  REASON_MARKET_CONTEXT_COLLECT_DISABLED,
  REASON_DB_HISTORY_READS_DISABLED,
  REASON_COST_BREAKER_DISABLED_PATH,
]);

/**
 * True only when `env[flag]` is exactly the string 'true'. Everything else —
 * unset, blank, whitespace, '1', 'TRUE', 'on' — is OFF. Never throws.
 */
export function flagEnabled(env, flag) {
  if (!env || typeof flag !== 'string' || !flag) return false;
  return env[flag] === 'true';
}

/**
 * True when the owner has explicitly engaged the master kill switch
 * (DB_READS_ENABLED=false). Unset means "not engaged", so the core app keeps
 * working by default.
 */
export function masterKillSwitchEngaged(env = process.env) {
  return !!env && env[COST_BREAKER_MASTER_ENV_FLAG] === 'false';
}

// Every gate below is master-switch-aware: the master switch can only ever
// turn something OFF, never on.
function gated(env, flag) {
  if (masterKillSwitchEngaged(env)) return false;
  return flagEnabled(env, flag);
}

/** The external price-history scheduler may run at all. */
export function priceHistoryScheduleAllowed(env = process.env) {
  return gated(env, PRICE_HISTORY_SCHEDULE_ENV_FLAG);
}

/** A price-history collection cycle (upstream fetch + DB) may run. */
export function priceHistoryCollectAllowed(env = process.env) {
  return gated(env, PRICE_HISTORY_COLLECT_ENV_FLAG);
}

/**
 * A price-history WRITE may touch the database. Enforced inside the storage
 * module itself, not only at the endpoints, so a caller that forgets the flag
 * still cannot write.
 */
export function priceHistoryWritesAllowed(env = process.env) {
  return gated(env, PRICE_HISTORY_WRITE_ENV_FLAG);
}

/** A price-history prune (DELETE) may touch the database. */
export function priceHistoryPruneAllowed(env = process.env) {
  return gated(env, PRICE_HISTORY_PRUNE_ENV_FLAG);
}

/** Non-critical historical reads (panels, valuation layer, diagnostics). */
export function priceHistoryReadsAllowed(env = process.env) {
  return gated(env, PRICE_HISTORY_READS_ENV_FLAG);
}

/**
 * Cheap single-row bookkeeping reads (the collector's own min-spacing guard,
 * the snapshot index). Allowed when either collection or history reads are on:
 * an operator who deliberately enables collection must not have to enable a
 * second flag for the guard that stops that collection double-writing.
 */
export function priceHistoryMetaReadsAllowed(env = process.env) {
  return priceHistoryCollectAllowed(env) || priceHistoryReadsAllowed(env);
}

/** The canonical market-context collector may run its DB write cycle. */
export function marketContextCollectAllowed(env = process.env) {
  return gated(env, MARKET_CONTEXT_COLLECT_ENV_FLAG);
}

// ── Observability ───────────────────────────────────────────────────────────
// Counters, so "the panel is empty because the breaker is engaged" is a fact
// the operator can read instead of infer from a billing page. Keys are our own
// stable path labels and reason codes — never user data.
export const costBreakerStats = { blocked: {}, reasons: {}, lastBlockedAt: null };

export function resetCostBreakerStatsForTests() {
  costBreakerStats.blocked = {};
  costBreakerStats.reasons = {};
  costBreakerStats.lastBlockedAt = null;
}

/**
 * Records one blocked path and logs it at most once per path per process, so a
 * breaker that is silently eating every request stays visible in the function
 * logs without the logging itself becoming the next cost problem.
 */
export function noteCostBreakerBlock(path, reason, nowMs = Date.now()) {
  const label = typeof path === 'string' && path ? path.slice(0, 64) : 'unknown';
  const code = COST_BREAKER_REASONS.includes(reason) ? reason : REASON_COST_BREAKER_DISABLED_PATH;
  costBreakerStats.blocked[label] = (costBreakerStats.blocked[label] || 0) + 1;
  costBreakerStats.reasons[label] = code;
  costBreakerStats.lastBlockedAt = nowMs;
  const n = costBreakerStats.blocked[label];
  if (n === 1 || n % 500 === 0) {
    console.warn('[COST_GUARD] path_disabled', { path: label, reason: code, blocked: n });
  }
  return { ok: false, reason: code };
}

/**
 * Response headers that make the breaker visible to the browser and to curl.
 * `X-Cost-Guard` is always present; `X-DB-Read-Guard` names the reason a
 * database read was refused. Both carry only the stable codes above.
 */
export function costGuardHeaders(reason, extra = {}) {
  const code = COST_BREAKER_REASONS.includes(reason) ? reason : null;
  const out = { ...extra, 'X-Cost-Guard': code ? 'engaged' : 'pass' };
  if (code) out['X-DB-Read-Guard'] = code;
  return out;
}
