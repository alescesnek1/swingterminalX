// morning-briefing.mjs — shared logic for the daily Terminal-X Morning Market
// Briefing sent to Telegram.
//
// WHAT THIS IS:
//   An INFORMATIONAL once-a-day market briefing. It is NOT a trade signal, NOT
//   a RADAR ENTRY_READY alert, and NEVER executes anything. It only reads the
//   desk's existing advisory state (market snapshot, Trading RADAR, regime,
//   safety diagnostics) and formats a concise Telegram message.
//
// SAFETY CONTRACT (mirrors cron-alerts but for a SEPARATE, independent path):
//   - Its own env gate: MORNING_BRIEFING_TELEGRAM_ENABLED === 'true'. It does
//     NOT read RADAR_TELEGRAM_ENABLED, so it can never enable/disable RADAR
//     alerts and the RADAR gate can never enable this.
//   - Honors the global kill switches TELEGRAM_ENABLED=false and
//     CRON_ALERTS_ENABLED=false.
//   - Missing TG_BOT_TOKEN / TG_CHAT_ID disables sending.
//   - It never touches the scanner BUY/FLUSH/WATCH alert path, the RADAR
//     ENTRY_READY gate, order execution, or worker state.
//   - The briefing may discuss watchlist ideas, but it must never claim a trade
//     is confirmed unless the RADAR candidate is truly actionability ENTRY_READY.
//
// All side effects (Telegram send, fleet read/write, AI call) are injected so
// this module stays pure and unit-testable.

export const MORNING_BRIEFING_CODES = Object.freeze({
  DISABLED_BY_ENV: 'MORNING_BRIEFING_DISABLED_BY_ENV',
  MISSING_CREDENTIALS: 'MORNING_BRIEFING_MISSING_CREDENTIALS',
  OUTSIDE_WINDOW: 'MORNING_BRIEFING_OUTSIDE_WINDOW',
  ALREADY_SENT: 'MORNING_BRIEFING_SKIPPED_ALREADY_SENT',
  SENT: 'MORNING_BRIEFING_SENT',
  SEND_FAILED: 'MORNING_BRIEFING_SEND_FAILED',
  DRY_RUN: 'MORNING_BRIEFING_DRY_RUN',
});

// ── data sources ────────────────────────────────────────────────────────────
// The briefing reads market state from the CANONICAL context store (the same
// database the RADAR alert path reads behind RADAR_ALERTS_CANONICAL_SOURCE), and
// only falls back to the legacy Fleet blob when canonical is unavailable. The
// fallback is always LABELLED and always age-checked: the Fleet blob is written
// by a local worker / an open browser tab, so at 08:00 it is routinely hours or
// days old. Presenting those cached numbers as "today" is what made this
// briefing lie (observed 2026-08-01: BTC printed +0.6% from a 2026-07-30 13:40
// snapshot while BTC was actually -1.8% on the day).
export const MORNING_BRIEFING_DATA_SOURCES = Object.freeze({
  CANONICAL: 'canonical_context',
  FLEET: 'fleet_snapshot',
  NONE: 'unavailable',
});

// Reason codes for a withheld section. Every code must be renderable into a
// sentence the owner can act on — "why is this box empty" must never be a guess.
export const MORNING_BRIEFING_DATA_REASONS = Object.freeze({
  NO_DATA: 'NO_MARKET_DATA',
  NO_MARKET_SNAPSHOT: 'NO_MARKET_SNAPSHOT',
  MARKET_STALE: 'MARKET_DATA_STALE',
  MARKET_NO_TIMESTAMP: 'MARKET_DATA_UNDATED',
  RADAR_PENDING: 'RADAR_NOT_SCORED',
  RADAR_EMPTY: 'RADAR_NO_CANDIDATES',
  RADAR_STALE: 'RADAR_CONTEXT_STALE',
  RADAR_NO_TIMESTAMP: 'RADAR_CONTEXT_UNDATED',
});

// Freshness bound for anything the briefing states as current. The canonical
// collector publishes every 3 minutes, so 15 minutes is five cycles — comfortably
// past scheduler drift, nowhere near "yesterday's tape".
export const DEFAULT_MAX_DATA_AGE_MS = 15 * 60 * 1000;

export function maxDataAgeMs(env = process.env) {
  const min = Number(env && env.MORNING_BRIEFING_MAX_DATA_AGE_MIN);
  if (!Number.isFinite(min) || min <= 0) return DEFAULT_MAX_DATA_AGE_MS;
  return Math.round(min * 60 * 1000);
}

export const DISCLAIMER = 'Advisory briefing only. No auto execution. Confirm manually before trading.';
export const MACRO_UNAVAILABLE = 'Macro/news unavailable — showing market-only briefing';

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'BUSD', 'USDP', 'USDD']);
const QUOTES = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD'];

// Best-effort sector tagging. Used only for the "Crypto sectors" section — when
// nothing maps, the section honestly reports sector data unavailable.
const SECTOR_MAP = {
  BTC: 'L1/L2', ETH: 'L1/L2', SOL: 'L1/L2', BNB: 'L1/L2', AVAX: 'L1/L2', ADA: 'L1/L2',
  SUI: 'L1/L2', APT: 'L1/L2', SEI: 'L1/L2', NEAR: 'L1/L2', TON: 'L1/L2', TRX: 'L1/L2',
  DOT: 'L1/L2', ARB: 'L1/L2', OP: 'L1/L2', MATIC: 'L1/L2', STRK: 'L1/L2', POL: 'L1/L2',
  UNI: 'DeFi', AAVE: 'DeFi', MKR: 'DeFi', CRV: 'DeFi', LDO: 'DeFi', PENDLE: 'DeFi',
  ENA: 'DeFi', CAKE: 'DeFi', GMX: 'DeFi', DYDX: 'DeFi', JUP: 'DeFi',
  FET: 'AI', RENDER: 'AI', RNDR: 'AI', TAO: 'AI', WLD: 'AI', OCEAN: 'AI', AKT: 'AI', IO: 'AI',
  DOGE: 'Meme', SHIB: 'Meme', PEPE: 'Meme', WIF: 'Meme', BONK: 'Meme', FLOKI: 'Meme', BRETT: 'Meme',
  IMX: 'Game', GALA: 'Game', AXS: 'Game', SAND: 'Game', MANA: 'Game', PIXEL: 'Game', BEAM: 'Game',
  LINK: 'Infra', GRT: 'Infra', FIL: 'Infra', AR: 'Infra', HNT: 'Infra', RUNE: 'Infra',
};

const FLUSH_STAGES = new Set(['LONG_FLUSH_CONFIRMED', 'STABILIZING', 'STABILIZATION', 'DISLOCATION_CONFIRMED', 'RECLAIM_DETECTED', 'SQUEEZE_CONFIRMED']);
const ENTRY_READY_ACTIONABILITY = 'ENTRY_READY';

