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
export function buildFreshnessMeta({ servedFrom = SERVED_LIVE, generatedAt = null, now = Date.now() } = {}) {
  const gen = Number.isFinite(generatedAt) ? generatedAt : null;
  const ageMs = gen != null ? Math.max(0, now - gen) : null;
  // Anything not served straight from the live build is, by definition,
  // not "fresh". Keeps the stale signal fail-safe: unknown → stale.
  const stale = servedFrom !== SERVED_LIVE;
  return {
    servedFrom,
    generatedAt: gen != null ? new Date(gen).toISOString() : null,
    generatedAtMs: gen,
    stale,
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
  return h;
}
