// Scheduled Telegram alerts for Trading RADAR only.
//
// Safety contract:
//   - no scanner/live-feed/generic flush alerts
//   - no WATCH/STABILIZING/SQUEEZE_CONFIRMED/DISLOCATION/NEAR_ENTRY alerts
//   - no Cockpit / Bot Feed / Live Feed alerts
//   - only a fully confirmed RADAR ENTRY_READY success (see
//     isConfirmedRadarEntryReady) may ever fire a Telegram message
//   - fail-closed by default: Telegram only runs when RADAR_TELEGRAM_ENABLED === 'true'
//   - this file is the ONLY place allowed to call the Telegram HTTP API

import { loadFleet, mutateFleet } from './_fleet-store.mjs';

// Read the RADAR result the publisher computed from the canonical database,
// instead of whatever a browser session last wrote into the Fleet. Flag-gated and
// OFF by default: this decides what may reach Telegram.
export const RADAR_ALERTS_CANONICAL_ENV_FLAG = 'RADAR_ALERTS_CANONICAL_SOURCE';

// The canonical RADAR is republished once per collector cycle (3 minutes), so the
// 120s threshold above — written for the browser-driven feed — would mark it stale
// at the exact moment it is freshly correct. Two cycles is the honest bound:
// newer means at least one cycle landed, older means collection actually stopped.
export const CANONICAL_RADAR_STALE_MS = 6 * 60 * 1000;

async function loadContextStore() { return await import('./_market-context-store.mjs'); }
async function loadDatabase() { return (await import('./_db.mjs')).getDb().pool; }

// Shapes the stored canonical RADAR into what selectRadarEntryAlerts consumes.
// Every gate downstream is unchanged; only the SOURCE of the candidates moves.
export function shapeCanonicalRadarForAlerts(radar, nowMs = Date.now()) {
  const rows = Array.isArray(radar?.candidates) ? radar.candidates : [];
  const candidates = rows.map((row) => {
    const payload = row && typeof row.payload === 'object' && row.payload !== null ? row.payload : {};
    return { ...payload, symbol: payload.symbol || row?.symbol, market: payload.market || row?.market };
  }).filter((c) => c.symbol);
  const computedAtMs = radar?.computedAt ? new Date(radar.computedAt).getTime() : NaN;
  const dataFreshnessMs = Number.isFinite(computedAtMs) ? Math.max(0, nowMs - computedAtMs) : Number.POSITIVE_INFINITY;
  return {
    status: String(radar?.status || 'PENDING').toUpperCase(),
    source: 'canonical_context',
    computedAt: radar?.computedAt || null,
    dataFreshnessMs,
    candidates,
    entryReady: candidates.filter((c) => ENTRY_READY_STATUSES.includes(String(c.STATUS || c.status || c.stage || ''))),
  };
}

export async function loadCanonicalRadarForAlerts(deps = {}) {
  let store; let database;
  try { store = deps.store || await loadContextStore(); database = deps.database || await loadDatabase(); }
  catch { return { ok: false, reason: 'DB_UNAVAILABLE' }; }
  const read = await store.getPublishedRadar(database);
  if (!read?.ok) return { ok: false, reason: read?.reason || 'DB_UNAVAILABLE' };
  const shaped = shapeCanonicalRadarForAlerts(read.radar, deps.nowMs || Date.now());
  if (shaped.status !== 'READY') return { ok: false, reason: `RADAR_${shaped.status}` };
  if (shaped.dataFreshnessMs > CANONICAL_RADAR_STALE_MS) return { ok: false, reason: 'RADAR_STALE' };
  return { ok: true, radar: shaped };
}

export const RADAR_TELEGRAM_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes, per-symbol

// Data is considered stale (and therefore non-alertable) once the underlying
// public snapshot is older than this. Mirrors the RADAR STALE threshold.
export const RADAR_STALE_MS = 120 * 1000;

// The only statuses that may EVER be alerted (V1/spec entry-ready set).
export const ENTRY_READY_STATUSES = Object.freeze([
  'EARLY_ENTRY_READY',
  'STANDARD_ENTRY_READY',
  'AGGRESSIVE_ENTRY_READY',
  'ENTRY_READY',
]);

