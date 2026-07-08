// Trade Tracker Cockpit engine — active trade manager (advisory only).
//
// Contract:
//   - no orders, no execution, no live-trading side effects
//   - never fabricates microstructure: missing inputs => null mini-score + lowConfidence
//   - never falls back to entry price for "current" (that would fake a 0% PnL)
//   - auto-detects TP1/TP2/TP3 hits, tracks realized PnL from partial exits, and
//     emits a concrete recommended ACTION + internal alert events
//
// This module is the tested reference. The browser cockpit in
// apps/edge/public/js/terminal.js mirrors this logic (kept in sync; guarded by
// tests/frontend.cockpit.test.mjs).

function n(v, fallback = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Number(v) || 0));
}

function round(v, digits = 2) {
  const x = Number(v);
  if (!Number.isFinite(x)) return null;
  return Number(x.toFixed(digits));
}

function componentScore(positive = [], negative = [], fallback = 55) {
  let score = fallback;
  for (const ok of positive) if (ok) score += 10;
  for (const bad of negative) if (bad) score -= 14;
  return clamp(score);
}

function present(...vals) {
  return vals.some((v) => v !== null && v !== undefined);
}

// Recommended-action vocabulary (the concrete verb shown on each card).
export const COCKPIT_ACTIONS = Object.freeze({
  HOLD: 'HOLD',
  WATCH: 'WATCH',
  TAKE_PARTIAL: 'TAKE_PARTIAL',
  TAKE_MORE: 'TAKE_MORE',
  MOVE_STOP: 'MOVE_STOP',
  PROTECT_PROFIT: 'PROTECT_PROFIT',
  REDUCE_RISK: 'REDUCE_RISK',
  EXIT: 'EXIT',
  INCOMPLETE_SETUP: 'INCOMPLETE_SETUP',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  NO_LIVE_PRICE: 'NO_LIVE_PRICE',
});

const STALE_MS = 5 * 60 * 1000;
const NEAR_STOP_PCT = 1.5; // within 1.5% above stop => danger zone

// Realized PnL from partial exits. trade.partials = [{ fraction: 0..1, price }].
function realizedFromPartials(trade, entry, qty) {
  const partials = Array.isArray(trade.partials) ? trade.partials : [];
  let takenFraction = 0;
  let realizedPnl = 0;
  for (const p of partials) {
    const f = clamp(n(p && p.fraction, 0), 0, 1);
    const px = n(p && p.price);
    if (f <= 0 || px == null || entry == null || qty == null) continue;
    takenFraction = clamp(takenFraction + f, 0, 1);
    realizedPnl += f * qty * (px - entry);
  }
  return { takenFraction, realizedPnl };
}

// Auto-detect + merge persisted TP hits. A TP is "hit" if the live price is
// at/above it now, OR a persisted hit was recorded AT THE SAME LEVEL that is
// configured now. Persisted hits are level-aware ({ price, at }); legacy boolean
// `true` records are NOT trusted (re-derived from live) so a stale hit clears the
// moment the TP level is edited.
export function detectTpHits(trade = {}, current = null) {
  const persisted = (trade && trade.tpHits) || {};
  const tp = [n(trade.tp1), n(trade.tp2), n(trade.tp3)];
  const persistedHit = (rec, lvl) =>
    !!(rec && typeof rec === 'object' && rec.price != null && lvl != null && Number(rec.price) === Number(lvl));
  const live = (lvl) => lvl != null && current != null && current >= lvl;
  return {
    tp1: !!(persistedHit(persisted.tp1, tp[0]) || live(tp[0])),
    tp2: !!(persistedHit(persisted.tp2, tp[1]) || live(tp[1])),
    tp3: !!(persistedHit(persisted.tp3, tp[2]) || live(tp[2])),
  };
}

// Structural setup validation. For a long: stop must sit BELOW entry and every
// provided TP ABOVE entry. Short is not yet supported here → always manual review
// so we never apply long-only stop/TP math to a short position.
export function validateSetup(side, entry, stop, tps = []) {
  const isShort = String(side || 'long').toLowerCase() === 'short';
  if (isShort) return { valid: false, reason: 'short trades not yet supported — manual review' };
  if (entry == null || !(entry > 0)) return { valid: true }; // entry validated at the input layer
  if (stop != null && stop > 0 && stop >= entry) {
    return { valid: false, reason: 'Invalid long setup: stop must be below entry' };
  }
  for (let i = 0; i < tps.length; i++) {
    const tp = tps[i];
    if (tp != null && tp > 0 && tp <= entry) {
      return { valid: false, reason: `Invalid long setup: TP${i + 1} must be above entry` };
    }
  }
  return { valid: true };
}