// ── small helpers ──────────────────────────────────────────────────────────
// null / undefined / '' must stay null, NOT become 0: Number(null) === 0 would
// turn "no data" into a real-looking zero (a missing volume rendering as $0, a
// missing age rendering as "under 1 min"), which is exactly the fallback this
// repo forbids.
function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

export function escapeHtml(v) {
  return String(v == null ? '--' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function baseOf(symbol) {
  const s = String(symbol || '').toUpperCase();
  for (const q of QUOTES) if (s.endsWith(q) && s.length > q.length) return s.slice(0, -q.length);
  return s;
}

function rowChange(row) {
  return num(row && (row.priceChangePercent ?? row.change24hPct ?? (row.diagnostics && row.diagnostics.change24hPct)));
}

function fmtPct(v) {
  const n = num(v);
  if (n == null) return 'N/A';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

// Human age for a Telegram line: "4 min", "3 h 12 min", "2 d 1 h".
export function fmtAge(ms) {
  const n = num(ms);
  if (n == null || n < 0) return 'unknown age';
  const min = Math.floor(n / 60000);
  if (min < 1) return 'under 1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const remMin = min % 60;
  if (h < 24) return remMin ? `${h} h ${remMin} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d} d ${remH} h` : `${d} d`;
}

function ageMsOf(iso, nowMs) {
  if (!iso) return null;
  const t = iso instanceof Date ? iso.getTime() : new Date(iso).getTime();
  return Number.isFinite(t) ? Math.max(0, nowMs - t) : null;
}

function isoOf(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function fmtUsd(v) {
  const n = num(v);
  if (n == null) return 'N/A';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// ── env gating ───────────────────────────────────────────────────────────--
// Fail-closed: enabled ONLY when MORNING_BRIEFING_TELEGRAM_ENABLED === 'true'
// AND no global kill switch is set. Deliberately does NOT reference
// RADAR_TELEGRAM_ENABLED — this path is independent of the RADAR gate.
export function isMorningBriefingHardDisabled(env = process.env) {
  return env.TELEGRAM_ENABLED === 'false'
    || env.CRON_ALERTS_ENABLED === 'false'
    || env.MORNING_BRIEFING_TELEGRAM_ENABLED !== 'true';
}

// ── timezone helpers (Intl-based, no external deps) ─────────────────────────
// Local calendar day (YYYY-MM-DD) in the target timezone, used for once-per-day
// dedup so a UTC cron firing across midnight can't double-send.
export function localDayString(now = new Date(), timeZone = 'Europe/Prague') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }
}

// Local hour (0-23) in the target timezone — used to fire at the configured
// local hour regardless of DST while the cron itself runs hourly in UTC.
export function localHour(now = new Date(), timeZone = 'Europe/Prague') {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(now);
    const n = parseInt(h, 10);
    return Number.isFinite(n) ? (n % 24) : null;
  } catch {
    return now.getUTCHours();
  }
}

// ── canonical row mapping ───────────────────────────────────────────────────
// market_ticker_observations row → the market-row shape the rest of this module
// already reads. NULL stays null so a missing field renders UNKNOWN, never 0.
export function mapCanonicalTicker(row) {
  if (!row || !row.symbol) return null;
  return {
    symbol: String(row.symbol).toUpperCase(),
    market: row.market || null,
    baseAsset: row.base_asset ? String(row.base_asset).toUpperCase() : null,
    quoteAsset: row.quote_asset ? String(row.quote_asset).toUpperCase() : null,
    lastPrice: num(row.last_price),
    priceChangePercent: num(row.price_change_percent),
    quoteVolume: num(row.quote_volume),
  };
}

// The canonical universe carries spot AND futures rows for the same symbol.
// Counting both would double every symbol in breadth/median/volume, so one row
// per symbol wins, spot first (that is the venue RADAR scores).
function dedupeBySymbolSpotFirst(rows) {
  const bySymbol = new Map();
  for (const r of rows) {
    if (!r || !r.symbol) continue;
    const prev = bySymbol.get(r.symbol);
    if (!prev || (prev.market !== 'spot' && r.market === 'spot')) bySymbol.set(r.symbol, r);
  }
  return Array.from(bySymbol.values());
}

// radar_candidate_state row → the candidate shape this module reads. The stored
// payload IS the evaluator's candidate, so it is spread as-is; only the fields the
// briefing gates on are re-derived from the authoritative columns.
export function mapCanonicalCandidate(row) {
  if (!row) return null;
  const payload = (row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)) ? row.payload : {};
  const symbol = payload.symbol || row.symbol;
  if (!symbol) return null;
  // ENTRY_READY may only ever come from the canonical `entry_ready` column. A
  // payload that claims ENTRY_READY while the column says otherwise is downgraded,
  // never promoted — the briefing must not announce a setup RADAR did not confirm.
  const entryReady = row.entry_ready === true;
  const payloadAction = payload.actionability && String(payload.actionability) !== ENTRY_READY_ACTIONABILITY
    ? String(payload.actionability) : null;
  return {
    ...payload,
    symbol: String(symbol).toUpperCase(),
    stage: payload.stage || row.status || 'NO_SETUP',
    actionability: entryReady ? ENTRY_READY_ACTIONABILITY : (payloadAction || 'NEEDS_CONFIRMATION'),
    safetyStatus: payload.safetyStatus || 'UNKNOWN',
    distanceToEntryReadyScore: num(payload.distanceToEntryReadyScore ?? row.setup_score),
  };
}

// ── data source selection + freshness ───────────────────────────────────────
// Resolves WHICH state the briefing describes and HOW OLD it is, on two
// independent axes: the market observation (pulse/sectors/movers) and the RADAR
// verdict (watchlist/candidates). Either axis may be unusable on its own, and an
// unusable axis is reported — never silently rendered from stale numbers.
export function buildMarketContext({ canonical = null, fleet = {}, env = process.env, nowMs = Date.now() } = {}) {
  const maxAge = maxDataAgeMs(env);
  const notes = [];
  let canonicalAxes = null; // set when canonical was read but unusable

  const emptyAxis = (reason) => ({ usable: false, observedAt: null, ageMs: null, reason });

  if (canonical && canonical.ok === true) {
    const market = (canonical.market && typeof canonical.market === 'object') ? canonical.market : null;
    const radar = (canonical.radar && typeof canonical.radar === 'object') ? canonical.radar : null;
    const markets = dedupeBySymbolSpotFirst((Array.isArray(market && market.tickers) ? market.tickers : [])
      .map(mapCanonicalTicker).filter(Boolean));
    const marketObservedAt = isoOf(market && market.observedAt);
    const marketAgeMs = ageMsOf(marketObservedAt, nowMs);
    let marketReason = null;
    if (!markets.length) marketReason = MORNING_BRIEFING_DATA_REASONS.NO_MARKET_SNAPSHOT;
    else if (marketAgeMs == null) marketReason = MORNING_BRIEFING_DATA_REASONS.MARKET_NO_TIMESTAMP;
    else if (marketAgeMs > maxAge) marketReason = MORNING_BRIEFING_DATA_REASONS.MARKET_STALE;

    const radarStatus = String((radar && radar.status) || 'PENDING').toUpperCase();
    const candidates = (Array.isArray(radar && radar.candidates) ? radar.candidates : [])
      .map(mapCanonicalCandidate).filter(Boolean);
    const candidatesObservedAt = isoOf(radar && (radar.computedAt || radar.diagnosticsComputedAt));
    const candidatesAgeMs = ageMsOf(candidatesObservedAt, nowMs);
    let candidatesReason = null;
    if (radarStatus !== 'READY') candidatesReason = MORNING_BRIEFING_DATA_REASONS.RADAR_PENDING;
    else if (!candidates.length) candidatesReason = MORNING_BRIEFING_DATA_REASONS.RADAR_EMPTY;
    else if (candidatesAgeMs == null) candidatesReason = MORNING_BRIEFING_DATA_REASONS.RADAR_NO_TIMESTAMP;
    else if (candidatesAgeMs > maxAge) candidatesReason = MORNING_BRIEFING_DATA_REASONS.RADAR_STALE;

    // Only take canonical when at least one axis is actually usable; otherwise fall
    // through to the labelled Fleet fallback rather than reporting an empty
    // canonical read as the whole truth.
    if (!marketReason || !candidatesReason) {
      const radarRegime = (radar && radar.marketRegime && typeof radar.marketRegime === 'object') ? radar.marketRegime : {};
      return {
        source: MORNING_BRIEFING_DATA_SOURCES.CANONICAL,
        sourceNotes: notes,
        maxAgeMs: maxAge,
        markets,
        candidates,
        entryReady: candidates.filter((c) => String(c.actionability || '') === ENTRY_READY_ACTIONABILITY),
        regime: radarRegime,
        universeDiagnostics: (radar && radar.universeDiagnostics && typeof radar.universeDiagnostics === 'object') ? radar.universeDiagnostics : {},
        market: { usable: !marketReason, observedAt: marketObservedAt, ageMs: marketAgeMs, reason: marketReason },
        candidatesFreshness: { usable: !candidatesReason, observedAt: candidatesObservedAt, ageMs: candidatesAgeMs, reason: candidatesReason },
      };
    }
    notes.push(`canonical unusable (market ${marketReason}, radar ${candidatesReason})`);
    // Remember WHY canonical failed. If the Fleet fallback is also unusable, the
    // canonical reason is the one worth reporting — "collector data is 2 h old"
    // points at the stage that actually broke, where the legacy blob's
    // "no snapshot" only restates that the old path is dead.
    canonicalAxes = {
      market: { reason: marketReason, observedAt: marketObservedAt, ageMs: marketAgeMs },
      candidates: { reason: candidatesReason, observedAt: candidatesObservedAt, ageMs: candidatesAgeMs },
    };
  } else if (canonical) {
    notes.push(`canonical read failed: ${String(canonical.reason || 'UNKNOWN').slice(0, 60)}`);
  } else {
    notes.push('canonical read not attempted');
  }

  // ── labelled fallback: the legacy Fleet blob ──
  const radar = (fleet && fleet.tradingRadar && typeof fleet.tradingRadar === 'object') ? fleet.tradingRadar : {};
  const snapshot = (fleet && fleet.autoMarketSnapshot && typeof fleet.autoMarketSnapshot === 'object') ? fleet.autoMarketSnapshot : {};
  const markets = Array.isArray(snapshot.markets) ? snapshot.markets : [];
  const marketObservedAt = isoOf(snapshot.fetchedAt || snapshot.receivedAt);
  const marketAgeMs = ageMsOf(marketObservedAt, nowMs);
  let marketReason = null;
  if (!markets.length || String(radar.source || '') === 'no_public_snapshot') marketReason = MORNING_BRIEFING_DATA_REASONS.NO_MARKET_SNAPSHOT;
  else if (marketAgeMs == null) marketReason = MORNING_BRIEFING_DATA_REASONS.MARKET_NO_TIMESTAMP;
  else if (marketAgeMs > maxAge) marketReason = MORNING_BRIEFING_DATA_REASONS.MARKET_STALE;

  const candidates = Array.isArray(radar.candidates) ? radar.candidates : [];
  const candidatesObservedAt = isoOf(radar.updatedAt
    || (fleet && fleet.radarContext && fleet.radarContext.receivedAt)
    || snapshot.fetchedAt);
  const candidatesAgeMs = ageMsOf(candidatesObservedAt, nowMs);
  let candidatesReason = null;
  if (!candidates.length) candidatesReason = MORNING_BRIEFING_DATA_REASONS.RADAR_EMPTY;
  else if (candidatesAgeMs == null) candidatesReason = MORNING_BRIEFING_DATA_REASONS.RADAR_NO_TIMESTAMP;
  else if (candidatesAgeMs > maxAge) candidatesReason = MORNING_BRIEFING_DATA_REASONS.RADAR_STALE;

  // Both sources unusable on an axis → report the canonical (primary) reason.
  let marketAxis = { usable: !marketReason, observedAt: marketObservedAt, ageMs: marketAgeMs, reason: marketReason };
  let candidatesAxis = { usable: !candidatesReason, observedAt: candidatesObservedAt, ageMs: candidatesAgeMs, reason: candidatesReason };
  if (canonicalAxes) {
    if (marketReason && canonicalAxes.market.reason) marketAxis = { usable: false, ...canonicalAxes.market };
    if (candidatesReason && canonicalAxes.candidates.reason) candidatesAxis = { usable: false, ...canonicalAxes.candidates };
  }

  const anythingAtAll = markets.length > 0 || candidates.length > 0;
  return {
    source: anythingAtAll ? MORNING_BRIEFING_DATA_SOURCES.FLEET : MORNING_BRIEFING_DATA_SOURCES.NONE,
    sourceNotes: notes,
    maxAgeMs: maxAge,
    markets,
    candidates,
    entryReady: Array.isArray(radar.entryReady) ? radar.entryReady : [],
    regime: (radar.marketRegime && typeof radar.marketRegime === 'object') ? radar.marketRegime : {},
    universeDiagnostics: (radar.universeDiagnostics && typeof radar.universeDiagnostics === 'object') ? radar.universeDiagnostics : {},
    market: (anythingAtAll || marketReason) ? marketAxis : emptyAxis(MORNING_BRIEFING_DATA_REASONS.NO_DATA),
    candidatesFreshness: candidatesAxis,
  };
}

// ── data gathering (read-only over the resolved market context) ──────────────
export function gatherBriefingData(fleet = {}, env = process.env, context = null) {
  const ctx = (context && typeof context === 'object')
    ? context
    : buildMarketContext({ fleet, env });
  const lastRegime = (fleet && fleet.lastRegime && typeof fleet.lastRegime === 'object') ? fleet.lastRegime : null;
  const marketFresh = !!(ctx.market && ctx.market.usable);
  const candidatesFresh = !!(ctx.candidatesFreshness && ctx.candidatesFreshness.usable);
  const regime = (ctx.regime && typeof ctx.regime === 'object') ? ctx.regime : {};
  // A stale/absent axis contributes NOTHING. Withholding is the whole point: a
  // number the owner cannot date is worse than an explicit UNKNOWN.
  const markets = marketFresh ? (Array.isArray(ctx.markets) ? ctx.markets : []) : [];
  const candidates = candidatesFresh ? (Array.isArray(ctx.candidates) ? ctx.candidates : []) : [];
  const entryReady = candidatesFresh && Array.isArray(ctx.entryReady) ? ctx.entryReady : [];
  const diag = (ctx.universeDiagnostics && typeof ctx.universeDiagnostics === 'object') ? ctx.universeDiagnostics : {};

  // ── market pulse ──
  // BTC/ETH come from the freshest atom available: the market rows themselves,
  // falling back to the regime block only when the rows do not carry the pair.
  const findPair = (base) => markets.find((m) => new RegExp(`^${base}(USDC|USDT)$`).test(String(m.symbol || '').toUpperCase())) || null;
  const btcRow = marketFresh ? findPair('BTC') : null;
  const ethRow = marketFresh ? findPair('ETH') : null;
  const btcChange = btcRow ? rowChange(btcRow) : (marketFresh && regime.btc ? num(regime.btc.change24hPct) : null);
  const ethChange = ethRow ? rowChange(ethRow) : (marketFresh && regime.eth ? num(regime.eth.change24hPct) : null);
  const regimeStatus = marketFresh
    ? (regime.status || (lastRegime && lastRegime.regime) || 'UNKNOWN')
    : 'UNKNOWN';
  const changes = markets.map(rowChange).filter((v) => v != null);
  // Breadth is counted from the rows just read (same definition as
  // evaluateMarketRegime) so the pulse can never mix a fresh row count with a
  // breadth figure computed on another cycle. The regime block is the fallback.
  const breadthPct = changes.length
    ? Number(((changes.filter((v) => v > 0).length / changes.length) * 100).toFixed(1))
    : (marketFresh ? num(regime.breadthPct) : null);
  const medAbs = changes.length
    ? Number(changes.map((c) => Math.abs(c)).sort((a, b) => a - b)[Math.floor(changes.length / 2)].toFixed(1))
    : null;
  const totalVol = markets.reduce((acc, m) => acc + (num(m.quoteVolume) || 0), 0) || null;
  const marketPulse = {
    btcChange, ethChange, regimeStatus,
    regimeScore: marketFresh ? num(regime.score) : null,
    breadthPct,
    medianAbsMove: medAbs,
    totalQuoteVolume: totalVol,
    rowCount: markets.length,
    regimeReasons: marketFresh && Array.isArray(regime.reasons) ? regime.reasons.slice(0, 2) : [],
  };

  // ── sectors (best-effort) ──
  const sectorAgg = new Map();
  for (const m of markets) {
    const sec = SECTOR_MAP[baseOf(m.symbol)];
    const c = rowChange(m);
    if (!sec || c == null) continue;
    const e = sectorAgg.get(sec) || { sum: 0, n: 0 };
    e.sum += c; e.n += 1; sectorAgg.set(sec, e);
  }
  const sectors = Array.from(sectorAgg.entries())
    .map(([name, e]) => ({ name, avgChange: Number((e.sum / e.n).toFixed(1)), count: e.n }))
    .sort((a, b) => b.avgChange - a.avgChange)
    .slice(0, 5);

  // ── coins to watch (grouped, deduped, capped) ──
  const used = new Set();
  const take = (rows, max) => {
    const out = [];
    for (const r of rows) {
      if (out.length >= max) break;
      const key = String(r.symbol || '').toUpperCase();
      if (!key || used.has(key)) continue;
      used.add(key);
      out.push(r);
    }
    return out;
  };

  const candByDistance = candidates
    .slice()
    .sort((a, b) => (num(b.distanceToEntryReadyScore) || 0) - (num(a.distanceToEntryReadyScore) || 0));

  const momentum = take(
    markets
      .filter((m) => !STABLES.has(baseOf(m.symbol)) && (rowChange(m) || 0) >= 3)
      .sort((a, b) => (rowChange(b) || 0) - (rowChange(a) || 0))
      .map((m) => ({
        symbol: m.symbol, display: baseOf(m.symbol),
        reason: `${fmtPct(rowChange(m))} 24h`, stage: 'momentum',
        safety: 'market row (unverified)', risk: 'extended — chase risk',
      })),
    3,
  );

  const flush = take(
    candidates
      .filter((c) => FLUSH_STAGES.has(String(c.stage || '').toUpperCase()))
      .map((c) => candidateRow(c, 'flush/rebound')),
    3,
  );

  const radarWatch = take(
    candByDistance
      .filter((c) => String(c.actionability || '') !== ENTRY_READY_ACTIONABILITY && (num(c.distanceToEntryReadyScore) || 0) >= 40)
      .map((c) => candidateRow(c, 'RADAR watch')),
    3,
  );

  const highVolume = take(
    markets
      .filter((m) => !STABLES.has(baseOf(m.symbol)) && num(m.quoteVolume) != null)
      .sort((a, b) => (num(b.quoteVolume) || 0) - (num(a.quoteVolume) || 0))
      .map((m) => ({
        symbol: m.symbol, display: baseOf(m.symbol),
        reason: `${fmtUsd(m.quoteVolume)} vol · ${fmtPct(rowChange(m))} 24h`, stage: 'high volume',
        safety: 'market row (unverified)', risk: 'liquidity-driven move',
      })),
    2,
  );

  const safetyApproved = take(
    candidates
      .filter((c) => String(c.safetyStatus || '').toUpperCase() === 'SAFE')
      .map((c) => candidateRow(c, 'safety-approved')),
    2,
  );

  const coinGroups = [
    { label: 'Strongest momentum', rows: momentum },
    { label: 'Flush / rebound setups', rows: flush },
    { label: 'RADAR near-entry / watchlist', rows: radarWatch },
    { label: 'High volume / unusual move', rows: highVolume },
    { label: 'Safety-approved / curated', rows: safetyApproved },
  ].filter((g) => g.rows.length);
  const coinCount = coinGroups.reduce((acc, g) => acc + g.rows.length, 0);

  // ── RADAR opportunities ──
  const realEntryReady = candidates.filter((c) => String(c.actionability || '') === ENTRY_READY_ACTIONABILITY);
  const entryReadyCount = realEntryReady.length || entryReady.length;
  const topClosest = candByDistance.slice(0, 3).map((c) => ({
    symbol: c.symbol, display: baseOf(c.symbol),
    distance: num(c.distanceToEntryReadyScore),
    stage: c.stage || c.STATUS || 'NO_SETUP',
    isEntryReady: String(c.actionability || '') === ENTRY_READY_ACTIONABILITY,
    blockedBy: c.blockedBy || null,
  }));

  // ── risks / blockers ──
  const missingMicro = candidates
    .filter((c) => Array.isArray(c.executionDataMissing) && c.executionDataMissing.length)
    .map((c) => baseOf(c.symbol));
  const unknownSafetyCandidates = candidates.filter((c) => String(c.safetyStatus || '').toUpperCase() === 'UNKNOWN');
  const unknownSafety = unknownSafetyCandidates.length;
  const regimeVeto = marketFresh
    && (['CRASH', 'RISK_OFF'].includes(String(regimeStatus).toUpperCase()) || regime.blocksMeanReversion === true);
  // Surface the listing basis from an UNKNOWN-safety candidate (that's the one
  // the note is about), not just any candidate that happens to carry a basis.
  const safetyBasisNote = unknownSafetyCandidates.find((c) => c.safetyBasis)?.safetyBasis || null;

  const radarSummary = {
    candidateCount: candidates.length,
    entryReadyCount,
    topClosest,
    anyBlocked: missingMicro.length > 0 || unknownSafety > 0 || regimeVeto,
  };

  const risks = {
    missingMicrostructure: Array.from(new Set(missingMicro)).slice(0, 6),
    unknownSafetyCount: unknownSafety,
    safetyBasisNote,
    regimeVeto,
    regimeStatus,
    safetyDiagnostics: {
      unknown: num(diag.safetyUnknown),
      danger: num(diag.safetyDanger),
    },
  };

  // Freshness travels WITH the data, so every renderer (message, AI context,
  // diagnostics) states the same age from the same source of truth.
  const freshness = {
    source: ctx.source || MORNING_BRIEFING_DATA_SOURCES.NONE,
    sourceNotes: Array.isArray(ctx.sourceNotes) ? ctx.sourceNotes.slice(0, 4) : [],
    maxAgeMs: num(ctx.maxAgeMs),
    marketUsable: marketFresh,
    marketObservedAt: (ctx.market && ctx.market.observedAt) || null,
    marketAgeMs: num(ctx.market && ctx.market.ageMs),
    marketReason: (ctx.market && ctx.market.reason) || null,
    candidatesUsable: candidatesFresh,
    candidatesObservedAt: (ctx.candidatesFreshness && ctx.candidatesFreshness.observedAt) || null,
    candidatesAgeMs: num(ctx.candidatesFreshness && ctx.candidatesFreshness.ageMs),
    candidatesReason: (ctx.candidatesFreshness && ctx.candidatesFreshness.reason) || null,
    marketRowsAvailable: Array.isArray(ctx.markets) ? ctx.markets.length : 0,
    candidatesAvailable: Array.isArray(ctx.candidates) ? ctx.candidates.length : 0,
  };

  return {
    marketPulse,
    sectors,
    coinGroups,
    coinCount,
    radarSummary,
    risks,
    freshness,
    snapshotAgeIso: freshness.marketObservedAt,
    marketRowsUsed: markets.length,
    radarCandidatesUsed: candidates.length,
    topSymbols: coinGroups.flatMap((g) => g.rows.map((r) => r.display)).slice(0, 12),
  };
}

function candidateRow(c, category) {
  const reasons = Array.isArray(c.reasons) ? c.reasons : (Array.isArray(c.REASON) ? c.REASON : []);
  const riskFlags = Array.isArray(c.riskFlags) ? c.riskFlags : [];
  const change = c.diagnostics ? num(c.diagnostics.change24hPct) : null;
  const reasonParts = [];
  if (reasons.length) reasonParts.push(String(reasons[0]));
  else if (change != null) reasonParts.push(`${fmtPct(change)} 24h`);
  else reasonParts.push(category);
  return {
    symbol: c.symbol,
    display: baseOf(c.symbol),
    reason: reasonParts.join(''),
    stage: c.stage || c.STATUS || 'NO_SETUP',
    safety: c.safetyStatus || 'UNKNOWN',
    risk: riskFlags[0] || c.blockedBy || (c.safetyStatus && c.safetyStatus !== 'SAFE' ? `safety ${c.safetyStatus}` : null),
    category,
  };
}

// ── AI block parsing (degrade-safe) ─────────────────────────────────────────
// The summarizer is asked to return MACRO:/BUSINESS:/TONE: blocks. Parse them
// tolerantly; anything missing falls back to the degraded defaults.
export function parseAiBlocks(text) {
  const out = { macro: null, business: null, tone: null };
  if (!text || typeof text !== 'string') return out;
  const grab = (label) => {
    const re = new RegExp(`${label}\\s*:?\\s*([\\s\\S]*?)(?=\\n\\s*(?:MACRO|BUSINESS|TONE)\\b|$)`, 'i');
    const m = re.exec(text);
    return m && m[1] ? m[1].trim().replace(/\s+/g, ' ').slice(0, 600) : null;
  };
  out.macro = grab('MACRO');
  out.business = grab('BUSINESS');
  out.tone = grab('TONE');
  // If the model ignored the labels entirely, treat the whole thing as macro.
  if (!out.macro && !out.business && !out.tone) {
    out.macro = text.trim().replace(/\s+/g, ' ').slice(0, 600);
  }
  return out;
}

// ── message builder ─────────────────────────────────────────────────────────
const TG_MAX = 4096;

const SOURCE_LABELS = Object.freeze({
  [MORNING_BRIEFING_DATA_SOURCES.CANONICAL]: 'canonical context store (server-side collector)',
  [MORNING_BRIEFING_DATA_SOURCES.FLEET]: 'legacy fleet snapshot (local worker / browser)',
  [MORNING_BRIEFING_DATA_SOURCES.NONE]: 'none',
});

// Turns a reason code into a sentence that names the broken stage. "Empty because
// X is not running" must never read the same as "empty because the market is quiet".
export function describeDataReason(reason, ageMs = null, maxAgeMs = null) {
  const age = ageMs != null ? fmtAge(ageMs) : 'unknown age';
  const limit = maxAgeMs != null ? fmtAge(maxAgeMs) : null;
  switch (reason) {
    case MORNING_BRIEFING_DATA_REASONS.NO_MARKET_SNAPSHOT:
      return 'no market snapshot available (collector/worker has posted nothing)';
    case MORNING_BRIEFING_DATA_REASONS.MARKET_STALE:
      return `market data is ${age} old${limit ? ` (limit ${limit})` : ''}`;
    case MORNING_BRIEFING_DATA_REASONS.MARKET_NO_TIMESTAMP:
      return 'market data carries no observation timestamp — cannot be dated';
    case MORNING_BRIEFING_DATA_REASONS.RADAR_PENDING:
      return 'RADAR has not scored the latest run yet';
    case MORNING_BRIEFING_DATA_REASONS.RADAR_EMPTY:
      return 'RADAR returned no candidates';
    case MORNING_BRIEFING_DATA_REASONS.RADAR_STALE:
      return `RADAR context is ${age} old${limit ? ` (limit ${limit})` : ''}`;
    case MORNING_BRIEFING_DATA_REASONS.RADAR_NO_TIMESTAMP:
      return 'RADAR context carries no timestamp — cannot be dated';
    case MORNING_BRIEFING_DATA_REASONS.NO_DATA:
      return 'no market data from any source';
    default:
      return reason ? `unavailable (${String(reason)})` : 'unavailable';
  }
}

// Data provenance block. Printed on EVERY briefing, fresh or not: the owner must
// be able to read the age of what he is looking at without asking.
function pushDataProvenance(L, f) {
  const label = SOURCE_LABELS[f.source] || String(f.source || 'unknown');
  L.push(`<b>0. Data provenance</b>`);
  L.push(`Source: ${escapeHtml(label)}`);
  if (f.marketUsable) {
    L.push(`Market data: ${escapeHtml(fmtAge(f.marketAgeMs))} old · observed ${escapeHtml(f.marketObservedAt)}`);
  } else {
    L.push(`⚠ Market data WITHHELD — ${escapeHtml(describeDataReason(f.marketReason, f.marketAgeMs, f.maxAgeMs))}${f.marketObservedAt ? ` · last observed ${escapeHtml(f.marketObservedAt)}` : ''}`);
  }
  if (f.candidatesUsable) {
    L.push(`RADAR context: ${escapeHtml(fmtAge(f.candidatesAgeMs))} old · ${escapeHtml(f.candidatesAvailable)} candidates`);
  } else {
    L.push(`⚠ RADAR watchlist WITHHELD — ${escapeHtml(describeDataReason(f.candidatesReason, f.candidatesAgeMs, f.maxAgeMs))}${f.candidatesObservedAt ? ` · last computed ${escapeHtml(f.candidatesObservedAt)}` : ''}`);
  }
  L.push('');
}

export function buildBriefingMessage({ data, dateStr, ai = null, aiUsed = false }) {
  const blocks = ai ? parseAiBlocks(ai.text) : { macro: null, business: null, tone: null };
  const L = []; // lines
  const p = data.marketPulse;
  const f = data.freshness || { source: MORNING_BRIEFING_DATA_SOURCES.NONE, marketUsable: false, candidatesUsable: false };

  L.push(`🌅 <b>Terminal-X Morning Market Briefing — ${escapeHtml(dateStr)}</b>`);
  if (!f.marketUsable || !f.candidatesUsable) {
    L.push('⚠ <b>PARTIAL BRIEFING — some sections withheld because the data is not current (see 0).</b>');
  }
  L.push('');

  pushDataProvenance(L, f);

  // 1. Market pulse
  L.push('<b>1. Market pulse</b>');
  if (!f.marketUsable) {
    // Never print a cached number here. This is the exact line that reported
    // BTC +0.6% off a two-day-old snapshot while BTC was -1.8% on the day.
    L.push('BTC UNKNOWN · ETH UNKNOWN (24h) — no current market observation');
    L.push('Regime: <b>UNKNOWN</b> (not computable without current market data)');
    L.push(`Reason: ${escapeHtml(describeDataReason(f.marketReason, f.marketAgeMs, f.maxAgeMs))}`);
  } else {
    L.push(`BTC ${escapeHtml(fmtPct(p.btcChange))} · ETH ${escapeHtml(fmtPct(p.ethChange))} (24h)`);
    L.push(`Regime: <b>${escapeHtml(p.regimeStatus)}</b>${p.regimeScore != null ? ` (score ${escapeHtml(p.regimeScore)})` : ''}`);
    const toneBits = [];
    if (p.breadthPct != null) toneBits.push(`breadth ${escapeHtml(p.breadthPct)}% green`);
    if (p.medianAbsMove != null) toneBits.push(`median move ±${escapeHtml(p.medianAbsMove)}%`);
    if (p.totalQuoteVolume != null) toneBits.push(`vol ${escapeHtml(fmtUsd(p.totalQuoteVolume))}`);
    if (toneBits.length) L.push(`Volatility/volume: ${toneBits.join(' · ')}`);
    if (p.rowCount) L.push(`Universe: ${escapeHtml(p.rowCount)} pairs · as of ${escapeHtml(f.marketObservedAt)} (${escapeHtml(fmtAge(f.marketAgeMs))} old)`);
    if (p.regimeReasons.length) L.push(`Note: ${escapeHtml(p.regimeReasons.join('; '))}`);
  }
  L.push('');

  // 2. Macro / world
  L.push('<b>2. Macro / world</b>');
  L.push(escapeHtml(blocks.macro || MACRO_UNAVAILABLE));
  L.push('');

  // 3. Business / market-moving
  L.push('<b>3. Business / market-moving</b>');
  L.push(escapeHtml(blocks.business || (aiUsed ? 'N/A' : 'AI summary unavailable')));
  L.push('');

  // 4. Crypto sectors
  L.push('<b>4. Crypto sectors</b>');
  if (data.sectors.length) {
    for (const s of data.sectors) {
      L.push(`• ${escapeHtml(s.name)}: ${escapeHtml(fmtPct(s.avgChange))} avg (${escapeHtml(s.count)} ${s.count === 1 ? 'coin' : 'coins'})`);
    }
  } else if (!f.marketUsable) {
    L.push(`Withheld — ${escapeHtml(describeDataReason(f.marketReason, f.marketAgeMs, f.maxAgeMs))}.`);
  } else {
    L.push('No sector mapped in the current market snapshot (data present, no sector match).');
  }
  L.push('');

  // 5. Coins to watch today
  L.push('<b>5. Coins to watch today</b>');
  if (data.coinGroups.length) {
    for (const g of data.coinGroups) {
      L.push(`<i>${escapeHtml(g.label)}</i>`);
      for (const r of g.rows) {
        const parts = [`stage ${escapeHtml(r.stage)}`, `safety ${escapeHtml(r.safety)}`];
        let line = `• <b>${escapeHtml(r.display)}</b> — ${escapeHtml(r.reason)} (${parts.join(', ')})`;
        if (r.risk) line += ` ⚠ ${escapeHtml(r.risk)}`;
        L.push(line);
      }
    }
  } else if (!f.candidatesUsable || !f.marketUsable) {
    // A watchlist is a list of setups to act on TODAY. An old one is not a
    // degraded version of that — it is a different, wrong answer.
    const bits = [];
    if (!f.candidatesUsable) bits.push(describeDataReason(f.candidatesReason, f.candidatesAgeMs, f.maxAgeMs));
    if (!f.marketUsable) bits.push(describeDataReason(f.marketReason, f.marketAgeMs, f.maxAgeMs));
    L.push(`Withheld — ${escapeHtml(bits.join('; '))}. No setups are being suggested today.`);
  } else {
    L.push('No standout coins in the current snapshot.');
  }
  L.push('');

  // 6. RADAR opportunities
  L.push('<b>6. RADAR opportunities</b>');
  const rs = data.radarSummary;
  if (!f.candidatesUsable) {
    L.push(`Candidates tracked: UNKNOWN · ENTRY_READY: UNKNOWN — ${escapeHtml(describeDataReason(f.candidatesReason, f.candidatesAgeMs, f.maxAgeMs))}.`);
    L.push('Treat this as NO RADAR read today, not as an all-clear.');
  } else {
    L.push(`Candidates tracked: ${escapeHtml(rs.candidateCount)} · ENTRY_READY: ${escapeHtml(rs.entryReadyCount)} · computed ${escapeHtml(fmtAge(f.candidatesAgeMs))} ago`);
    if (rs.topClosest.length) {
      L.push('Closest to entry:');
      for (const t of rs.topClosest) {
        const label = t.isEntryReady ? 'ENTRY_READY ✅' : `near (${t.distance != null ? escapeHtml(t.distance) + '%' : 'n/a'})`;
        L.push(`• <b>${escapeHtml(t.display)}</b> — ${label} · ${escapeHtml(t.stage)}`);
      }
    }
    if (rs.entryReadyCount === 0) {
      L.push('No confirmed ENTRY_READY today — all candidates are watchlist only.');
      if (rs.anyBlocked) L.push('Blocked by missing microstructure / safety / regime (see risks below).');
    }
  }
  L.push('');

  // 7. Risks / blockers
  L.push('<b>7. Risks / blockers</b>');
  const r = data.risks;
  let anyRisk = false;
  // Data breakage is the first-class risk: it is the one that makes every other
  // line in this message unreliable, so it is listed before market risks.
  if (!f.marketUsable) {
    L.push(`• DATA: market pulse withheld — ${escapeHtml(describeDataReason(f.marketReason, f.marketAgeMs, f.maxAgeMs))}`);
    anyRisk = true;
  }
  if (!f.candidatesUsable) {
    L.push(`• DATA: RADAR watchlist withheld — ${escapeHtml(describeDataReason(f.candidatesReason, f.candidatesAgeMs, f.maxAgeMs))}`);
    anyRisk = true;
  }
  for (const note of (f.sourceNotes || [])) { L.push(`• DATA: ${escapeHtml(note)}`); anyRisk = true; }
  if (r.missingMicrostructure.length) { L.push(`• Missing microstructure: ${escapeHtml(r.missingMicrostructure.join(', '))}`); anyRisk = true; }
  if (r.unknownSafetyCount > 0) { L.push(`• ${escapeHtml(r.unknownSafetyCount)} candidate(s) with UNKNOWN safety${r.safetyBasisNote ? ` (basis: ${escapeHtml(r.safetyBasisNote)})` : ''}`); anyRisk = true; }
  if (r.regimeVeto) { L.push(`• Macro/regime veto: ${escapeHtml(r.regimeStatus)} — mean-reversion entries discouraged`); anyRisk = true; }
  if (ai && ai.meta && ai.meta.fallbackUsed) { L.push('• AI provider degraded — fallback model used'); anyRisk = true; }
  if (!aiUsed) { L.push('• AI summary unavailable — market-only briefing'); anyRisk = true; }
  if (!anyRisk) L.push('No major blockers flagged.');
  L.push('');

  // 8. Disclaimer
  L.push(`<i>${escapeHtml(DISCLAIMER)}</i>`);

  let msg = L.join('\n');
  if (msg.length > TG_MAX) {
    msg = msg.slice(0, TG_MAX - 40).replace(/\n[^\n]*$/, '') + `\n…(truncated)\n<i>${escapeHtml(DISCLAIMER)}</i>`;
  }
  return msg;
}

// ── orchestrator ─────────────────────────────────────────────────────────--
// Pure-ish: all I/O injected. Returns a diagnostics object. Never throws.
export async function runMorningBriefing(opts = {}) {
  const {
    env = process.env,
    now = new Date(),
    dryRun = false,
    force = false,
    loadFleet,
    mutateFleet,
    sendMessage,        // async (token, chatId, text) => { ok, error? }
    summarize = null,   // async (context) => { ok, text?, meta, providerErrors }
    loadMarketContext = null, // async () => { ok, market:{observedAt,tickers}, radar } — canonical read
  } = opts;

  const timezone = env.MORNING_BRIEFING_TIMEZONE || 'Europe/Prague';
  const targetHour = Number.isFinite(Number(env.MORNING_BRIEFING_HOUR_LOCAL)) ? Number(env.MORNING_BRIEFING_HOUR_LOCAL) : 8;
  const today = localDayString(now, timezone);
  const token = env.TG_BOT_TOKEN ? String(env.TG_BOT_TOKEN).trim() : '';
  const chatId = env.TG_CHAT_ID ? String(env.TG_CHAT_ID).trim() : '';
  const hasCredentials = !!(token && chatId);

  const briefingEnabled = !isMorningBriefingHardDisabled(env);
  const forced = force || env.MORNING_BRIEFING_FORCE_SEND === 'true';

  const diag = {
    briefingEnabled,
    telegramEnabled: briefingEnabled && hasCredentials,
    sent: 0,
    skippedReason: null,
    code: null,
    aiUsed: false,
    aiFallbackUsed: false,
    marketRowsUsed: 0,
    radarCandidatesUsed: 0,
    dataSource: null,
    marketDataUsable: false,
    marketDataAgeMs: null,
    marketDataReason: null,
    radarDataUsable: false,
    radarDataAgeMs: null,
    radarDataReason: null,
    topSymbols: [],
    lastSentDate: null,
    providerErrors: [],
    messageLength: 0,
    dryRun: !!dryRun,
    timezone,
    targetHour,
    localDay: today,
  };

  // ── hard env gate (a real send is never attempted while disabled) ──
  if (!dryRun && !briefingEnabled) {
    diag.code = MORNING_BRIEFING_CODES.DISABLED_BY_ENV;
    diag.skippedReason = 'morning_briefing_disabled_by_env';
    return diag;
  }

  // Load existing dedup state (best-effort; failure shouldn't crash).
  let fleet = {};
  try {
    fleet = typeof loadFleet === 'function' ? (await loadFleet()) || {} : {};
  } catch (err) {
    diag.providerErrors.push(`fleet load failed: ${String(err && err.message || err).slice(0, 120)}`);
  }
  const prevState = (fleet && fleet.morningBriefing && typeof fleet.morningBriefing === 'object') ? fleet.morningBriefing : {};
  diag.lastSentDate = prevState.lastSentDate || null;

  // ── credentials gate (skip for dryRun preview) ──
  if (!dryRun && !hasCredentials) {
    diag.code = MORNING_BRIEFING_CODES.MISSING_CREDENTIALS;
    diag.skippedReason = 'missing_telegram_credentials';
    return diag;
  }

  // ── morning window gate (cron runs hourly; fire only at target local hour) ──
  if (!dryRun && !forced) {
    const hour = localHour(now, timezone);
    if (hour !== targetHour) {
      diag.code = MORNING_BRIEFING_CODES.OUTSIDE_WINDOW;
      diag.skippedReason = `outside_window_local_hour_${hour}_target_${targetHour}`;
      return diag;
    }
  }

  // ── once-per-day dedup ──
  if (!dryRun && !forced && prevState.lastSentDate === today) {
    diag.code = MORNING_BRIEFING_CODES.ALREADY_SENT;
    diag.skippedReason = 'already_sent_today';
    return diag;
  }

  // ── canonical market context (server-side collector) ──
  // Read first, Fleet second. A read failure is recorded and labelled, never
  // silently replaced by cached fleet numbers.
  let canonical = null;
  if (typeof loadMarketContext === 'function') {
    try {
      canonical = (await loadMarketContext()) || { ok: false, reason: 'EMPTY_READ' };
    } catch (err) {
      canonical = { ok: false, reason: 'READ_THREW' };
      diag.providerErrors.push(`market context read failed: ${String(err && err.message || err).slice(0, 120)}`);
    }
  }

  // ── build the briefing ──
  const context = buildMarketContext({ canonical, fleet, env, nowMs: now.getTime() });
  const data = gatherBriefingData(fleet, env, context);
  diag.marketRowsUsed = data.marketRowsUsed;
  diag.radarCandidatesUsed = data.radarCandidatesUsed;
  diag.topSymbols = data.topSymbols;
  diag.dataSource = data.freshness.source;
  diag.marketDataUsable = data.freshness.marketUsable;
  diag.marketDataAgeMs = data.freshness.marketAgeMs;
  diag.marketDataReason = data.freshness.marketReason;
  diag.radarDataUsable = data.freshness.candidatesUsable;
  diag.radarDataAgeMs = data.freshness.candidatesAgeMs;
  diag.radarDataReason = data.freshness.candidatesReason;
  for (const note of data.freshness.sourceNotes) diag.providerErrors.push(String(note).slice(0, 160));

  // ── AI summary (degrade-safe) ──
  let ai = null;
  if (typeof summarize === 'function') {
    try {
      const context = buildAiContext(data);
      const res = await summarize(context);
      if (res && res.ok && res.text) {
        ai = res;
        diag.aiUsed = true;
        diag.aiFallbackUsed = !!(res.meta && res.meta.fallbackUsed);
      }
      if (res && Array.isArray(res.providerErrors)) diag.providerErrors.push(...res.providerErrors.map((e) => String(e).slice(0, 200)));
    } catch (err) {
      diag.providerErrors.push(`ai error: ${String(err && err.message || err).slice(0, 160)}`);
    }
  }

  const message = buildBriefingMessage({ data, dateStr: today, ai, aiUsed: diag.aiUsed });
  diag.messageLength = message.length;
  diag.preview = message;

  // ── dry run: never send, never persist ──
  if (dryRun) {
    diag.code = MORNING_BRIEFING_CODES.DRY_RUN;
    diag.skippedReason = 'dry_run';
    return diag;
  }

  // ── send ──
  if (typeof sendMessage !== 'function') {
    diag.code = MORNING_BRIEFING_CODES.SEND_FAILED;
    diag.skippedReason = 'no_send_transport';
    return diag;
  }
  let sendResult;
  try {
    sendResult = await sendMessage(token, chatId, message);
  } catch (err) {
    sendResult = { ok: false, error: String(err && err.message || err).slice(0, 200) };
  }

  if (!sendResult || !sendResult.ok) {
    diag.code = MORNING_BRIEFING_CODES.SEND_FAILED;
    diag.skippedReason = sendResult && sendResult.error ? String(sendResult.error).slice(0, 200) : 'telegram_send_failed';
    return diag;
  }

  diag.sent = 1;
  diag.code = MORNING_BRIEFING_CODES.SENT;
  diag.lastSentDate = today;

  // ── persist dedup state (best-effort) ──
  if (typeof mutateFleet === 'function') {
    try {
      await mutateFleet((f) => {
        f.morningBriefing = {
          lastSentDate: today,
          lastSentAt: now.toISOString(),
          aiUsed: diag.aiUsed,
          aiFallbackUsed: diag.aiFallbackUsed,
          messageLength: diag.messageLength,
          topSymbols: diag.topSymbols,
          lastError: null,
        };
        return null;
      });
    } catch (err) {
      diag.providerErrors.push(`state persist failed: ${String(err && err.message || err).slice(0, 120)}`);
    }
  }

  return diag;
}

// Compact, AI-safe context (no internal identifiers, no raw fleet dump).
export function buildAiContext(data) {
  const f = data.freshness || { marketUsable: false, candidatesUsable: false };
  // The summarizer is told the provenance too. Handing it withheld numbers with
  // no age would let the narration reintroduce exactly the stale figures the
  // message layer just refused to print.
  return {
    data_freshness: {
      source: f.source || 'unavailable',
      market_data_usable: !!f.marketUsable,
      market_data_age_minutes: f.marketAgeMs == null ? null : Math.round(f.marketAgeMs / 60000),
      market_data_withheld_reason: f.marketUsable ? null : (f.marketReason || 'UNKNOWN'),
      radar_data_usable: !!f.candidatesUsable,
      radar_data_age_minutes: f.candidatesAgeMs == null ? null : Math.round(f.candidatesAgeMs / 60000),
      radar_data_withheld_reason: f.candidatesUsable ? null : (f.candidatesReason || 'UNKNOWN'),
    },
    market_pulse: f.marketUsable ? {
      btc_change_24h: data.marketPulse.btcChange,
      eth_change_24h: data.marketPulse.ethChange,
      regime: data.marketPulse.regimeStatus,
      regime_score: data.marketPulse.regimeScore,
      breadth_pct_green: data.marketPulse.breadthPct,
      median_abs_move_pct: data.marketPulse.medianAbsMove,
    } : null,
    sectors: f.marketUsable ? data.sectors : [],
    top_symbols: f.candidatesUsable ? data.topSymbols : [],
    radar: f.candidatesUsable ? {
      candidate_count: data.radarSummary.candidateCount,
      entry_ready_count: data.radarSummary.entryReadyCount,
      closest: data.radarSummary.topClosest.map((t) => ({ symbol: t.display, distance: t.distance, stage: t.stage, entry_ready: t.isEntryReady })),
    } : null,
    regime_veto: f.marketUsable ? data.risks.regimeVeto : null,
  };
}
