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

export function evaluateTradeCockpit(trade = {}, market = {}, regime = {}) {
  const entry = n(trade.entryPrice ?? trade.entry);
  const qty = n(trade.quantity ?? trade.qty ?? trade.size);
  const current = n(market.currentPrice ?? market.price ?? market.lastPrice ?? trade.currentPrice, entry);
  const stop = n(trade.stopLoss ?? trade.stop);
  const tp1 = n(trade.tp1);
  const tp2 = n(trade.tp2);
  const tp3 = n(trade.tp3);
  const realizedPnl = n(trade.realizedPnl, 0);
  const value = current != null && qty != null ? current * qty : null;
  const pnlUsd = entry != null && current != null && qty != null ? (current - entry) * qty : 0;
  const pnlPct = entry > 0 && current != null ? ((current - entry) / entry) * 100 : 0;
  const distanceToStopPct = stop > 0 && current > 0 ? ((stop - current) / current) * 100 : null;
  const tpDistances = [tp1, tp2, tp3].map((tp) => tp > 0 && current > 0 ? ((tp - current) / current) * 100 : null);
  const ageMs = trade.entryTime ? Math.max(0, Date.now() - new Date(trade.entryTime).getTime()) : 0;

  const momentum = componentScore([
    n(market.change1hPct, 0) > 0,
    n(market.change4hPct, 0) > 0,
    market.higherLowHeld === true,
    market.vwapHeld === true,
  ], [
    market.lowerHigh === true,
    market.vwapLost === true,
    market.reclaimLost === true,
  ]);
  const book = componentScore([
    n(market.bidDepthRebuildPct, 0) > 8,
    n(market.spreadPct, 0.05) <= 0.08,
    market.askWallsAbsorbed === true,
  ], [
    market.bidsVanished === true,
    market.askWallsReloaded === true,
    n(market.spreadPct, 0) > 0.18,
  ]);
  const flow = componentScore([
    n(market.buyVolumeDominance ?? market.marketBuyVolumeDominance, 0) >= 0.55,
    market.sellVolumeFading === true,
    market.deltaImproves === true,
  ], [
    market.positiveDeltaNoAdvance === true,
    market.perpsOnlyMove === true,
    market.sellVolumeSpike === true,
  ]);
  const derivatives = componentScore([
    n(market.fundingRate, 0) <= 0.05,
    n(market.openInterestChangePct, 0) < 10,
    market.spotLed === true,
  ], [
    n(market.fundingRate, 0) > 0.08,
    n(market.openInterestChangePct, 0) > 18,
    market.leveragedLongCrowding === true,
  ]);
  const marketScore = clamp(regime.score == null ? n(market.marketRegimeScore, 55) : regime.score);
  const progress = clamp(55 + Math.min(25, Math.max(-20, pnlPct * 2)) + (tp1 && current >= tp1 ? 10 : 0) + (tp2 && current >= tp2 ? 10 : 0));

  let health = clamp(momentum * 0.20 + book * 0.20 + flow * 0.20 + derivatives * 0.15 + marketScore * 0.15 + progress * 0.10);
  let status = 'HOLD_BUT_WATCH';
  let action = 'Hold but do not add. Tighten monitoring.';
  let mode = 'caution';
  const reasons = [];

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
  if (marketScore < 25) {
    status = health <= 20 ? 'EMERGENCY_EXIT' : 'RISK_OFF_EXIT';
    action = 'Close or heavily reduce. Market regime disaster.';
    health = Math.min(health, 30);
    mode = 'exit';
    reasons.push('market regime disaster');
  }
  if ((book < 20 && n(market.spreadPct, 0) > 0.18) || market.orderBookCollapse === true) {
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
    if (tpReached && (flow < 50 || book < 50)) {
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

  const nextTp = [tp1, tp2, tp3].find((tp) => tp > current);
  const nextDecisionLevel = status === 'EMERGENCY_EXIT' || status === 'EXIT_ALL'
    ? 'immediate close'
    : stop && Math.abs(distanceToStopPct) < Math.abs(tpDistances.find((x) => x != null) ?? 999)
      ? `stop ${stop}`
      : nextTp ? `TP ${nextTp}` : 'trail structure / next candle';

  if (!reasons.length) {
    reasons.push(`momentum ${round(momentum, 0)}, book ${round(book, 0)}, flow ${round(flow, 0)}, market ${round(marketScore, 0)}`);
  }

  return {
    symbol: String(trade.symbol || '').toUpperCase(),
    status,
    action,
    mode,
    tradeHealthScore: round(health, 0),
    pnlPct: round(pnlPct, 2),
    pnlUsd: round(pnlUsd, 2),
    realizedPnl: round(realizedPnl, 2),
    totalPnl: round(pnlUsd + realizedPnl, 2),
    positionValue: round(value, 2),
    distanceToStopPct: round(distanceToStopPct, 2),
    distanceToTpPct: tpDistances.map((x) => round(x, 2)),
    timeInTradeMs: ageMs,
    nextDecisionLevel,
    scores: {
      momentum: round(momentum, 0),
      orderBook: round(book, 0),
      flow: round(flow, 0),
      derivatives: round(derivatives, 0),
      market: round(marketScore, 0),
      progress: round(progress, 0),
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
    biggestRisk: rows.slice().sort((a, b) => a.tradeHealthScore - b.tradeHealthScore)[0]?.symbol || '--',
    biggestWinner: rows.slice().sort((a, b) => b.pnlUsd - a.pnlUsd)[0]?.symbol || '--',
  };
}