export function evaluateTradeCockpit(trade = {}, market = {}, regime = {}, now = Date.now()) {
  const symbol = String(trade.symbol || '').toUpperCase();
  const entry = n(trade.entryPrice ?? trade.entry);
  const qty = n(trade.quantity ?? trade.qty ?? trade.size);
  const current = n(market.currentPrice ?? market.price ?? market.lastPrice ?? trade.currentPrice); // NO entry fallback
  const stop = n(trade.stopLoss ?? trade.stop);
  const hardInval = n(trade.hardInvalidation);
  const tps = [n(trade.tp1), n(trade.tp2), n(trade.tp3)];
  const hasAnyTp = tps.some((t) => t != null && t > 0);
  const hasPrice = current != null && current > 0;
  const ageMs = trade.entryTime ? Math.max(0, now - new Date(trade.entryTime).getTime()) : 0;
  const lastUpdate = market.updatedAt ? new Date(market.updatedAt).getTime() : (hasPrice ? now : null);
  const stale = lastUpdate != null && (now - lastUpdate) > STALE_MS;
  const safetyStatus = String(trade.safetyStatus || market.safetyStatus || 'UNKNOWN').toUpperCase();
  const side = String(trade.side || 'long').toLowerCase();

  const base = {
    symbol, side, mode: 'caution', priceUnavailable: false, lowConfidence: false, missingComponents: [],
    stopHit: false, safetyStatus, stale,
    tpHits: detectTpHits(trade, hasPrice ? current : null),
    timeInTradeMs: ageMs, lastUpdateMs: lastUpdate,
  };

  // ── Structural setup validation: an invalid stop/TP geometry (or an
  // unsupported short) OVERRIDES everything. Never emit a hard STOP/TP/EXIT
  // verdict on a structurally invalid setup — force manual review instead. ──
  const setup = validateSetup(side, entry, stop, tps);
  if (!setup.valid) {
    const pnlPctInv = (hasPrice && entry > 0) ? ((current - entry) / entry) * 100 : null;
    return {
      ...base,
      status: 'INVALID_SETUP', action: COCKPIT_ACTIONS.MANUAL_REVIEW, mode: 'manual',
      priceUnavailable: !hasPrice, lowConfidence: true,
      stopHit: false, tpHits: { tp1: false, tp2: false, tp3: false },
      missingComponents: ['orderBook', 'flow', 'derivatives'],
      tradeHealthScore: null,
      current: hasPrice ? round(current, 8) : null, entryPrice: entry, quantity: qty,
      pnlPct: pnlPctInv == null ? null : round(pnlPctInv, 2),
      unrealizedPnlUsd: null, realizedPnl: null, totalPnl: null, positionValue: null,
      distanceToStopPct: null, distanceToTpPct: [null, null, null], nextTp: null,
      suggestedStop: null, nextDecisionLevel: 'fix setup — manual review',
      scores: { momentum: null, orderBook: null, flow: null, derivatives: null, market: null, progress: null },
      reason: [setup.reason],
      whyMissing: [], invalidation: setup.reason,
    };
  }

  // ── No live price: never fake PnL by using entry ──
  if (!hasPrice) {
    return {
      ...base,
      status: 'NO_LIVE_PRICE', action: COCKPIT_ACTIONS.NO_LIVE_PRICE, mode: 'manual', priceUnavailable: true, lowConfidence: true,
      missingComponents: ['price', 'orderBook', 'flow', 'derivatives'],
      tradeHealthScore: null, current: null,
      pnlPct: null, unrealizedPnlUsd: null, realizedPnl: round(realizedFromPartials(trade, entry, qty).realizedPnl, 2) || null,
      totalPnl: null, positionValue: null,
      distanceToStopPct: null, distanceToTpPct: [null, null, null], nextTp: null,
      suggestedStop: null, nextDecisionLevel: 'await live price',
      scores: { momentum: null, orderBook: null, flow: null, derivatives: null, market: null, progress: null },
      reason: [market.found === false ? 'not in scanner universe' : 'live price unavailable'],
      whyMissing: ['live price'],
      invalidation: stop ? `loss of ${stop}` : 'missing stop',
    };
  }

  // ── PnL incl. realized partials ──
  const { takenFraction, realizedPnl } = realizedFromPartials(trade, entry, qty);
  const remainingFraction = clamp(1 - takenFraction, 0, 1);
  const pnlPct = entry > 0 ? ((current - entry) / entry) * 100 : null;
  const unrealizedPnlUsd = (entry != null && qty != null) ? remainingFraction * qty * (current - entry) : null;
  const totalPnl = (unrealizedPnlUsd == null) ? round(realizedPnl, 2) : round(realizedPnl + unrealizedPnlUsd, 2);
  const positionValue = qty != null ? round(remainingFraction * qty * current, 2) : null;

  // ── Component presence (only score real data) ──
  const momentumPresent = present(market.change1hPct, market.change4hPct, market.higherLowHeld, market.vwapHeld, market.lowerHigh, market.vwapLost, market.reclaimLost);
  const bookPresent = present(market.spreadPct, market.bidDepthRebuildPct, market.askWallsAbsorbed, market.bidsVanished, market.askWallsReloaded);
  const flowPresent = present(market.buyVolumeDominance, market.marketBuyVolumeDominance, market.sellVolumeFading, market.deltaImproves, market.positiveDeltaNoAdvance, market.perpsOnlyMove, market.sellVolumeSpike);
  const derivPresent = present(market.fundingRate, market.openInterestChangePct, market.spotLed, market.leveragedLongCrowding);
  const marketPresent = present(regime.score, market.marketRegimeScore);

  const momentum = momentumPresent ? componentScore([
    n(market.change1hPct, 0) > 0, n(market.change4hPct, 0) > 0, market.higherLowHeld === true, market.vwapHeld === true,
  ], [market.lowerHigh === true, market.vwapLost === true, market.reclaimLost === true]) : null;
  const book = bookPresent ? componentScore([
    n(market.bidDepthRebuildPct, 0) > 8, market.spreadPct != null && n(market.spreadPct) <= 0.08, market.askWallsAbsorbed === true,
  ], [market.bidsVanished === true, market.askWallsReloaded === true, market.spreadPct != null && n(market.spreadPct) > 0.18]) : null;
  const flow = flowPresent ? componentScore([
    n(market.buyVolumeDominance ?? market.marketBuyVolumeDominance, 0) >= 0.55, market.sellVolumeFading === true, market.deltaImproves === true,
  ], [market.positiveDeltaNoAdvance === true, market.perpsOnlyMove === true, market.sellVolumeSpike === true]) : null;
  const derivatives = derivPresent ? componentScore([
    n(market.fundingRate, 0) <= 0.05, n(market.openInterestChangePct, 0) < 10, market.spotLed === true,
  ], [n(market.fundingRate, 0) > 0.08, n(market.openInterestChangePct, 0) > 18, market.leveragedLongCrowding === true]) : null;
  const marketScore = marketPresent ? clamp(regime.score == null ? n(market.marketRegimeScore, 55) : regime.score) : null;
  const tpHits = base.tpHits;
  const progress = clamp(55 + Math.min(25, Math.max(-20, (pnlPct || 0) * 2)) + (tpHits.tp1 ? 8 : 0) + (tpHits.tp2 ? 8 : 0) + (tpHits.tp3 ? 9 : 0));

  const WEIGHTS = { momentum: 0.20, orderBook: 0.20, flow: 0.20, derivatives: 0.15, market: 0.15, progress: 0.10 };
  const comps = { momentum, orderBook: book, flow, derivatives, market: marketScore, progress };
  let wSum = 0; let acc = 0;
  for (const k of Object.keys(comps)) { if (comps[k] != null) { acc += comps[k] * WEIGHTS[k]; wSum += WEIGHTS[k]; } }
  const missingComponents = ['orderBook', 'flow', 'derivatives'].filter((k) => comps[k] == null);
  const lowConfidence = missingComponents.length > 0;
  let health = wSum > 0 ? clamp(acc / wSum) : 50;

  // ── Levels / distances ──
  const distanceToStopPct = stop > 0 ? ((stop - current) / current) * 100 : null;
  const distanceToTpPct = tps.map((tp) => (tp != null && tp > 0) ? ((tp - current) / current) * 100 : null);
  const nearStop = stop > 0 && current > stop && distanceToStopPct != null && Math.abs(distanceToStopPct) <= NEAR_STOP_PCT;
  const nextTpIdx = tps.findIndex((tp, i) => tp != null && tp > current && !tpHits['tp' + (i + 1)]);
  const nextTp = nextTpIdx >= 0 ? { idx: nextTpIdx + 1, price: tps[nextTpIdx], distancePct: round(distanceToTpPct[nextTpIdx], 2) } : null;
  // Suggested stop: lift to breakeven once meaningfully in profit / after TP1.
  let suggestedStop = stop || null;
  if ((pnlPct != null && pnlPct >= 6) || tpHits.tp1) {
    suggestedStop = stop && stop >= entry ? round(stop, 8) : round(entry, 8);
  }

  // ── Status + action decision tree ──
  let status = 'HOLD_BUT_WATCH';
  let action = COCKPIT_ACTIONS.WATCH;
  let mode = 'caution';
  const reasons = [];
  const incomplete = !(stop > 0) || !hasAnyTp;
  const fading = (flow != null && flow < 50) || (book != null && book < 50) || (momentum != null && momentum < 45);

  // Order matters: hard dangers (stop hit / invalidation / safety / regime /
  // book collapse) always win, THEN incomplete-setup, THEN TP-state, near-stop,
  // profit protection, and finally the health bands.
  if (stop > 0 && current <= stop) {
    status = 'EXIT_ALL'; action = COCKPIT_ACTIONS.EXIT; mode = 'exit'; base.stopHit = true; health = Math.min(health, 15);
    reasons.push('price at/below stop — stop hit');
  } else if (trade.hardInvalidationActive === true || market.hardInvalidationActive === true || (hardInval != null && current <= hardInval)) {
    status = 'EMERGENCY_EXIT'; action = COCKPIT_ACTIONS.EXIT; mode = 'emergency'; health = Math.min(health, 15);
    reasons.push('hard invalidation active');
  } else if (safetyStatus === 'DANGER' || market.exploitRisk === true || market.hackRisk === true || market.delistingRisk === true || market.newsRisk === 'high') {
    status = 'MANUAL_REVIEW'; action = COCKPIT_ACTIONS.EXIT; mode = 'emergency'; health = Math.min(health, 25);
    reasons.push(safetyStatus === 'DANGER' ? 'safety DANGER' : 'fundamental/news risk active');
  } else if (marketScore != null && marketScore < 25) {
    status = 'RISK_OFF_EXIT'; action = COCKPIT_ACTIONS.EXIT; mode = 'exit'; health = Math.min(health, 30);
    reasons.push('market regime disaster');
  } else if (book != null && book < 20 && market.spreadPct != null && n(market.spreadPct) > 0.18) {
    status = 'EXIT_ALL'; action = COCKPIT_ACTIONS.REDUCE_RISK; mode = 'exit'; health = Math.min(health, 25);
    reasons.push('order book support collapsed');
  } else if (incomplete) {
    status = 'INCOMPLETE_SETUP';
    action = COCKPIT_ACTIONS.INCOMPLETE_SETUP;
    mode = 'manual';
    health = Math.min(health, 50);
    if (!(stop > 0)) reasons.push('no stop / invalidation defined');
    if (!hasAnyTp) reasons.push('no take-profit zones defined');
  } else if (tpHits.tp3) {
    status = 'TAKE_PROFIT'; action = COCKPIT_ACTIONS.EXIT; mode = 'profit';
    reasons.push('TP3 reached — take 60-80%, trail any runner');
  } else if (tpHits.tp2) {
    status = 'TAKE_PROFIT'; action = COCKPIT_ACTIONS.TAKE_MORE; mode = 'profit';
    reasons.push('TP2 reached — take 30-40% and move stop up');
  } else if (tpHits.tp1) {
    status = 'TAKE_PROFIT'; action = COCKPIT_ACTIONS.TAKE_PARTIAL; mode = 'profit';
    reasons.push('TP1 reached — take 25-35%, trail remainder');
  } else if (nearStop) {
    status = 'HOLD_BUT_WATCH'; action = COCKPIT_ACTIONS.REDUCE_RISK; mode = 'caution';
    reasons.push('price near stop — reduce risk / prepare exit');
  } else if (pnlPct != null && pnlPct >= 3 && fading) {
    status = 'TAKE_PROFIT_AGGRESSIVE'; action = COCKPIT_ACTIONS.PROTECT_PROFIT; mode = 'profit';
    reasons.push('in profit but momentum/flow/book fading — protect profit');
  } else if (health >= 81) {
    status = 'HOLD_STRONG'; action = COCKPIT_ACTIONS.HOLD; mode = 'strong';
    reasons.push('structure strong — hold');
  } else if (health >= 66) {
    status = 'HOLD'; action = pnlPct != null && pnlPct >= 6 ? COCKPIT_ACTIONS.MOVE_STOP : COCKPIT_ACTIONS.HOLD; mode = 'hold';
    reasons.push(pnlPct != null && pnlPct >= 6 ? 'healthy + in profit — trail/move stop up' : 'healthy — hold and trail');
  } else if (health >= 51) {
    status = 'HOLD_BUT_WATCH'; action = COCKPIT_ACTIONS.WATCH; mode = 'caution';
    reasons.push('mixed health — watch, no add');
  } else if (health >= 36) {
    status = 'TAKE_PROFIT_AGGRESSIVE'; action = pnlPct != null && pnlPct > 0 ? COCKPIT_ACTIONS.PROTECT_PROFIT : COCKPIT_ACTIONS.REDUCE_RISK; mode = 'profit';
    reasons.push('weak health — reduce / protect');
  } else if (lowConfidence) {
    // Critical health but the score is built on partial data (order book / flow /
    // derivatives missing). Do NOT auto-exit on a low-confidence score — a hard
    // exit here must come from a price-only trigger (stop hit) handled above.
    status = 'MANUAL_REVIEW'; action = COCKPIT_ACTIONS.REDUCE_RISK; mode = 'caution';
    reasons.push('weak health but low-confidence data — manual review (no auto-exit)');
  } else {
    status = 'EXIT_ALL'; action = COCKPIT_ACTIONS.EXIT; mode = 'exit';
    reasons.push('health critical — exit');
  }

  if (safetyStatus !== 'SAFE' && status !== 'NO_LIVE_PRICE') reasons.push(`safety ${safetyStatus}`);
  if (lowConfidence) reasons.push(`low-confidence: missing ${missingComponents.join('/')} data`);

  const nextDecisionLevel = (status === 'EXIT_ALL' || status === 'EMERGENCY_EXIT' || status === 'RISK_OFF_EXIT')
    ? 'immediate close'
    : (stop > 0 && distanceToStopPct != null && nextTp && Math.abs(distanceToStopPct) < Math.abs(nextTp.distancePct ?? 999))
      ? `stop ${stop}`
      : nextTp ? `TP${nextTp.idx} ${nextTp.price}` : (stop > 0 ? `stop ${stop}` : 'trail structure / next candle');

  const r0 = (v) => (v == null ? null : round(v, 0));
  const r2 = (v) => (v == null ? null : round(v, 2));

  return {
    ...base, side, status, action, mode, lowConfidence, missingComponents,
    tradeHealthScore: r0(health),
    current: round(current, 8), entryPrice: entry, quantity: qty,
    pnlPct: r2(pnlPct), unrealizedPnlUsd: r2(unrealizedPnlUsd), realizedPnl: round(realizedPnl, 2), totalPnl,
    positionValue, takenFraction: round(takenFraction, 4), remainingFraction: round(remainingFraction, 4),
    distanceToStopPct: r2(distanceToStopPct), distanceToTpPct: distanceToTpPct.map((x) => r2(x)),
    nextTp, suggestedStop, nextDecisionLevel,
    scores: { momentum: r0(momentum), orderBook: r0(book), flow: r0(flow), derivatives: r0(derivatives), market: r0(marketScore), progress: r0(progress) },
    reason: reasons.slice(0, 5),
    invalidation: (status === 'EXIT_ALL' || status === 'EMERGENCY_EXIT') ? 'none before close' : (stop ? `loss of ${stop}${hardInval ? ` / hard ${hardInval}` : ''} or market regime below 40` : 'missing stop'),
  };
}

