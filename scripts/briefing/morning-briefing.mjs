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
function num(v) {
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

// ── data gathering (read-only over fleet state) ─────────────────────────────
export function gatherBriefingData(fleet = {}, env = process.env) {
  const radar = (fleet && fleet.tradingRadar && typeof fleet.tradingRadar === 'object') ? fleet.tradingRadar : {};
  const regime = (radar.marketRegime && typeof radar.marketRegime === 'object') ? radar.marketRegime : {};
  const lastRegime = (fleet && fleet.lastRegime && typeof fleet.lastRegime === 'object') ? fleet.lastRegime : null;
  const snapshot = (fleet && fleet.autoMarketSnapshot && typeof fleet.autoMarketSnapshot === 'object') ? fleet.autoMarketSnapshot : {};
  const markets = Array.isArray(snapshot.markets) ? snapshot.markets : [];
  const candidates = Array.isArray(radar.candidates) ? radar.candidates : [];
  const entryReady = Array.isArray(radar.entryReady) ? radar.entryReady : [];
  const diag = (radar.universeDiagnostics && typeof radar.universeDiagnostics === 'object') ? radar.universeDiagnostics : {};

  // ── market pulse ──
  const btcChange = regime.btc ? num(regime.btc.change24hPct) : null;
  const ethChange = regime.eth ? num(regime.eth.change24hPct) : null;
  const regimeStatus = regime.status || (lastRegime && lastRegime.regime) || 'UNKNOWN';
  const breadthPct = num(regime.breadthPct);
  const changes = markets.map(rowChange).filter((v) => v != null);
  const medAbs = changes.length
    ? Number(changes.map((c) => Math.abs(c)).sort((a, b) => a - b)[Math.floor(changes.length / 2)].toFixed(1))
    : null;
  const totalVol = markets.reduce((acc, m) => acc + (num(m.quoteVolume) || 0), 0) || null;
  const marketPulse = {
    btcChange, ethChange, regimeStatus,
    regimeScore: num(regime.score),
    breadthPct,
    medianAbsMove: medAbs,
    totalQuoteVolume: totalVol,
    rowCount: markets.length,
    regimeReasons: Array.isArray(regime.reasons) ? regime.reasons.slice(0, 2) : [],
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
  const regimeVeto = ['CRASH', 'RISK_OFF'].includes(String(regimeStatus).toUpperCase()) || regime.blocksMeanReversion === true;
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

  return {
    marketPulse,
    sectors,
    coinGroups,
    coinCount,
    radarSummary,
    risks,
    snapshotAgeIso: snapshot.fetchedAt || snapshot.receivedAt || null,
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

export function buildBriefingMessage({ data, dateStr, ai = null, aiUsed = false }) {
  const blocks = ai ? parseAiBlocks(ai.text) : { macro: null, business: null, tone: null };
  const L = []; // lines
  const p = data.marketPulse;

  L.push(`🌅 <b>Terminal-X Morning Market Briefing — ${escapeHtml(dateStr)}</b>`);
  L.push('');

  // 1. Market pulse
  L.push('<b>1. Market pulse</b>');
  L.push(`BTC ${escapeHtml(fmtPct(p.btcChange))} · ETH ${escapeHtml(fmtPct(p.ethChange))} (24h)`);
  L.push(`Regime: <b>${escapeHtml(p.regimeStatus)}</b>${p.regimeScore != null ? ` (score ${escapeHtml(p.regimeScore)})` : ''}`);
  const toneBits = [];
  if (p.breadthPct != null) toneBits.push(`breadth ${escapeHtml(p.breadthPct)}% green`);
  if (p.medianAbsMove != null) toneBits.push(`median move ±${escapeHtml(p.medianAbsMove)}%`);
  if (p.totalQuoteVolume != null) toneBits.push(`vol ${escapeHtml(fmtUsd(p.totalQuoteVolume))}`);
  if (toneBits.length) L.push(`Volatility/volume: ${toneBits.join(' · ')}`);
  if (p.regimeReasons.length) L.push(`Note: ${escapeHtml(p.regimeReasons.join('; '))}`);
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
  } else {
    L.push('Sector data unavailable from current snapshot.');
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
  } else {
    L.push('No standout coins in the current snapshot.');
  }
  L.push('');

  // 6. RADAR opportunities
  L.push('<b>6. RADAR opportunities</b>');
  const rs = data.radarSummary;
  L.push(`Candidates tracked: ${escapeHtml(rs.candidateCount)} · ENTRY_READY: ${escapeHtml(rs.entryReadyCount)}`);
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
  L.push('');

  // 7. Risks / blockers
  L.push('<b>7. Risks / blockers</b>');
  const r = data.risks;
  let anyRisk = false;
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

  // ── build the briefing ──
  const data = gatherBriefingData(fleet, env);
  diag.marketRowsUsed = data.marketRowsUsed;
  diag.radarCandidatesUsed = data.radarCandidatesUsed;
  diag.topSymbols = data.topSymbols;

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
function buildAiContext(data) {
  return {
    market_pulse: {
      btc_change_24h: data.marketPulse.btcChange,
      eth_change_24h: data.marketPulse.ethChange,
      regime: data.marketPulse.regimeStatus,
      regime_score: data.marketPulse.regimeScore,
      breadth_pct_green: data.marketPulse.breadthPct,
      median_abs_move_pct: data.marketPulse.medianAbsMove,
    },
    sectors: data.sectors,
    top_symbols: data.topSymbols,
    radar: {
      candidate_count: data.radarSummary.candidateCount,
      entry_ready_count: data.radarSummary.entryReadyCount,
      closest: data.radarSummary.topClosest.map((t) => ({ symbol: t.display, distance: t.distance, stage: t.stage, entry_ready: t.isEntryReady })),
    },
    regime_veto: data.risks.regimeVeto,
  };
}
