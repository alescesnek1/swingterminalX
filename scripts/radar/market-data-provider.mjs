// market-data-provider.mjs — Market Data Provider abstraction for the RADAR
// static microstructure overlay.
//
// WHY THIS EXISTS
//   Static microstructure (order-book depth / spread / funding) is an OPTIONAL,
//   provider-backed OVERLAY — never a hard dependency, never an automatic
//   Binance scraping cron. Production runs with NO provider configured, so the
//   producer performs ZERO external fetches and the UI shows
//   "provider unavailable" (not a misleading "missing/error" state).
//
//   Binance public fapi is reachable only from an operator's local PC; both
//   GitHub Actions and Netlify serverless egress are region-blocked (HTTP 451).
//   So `binance-public` is a DIAGNOSTIC / LOCAL-ONLY provider that must be
//   explicitly opted into via MARKET_DATA_PROVIDER=binance-public. It must
//   never be the default and never run on an automatic schedule.
//
// SAFETY POSTURE (fail-closed)
//   • Default (unset / "none") → unavailable, reason "provider-unavailable",
//     ZERO external calls.
//   • PUBLIC market data only — no API key, no signature, no order/margin/signed
//     endpoint. No worker/session/live-testnet lifecycle. Never touches order paths.
//   • Static-only / provider-unavailable data must NEVER pass Absorb, promote a
//     candidate to ENTRY_READY, or make it Telegram-eligible.
//
// INTERFACE
//   createMarketDataProvider(env, opts) -> provider
//   provider.name                          'none' | 'binance-public' | 'snapshot'
//   provider.getStaticMicrostructure(c)    -> { available, reason, symbol?, fields? }
//   provider.health()                      -> { name, status, reason }

import { enrichRadarCandidatesMicrostructure } from '../auto/microstructure-enrichment.mjs';

// The single canonical reason string used everywhere a provider cannot serve
// trusted static microstructure. Surfaced verbatim in API/UI diagnostics.
export const PROVIDER_UNAVAILABLE = 'provider-unavailable';

// A stored static snapshot older than this is reported as "stale" rather than
// "present" so the UI never treats long-dead overlay data as fresh.
export const MICROSTRUCTURE_STALE_MS = 30 * 60 * 1000;

// Resolve the configured provider name. Anything other than the two explicit
// opt-in providers (including unset/empty/unknown) falls closed to "none".
export function resolveProviderName(env = {}) {
  const raw = String(env.MARKET_DATA_PROVIDER || '').trim().toLowerCase();
  if (raw === 'binance-public') return 'binance-public';
  if (raw === 'snapshot') return 'snapshot';
  return 'none';
}

// ── none: the fail-closed default ────────────────────────────────────────────
// Returns "unavailable" for every candidate and performs ZERO external calls.
function createNoneProvider() {
  return {
    name: 'none',
    diagnostic: false,
    async getStaticMicrostructure() {
      return { available: false, reason: PROVIDER_UNAVAILABLE, symbol: null, fields: null };
    },
    health() {
      return { name: 'none', status: 'unavailable', reason: PROVIDER_UNAVAILABLE };
    },
  };
}

// ── binance-public: DIAGNOSTIC / LOCAL-ONLY ──────────────────────────────────
// Reuses the existing public fapi logic in microstructure-enrichment.mjs. Must
// be explicitly selected (MARKET_DATA_PROVIDER=binance-public); never default,
// never scheduled. Public market data only — no key/secret, no signed endpoint.
function createBinancePublicProvider(env, opts = {}) {
  const fetchImpl = opts.fetchFn || opts.fetchImpl || globalThis.fetch;
  // Per-candidate measurement: delegate to the shared, well-tested enrichment
  // helper with a single-candidate, single-scan config so the resolver, host
  // allowlist, and fail-closed field omission all behave identically.
  async function getStaticMicrostructure(candidate, callOpts = {}) {
    const config = { enabled: true, topN: 1, scanLimit: 1, cacheMs: 0 };
    const data = await enrichRadarCandidatesMicrostructure([candidate], {
      config,
      fetchImpl,
      spotBaseUrl: callOpts.spotBaseUrl ?? opts.spotBaseUrl,
      futuresBaseUrl: callOpts.futuresBaseUrl ?? opts.futuresBaseUrl,
      timeoutMs: callOpts.timeoutMs ?? opts.timeoutMs,
      now: callOpts.now ?? opts.now,
      cache: callOpts.cache ?? opts.cache,
    });
    const keys = Object.keys(data);
    if (!keys.length) return { available: true, reason: 'no-data', symbol: null, fields: null };
    return { available: true, reason: null, symbol: keys[0], fields: data[keys[0]] };
  }
  return {
    name: 'binance-public',
    diagnostic: true,
    getStaticMicrostructure,
    health() {
      return { name: 'binance-public', status: 'available', diagnostic: true, reason: null };
    },
  };
}