// Build internal UI alert events by diffing this evaluation against the previous
// snapshot persisted on the trade. Never sends Telegram — UI/log only.
export function buildCockpitAlerts(evalResult = {}, prev = {}, now = Date.now()) {
  const alerts = [];
  const sym = evalResult.symbol;
  const push = (type, urgency, reason) => alerts.push({
    symbol: sym, type, urgency, status: evalResult.status, action: evalResult.action,
    price: evalResult.current, reason, time: new Date(now).toISOString(),
  });
  const ph = prev.tpHits || {};
  const th = evalResult.tpHits || {};
  if (th.tp1 && !ph.tp1) push('TP1_HIT', 'P3', 'TP1 zone reached');
  if (th.tp2 && !ph.tp2) push('TP2_HIT', 'P2', 'TP2 zone reached');
  if (th.tp3 && !ph.tp3) push('TP3_HIT', 'P2', 'TP3 zone reached');
  if (evalResult.stopHit && !prev.stopHit) push('STOP_HIT', 'P1', 'stop loss breached');
  else if (evalResult.action === 'REDUCE_RISK' && evalResult.distanceToStopPct != null && Math.abs(evalResult.distanceToStopPct) <= 1.5 && prev.status !== evalResult.status) push('STOP_NEAR', 'P1', 'price near stop');
  if (evalResult.status === 'NO_LIVE_PRICE' && prev.status !== 'NO_LIVE_PRICE') push('NO_LIVE_PRICE', 'P3', 'live price unavailable');
  if (evalResult.status === 'INCOMPLETE_SETUP' && prev.status !== 'INCOMPLETE_SETUP') push('INCOMPLETE_SETUP', 'P3', 'stop/TP not defined');
  if (evalResult.safetyStatus === 'DANGER' && prev.safetyStatus !== 'DANGER') push('SAFETY_DANGER', 'P1', 'safety DANGER');
  if (evalResult.stale && !prev.stale) push('STALE', 'P4', 'market data stale');
  return alerts;
}

