// ─────────────────────────────────────────────────────────────
// Swing Terminal — Freshness metadata helper (Batch B)
//
// Single source of truth for "how fresh is this data?" so the
// /api/markets edge function and the browser agree on what counts
// as LIVE vs STALE vs a FALLBACK degraded response.
//
// Why headers (not a body envelope): /api/markets serves a bare
// JSON array (tier-pre-sliced). Wrapping it in an object would break
// the array contract the scanner + tier slicing rely on. So freshness
// travels as response headers, which the browser reads off the
// Response object without touching the row payload.
//
// PURE + dependency-free on purpose: this runs on the Deno edge AND
// is imported directly by Node test runner. No Deno/Node globals at
// module load, no network, no I/O.
// ─────────────────────────────────────────────────────────────

export const SERVED_LIVE = 'live';            // freshly built, or within-TTL cached snapshot
export const SERVED_STALE = 'stale-memory';   // last-good snapshot served because upstream failed
export const SERVED_FALLBACK = 'fallback';    // reserved: degraded/secondary source

/**
 * Build a freshness descriptor.
 * @param {Object} opts
 * @param {string} [opts.servedFrom] one of SERVED_LIVE | SERVED_STALE | SERVED_FALLBACK
 * @param {number|null} [opts.generatedAt] epoch ms the served snapshot was built
 * @param {number} [opts.now] epoch ms "now" (injectable for tests)
 * @returns {{servedFrom:string, generatedAt:string|null, generatedAtMs:number|null, stale:boolean, ageMs:number|null}}
 */
export function buildFreshnessMeta({ servedFrom = SERVED_LIVE, generatedAt = null, now = Date.now(), maxAgeMs = null } = {}) {
  const gen = Number.isFinite(generatedAt) ? generatedAt : null;
  const ageMs = gen != null ? Math.max(0, now - gen) : null;
  // Anything not served straight from the live build is, by definition,
  // not "fresh". Keeps the stale signal fail-safe: unknown → stale.
  // `maxAgeMs` (opt-in, default off) additionally demotes a snapshot that
  // WAS built live but has since aged past the caller's budget — see
  // freshnessVerdict below.
  const verdict = freshnessVerdict({ servedFrom, generatedAt: gen, now, maxAgeMs });
  return {
    servedFrom,
    generatedAt: gen != null ? new Date(gen).toISOString() : null,
    generatedAtMs: gen,
    stale: verdict.stale,
    staleReason: verdict.reason,
    ageMs,
  };
}

/**
 * Map a freshness descriptor to response headers. Preserves the
 * existing `X-Served-From` contract and adds explicit age/stale flags.
 * @param {ReturnType<typeof buildFreshnessMeta>} meta
 * @returns {Record<string,string>}
 */
export function freshnessHeaders(meta) {
  const h = {
    'X-Served-From': meta.servedFrom,
    'X-Stale': meta.stale ? 'true' : 'false',
  };
  if (meta.generatedAt) h['X-Generated-At'] = meta.generatedAt;
  if (meta.ageMs != null) h['X-Age-Ms'] = String(meta.ageMs);
  // Why it is stale, so the operator sees a reason instead of a bare flag.
  if (meta.staleReason) h['X-Stale-Reason'] = meta.staleReason;
  return h;
}

// ─────────────────────────────────────────────────────────────
// Manual-refresh freshness hotfix
//
// Two additions, both pure:
//
// 1) AGE-BASED STALENESS. `servedFrom` alone is not enough. A snapshot
//    can be built "live" on the edge and still reach the browser minutes
//    later (CDN s-maxage + stale-while-revalidate, an isolate response
//    cache, a sleeping laptop). Age is the only honest test, so callers
//    can pass an explicit `maxAgeMs` budget and get `stale:true` with a
//    reason when the snapshot is older than that. Default stays OFF
//    (null) so no existing caller changes behaviour.
//
// 2) FORCE-REFRESH DETECTION. A user pressing REFRESH must be able to
//    reach origin. `isForceRefreshRequest` is the single, testable place
//    that decides whether a request carries that intent. It is
//    deliberately limited to the PUBLIC market read — no DB-backed
//    history/context collector consults it.
// ─────────────────────────────────────────────────────────────

// Default age budget for a market snapshot before it stops counting as
// live. Sized above the worst-case CDN path (s-maxage 30 + SWR 60) and at
// the collector's own ~3 min publish cycle, so a healthy pipeline never
// flickers STALE but a frozen one is called out within one cycle.
export const MARKET_MAX_AGE_MS = 180_000;

// Reasons a snapshot is not trustworthy as "live". Strings are surfaced
// to the operator, so they must stay specific and non-secret.
export const STALE_REASON_SERVED_FROM = 'served-from-not-live';
export const STALE_REASON_AGE = 'snapshot-older-than-budget';
export const STALE_REASON_NO_TIMESTAMP = 'no-snapshot-timestamp';

/**
 * Age-aware freshness verdict. Pure; `now` is injectable.
 * Fails closed: an unknown timestamp is UNKNOWN, never "fresh".
 * @param {Object} opts
 * @param {string} [opts.servedFrom]
 * @param {number|null} [opts.generatedAt] epoch ms
 * @param {number} [opts.now]
 * @param {number|null} [opts.maxAgeMs] age budget; null disables the age test
 * @returns {{stale:boolean, reason:string|null, ageMs:number|null}}
 */
export function freshnessVerdict({ servedFrom = SERVED_LIVE, generatedAt = null, now = Date.now(), maxAgeMs = null } = {}) {
  const gen = Number.isFinite(generatedAt) ? generatedAt : null;
  const ageMs = gen != null ? Math.max(0, now - gen) : null;
  if (servedFrom !== SERVED_LIVE) return { stale: true, reason: STALE_REASON_SERVED_FROM, ageMs };
  if (gen == null) {
    // No timestamp AND an age budget was requested → we cannot prove
    // freshness, so we must not claim it.
    if (Number.isFinite(maxAgeMs)) return { stale: true, reason: STALE_REASON_NO_TIMESTAMP, ageMs: null };
    return { stale: false, reason: null, ageMs: null };
  }
  if (Number.isFinite(maxAgeMs) && ageMs > maxAgeMs) return { stale: true, reason: STALE_REASON_AGE, ageMs };
  return { stale: false, reason: null, ageMs };
}

/**
 * Does this request explicitly ask to bypass caches and rebuild?
 * Accepts `?force=1` / `?force=true` or `X-Force-Refresh: 1`.
 * @param {{url?:string, headers?:{get:(k:string)=>string|null}}} request
 * @returns {boolean}
 */
export function isForceRefreshRequest(request) {
  if (!request) return false;
  const truthy = (v) => v === '1' || v === 'true' || v === 'yes';
  const hdr = request.headers && typeof request.headers.get === 'function'
    ? request.headers.get('X-Force-Refresh')
    : null;
  if (hdr && truthy(String(hdr).trim().toLowerCase())) return true;
  // Regex over the raw query rather than `new URL()`: this is a read path on
  // every markets request, and a malformed URL must resolve to "no force"
  // WITHOUT a throw to swallow. No try/catch means no failure to hide.
  // Deliberately NOT percent-decoded — `1`/`true`/`yes` need no decoding, and
  // decodeURIComponent throws on malformed input like `?force=%E0%A4%A`, which
  // would have turned a junk query string into a 502 on the whole market read.
  const url = typeof request.url === 'string' ? request.url : '';
  const m = /[?&]force=([^&#]*)/.exec(url);
  if (m && truthy(m[1].trim().toLowerCase())) return true;
  return false;
}
