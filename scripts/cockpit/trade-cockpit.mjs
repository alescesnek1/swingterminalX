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

// Honest cockpit evaluation. Mini-scores are computed ONLY from real data that
// is actually present on the market snapshot. When the inputs for a component
// (order book, flow, derivatives) are absent we return null ("N/A") instead of
// fabricating a neutral-positive default, the health score is re-normalised over
// the components we genuinely have, and `lowConfidence` is flagged. When there is
// no live price at all we never fall back to the entry price (that would show a
// fake 0% PnL); the trade is marked NO_LIVE_PRICE instead.
function present(...vals) {
  return vals.some((v) => v !== null && v !== undefined);
}

export function evaluateTradeCockpit(trade = {}, market = {}, regime = {}) {
  const entry = n(trade.entryPrice ?? trade.entry);
  const qty = n(trade.quantity ?? trade.qty ?? trade.size);
  const current = n(market.currentPrice ?? market.price ?? market.lastPrice ?? trade.currentPrice); // NO entry fallback
  const stop = n(trade.stopLoss ?? trade.stop);
  const tp1 = n(trade.tp1);
  const tp2 = n(trade.tp2);
  const tp3 = n(trade.tp3);
  const realizedPnl = n(trade.realizedPnl, 0);
  const hasPrice = current != null && current > 0;
  const value = hasPrice && qty != null ? current * qty : null;
  const pnlUsd = entry != null && hasPrice && qty != null ? (current - entry) * qty : null;
  const pnlPct = entry > 0 && hasPrice ? ((current - entry) / entry) * 100 : null;
  const distanceToStopPct = stop > 0 && hasPrice ? ((stop - current) / current) * 100 : null;
  const tpDistances = [tp1, tp2, tp3].map((tp) => tp > 0 && hasPrice ? ((tp - current) / current) * 100 : null);
  const ageMs = trade.entryTime ? Math.max(0, Date.now() - new Date(trade.entryTime).getTime()) : 0;

  // ── Component presence: only score what we actually have ──
  const momentumPresent = present(market.change1hPct, market.change4hPct, market.higherLowHeld, market.vwapHeld, market.lowerHigh, market.vwapLost, market.reclaimLost);
  const bookPresent = present(market.spreadPct, market.bidDepthRebuildPct, market.askWallsAbsorbed, market.bidsVanished, market.askWallsReloaded);
  const flowPresent = present(market.buyVolumeDominance, market.marketBuyVolumeDominance, market.sellVolumeFading, market.deltaImproves, market.positiveDeltaNoAdvance, market.perpsOnlyMove, market.sellVolumeSpike);
  const derivPresent = present(market.fundingRate, market.openInterestChangePct, market.spotLed, market.leveragedLongCrowding);
  const marketPresent = present(regime.score, market.marketRegimeScore);

  const momentum = momentumPresent ? componentScore([
    n(market.change1hPct, 0) > 0,
    n(market.change4hPct, 0) > 0,
    market.higherLowHeld === true,
    market.vwapHeld === true,
  ], [
    market.lowerHigh === true,
    market.vwapLost === true,
    market.reclaimLost === true,
  ]) : null;
  const book = bookPresent ? componentScore([
    n(market.bidDepthRebuildPct, 0) > 8,
    market.spreadPct != null && n(market.spreadPct) <= 0.08,
    market.askWallsAbsorbed === true,
  ], [
    market.bidsVanished === true,
    market.askWallsReloaded === true,
    market.spreadPct != null && n(market.spreadPct) > 0.18,
  ]) : null;
  const flow = flowPresent ? componentScore([
    n(market.buyVolumeDominance ?? market.marketBuyVolumeDominance, 0) >= 0.55,
    market.sellVolumeFading === true,
    market.deltaImproves === true,
  ], [
    market.positiveDeltaNoAdvance === true,
    market.perpsOnlyMove === true,
    market.sellVolumeSpike === true,
  ]) : null;
  const derivatives = derivPresent ? componentScore([
    n(market.fundingRate, 0) <= 0.05,
    n(market.openInterestChangePct, 0) < 10,
    market.spotLed === true,
  ], [
    n(market.fundingRate, 0) > 0.08,
    n(market.openInterestChangePct, 0) > 18,
    market.leveragedLongCrowding === true,
  ]) : null;
  const marketScore = marketPresent ? clamp(regime.score == null ? n(market.marketRegimeScore, 55) : regime.score) : null;
  const progress = hasPrice ? clamp(55 + Math.min(25, Math.max(-20, (pnlPct || 0) * 2)) + (tp1 && current >= tp1 ? 10 : 0) + (tp2 && current >= tp2 ? 10 : 0)) : null;

  // Re-normalise health over the components we actually have (no fabricated fill).
  const WEIGHTS = { momentum: 0.20, orderBook: 0.20, flow: 0.20, derivatives: 0.15, market: 0.15, progress: 0.10 };
  const comps = { momentum, orderBook: book, flow, derivatives, market: marketScore, progress };
  let wSum = 0; let acc = 0;
  for (const k of Object.keys(comps)) {
    if (comps[k] != null) { acc += comps[k] * WEIGHTS[k]; wSum += WEIGHTS[k]; }
  }
  const missingComponents = ['orderBook', 'flow', 'derivatives'].filter((k) => comps[k] == null);
  const lowConfidence = missingComponents.length > 0;
  let health = wSum > 0 ? clamp(acc / wSum) : null;

  let status = 'HOLD_BUT_WATCH';
  let action = 'Hold but do not add. Tighten monitoring.';
  let mode = 'caution';
  const reasons = [];

  // No live price → never fake a 0% PnL by falling back to entry.
  if (!hasPrice) {
    return {
      symbol: String(trade.symbol || '').toUpperCase(),
      status: 'NO_LIVE_PRICE',
      action: 'Live price unavailable — symbol not in scanner universe. Cannot evaluate trade health.',
      mode: 'manual',
      priceUnavailable: true,
      lowConfidence: true,
      missingComponents: ['price', 'orderBook', 'flow', 'derivatives'],
      tradeHealthScore: null,
      pnlPct: null,
      pnlUsd: null,
      realizedPnl: round(realizedPnl, 2),
      totalPnl: realizedPnl ? round(realizedPnl, 2) : null,
      positionValue: null,
      distanceToStopPct: null,
      distanceToTpPct: [null, null, null],
      timeInTradeMs: ageMs,
      nextDecisionLevel: 'await live price / not in scanner universe',
      scores: { momentum: null, orderBook: null, flow: null, derivatives: null, market: marketScore, progress: null },
      reason: ['live price unavailable (not in scanner universe)'],
      invalidation: stop ? `loss of ${stop}` : 'missing stop loss',
    };
  }

  if (!stop) {
    status = 'MISSING_RISK_DATA';
    action = 'Define stop loss / invalidation before tracking decision quality.';
    health = Math.min(health, 55);
    mode = 'caution';
    reasons.push('missing stop loss');
  }
  if (stop > 0 && current <= stop) {
    status = 'EXIT_ALL';
    action = 'Exit all immediately. Stop loss level is breached.';
    health = Math.min(health, 20);
    mode = 'exit';
    reasons.push('price below stop');
  }
  if (trade.hardInvalidationActive === true || market.hardInvalidationActive === true) {
    status = 'EMERGENCY_EXIT';
    action = 'Exit all immediately. Hard invalidation is active.';
    health = Math.min(health, 15);
    mode = 'emergency';
    reasons.push('hard invalidation active');
  }
  if (marketScore != null && marketScore < 25) {
    status = health <= 20 ? 'EMERGENCY_EXIT' : 'RISK_OFF_EXIT';
    action = 'Close or heavily reduce. Market regime disaster.';
    health = Math.min(health, 30);
    mode = 'exit';
    reasons.push('market regime disaster');
  }
  if ((book != null && book < 20 && market.spreadPct != null && n(market.spreadPct) > 0.18) || market.orderBookCollapse === true) {
    status = health <= 20 ? 'EMERGENCY_EXIT' : 'EXIT_ALL';
    action = 'Exit all or heavily reduce. Order book support collapsed.';
    health = Math.min(health, 25);
    mode = 'exit';
    reasons.push('order book support collapsed');
  }
  if (market.newsRisk === 'high' || market.exploitRisk === true || market.delistingRisk === true || market.hackRisk === true) {
    status = 'MANUAL_REVIEW';
    action = 'Manual review now. Fundamental/news risk is active.';
    health = Math.min(health, 40);
    mode = 'manual';
    reasons.push('fundamental/news risk active');
  }

  const tpReached = (tp3 && current >= tp3) ? 3 : (tp2 && current >= tp2) ? 2 : (tp1 && current >= tp1) ? 1 : 0;
  if (!['EMERGENCY_EXIT', 'EXIT_ALL', 'RISK_OFF_EXIT', 'MANUAL_REVIEW', 'MISSING_RISK_DATA'].includes(status)) {
    if (tpReached && ((flow != null && flow < 50) || (book != null && book < 50))) {
      status = tpReached >= 2 ? 'TAKE_PROFIT_AGGRESSIVE' : 'TAKE_PROFIT';
      action = tpReached >= 2 ? 'Take profit 50-70% and trail rest tightly.' : 'Take profit 25-40% and trail rest structurally.';
      health = Math.min(health, tpReached >= 2 ? 50 : 58);
      mode = 'profit';
      reasons.push(`TP${tpReached} reached with weakening support`);
    } else if (health >= 91 && market.addRulesValid === true) {
      status = 'ADD_ALLOWED';
      action = 'Add partial only on valid pullback / higher low.';
      mode = 'add';
    } else if (health >= 81) {
      status = 'HOLD_STRONG';
      action = 'Hold, do not take early profit unless at supply.';
      mode = 'strong';
    } else if (health >= 66) {
      status = 'HOLD';
      action = 'Hold and trail structurally.';
      mode = 'hold';
    } else if (health >= 51) {
      status = 'HOLD_BUT_WATCH';
      action = 'Hold, no add, prepare stop update.';
      mode = 'caution';
    } else if (health >= 36) {
      status = 'TAKE_PROFIT_AGGRESSIVE';
      action = pnlPct > 0 ? 'Take profit 50-70% and trail rest tightly.' : 'Tighten stop or exit if next candle fails.';
      mode = 'profit';
    } else {
      status = 'EXIT_ALL';
      action = 'Close or reduce 80-100%.';
      mode = 'exit';
    }
  }

  // round() coerces null→0; preserve genuine "no data" as null instead.
  const r0 = (v) => (v == null ? null : round(v, 0));
  const r2 = (v) => (v == null ? null : round(v, 2));
  const fmtScore = (v) => (v == null ? 'N/A' : round(v, 0));

  const nextTp = [tp1, tp2, tp3].find((tp) => tp > current);
  const nextDecisionLevel = status === 'EMERGENCY_EXIT' || status === 'EXIT_ALL'
    ? 'immediate close'
    : stop && distanceToStopPct != null && Math.abs(distanceToStopPct) < Math.abs(tpDistances.find((x) => x != null) ?? 999)
      ? `stop ${stop}`
      : nextTp ? `TP ${nextTp}` : 'trail structure / next candle';

  if (!reasons.length) {
    reasons.push(`momentum ${fmtScore(momentum)}, book ${fmtScore(book)}, flow ${fmtScore(flow)}, market ${fmtScore(marketScore)}`);
  }
  if (lowConfidence) {
    reasons.push(`low-confidence: missing ${missingComponents.join('/')} data`);
  }

  return {
    symbol: String(trade.symbol || '').toUpperCase(),
    status,
    action,
    mode,
    lowConfidence,
    missingComponents,
    priceUnavailable: false,
    tradeHealthScore: r0(health),
    pnlPct: r2(pnlPct),
    pnlUsd: r2(pnlUsd),
    realizedPnl: round(realizedPnl, 2),
    totalPnl: pnlUsd == null ? (realizedPnl ? round(realizedPnl, 2) : null) : round(pnlUsd + realizedPnl, 2),
    positionValue: r2(value),
    distanceToStopPct: r2(distanceToStopPct),
    distanceToTpPct: tpDistances.map((x) => r2(x)),
    timeInTradeMs: ageMs,
    nextDecisionLevel,
    scores: {
      momentum: r0(momentum),
      orderBook: r0(book),
      flow: r0(flow),
      derivatives: r0(derivatives),
      market: r0(marketScore),
      progress: r0(progress),
    },
    reason: reasons.slice(0, 4),
    invalidation: status === 'EMERGENCY_EXIT' || status === 'EXIT_ALL' ? 'none before close' : (stop ? `loss of ${stop} or market regime below 40` : 'missing stop loss'),
  };
}