// Pre-fill a cockpit position from a focused RADAR candidate. Marks which fields
// came from RADAR vs fallback so the UI can label them honestly.
export function prefillFromRadarCandidate(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const zone = candidate.entryZone || null;
  const entryMid = zone && zone.low != null && zone.high != null ? (Number(zone.low) + Number(zone.high)) / 2 : null;
  const tps = Array.isArray(candidate.TAKE_PROFIT_LEVELS || candidate.takeProfitCheckpoints)
    ? (candidate.TAKE_PROFIT_LEVELS || candidate.takeProfitCheckpoints) : [];
  const tpLevel = (i) => (tps[i] && (tps[i].level != null ? Number(tps[i].level) : null));
  return {
    symbol: String(candidate.symbol || '').toUpperCase(),
    entryType: candidate.ENTRY_TYPE || candidate.entryType || 'RADAR',
    entryPrice: entryMid != null ? round(entryMid, 8) : null,
    stopLoss: n(candidate.STOP_LOSS_LEVEL ?? candidate.suggestedStop),
    hardInvalidation: n(candidate.HARD_INVALIDATION ?? candidate.invalidationLevel),
    tp1: tpLevel(0), tp2: tpLevel(1), tp3: tpLevel(2),
    safetyStatus: candidate.safetyStatus || 'UNKNOWN',
    notes: Array.isArray(candidate.REASON) ? candidate.REASON.join('; ') : (candidate.reasons || []).join('; '),
    fromRadar: true,
    radarSnapshot: {
      status: candidate.STATUS || candidate.actionability, confidence: candidate.FINAL_CONFIDENCE ?? candidate.confidence,
      entryZone: zone, capturedAt: new Date().toISOString(),
    },
  };
}