// ── snapshot: read-only, NO external fetch ───────────────────────────────────
// Serves whatever a previous producer run already stored in
// fleet.radarMicrostructureSnapshot. It NEVER calls an external API. Useful for
// the control plane / API context; in the producer it behaves like "none"
// (nothing new to measure) because the producer is the thing that writes it.
function createSnapshotProvider(env, opts = {}) {
  // opts.snapshot may be the raw fleet.radarMicrostructureSnapshot object, or
  // opts.getSnapshot a function returning it. No network access either way.
  const readSnapshot = () => {
    if (typeof opts.getSnapshot === 'function') return opts.getSnapshot();
    return opts.snapshot || null;
  };
  const symbolKeys = (candidate) => {
    const keys = [];
    const add = (v) => {
      if (typeof v !== 'string') return;
      const s = v.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (s) keys.push(s);
    };
    if (candidate && typeof candidate === 'object') {
      add(candidate.futures_pair);
      add(candidate.futuresPair);
      add(candidate.pair);
      add(candidate.symbol);
      if (candidate.base && candidate.quote) add(`${candidate.base}${candidate.quote}`);
    }
    return keys;
  };
  return {
    name: 'snapshot',
    diagnostic: false,
    async getStaticMicrostructure(candidate) {
      const snap = readSnapshot();
      const data = snap && snap.data && typeof snap.data === 'object' ? snap.data : null;
      if (!data) return { available: false, reason: PROVIDER_UNAVAILABLE, symbol: null, fields: null };
      for (const key of symbolKeys(candidate)) {
        if (data[key]) return { available: true, reason: null, symbol: key, fields: data[key] };
      }
      return { available: true, reason: 'no-data', symbol: null, fields: null };
    },
    health() {
      const snap = readSnapshot();
      const present = !!(snap && snap.data && Object.keys(snap.data).length);
      return present
        ? { name: 'snapshot', status: 'available', reason: null }
        : { name: 'snapshot', status: 'unavailable', reason: PROVIDER_UNAVAILABLE };
    },
  };
}

// Factory. The provider is chosen purely from env (fail-closed default), so a
// missing/unknown MARKET_DATA_PROVIDER can never trigger an external fetch.
export function createMarketDataProvider(env = {}, opts = {}) {
  const name = resolveProviderName(env);
  if (name === 'binance-public') return createBinancePublicProvider(env, opts);
  if (name === 'snapshot') return createSnapshotProvider(env, opts);
  return createNoneProvider(env, opts);
}

// Classify a stored static snapshot for API/UI diagnostics. Pure, no network.
// Distinguishes present / stale / unavailable so the UI never shows a
// misleading "missing/no-data error" when the provider simply isn't configured.
export function microstructureSnapshotStatus(snapshot, nowMs = Date.now(), staleMs = MICROSTRUCTURE_STALE_MS) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const data = snap.data && typeof snap.data === 'object' ? snap.data : {};
  const metrics = Object.keys(data).length;
  const provider = typeof snap.provider === 'string' && snap.provider ? snap.provider : 'none';
  const receivedAt = typeof snap.receivedAt === 'string' ? snap.receivedAt : null;
  const ageMs = receivedAt ? (nowMs - Date.parse(receivedAt)) : null;
  const present = metrics > 0;
  const stale = present && Number.isFinite(ageMs) && ageMs > staleMs;
  let providerStatus;
  let unavailableReason = null;
  if (!present) {
    providerStatus = 'unavailable';
    unavailableReason = PROVIDER_UNAVAILABLE;
  } else if (stale) {
    providerStatus = 'stale';
  } else {
    providerStatus = 'present';
  }
  return { provider, providerStatus, unavailableReason, present, stale, metrics, receivedAt };
}
