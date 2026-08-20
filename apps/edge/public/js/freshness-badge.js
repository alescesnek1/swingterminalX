// ─────────────────────────────────────────────────────────────
// Swing Terminal — Freshness/source badge decision (pure, no DOM)
//
// Maps the markets freshness state to the top-bar source badge:
//   live           → green  LIVE
//   stale-memory   → amber  STALE   (last-good snapshot, upstream failed)
//   error / !ok    → red    OFFLINE (the fetch itself failed)
//   anything else  → muted  (initial LOADING, etc.)
//
// Extracted from terminal.js so the decision is importable and
// unit-testable (Phase 4). terminal.js (a classic <script>) calls this
// via window.freshnessBadge, and keeps a safe inline fallback so the
// badge still renders even if this module fails to load.
// ─────────────────────────────────────────────────────────────

export function freshnessBadge(fresh, src) {
  const f = fresh || {};
  const at = f.servedFrom ? ('source: ' + f.servedFrom) : null;
  if (src === 'ERROR' || f.ok === false) return { cls: 's-error', label: 'OFFLINE', title: at || 'fetch failed' };
  if (src === 'STALE' || f.stale === true) return { cls: 's-stale', label: 'STALE', title: at || 'stale snapshot' };
  if (src === 'LIVE') return { cls: 's-live', label: 'LIVE', title: at || 'live' };
  return { cls: 's-mock', label: src || '—', title: at || (src || '—') };
}

// ─────────────────────────────────────────────────────────────
// Manual-refresh freshness hotfix — age-aware trust gate.
//
// The badge above answers "what did the edge say?". These answer the
// harder question the trader actually needs: "may I believe the NUMBERS
// on screen right now?".
//
// The edge stamps X-Generated-At when it writes the response, but the
// response can then sit in a CDN entry, an isolate cache, or a laptop that
// went to sleep. So age is measured in the BROWSER, against the snapshot
// build time, every time we paint. Anything past the budget is not live —
// and a snapshot with no timestamp at all is UNKNOWN, never live.
//
// Consequence, and the whole point of the hotfix: while the dataset is
// stale, a per-coin 24h % is NOT market truth. It is a frozen number from
// a past snapshot, so it renders as STALE instead of a confident +35.20%.
// ─────────────────────────────────────────────────────────────

// Keep in sync with MARKET_MAX_AGE_MS in the edge freshness lib. Above the
// worst-case CDN path (s-maxage 30 + SWR 60) and at the collector's ~3 min
// publish cycle: a healthy pipeline never flickers, a frozen one is named.
export const MARKET_MAX_AGE_MS = 180_000;

// Keep in sync with HARD_MAX_MARKET_AGE_MS in the edge freshness lib.
// The hard ceiling: past this the snapshot is not "stale market data", it is
// NOT market data. Production shipped a 25.9-hour-old canonical snapshot into
// the scanner and every row still looked like a normal quote, so this is the
// line where the UI stops rendering a market table and says so.
export const HARD_MAX_MARKET_AGE_MS = 30 * 60_000;

/**
 * May the on-screen market numbers be presented as live?
 * Pure. Fails closed — every unknown resolves to stale.
 * @param {Object} fresh window.__marketsFreshness
 * @param {Object} [opts] { now, maxAgeMs }
 * @returns {{stale:boolean, reason:string|null, ageMs:number|null, ageLabel:string|null}}
 */
export function marketFreshnessState(fresh, opts) {
  const f = fresh || {};
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const maxAgeMs = Number.isFinite(o.maxAgeMs) ? o.maxAgeMs : MARKET_MAX_AGE_MS;
  const gen = Number.isFinite(f.generatedAt) ? f.generatedAt : null;
  const ageMs = gen != null ? Math.max(0, now - gen) : null;
  const label = ageMs == null ? null : ageAgoLabel(ageMs);
  if (f.ok === false) return { stale: true, reason: 'fetch failed', ageMs, ageLabel: label };
  if (f.stale === true) return { stale: true, reason: f.staleReason || 'upstream served a last-good snapshot', ageMs, ageLabel: label };
  // No build timestamp → freshness is unprovable, so we do not claim it.
  if (gen == null) return { stale: true, reason: 'no snapshot timestamp', ageMs: null, ageLabel: null };
  if (ageMs > maxAgeMs) return { stale: true, reason: 'snapshot is ' + label + ' old', ageMs, ageLabel: label };
  return { stale: false, reason: null, ageMs, ageLabel: label };
}