// Explicitly forbidden stages - scanner/score/early-pipeline states. These can
// never be alerted and are logged as legacy-blocked if they ever reach here.
export const FORBIDDEN_STAGES = Object.freeze([
  'BUY', 'FLUSH+BUY', 'STRONG BUY', 'RECLAIM',
  'WATCH', 'NEAR_ENTRY',
  'DISLOCATION_CONFIRMED', 'LONG_FLUSH_CONFIRMED', 'STABILIZING', 'SQUEEZE_CONFIRMED',
]);

// Diagnostic / log codes (single source of truth).
export const TELEGRAM_CODES = Object.freeze({
  DISABLED_BY_ENV: 'TELEGRAM_DISABLED_BY_ENV',
  MISSING_CREDENTIALS: 'TELEGRAM_MISSING_CREDENTIALS',
  SKIPPED_NOT_ENTRY_READY: 'TELEGRAM_SKIPPED_NOT_ENTRY_READY',
  SKIPPED_SAFETY_NOT_SAFE: 'TELEGRAM_SKIPPED_SAFETY_NOT_SAFE',
  SKIPPED_MISSING_MICROSTRUCTURE: 'TELEGRAM_SKIPPED_MISSING_MICROSTRUCTURE',
  SKIPPED_COOLDOWN: 'TELEGRAM_SKIPPED_COOLDOWN',
  LEGACY_BLOCKED: 'TELEGRAM_LEGACY_BLOCKED',
  API_ERROR: 'TELEGRAM_API_ERROR',
  SENT: 'TELEGRAM_RADAR_SENT',
  OK: 'TELEGRAM_RADAR_OK',
});