export function summarizeCockpit(evaluations = []) {
  const rows = Array.isArray(evaluations) ? evaluations : [];
  const count = (names) => rows.filter((r) => names.includes(r.status)).length;
  const totalValue = rows.reduce((sum, r) => sum + (n(r.positionValue, 0) || 0), 0);
  const totalPnl = rows.reduce((sum, r) => sum + (n(r.totalPnl, 0) || 0), 0);
  const unrealized = rows.reduce((sum, r) => sum + (n(r.unrealizedPnlUsd, 0) || 0), 0);
  const healthRows = rows.filter((r) => r.tradeHealthScore != null);
  const needsAction = rows.filter((r) => ['EXIT', 'TAKE_PARTIAL', 'TAKE_MORE', 'PROTECT_PROFIT', 'REDUCE_RISK', 'INCOMPLETE_SETUP', 'MANUAL_REVIEW', 'MOVE_STOP'].includes(r.action)).length;
  return {
    openTrades: rows.length,
    totalPositionValue: round(totalValue, 2),
    unrealizedPnlUsd: round(unrealized, 2),
    totalPnlUsd: round(totalPnl, 2),
    totalPnlPct: totalValue > 0 ? round((totalPnl / totalValue) * 100, 2) : 0,
    needsActionCount: needsAction,
    holdCount: count(['HOLD', 'HOLD_STRONG', 'ADD_ALLOWED']),
    cautionCount: count(['HOLD_BUT_WATCH', 'MANUAL_REVIEW', 'INCOMPLETE_SETUP', 'INVALID_SETUP']),
    takeProfitCount: count(['TAKE_PROFIT', 'TAKE_PROFIT_AGGRESSIVE']),
    exitCount: count(['EXIT_ALL', 'EMERGENCY_EXIT', 'RISK_OFF_EXIT']),
    noPriceCount: rows.filter((r) => r.status === 'NO_LIVE_PRICE').length,
    staleCount: rows.filter((r) => r.stale).length,
    averageHealth: healthRows.length ? round(healthRows.reduce((s, r) => s + r.tradeHealthScore, 0) / healthRows.length, 0) : null,
    biggestRisk: healthRows.slice().sort((a, b) => a.tradeHealthScore - b.tradeHealthScore)[0]?.symbol || '--',
    biggestWinner: rows.filter((r) => r.totalPnl != null).sort((a, b) => b.totalPnl - a.totalPnl)[0]?.symbol || '--',
  };
}