/**
 * Is the on-screen dataset too old to be shown as a market table at all?
 *
 * This is the HARD gate, one step past `marketFreshnessState`. Stale means
 * "believe the shape, not the numbers"; unusable means "there is nothing here
 * to believe" — the scanner must say MARKET DATA UNAVAILABLE instead of
 * painting rows that look exactly like live quotes.
 *
 * Pure. Fails closed on every unknown: a failed fetch and a missing timestamp
 * are both unusable, because neither can prove the data is from today.
 *
 * @param {Object} fresh window.__marketsFreshness
 * @param {Object} [opts] { now, hardMaxAgeMs }
 * @returns {{unusable:boolean, reason:string|null, ageMs:number|null, ageLabel:string|null}}
 */
export function marketDataUnusable(fresh, opts) {
  const f = fresh || {};
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const hardMaxAgeMs = Number.isFinite(o.hardMaxAgeMs) ? o.hardMaxAgeMs : HARD_MAX_MARKET_AGE_MS;
  const gen = Number.isFinite(f.generatedAt) ? f.generatedAt : null;
  const ageMs = gen != null ? Math.max(0, now - gen) : null;
  const label = ageMs == null ? null : ageAgoLabel(ageMs);
  if (f.ok === false) return { unusable: true, reason: 'the market read failed', ageMs, ageLabel: label };
  if (gen == null) return { unusable: true, reason: 'no snapshot timestamp', ageMs: null, ageLabel: null };
  if (ageMs > hardMaxAgeMs) {
    return { unusable: true, reason: 'snapshot is ' + label + ' old — beyond the ' + ageAgoLabel(hardMaxAgeMs) + ' hard limit', ageMs, ageLabel: label };
  }
  return { unusable: false, reason: null, ageMs, ageLabel: label };
}

/** Compact human age ("48m", "12s"). Pure. */
export function ageAgoLabel(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return '—';
  const sec = Math.round(ageMs / 1000);
  if (sec < 90) return sec + 's';
  const min = Math.round(sec / 60);
  if (min < 90) return min + 'm';
  return Math.round(min / 60) + 'h';
}

/**
 * How to render a percentage that is only meaningful if the dataset is
 * current (24h change being the case that burned us: a stale +35.20%
 * looked exactly like a live one).
 *
 * Rules, in order:
 *   dataset stale        → 'STALE'   (never a number)
 *   value absent/NaN     → 'UNKNOWN' (never 0.00%, never synthesized)
 *   otherwise            → the signed number
 *
 * @param {number|null|undefined} value
 * @param {{stale:boolean, reason?:string|null, ageLabel?:string|null}} state
 * @param {Object} [opts] { format: (n)=>string }
 * @returns {{text:string, cls:string, title:string, known:boolean}}
 */
export function pct24hDisplay(value, state, opts) {
  const st = state || { stale: true, reason: 'unknown freshness' };
  const fmt = (opts && typeof opts.format === 'function')
    ? opts.format
    : (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  if (st.stale) {
    const age = st.ageLabel ? ' · snapshot ' + st.ageLabel + ' old' : '';
    return {
      text: 'STALE',
      cls: 'pct-stale',
      title: '24h change withheld — dataset is not live' + age + (st.reason ? ' (' + st.reason + ')' : '') + '. Press REFRESH.',
      known: false,
    };
  }
  // Reject null/'' BEFORE Number(), or a missing value becomes a confident 0.
  if (value === null || value === undefined || value === '') {
    return { text: 'UNKNOWN', cls: 'pct-unknown', title: '24h change not reported by the market source', known: false };
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return { text: 'UNKNOWN', cls: 'pct-unknown', title: '24h change not reported by the market source', known: false };
  }
  return { text: fmt(n), cls: n >= 0 ? 'pos' : 'neg', title: '24h change from the current market snapshot', known: true };
}

if (typeof window !== 'undefined') {
  window.freshnessBadge = freshnessBadge;
  // terminal.js is a classic <script>, so the age-aware helpers are handed
  // over on `window` the same way. terminal.js keeps fail-closed inline
  // fallbacks: if this module ever fails to load the UI degrades to STALE,
  // never to a confident number.
  window.__marketFreshness = { marketFreshnessState, marketDataUnusable, pct24hDisplay, ageAgoLabel, MARKET_MAX_AGE_MS, HARD_MAX_MARKET_AGE_MS };
}