export function isTelegramHardDisabled(env = process.env) {
  return env.TELEGRAM_ENABLED === 'false'
    || env.RADAR_TELEGRAM_ENABLED === 'false'
    || env.CRON_ALERTS_ENABLED === 'false'
    || env.RADAR_TELEGRAM_ENABLED !== 'true';
}

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function escHtml(v) {
  return String(v == null ? '--' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtZone(zone) {
  if (!zone || typeof zone !== 'object') return '--';
  const low = zone.low != null ? zone.low : '--';
  const high = zone.high != null ? zone.high : '--';
  return `${low} - ${high}`;
}

function tpLevels(candidate) {
  const tps = candidate.TAKE_PROFIT_LEVELS || candidate.takeProfitCheckpoints || [];
  if (!Array.isArray(tps)) return [null, null, null];
  return [0, 1, 2].map((i) => {
    const t = tps[i];
    if (t == null) return null;
    if (typeof t === 'object') return t.level != null ? t.level : (t.price != null ? t.price : null);
    return t;
  });
}

// Stable hash of a setup so the same unchanged ENTRY_READY is not re-sent.
export function setupHash(candidate = {}) {
  const symbol = String(candidate.symbol || '').toUpperCase();
  const status = String(candidate.STATUS || candidate.status || candidate.stage || '');
  const zone = candidate.entryZone && typeof candidate.entryZone === 'object'
    ? `${candidate.entryZone.low}-${candidate.entryZone.high}`
    : '';
  const inval = candidate.invalidationLevel != null ? candidate.invalidationLevel : candidate.suggestedStop;
  return `${symbol}|${status}|${zone}|${inval}`;
}

export function normalizeRadarTelegramAlertState(input = {}) {
  const state = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const sent = state.sent && typeof state.sent === 'object' && !Array.isArray(state.sent) ? state.sent : {};
  return {
    mode: 'ENTRY_READY_ONLY',
    // NOT `Number.isFinite(Number(state.cooldownMs))`: Number(null) and Number('') are
    // both 0, so an absent cooldown resolved to "no cooldown at all" and the
    // per-symbol anti-spam window silently disappeared. A missing or non-positive
    // value must fall back to the real window.
    cooldownMs: (() => {
      const raw = state.cooldownMs;
      if (raw === null || raw === undefined || raw === '') return RADAR_TELEGRAM_COOLDOWN_MS;
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 ? value : RADAR_TELEGRAM_COOLDOWN_MS;
    })(),
    sent,
    lastSentAt: state.lastSentAt || null,
    lastError: state.lastError || null,
    sentCount: Number.isFinite(Number(state.sentCount)) ? Number(state.sentCount) : 0,
    legacyBlockedCount: Number.isFinite(Number(state.legacyBlockedCount)) ? Number(state.legacyBlockedCount) : 0,
    lastLegacyBlockedAt: state.lastLegacyBlockedAt || null,
    lastRadarSentAt: state.lastRadarSentAt || null,
    lastRadarSkippedReason: state.lastRadarSkippedReason || null,
  };
}

// All radar V1 condition flags must be true (or absent => treated as not-false).
export function radarConditionsPassed(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  for (const key of ['allRadarConditionsPassed', 'allConditionsPassed', 'conditionsPassed']) {
    if (candidate[key] === false) return false;
  }
  if (Array.isArray(candidate.conditions)) {
    return candidate.conditions.every((condition) => {
      if (condition === true) return true;
      if (!condition || typeof condition !== 'object') return false;
      if ('passed' in condition) return condition.passed === true;
      if ('ok' in condition) return condition.ok === true;
      if ('status' in condition) return String(condition.status).toUpperCase() === 'PASSED';
      return false;
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// THE SINGLE SUCCESS GATE.
// Returns { ok, reason, code }. ok === true ONLY for a fully confirmed,
// non-stale, microstructure-backed, SAFE RADAR ENTRY_READY success.
// No threshold here may be lowered to "make Telegram fire".
// ---------------------------------------------------------------------------
export function evaluateConfirmedRadarEntryReady(candidate, opts = {}) {
  const C = TELEGRAM_CODES;
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, reason: 'invalid_candidate', code: C.SKIPPED_NOT_ENTRY_READY };
  }
  const status = String(candidate.STATUS || candidate.status || candidate.stage || '');

  if (FORBIDDEN_STAGES.includes(status)) {
    return { ok: false, reason: `legacy_blocked_${status}`, code: C.LEGACY_BLOCKED };
  }
  if (!ENTRY_READY_STATUSES.includes(status)) {
    return { ok: false, reason: 'stage_not_entry_ready', code: C.SKIPPED_NOT_ENTRY_READY };
  }
  if (String(candidate.actionability || '') !== 'ENTRY_READY') {
    return { ok: false, reason: 'actionability_not_entry_ready', code: C.SKIPPED_NOT_ENTRY_READY };
  }
  if (candidate.telegramEligible !== true) {
    return { ok: false, reason: 'not_telegram_eligible', code: C.SKIPPED_NOT_ENTRY_READY };
  }
  if (!radarConditionsPassed(candidate)) {
    return { ok: false, reason: 'radar_conditions_not_passed', code: C.SKIPPED_NOT_ENTRY_READY };
  }

  const safety = String(candidate.safetyStatus || 'UNKNOWN').toUpperCase();
  if (safety !== 'SAFE') {
    const reason = safety === 'DANGER' ? 'safety_danger'
      : safety === 'CAUTION' ? 'safety_caution'
      : 'safety_unknown';
    return { ok: false, reason, code: C.SKIPPED_SAFETY_NOT_SAFE };
  }

  const execMissing = Array.isArray(candidate.executionDataMissing) ? candidate.executionDataMissing : [];
  if (execMissing.length > 0) {
    return { ok: false, reason: `missing_microstructure:${execMissing.join('/')}`, code: C.SKIPPED_MISSING_MICROSTRUCTURE };
  }
  const exec = num(candidate.EXECUTION_SCORE);
  if (exec == null) {
    return { ok: false, reason: 'missing_execution_score', code: C.SKIPPED_MISSING_MICROSTRUCTURE };
  }
  if (exec < 65) {
    return { ok: false, reason: 'execution_below_65', code: C.SKIPPED_NOT_ENTRY_READY };
  }

  const setup = num(candidate.SETUP_SCORE);
  if (setup == null || setup < 65) {
    return { ok: false, reason: 'setup_below_65', code: C.SKIPPED_NOT_ENTRY_READY };
  }
  const rr = num(candidate.RISK_REWARD_SCORE);
  if (rr == null || rr < 55) {
    return { ok: false, reason: 'risk_reward_below_55', code: C.SKIPPED_NOT_ENTRY_READY };
  }
  const regime = num(candidate.MARKET_REGIME_SCORE);
  if (regime == null || regime < 50) {
    return { ok: false, reason: 'market_regime_below_50', code: C.SKIPPED_NOT_ENTRY_READY };
  }

  const conf = num(candidate.confidence != null ? candidate.confidence : candidate.FINAL_CONFIDENCE);
  if (conf == null || conf < 75) {
    return { ok: false, reason: 'confidence_below_75', code: C.SKIPPED_NOT_ENTRY_READY };
  }

  if (!candidate.entryZone || typeof candidate.entryZone !== 'object'
      || candidate.entryZone.low == null || candidate.entryZone.high == null) {
    return { ok: false, reason: 'missing_entry_zone', code: C.SKIPPED_NOT_ENTRY_READY };
  }
  if (candidate.invalidationLevel == null && candidate.suggestedStop == null) {
    return { ok: false, reason: 'missing_stop_invalidation', code: C.SKIPPED_NOT_ENTRY_READY };
  }
  const tps = candidate.TAKE_PROFIT_LEVELS || candidate.takeProfitCheckpoints;
  const tpOk = candidate.tpZonesExist === true || (Array.isArray(tps) && tps.length >= 3);
  if (!tpOk) {
    return { ok: false, reason: 'missing_tp_zones', code: C.SKIPPED_NOT_ENTRY_READY };
  }

  if (opts.stale === true || candidate.stale === true) {
    return { ok: false, reason: 'stale_candidate', code: C.SKIPPED_NOT_ENTRY_READY };
  }

  return { ok: true, reason: 'confirmed_entry_ready', code: C.OK };
}

export function isConfirmedRadarEntryReady(candidate, opts = {}) {
  return evaluateConfirmedRadarEntryReady(candidate, opts).ok === true;
}

// Back-compat alias used by older callers/tests. Delegates to the single gate.
export function isRadarTelegramQualifiedCandidate(candidate, opts = {}) {
  return isConfirmedRadarEntryReady(candidate, opts);
}

export function shouldSendRadarTelegramAlert(candidate, state = {}, nowMs = Date.now()) {
  const status = String((candidate && (candidate.STATUS || candidate.status || candidate.stage)) || '');
  if (!candidate || !ENTRY_READY_STATUSES.includes(status)) return false;
  const symbol = String(candidate.symbol || '').toUpperCase();
  if (!symbol) return false;
  const normalized = normalizeRadarTelegramAlertState(state);
  const rec = normalized.sent[symbol];
  const lastSentAt = rec && rec.lastSentAt ? new Date(rec.lastSentAt).getTime() : 0;
  if (Number.isFinite(lastSentAt) && lastSentAt > 0) {
    if (nowMs - lastSentAt < normalized.cooldownMs) return false; // within cooldown
    if (rec.hash && rec.hash === setupHash(candidate)) return false; // unchanged setup
  }
  return true;
}

// Staleness bound for the radar object at hand. The browser-driven Fleet feed is
// refreshed continuously, so 120s is the honest bound there. The canonical RADAR is
// republished once per 180s collector cycle, so 120s would mark it stale for most of
// every cycle — exactly when it is as fresh as it can ever be. loadCanonicalRadarForAlerts
// already used the two-cycle bound, but selectRadarEntryAlerts is called without opts
// and re-applied the 120s one, silently blocking every alert on a verdict 120-360s old.
export function radarStaleBoundMs(radar = {}) {
  return String(radar && radar.source) === 'canonical_context' ? CANONICAL_RADAR_STALE_MS : RADAR_STALE_MS;
}

export function selectRadarEntryAlerts(radar = {}, state = {}, nowMs = Date.now(), opts = {}) {
  const boundMs = Number.isFinite(Number(opts.staleMs)) && Number(opts.staleMs) > 0
    ? Number(opts.staleMs)
    : radarStaleBoundMs(radar);
  // Unknown freshness is STALE, not fresh. `dataFreshnessMs` is null exactly when the
  // radar has no dated market observation behind it (evaluateTradingRadar sets it from
  // fetchedAt/receivedAt, and the production Fleet blob carried null for days while a
  // frozen state kept reporting status WATCHING). Treating that as alertable is a
  // fail-OPEN on missing data, which this repo's alert logic must never do.
  // NOT `Number(radar.dataFreshnessMs)`: Number(null) is 0, which reads as "observed
  // this instant" — the absent value would have become the freshest possible one.
  const rawFreshness = radar.dataFreshnessMs;
  const freshnessMs = (rawFreshness === null || rawFreshness === undefined || rawFreshness === '')
    ? Number.NaN
    : Number(rawFreshness);
  const freshnessKnown = Number.isFinite(freshnessMs);
  const stale = opts.stale === true
    || radar.status === 'STALE'
    || !freshnessKnown
    || freshnessMs > boundMs;
  const candidates = (Array.isArray(radar.entryReady) && radar.entryReady.length > 0)
    ? radar.entryReady
    : (Array.isArray(radar.candidates) ? radar.candidates : []);
  return candidates
    .filter((c) => isConfirmedRadarEntryReady(c, { stale }) && shouldSendRadarTelegramAlert(c, state, nowMs))
    .slice(0, 5);
}

export function buildRadarTelegramMessage(candidate) {
  const reasons = Array.isArray(candidate.REASON) ? candidate.REASON
    : (Array.isArray(candidate.reasons) ? candidate.reasons : []);
  const [tp1, tp2, tp3] = tpLevels(candidate);
  const stop = candidate.suggestedStop != null ? candidate.suggestedStop : candidate.STOP_LOSS_LEVEL;
  const inval = candidate.invalidationLevel != null ? candidate.invalidationLevel : candidate.HARD_INVALIDATION;
  const action = candidate.ACTION || candidate.action || 'See RADAR for execution detail.';
  return [
    `[OK] RADAR ENTRY_READY - <b>${escHtml(candidate.symbol)}</b>`,
    `Source: Trading RADAR (confirmed setup)`,
    `Status: <b>${escHtml(candidate.STATUS || candidate.status || candidate.stage || '--')}</b>`,
    `Confidence: ${escHtml(candidate.confidence ?? candidate.FINAL_CONFIDENCE)}`,
    `Setup score: ${escHtml(candidate.SETUP_SCORE)} | Execution score: ${escHtml(candidate.EXECUTION_SCORE)}`,
    `Risk/Reward: ${escHtml(candidate.RISK_REWARD_SCORE)} | Market regime: ${escHtml(candidate.MARKET_REGIME_SCORE)}`,
    `Entry zone: ${escHtml(fmtZone(candidate.entryZone))}`,
    `Stop / invalidation: ${escHtml(stop)} / ${escHtml(inval)}`,
    `TP1 / TP2 / TP3: ${escHtml(tp1)} / ${escHtml(tp2)} / ${escHtml(tp3)}`,
    `Safety: ${escHtml(candidate.safetyStatus || 'UNKNOWN')}`,
    `Safety basis: ${escHtml(candidate.safetyBasis || '--')}`,
    `Reason: ${escHtml(reasons.slice(0, 3).join(' | ') || '--')}`,
    `Next action: ${escHtml(action)}`,
    `Time: ${escHtml(new Date().toISOString())}`,
    `Advisory only - no order executed.`,
  ].join('\n');
}

// PRIVATE: the only function permitted to hit the Telegram HTTP API.
async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, description: detail || `${res.status} ${res.statusText}`, error_code: res.status };
  }
  return res.json();
}

export async function sendRadarEntryReadyTelegram(candidate, state, token, chatId, opts = {}) {
  const ev = evaluateConfirmedRadarEntryReady(candidate, opts);
  if (!ev.ok) {
    return { ok: false, reason: ev.reason, code: ev.code };
  }
  if (!shouldSendRadarTelegramAlert(candidate, state, opts.now || Date.now())) {
    return { ok: false, reason: 'cooldown_active', code: TELEGRAM_CODES.SKIPPED_COOLDOWN };
  }
  const msg = buildRadarTelegramMessage(candidate);
  const result = await sendTelegram(token, chatId, msg);
  if (result && result.ok) {
    return { ok: true, code: TELEGRAM_CODES.SENT };
  }
  const errorMsg = result && result.description ? result.description : 'Telegram send failed';
  return { ok: false, reason: errorMsg, code: TELEGRAM_CODES.API_ERROR };
}

function markSent(state, candidate, nowIso) {
  const symbol = String(candidate.symbol || '').toUpperCase();
  if (!symbol) return state;
  state.sent[symbol] = {
    lastSentAt: nowIso,
    stage: 'ENTRY_READY',
    hash: setupHash(candidate),
    entryType: candidate.entryType || candidate.ENTRY_TYPE || null,
    setupQualityScore: candidate.setupQualityScore ?? candidate.SETUP_SCORE ?? null,
  };
  state.lastSentAt = nowIso;
  state.lastRadarSentAt = nowIso;
  state.lastError = null;
  state.sentCount = (Number(state.sentCount) || 0) + 1;
  return state;
}

export async function runRadarTelegramAlertCycle() {
  const telegramMode = 'ENTRY_READY_ONLY';

  if (isTelegramHardDisabled()) {
    console.warn(`[cron-alerts] ${TELEGRAM_CODES.DISABLED_BY_ENV}: Telegram disabled by env hard-kill; sent=0`);
    return { ok: true, sent: 0, skipped: 0, skippedReasons: {}, selected: null, lastSentAt: null, telegramMode, code: TELEGRAM_CODES.DISABLED_BY_ENV, reason: 'telegram_hard_disabled' };
  }

  const token = process.env.TG_BOT_TOKEN ? process.env.TG_BOT_TOKEN.trim() : '';
  const chatId = process.env.TG_CHAT_ID ? process.env.TG_CHAT_ID.trim() : '';
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const fleet = await loadFleet();
  const fleetRadar = fleet && fleet.tradingRadar ? fleet.tradingRadar : {};
  let state = normalizeRadarTelegramAlertState(fleetRadar.telegramAlertState);

  // Alert-state bookkeeping (cooldowns) always stays in the Fleet; only the market
  // decision moves. When the canonical source is enabled it is authoritative: if it
  // cannot be read, NOTHING is sent. Quietly falling back to the Fleet would alert
  // from a browser-written snapshot that the canonical RADAR never agreed with.
  let radar = fleetRadar;
  let radarSource = 'fleet';
  if (process.env[RADAR_ALERTS_CANONICAL_ENV_FLAG] === 'true') {
    const canonical = await loadCanonicalRadarForAlerts({ nowMs });
    if (canonical.ok) { radar = canonical.radar; radarSource = 'canonical'; }
    else {
      console.warn(`[cron-alerts] canonical_radar_unavailable: ${canonical.reason}; sent=0 (fail-closed)`);
      return { ok: true, sent: 0, skipped: 0, skippedReasons: {}, selected: null, lastSentAt: state.lastSentAt || null, telegramMode, radarSource: 'canonical_unavailable', reason: `canonical_${String(canonical.reason).toLowerCase()}` };
    }
  }

  if (!token || !chatId) {
    const result = { ok: false, sent: 0, skipped: 0, skippedReasons: {}, selected: null, lastSentAt: state.lastSentAt || null, telegramMode, code: TELEGRAM_CODES.MISSING_CREDENTIALS, reason: 'missing_credentials' };
    await mutateFleet((f) => {
      const current = f.tradingRadar || {};
      const nextState = normalizeRadarTelegramAlertState(current.telegramAlertState);
      nextState.lastError = 'Telegram credentials missing';
      f.tradingRadar = { ...current, telegramAlertState: nextState };
      return result;
    });
    console.warn(`[cron-alerts] ${TELEGRAM_CODES.MISSING_CREDENTIALS}: RADAR alerts not sent.`);
    return result;
  }

  const potentials = selectRadarEntryAlerts(radar, state, nowMs);
  console.log(`[cron-alerts] radar_source=${radarSource} candidates=${(radar.candidates || []).length} entryReady=${(radar.entryReady || []).length} due=${potentials.length}`);

  if (!potentials.length) {
    const result = { ok: true, sent: 0, skipped: 0, skippedReasons: {}, selected: null, lastSentAt: state.lastSentAt || null, telegramMode, reason: 'no_entry_ready_due' };
    await mutateFleet((f) => {
      const current = f.tradingRadar || {};
      f.tradingRadar = { ...current, telegramAlertState: normalizeRadarTelegramAlertState(current.telegramAlertState) };
      return result;
    });
    console.log('[cron-alerts] No confirmed RADAR ENTRY_READY alerts due.');
    return result;
  }

  let sentCount = 0;
  let skippedCount = 0;
  const skippedReasons = {};
  let lastError = null;
  let legacyBlockedCountInc = 0;
  let lastSkippedReason = null;
  let selectedSymbol = null;

  const noteSkip = (code, reason) => {
    skippedCount += 1;
    const key = `${code}:${reason}`;
    skippedReasons[key] = (skippedReasons[key] || 0) + 1;
  };

  for (const candidate of potentials) {
    const res = await sendRadarEntryReadyTelegram(candidate, state, token, chatId, { now: nowMs });

    if (res.ok) {
      sentCount += 1;
      if (!selectedSymbol) selectedSymbol = String(candidate.symbol || '').toUpperCase();
      markSent(state, candidate, nowIso);
      console.log(`[cron-alerts] ${TELEGRAM_CODES.SENT}: ${candidate.symbol}`);
    } else if (res.code === TELEGRAM_CODES.LEGACY_BLOCKED) {
      legacyBlockedCountInc += 1;
      state.lastLegacyBlockedAt = nowIso;
      noteSkip(res.code, res.reason);
      console.warn(`[cron-alerts] ${TELEGRAM_CODES.LEGACY_BLOCKED}: ${candidate.symbol} - ${res.reason}`);
    } else if (res.code === TELEGRAM_CODES.API_ERROR) {
      lastError = res.reason;
      noteSkip(res.code, res.reason);
      console.error(`[cron-alerts] ${TELEGRAM_CODES.API_ERROR}: ${candidate.symbol} - ${res.reason}`);
    } else {
      lastSkippedReason = res.reason;
      noteSkip(res.code, res.reason);
      console.log(`[cron-alerts] ${res.code}: ${candidate.symbol} - ${res.reason}`);
    }
  }

  const result = {
    ok: !lastError,
    sent: sentCount,
    skipped: skippedCount,
    skippedReasons,
    selected: selectedSymbol,
    lastSentAt: sentCount > 0 ? nowIso : (state.lastSentAt || null),
    telegramMode,
    lastError,
  };

  await mutateFleet((f) => {
    const current = f.tradingRadar || {};
    const nextState = normalizeRadarTelegramAlertState(current.telegramAlertState);

    for (const [sym, info] of Object.entries(state.sent)) {
      if (!nextState.sent[sym] || new Date(info.lastSentAt) > new Date(nextState.sent[sym].lastSentAt)) {
        nextState.sent[sym] = info;
      }
    }

    if (sentCount > 0) {
      nextState.lastSentAt = nowIso;
      nextState.lastRadarSentAt = nowIso;
      nextState.sentCount += sentCount;
    }
    if (legacyBlockedCountInc > 0) {
      nextState.legacyBlockedCount += legacyBlockedCountInc;
      nextState.lastLegacyBlockedAt = nowIso;
    }
    if (lastSkippedReason) nextState.lastRadarSkippedReason = lastSkippedReason;
    if (lastError) nextState.lastError = String(lastError).slice(0, 200);
    else if (sentCount > 0) nextState.lastError = null;

    f.tradingRadar = { ...current, telegramAlertState: nextState };
    return result;
  });

  console.log(`[cron-alerts] RADAR ENTRY_READY sent=${sentCount} skipped=${skippedCount}`);
  return result;
}

// A Netlify v2 function must resolve to a Response (or undefined). Returning the
// plain result object made EVERY scheduled invocation fail with
// "Function returned an unsupported value" AFTER the work had already run, and
// Netlify then retried it — three invocations were observed within five seconds
// for a single tick. Harmless only because Telegram was hard-disabled; with
// sending enabled those retries are duplicate-alert attempts.
export default async () => {
  let result;
  try { result = await runRadarTelegramAlertCycle(); }
  catch (error) {
    console.error('[cron-alerts] cycle_threw', { name: error?.name || 'Error' });
    return new Response(JSON.stringify({ ok: false, reason: 'ALERT_CYCLE_FAILED' }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  return new Response(JSON.stringify(result ?? { ok: true }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
};

export const config = {
  schedule: '*/5 * * * *',
};