// ─────────────────────────────────────────────────────────────
// M1 — Coinee-inspired, Terminal-X-native manual-review layer.
//
// Two PURE, presentation-only helpers that expose data Terminal-X ALREADY has,
// more honestly. They change no score, gate, action, ENTRY_READY, or Telegram
// behaviour; they never fabricate a value; they never emit an execution verb.
// Missing inputs render as N/A / "manual review", never as a neutral-positive
// default. The returned objects are display models only (no action / status /
// entryReady / telegram field), so they cannot drive an exit or unlock an alert.
//
// Honest terminology (never rename to imply data we lack):
//   • "Flow (taker)"      — windowed taker delta, NOT a true CVD series
//   • "Orderbook (depth)" — resting depth walls, NOT confirmed whale orders
//   • "Funding"           — funding-rate context, NOT an entry signal
// Nothing here is a "liquidation heatmap" — we have no liquidation feed.
// ─────────────────────────────────────────────────────────────

export const REVIEW_CARD_KEYS = Object.freeze([
  'structure', 'flow', 'funding', 'oi', 'orderbook', 'safety', 'news', 'regime',
]);

// Extreme-funding thresholds (8h funding, percent units) — mirror the trap
// thresholds the funding-divergence feed already uses, for labelling only.
const FUNDING_EXTREME_POS_PCT = 0.03;   // +3 bps — longs paying heavily
const FUNDING_EXTREME_NEG_PCT = -0.005; // -0.5 bps — shorts paying