export function summarizeCockpit(evaluations = []) {
  const rows = Array.isArray(evaluations) ? evaluations : [];
  const count = (names) => rows.filter((r) => names.includes(r.status)).length;
  const totalValue = rows.reduce((sum, r) => sum + (n(r.positionValue, 0) || 0), 0);
  const totalPnl = rows.reduce((sum, r) => sum + (n(r.totalPnl, 0) || 0), 0);
  return {
    openTrades: rows.length,
    totalPositionValue: round(totalValue, 2),
    unrealizedPnlUsd: round(rows.reduce((sum, r) => sum + (n(r.pnlUsd, 0) || 0), 0), 2),
    totalPnlUsd: round(totalPnl, 2),
    totalPnlPct: totalValue > 0 ? round((totalPnl / totalValue) * 100, 2) : 0,
    holdCount: count(['HOLD', 'HOLD_STRONG', 'ADD_ALLOWED']),
    cautionCount: count(['HOLD_BUT_WATCH', 'MISSING_RISK_DATA', 'MANUAL_REVIEW']),
    takeProfitCount: count(['TAKE_PROFIT', 'TAKE_PROFIT_AGGRESSIVE']),
    exitCount: count(['EXIT_ALL', 'EMERGENCY_EXIT', 'RISK_OFF_EXIT']),
    // Trades with no live price / no health score are not ranked as risk or winner.
    biggestRisk: rows.filter((r) => r.tradeHealthScore != null).sort((a, b) => a.tradeHealthScore - b.tradeHealthScore)[0]?.symbol || '--',
    biggestWinner: rows.filter((r) => r.pnlUsd != null).sort((a, b) => b.pnlUsd - a.pnlUsd)[0]?.symbol || '--',
  };
}