// Build the 8-card manual-review checklist for one tracked trade. Reads only the
// already-computed evaluation + the honest market lookup + optional funding
// context (from the existing funding-divergence feed). Pure: does not mutate its
// inputs and returns a plain display object.
export function buildReviewChecklist(evalResult = {}, market = {}, context = {}) {
  const scores = (evalResult && evalResult.scores) || {};
  const fundingCtx = context && context.funding && typeof context.funding === 'object' ? context.funding : null;
  const stale = evalResult && evalResult.stale === true;
  const liveFresh = stale ? false : true;

  const cards = [];
  const add = (key, label, o = {}) => cards.push({
    key,
    label,
    status: o.status === 'ok' ? 'ok' : 'na',
    value: o.value == null ? null : String(o.value),
    source: o.source == null ? null : String(o.source),
    note: o.note == null ? null : String(o.note),
    fresh: typeof o.fresh === 'boolean' ? o.fresh : null,
  });

  // 1. STRUCTURE — momentum / higher-low / vwap (scanner)
  if (scores.momentum != null) add('structure', 'Structure', { status: 'ok', value: `score ${Math.round(scores.momentum)}`, source: 'scanner', fresh: liveFresh });
  else add('structure', 'Structure', { status: 'na', note: 'manual review', source: 'scanner' });

  // 2. FLOW — windowed taker delta (NOT CVD)
  if (scores.flow != null) add('flow', 'Flow (taker)', { status: 'ok', value: `score ${Math.round(scores.flow)}`, source: 'scanner microstructure', fresh: liveFresh });
  else add('flow', 'Flow (taker)', { status: 'na', note: 'Flow unavailable', source: 'scanner microstructure' });

  // 3. FUNDING — scored funding, else funding-divergence context, else N/A
  const funding = n(market.fundingRate);
  if (funding != null) add('funding', 'Funding', { status: 'ok', value: `${round(funding, 4)}%`, source: 'premiumIndex', fresh: liveFresh });
  else if (fundingCtx && Number.isFinite(Number(fundingCtx.funding_pct))) add('funding', 'Funding', { status: 'ok', value: `${round(Number(fundingCtx.funding_pct), 4)}%${fundingCtx.signal ? ` · ${fundingCtx.signal}` : ''}`, source: fundingCtx.source || 'funding-divergence', note: 'context only' });
  else add('funding', 'Funding', { status: 'na', note: 'Funding unavailable', source: 'premiumIndex' });

  // 4. OI Δ
  const oi = n(market.openInterestChangePct);
  if (oi != null) add('oi', 'OI Δ', { status: 'ok', value: `${round(oi, 2)}%`, source: 'futures OI', fresh: liveFresh });
  else add('oi', 'OI Δ', { status: 'na', note: 'OI unavailable', source: 'futures OI' });

  // 5. ORDERBOOK — resting depth walls (NOT confirmed whale orders)
  if (scores.orderBook != null) add('orderbook', 'Orderbook (depth)', { status: 'ok', value: `score ${Math.round(scores.orderBook)}`, source: 'depth', fresh: liveFresh });
  else add('orderbook', 'Orderbook (depth)', { status: 'na', note: 'Orderbook unavailable', source: 'depth' });

  // 6. SAFETY — UNKNOWN is missing context (blocks alerts), not a health value
  const safety = String(evalResult.safetyStatus || 'UNKNOWN').toUpperCase();
  if (safety === 'UNKNOWN') add('safety', 'Safety', { status: 'na', value: 'UNKNOWN', source: 'safety model', note: 'Safety UNKNOWN blocks alerts' });
  else add('safety', 'Safety', { status: 'ok', value: safety, source: 'safety model' });

  // 7. NEWS / risk flags
  const newsFlags = [];
  if (market.newsRisk) newsFlags.push(`news ${market.newsRisk}`);
  if (market.exploitRisk === true) newsFlags.push('exploit');
  if (market.hackRisk === true) newsFlags.push('hack');
  if (market.delistingRisk === true) newsFlags.push('delisting');
  const newsPresent = market.newsRisk != null || market.exploitRisk === true || market.hackRisk === true || market.delistingRisk === true;
  if (newsPresent) add('news', 'News/Risk', { status: 'ok', value: newsFlags.join(', ') || 'clear', source: 'safety/news' });
  else add('news', 'News/Risk', { status: 'na', note: 'News unavailable/degraded', source: 'safety/news' });

  // 8. MARKET REGIME
  const regimeScore = scores.market != null ? scores.market : n(market.marketRegimeScore);
  if (regimeScore != null) add('regime', 'Market regime', { status: 'ok', value: `score ${Math.round(regimeScore)}`, source: 'regime model', fresh: liveFresh });
  else add('regime', 'Market regime', { status: 'na', note: 'Market regime unavailable', source: 'regime model' });

  const naCount = cards.filter((c) => c.status === 'na').length;
  // "Manual review required" when trading context we would act on is missing, or
  // safety is UNKNOWN. Advisory presentation only — drives NO action/exit/alert.
  const isNa = (key) => { const c = cards.find((x) => x.key === key); return c ? c.status === 'na' : true; };
  const manualReview = safety === 'UNKNOWN' || ['flow', 'orderbook', 'oi'].some(isNa);

  return { contextOnly: true, cards, naCount, manualReview };
}

// Group the existing funding-divergence signals into an at-a-glance funding
// context read-model. Pure over the SAME data the scanner table already stamps —
// it is context, never an entry signal, and carries no action/telegram field.
export function summarizeFundingContext(signals = []) {
  const rows = Array.isArray(signals) ? signals : [];
  const norm = [];
  const states = { SHORTS_TRAPPED: 0, LONGS_TRAPPED: 0, CROWDED_LONG: 0 };
  for (const s of rows) {
    if (!s || typeof s !== 'object') continue;
    const funding_pct = Number(s.funding_pct);
    if (!Number.isFinite(funding_pct)) continue;
    const sig = String(s.signal || '').toUpperCase();
    if (Object.prototype.hasOwnProperty.call(states, sig)) states[sig] += 1;
    norm.push({
      symbol: String(s.symbol || s.pair || '').toUpperCase(),
      funding_pct: round(funding_pct, 4),
      price_change_24h_pct: Number.isFinite(Number(s.price_change_24h_pct)) ? round(Number(s.price_change_24h_pct), 2) : null,
      signal: sig || null,
      bias: s.bias ? String(s.bias).toLowerCase() : null,
    });
  }
  const extremePositive = norm.filter((r) => r.funding_pct >= FUNDING_EXTREME_POS_PCT).sort((a, b) => b.funding_pct - a.funding_pct).slice(0, 10);
  const extremeNegative = norm.filter((r) => r.funding_pct <= FUNDING_EXTREME_NEG_PCT).sort((a, b) => a.funding_pct - b.funding_pct).slice(0, 10);
  const divergences = norm.filter((r) => r.signal).slice(0, 20);
  return {
    contextOnly: true,
    source: 'funding-divergence',
    count: norm.length,
    states,
    extremePositive,
    extremeNegative,
    divergences,
  };
}

// Pure grouping reference for the MARKET-WIDE funding context block that the
// /api/funding-divergence endpoint attaches (buildFundingContext mirrors this
// shape). Given a full list of {symbol,pair,funding_pct,...} rows across USDⓈ-M
// perps, return the top positive / negative funding names. Context only — no
// signal/bias/confidence, never fed to any gate, score, or Telegram path.
export function summarizeMarketFunding(rows = [], opts = {}) {
  const topN = Number.isFinite(Number(opts.topN)) && Number(opts.topN) > 0 ? Math.min(Math.trunc(Number(opts.topN)), 50) : 12;
  const norm = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    const funding_pct = Number(r.funding_pct);
    if (!Number.isFinite(funding_pct)) continue;
    norm.push({
      symbol: String(r.symbol || r.pair || '').toUpperCase(),
      pair: r.pair ? String(r.pair).toUpperCase() : null,
      funding_pct: round(funding_pct, 4),
      mark_price: Number.isFinite(Number(r.mark_price)) ? Number(r.mark_price) : null,
      price_change_24h_pct: Number.isFinite(Number(r.price_change_24h_pct)) ? round(Number(r.price_change_24h_pct), 2) : null,
    });
  }
  const top_positive = norm.filter((r) => r.funding_pct > 0).sort((a, b) => b.funding_pct - a.funding_pct).slice(0, topN);
  const top_negative = norm.filter((r) => r.funding_pct < 0).sort((a, b) => a.funding_pct - b.funding_pct).slice(0, topN);
  return { context_only: true, source: 'funding-divergence', universe_count: norm.length, top_positive, top_negative };
}
