// trading-radar.mjs - read-only mean-reversion advisory engine.
//
// SAFETY CONTRACT:
//   - no orders
//   - no execution intents
//   - no live/paper gate changes
// It consumes public market snapshots plus optional microstructure/position context
// and returns advisory candidates and exit guidance only.

import { buildSafetyDiagnostics, evaluateKnownSafety, classifyMarketSafety } from '../safety/chain-safety.mjs';
import { matchCoinGeckoTrendingToMarketSymbol } from '../market/coingecko-highlights.mjs';
const WEIRD_BASE_RE = /(UP|DOWN|BULL|BEAR)$|\d+(L|S)$/;
const QUOTES = new Set(['USDC', 'USDT']);

export const RADAR_STAGES = Object.freeze({
  NO_SETUP: 'NO_SETUP',
  IGNORE: 'IGNORE',
  WATCH: 'WATCH',
  DISLOCATION_CONFIRMED: 'DISLOCATION_CONFIRMED',
  LONG_FLUSH_CONFIRMED: 'LONG_FLUSH_CONFIRMED',
  STABILIZATION: 'STABILIZATION',
  STABILIZING: 'STABILIZING',
  RECLAIM_DETECTED: 'RECLAIM_DETECTED',
  SQUEEZE_CONFIRMED: 'SQUEEZE_CONFIRMED',
  ENTRY_READY: 'ENTRY_READY',
  EARLY_ENTRY_READY: 'EARLY_ENTRY_READY',
  STANDARD_ENTRY_READY: 'STANDARD_ENTRY_READY',
  AGGRESSIVE_ENTRY_READY: 'AGGRESSIVE_ENTRY_READY',
  WAIT_FOR_PULLBACK: 'WAIT_FOR_PULLBACK',
  WAIT_FOR_RECLAIM: 'WAIT_FOR_RECLAIM',
  EXTENDED_ENTRY: 'EXTENDED_ENTRY',
  CHASE_RISK: 'CHASE_RISK',
  RISK_OFF_BLOCKED: 'RISK_OFF_BLOCKED',
  INVALIDATED: 'INVALIDATED',
});

export const RADAR_ENTRY_TYPES = Object.freeze({
  NONE: null,
  RECLAIM_RETEST: 'RECLAIM_RETEST',
  ABSORPTION: 'ABSORPTION',
  EARLY_REVERSAL_ENTRY: 'EARLY_REVERSAL_ENTRY',
  STANDARD_ENTRY: 'STANDARD_ENTRY',
  AGGRESSIVE_ENTRY: 'AGGRESSIVE_ENTRY',
  EXTENDED_ENTRY: 'EXTENDED_ENTRY',
  CHASE_RISK: 'CHASE_RISK',
});

export const RADAR_EXIT_MODES = Object.freeze({
  EXHAUSTION_MODE: 'EXHAUSTION_MODE',
  NORMAL_MEAN_REVERSION_MODE: 'NORMAL_MEAN_REVERSION_MODE',
  EXPANSION_MODE: 'EXPANSION_MODE',
});

const DEFAULT_FILTERS = Object.freeze({
  minQuoteVolume24h: 10_000_000,
  maxSpreadPct: 0.15,
  minDepthUsd: 100_000,
});

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

function pctDistance(from, to) {
  const a = n(from);
  const b = n(to);
  if (!(a > 0) || !(b > 0)) return null;
  return ((b - a) / a) * 100;
}

function quoteAssetOf(m) {
  if (m && m.quoteAsset) return String(m.quoteAsset).toUpperCase();
  const s = String((m && m.symbol) || '').toUpperCase();
  for (const q of QUOTES) if (s.endsWith(q)) return q;
  return '';
}

function baseAssetOf(m) {
  if (m && m.baseAsset) return String(m.baseAsset).toUpperCase();
  const s = String((m && m.symbol) || '').toUpperCase();
  const q = quoteAssetOf(m);
  return q && s.endsWith(q) ? s.slice(0, -q.length) : s;
}

function midPrice(m) {
  const bid = n(m && m.bidPrice);
  const ask = n(m && m.askPrice);
  const last = n(m && (m.lastPrice ?? m.price ?? m.currentPrice));
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  return last > 0 ? last : null;
}

function pctToRatio(pct) {
  const v = Math.max(0.001, Math.abs(Number(pct) || 0));
  return v / 100;
}

function compactReasons(list, max = 6) {
  return Array.from(new Set((list || []).filter(Boolean).map((r) => String(r).slice(0, 180)))).slice(0, max);
}

export function defaultTradingRadarState(nowIso = null) {
  return {
    updatedAt: nowIso,
    source: 'uninitialized',
    dataFreshnessMs: null,
    status: 'SCANNING',
    universeDiagnostics: {
      fetched: 0,
      liquid: 0,
      spreadOk: 0,
      depthOk: 0,
      rejected: {},
      rejectedSamples: [],
      scannerRowsAvailable: 0,
      scannerRowsSent: 0,
      scannerRowsReceived: 0,
      scannerRowsSanitized: 0,
      scannerRowsRejected: 0,
      radarRowsEvaluated: 0,
      radarRowsDisplayed: 0,
      rejectedByReason: {},
      topRejectedSamples: [],
      fieldMappingDetected: [],
      safetyRowsChecked: 0,
      safetyRowsUnknown: 0,
      safetyRowsCaution: 0,
      safetyRowsDanger: 0,
      chainApiAvailable: false,
      lastSafetyCheckAt: null,
      topSafetyRisks: [],
    },
    marketRegime: {
      status: 'UNKNOWN',
      score: 50,
      blocksMeanReversion: false,
      reasons: ['no market data yet'],
      breadthPct: null,
      btc: null,
      eth: null,
    },
    pipeline: {
      NO_SETUP: 0,
      WATCH: 0,
      LONG_FLUSH_CONFIRMED: 0,
      STABILIZING: 0,
      SQUEEZE_CONFIRMED: 0,
      ENTRY_READY: 0,
    },
    candidates: [],
    watchlist: [],
    entryReady: [],
    selected: null,
    exitGuidance: null,
    telegramAlertState: {
      mode: 'ENTRY_READY_ONLY',
      cooldownMs: 60 * 60 * 1000,
      sent: {},
      lastSentAt: null,
      lastError: null,
      sentCount: 0,
      legacyBlockedCount: 0,
      lastLegacyBlockedAt: null,
      lastRadarSkippedReason: null,
      lastRadarSentAt: null,
    },
    missingSignals: [],
    dataCompleteness: 0,
    lastError: null,
  };
}

function rejectCount(diag, reason, symbol) {
  diag.rejected[reason] = (diag.rejected[reason] || 0) + 1;
  if (diag.rejectedSamples.length < 30) diag.rejectedSamples.push({ symbol, reason });
}

export function buildRadarUniverse(markets = [], opts = {}) {
  const filters = { ...DEFAULT_FILTERS, ...(opts.filters || {}) };
  const diag = { fetched: markets.length, liquid: 0, spreadOk: 0, depthOk: 0, rejected: {}, rejectedSamples: [] };
  const missing = new Set();
  const universe = [];

  for (const raw of markets || []) {
    const symbol = String((raw && raw.symbol) || '').toUpperCase();
    if (!symbol) { rejectCount(diag, 'missing symbol', ''); continue; }
    const quote = quoteAssetOf(raw);
    const base = baseAssetOf(raw);
    if (!QUOTES.has(quote)) { rejectCount(diag, 'non stable quote', symbol); continue; }
    if (WEIRD_BASE_RE.test(base) || raw.leveraged === true || raw.isLeveraged === true) {
      rejectCount(diag, 'weird/leverage token', symbol);
      continue;
    }
    if (raw.delisted === true || raw.exploitRisk === true || raw.unlockRisk === true || raw.newsRisk === 'high') {
      rejectCount(diag, 'event/delist risk', symbol);
      continue;
    }
    if (raw.status && String(raw.status).toUpperCase() !== 'TRADING') {
      rejectCount(diag, 'not trading', symbol);
      continue;
    }

    const hasScanner = raw.isScannerContext === true || raw.scannerScore != null || raw.scannerPanic != null || raw.scannerHot != null;

    const quoteVolume = n(raw.quoteVolume24h ?? raw.volume24hUsd ?? raw.quoteVolume);
    if (!(quoteVolume >= filters.minQuoteVolume24h) && !hasScanner) {
      rejectCount(diag, 'low 24h volume', symbol);
      continue;
    }
    diag.liquid++;

    const spreadPct = n(raw.spreadPct);
    if (spreadPct == null) missing.add('spreadPct');
    if (spreadPct != null && spreadPct > filters.maxSpreadPct && !hasScanner) {
      rejectCount(diag, 'wide spread', symbol);
      continue;
    }
    diag.spreadOk++;

    const depthUsd = n(raw.depthUsdWithin1Pct ?? raw.depthUsdWithin0_5Pct ?? raw.orderBookDepthUsd);
    if (depthUsd == null) {
      missing.add('orderBookDepthWithin1Pct');
    } else if (depthUsd < filters.minDepthUsd && !hasScanner) {
      rejectCount(diag, 'thin order book depth', symbol);
      continue;
    } else {
      diag.depthOk++;
    }

    const mid = midPrice(raw);
    if (mid == null) missing.add('midPrice');
    universe.push({
      ...raw,
      symbol,
      baseAsset: base,
      quoteAsset: quote,
      quoteVolume,
      spreadPct,
      mid,
      depthUsd,
    });
  }

  return { universe, diagnostics: diag, missingSignals: Array.from(missing).sort() };
}

export function evaluateMarketRegime(markets = []) {
  const btc = (markets || []).find((m) => /^BTC(USDC|USDT)$/.test(String(m.symbol || '').toUpperCase())) || null;
  const eth = (markets || []).find((m) => /^ETH(USDC|USDT)$/.test(String(m.symbol || '').toUpperCase())) || null;
  const changes = (markets || []).map((m) => n(m.change24hPct ?? m.priceChangePercent)).filter((v) => v != null);
  const breadthPct = changes.length ? (changes.filter((v) => v > 0).length / changes.length) * 100 : null;
  const btcChange = btc ? n(btc.change24hPct ?? btc.priceChangePercent, 0) : null;
  const ethChange = eth ? n(eth.change24hPct ?? eth.priceChangePercent, 0) : null;
  const reasons = [];
  let score = 70;

  if (btcChange == null) { score -= 12; reasons.push('BTC structure unavailable'); }
  else if (btcChange <= -4) { score -= 30; reasons.push('BTC active breakdown'); }
  else if (btcChange <= -2) { score -= 14; reasons.push('BTC weak'); }
  else reasons.push('BTC not in active breakdown');

  if (ethChange == null) { score -= 8; reasons.push('ETH structure unavailable'); }
  else if (ethChange <= -5) { score -= 22; reasons.push('ETH active breakdown'); }
  else if (ethChange <= -2.5) { score -= 10; reasons.push('ETH weak'); }

  if (breadthPct == null) { score -= 8; reasons.push('market breadth unavailable'); }
  else if (breadthPct < 25) { score -= 22; reasons.push('breadth collapse'); }
  else if (breadthPct < 40) { score -= 10; reasons.push('weak breadth'); }
  else reasons.push('breadth supportive enough');

  let hardBlockReason = null;
  if (btcChange <= -4) hardBlockReason = 'BTC active breakdown';
  else if (ethChange <= -5) hardBlockReason = 'ETH active breakdown';
  else if (breadthPct != null && breadthPct < 25) hardBlockReason = 'breadth collapse';

  const blocks = score < 45 || hardBlockReason != null;
  return {
    status: blocks ? 'RISK_OFF_BREAKDOWN' : (score >= 70 ? 'SUPPORTIVE' : 'MIXED'),
    score: round(clamp(score), 0),
    blocksMeanReversion: blocks,
    reasons: compactReasons(reasons, 5),
    diagnostics: {
      btcChange: btcChange == null ? null : round(btcChange, 2),
      ethChange: ethChange == null ? null : round(ethChange, 2),
      breadthPct: breadthPct == null ? null : round(breadthPct, 1),
      reasons: reasons,
      hardBlockThreshold: 45,
      hardBlockReason
    },
    breadthPct: breadthPct == null ? null : round(breadthPct, 1),
    btc: btc ? { symbol: btc.symbol, change24hPct: round(btcChange, 2) } : null,
    eth: eth ? { symbol: eth.symbol, change24hPct: round(ethChange, 2) } : null,
  };
}

function signalBooleans(m, regime) {
  const c24 = n(m.change24hPct ?? m.priceChangePercent ?? m.diagnostics?.change24hPct, 0);
  const c12 = n(m.change12hPct ?? m.diagnostics?.change12hPct);
  const c4 = n(m.change4hPct ?? m.diagnostics?.change4hPct);
  const c1 = n(m.change1hPct ?? m.diagnostics?.change1hPct);
  const btcRel = n(m.btcRelativeChangePct ?? m.relativeToBtcPct);
  const atrPct = n(m.atrPct ?? m.realizedVolatilityPct);
  const volumeSpike = n(m.volumeSpike, Math.abs(c24) >= 6 ? 1.6 : 1);
  const oiChange = n(m.openInterestChangePct);
  const funding = n(m.fundingRate);
  const wickRecovery = n(m.wickRecoveryPct);
  const sellRatio = n(m.marketSellRatio);
  const bidRebuild = n(m.bidDepthRebuildPct ?? m.bidDepthChangePct);
  const shortLiq = n(m.shortLiquidationSpike);
  const longLiq = n(m.longLiquidationSpike ?? m.longLiquidationUsd);
  const buyDominance = n(m.marketBuyVolumeDominance ?? m.buyVolumeDominance);
  const retestHeld = m.retestHeld === true;
  const absorptionScore = n(m.absorptionScore);
  const reclaim = m.reclaimConfirmed === true || m.vwapReclaimed === true || m.rangeHighReclaimed === true;
  const higherLow = m.higherLowHeld === true;
  const noNewLows = m.noNewLows === true || n(m.noNewLowMinutes, 0) >= 20;
  const rangeFormed = m.rangeFormed === true || n(m.localRangeMinutes, 0) >= 20;
  const tightSpread = m.spreadPct == null || n(m.spreadPct, 999) <= 0.08;
  const supportRetest = m.supportRetested === true
    || m.liquidationLowRetested === true
    || (n(m.distanceToSupportPct) != null && n(m.distanceToSupportPct) <= 0.75);
  const deltaImproves = m.deltaImproves === true
    || n(m.deltaImprovementPct, 0) > 0
    || buyDominance >= 0.55;

  const dropVsVol = atrPct != null ? Math.abs(c24) / Math.max(atrPct, 0.1) : null;
  const isScannerFlush = Array.isArray(m.scannerTags) && (m.scannerTags.includes('FLUSH') || m.scannerTags.includes('CAPITULATION'));
  const isScannerBuy = Array.isArray(m.scannerTags) && (m.scannerTags.includes('BUY') || m.scannerTags.includes('STRONG BUY') || m.scannerTags.includes('RECLAIM'));
  const scannerSignal = String(m.scannerSignal || '').toUpperCase();
  const isScannerReclaim = scannerSignal.includes('RECLAIM') || (Array.isArray(m.scannerTags) && m.scannerTags.includes('RECLAIM'));

  const watchDrop = c24 <= -4 || c12 <= -3.5 || c4 <= -2.5 || btcRel <= -3 || dropVsVol >= 1.8 || isScannerFlush || (m.scannerPanic > 50);
  const panicFlush = (longLiq != null && longLiq >= 1.5) || (sellRatio != null && sellRatio >= 0.62) || (volumeSpike >= 1.8 && c24 <= -6) || isScannerFlush;
  const oiFlush = oiChange != null && oiChange <= -4;
  const fundingOk = funding == null || funding <= 0.03;
  const wickOk = wickRecovery == null ? c24 <= -7 : wickRecovery >= 35;
  const bidsOk = bidRebuild != null && bidRebuild >= 8;
  const sellFade = m.sellAggressionFading === true || (sellRatio != null && sellRatio <= 0.56);
  const lateShorts = m.lateShortsAppearing === true || (oiChange != null && oiChange >= 0 && fundingOk);
  const squeeze = reclaim && (shortLiq >= 1.2 || buyDominance >= 0.56 || higherLow);
  const retestEntry = reclaim && retestHeld && (m.vwapHeld !== false) && (bidsOk || tightSpread) && !regime.blocksMeanReversion;
  const absorptionConfirmed = absorptionScore >= 70
    && supportRetest
    && (m.aggressiveSellsFailed === true || sellFade)
    && (m.bidAbsorption === true || bidsOk || absorptionScore >= 80)
    && deltaImproves
    && tightSpread;
  const absorptionEntry = absorptionConfirmed && !regime.blocksMeanReversion;

  return {
    c24, c12, c4, c1, btcRel, atrPct, volumeSpike, oiChange, funding,
    watchDrop, panicFlush, oiFlush, fundingOk, wickOk, bidsOk, sellFade,
    noNewLows, rangeFormed, lateShorts, squeeze, reclaim, higherLow,
    retestEntry, absorptionEntry, absorptionScore, buyDominance, shortLiq, longLiq,
    tightSpread, supportRetest, deltaImproves, absorptionConfirmed,
    isScannerFlush, isScannerBuy, isScannerReclaim
  };
}

export function classifyRadarStage(market, regime = evaluateMarketRegime([])) {
  const s = signalBooleans(market, regime);
  const reasons = [];
  const riskFlags = [];
  let stage = RADAR_STAGES.NO_SETUP;

  const cl = {
    relativeDump: { status: 'WAIT', reason: 'requires relative dump or panic', value: s.c24 },
    longFlush: { status: 'WAIT', reason: 'requires flush confirmation', value: s.volumeSpike },
    stabilization: { status: 'WAIT', reason: 'requires new lows paused', value: s.c1 },
    absorption: { status: 'WAIT', reason: 'requires aggressive sell absorption', value: s.absorptionScore },
    squeezeOrReclaim: { status: 'WAIT', reason: 'requires structural reclaim', value: s.squeeze },
    marketRegime: { status: regime.blocksMeanReversion ? 'FAIL' : 'PASS', reason: regime.blocksMeanReversion ? 'regime breakdown' : 'supportive', value: regime.score },
    entryVariant: { status: 'WAIT', type: 'NONE', reason: 'waiting for entry trigger' },
    invalidation: { status: 'WAIT', level: null, reason: 'waiting for support level' }
  };

  const isScannerWatch = (market.scannerScore >= 7 || (market.scannerHot && market.scannerHot >= 70) || market.scannerPanic > 50 || s.isScannerFlush || s.isScannerBuy || s.c12 <= -4 || s.c24 <= -6);
  if ((s.watchDrop && s.volumeSpike >= 1.2) || isScannerWatch) {
    stage = RADAR_STAGES.WATCH;
    cl.relativeDump.status = 'PASS';
    cl.relativeDump.reason = isScannerWatch ? `scanner context (score ${market.scannerScore || 0})` : `relative drop (${round(s.c24, 1)}%, vol x${round(s.volumeSpike, 1)})`;
    reasons.push(cl.relativeDump.reason);
  }

  const isScannerLongFlush = s.isScannerFlush || ((s.c12 <= -4 || s.c24 <= -6) && (market.scannerPanic > 50 || market.scannerHot > 70 || s.volumeSpike >= 1.2));
  if (stage === RADAR_STAGES.WATCH && ((s.panicFlush && s.fundingOk && s.wickOk && (s.oiFlush || s.bidsOk || s.c24 <= -8 || s.isScannerBuy)) || isScannerLongFlush)) {
    stage = RADAR_STAGES.LONG_FLUSH_CONFIRMED;
    cl.longFlush.status = 'PASS';
    cl.longFlush.reason = isScannerLongFlush ? 'scanner FLUSH tag or heavy drawdown' : 'panic selling with funding reset';
    reasons.push(cl.longFlush.reason);
  }

  const isScannerStabilizing = ((s.c1 > 0 || s.c4 > 0) && (s.c12 < -2 || s.c24 < -2)) || s.isScannerBuy;
  if (stage === RADAR_STAGES.LONG_FLUSH_CONFIRMED && ((s.noNewLows && s.rangeFormed && (s.sellFade || s.bidsOk || s.lateShorts)) || isScannerStabilizing)) {
    stage = RADAR_STAGES.STABILIZING;
    cl.stabilization.status = 'PASS';
    cl.stabilization.reason = isScannerStabilizing ? 'short-term improvement after dump' : 'range formed, no new lows';
    reasons.push(cl.stabilization.reason);
  }

  // Variant B: Absorption Path Logic
  let absorptionProxies = 0;
  if (s.c12 <= -4 && s.c1 > 0) absorptionProxies++; // aggressive sells fail proxy
  if (s.tightSpread && s.isScannerBuy) absorptionProxies++; // bid absorption proxy
  if (s.c4 > 0 && market.scannerScore >= 5) absorptionProxies++; // delta improves proxy

  const realAbsorptionData = market.absorptionScore != null || market.bidDepthRebuildPct != null || market.bidAbsorption != null || market.aggressiveSellsFailed != null;
  const strongAbsorptionProxy = absorptionProxies >= 3 && market.scannerScore >= 8 && s.c1 > 0.5 && s.c4 > 0;
  const isAbsorption = s.absorptionConfirmed || (absorptionProxies >= 2 && realAbsorptionData) || strongAbsorptionProxy;
  
  if (stage === RADAR_STAGES.STABILIZING) {
    if (realAbsorptionData) {
      if (isAbsorption) {
        cl.absorption.status = 'PASS';
        cl.absorption.reason = 'aggressive sells absorbed at support';
      } else {
        cl.absorption.status = 'WAIT';
        cl.absorption.reason = 'awaiting absorption confirmation';
      }
    } else {
      cl.absorption.status = strongAbsorptionProxy ? 'PASS' : 'MISSING DATA';
      cl.absorption.reason = strongAbsorptionProxy ? 'strong scanner recovery proxies, no order book data' : 'lacking order book / delta data';
    }
  }

  const hasRecovery = (s.c1 > 1.5 || s.c4 > 2);
  const hasDrawdown = (s.c12 < -3 || s.c24 < -4);
  const isSqueeze = (s.squeeze || (s.isScannerReclaim && hasRecovery && hasDrawdown && market.scannerScore >= 7)) && !regime.blocksMeanReversion;

  if (stage === RADAR_STAGES.STABILIZING && (isSqueeze || cl.absorption.status === 'PASS')) {
    stage = RADAR_STAGES.SQUEEZE_CONFIRMED;
    if (isSqueeze) {
      cl.squeezeOrReclaim.status = 'PASS';
      cl.squeezeOrReclaim.reason = 'reclaim and squeeze confirmed';
    } else {
      cl.squeezeOrReclaim.status = 'WAIT';
      cl.squeezeOrReclaim.reason = 'absorption passed, awaiting reclaim';
    }
    reasons.push('setup structural confirmation');
  }

  const passCount = Object.values(cl).filter((x) => x && x.status === 'PASS').length;
  const missingCriticalCount = Object.values(cl).filter((x) => x && x.status === 'MISSING DATA').length + missingForMarket(market).length;
  const scannerSignalStrength = clamp(
    (market.scannerScore != null ? Number(market.scannerScore) * 5 : 0)
      + (market.scannerPanic != null ? Number(market.scannerPanic) * 0.25 : 0)
      + (market.scannerHot != null ? Number(market.scannerHot) * 0.12 : 0),
    0,
    100
  );
  const dumpMagnitude = clamp(Math.max(Math.abs(s.c24 || 0), Math.abs(s.c12 || 0) * 1.25, Math.abs(s.c4 || 0) * 2), 0, 40);
  const recoverySpeed = clamp((s.c1 > 0 ? s.c1 * 4 : 0) + (s.c4 > 0 ? s.c4 * 1.8 : 0), 0, 20);
  const spreadQuality = market.spreadPct == null ? 1.5 : clamp(6 - Number(market.spreadPct) * 30, -8, 6);
  const liquidityQuality = market.quoteVolume ? clamp(Math.log10(Math.max(1, market.quoteVolume)) - 6, -4, 5) : -3;
  const precisionMod = round(spreadQuality + liquidityQuality + (scannerSignalStrength - 35) * 0.06 + dumpMagnitude * 0.08 + recoverySpeed * 0.12 - missingCriticalCount * 1.5, 2);

  // Confidence Calculation
  let confidence = clamp(35 + (stage === RADAR_STAGES.NO_SETUP ? 0 : 10)
    + (market.depthUsd != null ? 8 : 0)
    + (s.oiChange != null ? 6 : 0)
    + (s.funding != null ? 6 : 0)
    + (s.shortLiq != null || s.longLiq != null ? 6 : 0)
    + (s.tightSpread ? 5 : 0)
    + (market.scannerScore != null ? clamp((market.scannerScore - 5) * 3, 0, 15) : 0)
    + (s.isScannerBuy ? 8 : (s.isScannerFlush ? 5 : 0))
    + passCount * 1.7
    - (regime.blocksMeanReversion ? 15 : 0)
    - (!realAbsorptionData ? 10 : 0)
    - missingCriticalCount * 0.9
    + precisionMod);

  let entryType = RADAR_ENTRY_TYPES.NONE;
  if (stage === RADAR_STAGES.SQUEEZE_CONFIRMED) {
    if (cl.absorption.status === 'PASS') {
      entryType = RADAR_ENTRY_TYPES.ABSORPTION;
      cl.entryVariant.status = 'PASS';
      cl.entryVariant.type = 'ABSORPTION_ENTRY';
      cl.entryVariant.reason = 'absorption sequence validated';
      reasons.push('support/liquidation low absorbed aggressive sells');
    } else if (s.retestEntry) {
      entryType = RADAR_ENTRY_TYPES.RECLAIM_RETEST;
      cl.entryVariant.status = 'PASS';
      cl.entryVariant.type = 'RECLAIM_RETEST';
      cl.entryVariant.reason = 'reclaim retest held';
    }
  }

  // Hard Gate
  if (entryType !== RADAR_ENTRY_TYPES.NONE && cl.marketRegime.status === 'PASS' && confidence >= 75) {
    stage = RADAR_STAGES.ENTRY_READY;
  }

  if (regime.blocksMeanReversion) riskFlags.push('market regime blocks mean reversion');
  if (s.funding != null && s.funding > 0.08) riskFlags.push('funding toxic/long crowded');
  if (s.oiChange != null && s.oiChange > 12) riskFlags.push('OI expansion may be leveraged crowding');
  if (!s.tightSpread) riskFlags.push('spread above ideal');
  if (stage === RADAR_STAGES.WATCH) riskFlags.push('falling knife risk until stabilization confirms');

  // Adjust confidence based on final stage
  confidence = clamp(confidence + (stage === RADAR_STAGES.ENTRY_READY ? 15 : (stage === RADAR_STAGES.SQUEEZE_CONFIRMED ? 8 : 0)));

  const baseScore = {
    [RADAR_STAGES.NO_SETUP]: 0,
    [RADAR_STAGES.WATCH]: 38,
    [RADAR_STAGES.LONG_FLUSH_CONFIRMED]: 55,
    [RADAR_STAGES.STABILIZING]: 66,
    [RADAR_STAGES.SQUEEZE_CONFIRMED]: 76,
    [RADAR_STAGES.ENTRY_READY]: 84,
  }[stage];
  
  const setupQualityScore = clamp(baseScore
    + Math.min(8, Math.max(0, (s.volumeSpike - 1.2) * 4))
    + (s.bidsOk ? 5 : 0)
    + (s.buyDominance >= 0.58 ? 5 : 0)
    + passCount * 1.8
    + scannerSignalStrength * 0.08
    + dumpMagnitude * 0.12
    + recoverySpeed * 0.15
    - (regime.blocksMeanReversion ? 25 : 0)
    - (riskFlags.length * 3)
    - missingCriticalCount * 1.1
    + precisionMod * 1.5);

  let actionability = 'WATCH_ONLY';
  if (stage === RADAR_STAGES.LONG_FLUSH_CONFIRMED) actionability = 'NEEDS_STABILIZATION';
  if (stage === RADAR_STAGES.STABILIZING) actionability = cl.absorption.status === 'WAIT' ? 'NEEDS_ABSORPTION' : 'NEEDS_CONFIRMATION';
  if (stage === RADAR_STAGES.SQUEEZE_CONFIRMED) actionability = 'NEAR_ENTRY';
  if (stage === RADAR_STAGES.ENTRY_READY) actionability = 'ENTRY_READY';
  if (regime.blocksMeanReversion && stage !== RADAR_STAGES.NO_SETUP) actionability = 'INVALIDATED';

  let nextRequiredConfirmation = null;
  if (actionability === 'WATCH_ONLY') nextRequiredConfirmation = 'needs long flush confirmation';
  if (actionability === 'NEEDS_STABILIZATION') nextRequiredConfirmation = 'needs no-new-low for next 15m candle';
  if (actionability === 'NEEDS_ABSORPTION') nextRequiredConfirmation = 'needs absorption: sellers fail to break liquidation low';
  if (actionability === 'NEEDS_CONFIRMATION') nextRequiredConfirmation = 'needs structural reclaim or squeeze confirmation';
  if (actionability === 'NEAR_ENTRY') nextRequiredConfirmation = confidence < 75 ? 'needs confidence >= 75 via strict data' : 'needs clear invalidation level / hold above entry zone';
  if (actionability === 'INVALIDATED') nextRequiredConfirmation = 'needs BTC/ETH regime stay supportive';

  // Distance to entry ready score (0-100)
  let distanceToEntryReadyScore = clamp(
    baseScore + 
    passCount * 3.2 +
    scannerSignalStrength * 0.10 +
    dumpMagnitude * 0.18 +
    recoverySpeed * 0.35 +
    (actionability === 'NEAR_ENTRY' ? 15 : 0) +
    (cl.absorption.status === 'PASS' ? 5 : 0) +
    (s.c1 > 0 ? 3 : 0) -
    (regime.blocksMeanReversion ? 40 : 0) +
    (market.spreadPct != null && market.spreadPct > 0.15 ? -8 : 0) -
    missingCriticalCount * 1.4 +
    (precisionMod * 0.8)
  );
  // distanceToEntryReadyScore is capped strictly below 100 here. The reserved
  // 100 value is assigned later in evaluateTradingRadar ONLY when the V1/spec
  // ENTRY_READY gate (buildRadarV1Output) actually passes — never from this
  // heuristic stage machine. This keeps "100 == real ENTRY_READY" single-sourced.
  distanceToEntryReadyScore = Math.min(distanceToEntryReadyScore, 97);

  let blockedBy = null;
  if (actionability !== 'ENTRY_READY') {
    if (regime.blocksMeanReversion) blockedBy = 'regime breakdown';
    else if (cl.relativeDump.status === 'WAIT') blockedBy = cl.relativeDump.reason;
    else if (cl.longFlush.status === 'WAIT') blockedBy = cl.longFlush.reason;
    else if (cl.stabilization.status === 'WAIT') blockedBy = cl.stabilization.reason;
    else if (cl.absorption.status === 'WAIT') blockedBy = cl.absorption.reason;
    else if (cl.squeezeOrReclaim.status === 'WAIT') blockedBy = cl.squeezeOrReclaim.reason;
    else if (confidence < 75) blockedBy = 'confidence < 75';
    else blockedBy = 'waiting for entry trigger';
  }

  return {
    stage,
    actionability,
    distanceToEntryReadyScore: round(distanceToEntryReadyScore, 0),
    setupQualityScore: round(setupQualityScore, 0),
    confidence: round(confidence, 0),
    entryType,
    nextRequiredConfirmation,
    blockedBy,
    reasons: compactReasons(reasons.length ? reasons : ['no flush/stabilization sequence confirmed'], 8),
    riskFlags: compactReasons(riskFlags, 8),
    conditionChecklist: cl,
    _signals: s,
  };
}

export function buildPriceLevels(market, stageInfo = {}) {
  const px = market.mid || midPrice(market) || n(market.lastPrice ?? market.price);
  if (!(px > 0)) return { entryZone: null, invalidationLevel: null, suggestedStop: null };
  const atr = pctToRatio(market.atrPct ?? market.realizedVolatilityPct ?? Math.max(2, Math.abs(n(market.change24hPct ?? market.priceChangePercent, 0)) / 2));
  const low = n(market.flushLow ?? market.liquidationLow ?? market.localLow);
  const reclaim = n(market.reclaimLevel ?? market.vwap ?? market.anchoredVwap ?? market.rangeHigh ?? market.breakdownLevel);
  const higherLow = n(market.higherLow ?? market.higherLowLevel ?? market.retestLow);
  const rangeLow = n(market.rangeLow);
  const support = low || reclaim || px * (1 - atr * 0.6);
  const entryType = stageInfo.entryType;
  const center = entryType === RADAR_ENTRY_TYPES.ABSORPTION ? support : (higherLow || reclaim || px);
  const halfBand = Math.max(atr * 0.18, 0.0025);
  const stopBuffer = Math.max(atr * 0.35, 0.006);
  const structuralStopBase = higherLow || reclaim || rangeLow || support;
  const stop = structuralStopBase * (1 - stopBuffer);
  const supply1 = n(market.nearestSupply ?? market.localHigh ?? market.priorBounceHigh ?? market.rangeHigh);
  const supply2 = n(market.nextSupply ?? market.breakdownLevel ?? market.maResistance);
  const supply3 = n(market.meanReversionTarget ?? market.majorSupply ?? market.previousSupport);
  return {
    entryZone: { low: round(center * (1 - halfBand), 8), high: round(center * (1 + halfBand), 8) },
    invalidationLevel: round((low || structuralStopBase) * (1 - stopBuffer * 1.45), 8),
    suggestedStop: round(stop, 8),
    stopReference: higherLow ? 'higher low + ATR buffer'
      : reclaim ? 'reclaim/VWAP structure + ATR buffer'
      : low ? 'panic/liquidation low + ATR buffer'
      : 'range support + ATR buffer',
    takeProfitCheckpoints: [
      { label: 'TP1', pct: 6, level: round(Math.max(px * 1.055, supply1 || 0), 8), basis: supply1 ? 'nearest supply/local high' : '+5.5% default' },
      { label: 'TP2', pct: 11, level: round(Math.max(px * 1.105, supply2 || 0), 8), basis: supply2 ? 'next supply/breakdown level' : '+10.5% default' },
      { label: 'TP3', pct: 16, level: round(Math.max(px * 1.16, supply3 || 0), 8), basis: supply3 ? 'mean reversion target' : '+16% default' },
    ],
  };
}

function radarScorePack(market, regime, stageInfo, levels, safety) {
  const s = stageInfo._signals || signalBooleans(market, regime);
  const missing = missingForMarket(market);
  const missingPenalty = Math.min(22, missing.length * 3);
  const px = market.mid || midPrice(market) || n(market.lastPrice ?? market.price);
  const stopDistance = pctDistance(px, levels.suggestedStop);
  const tp1Distance = levels.takeProfitCheckpoints && levels.takeProfitCheckpoints[0] ? pctDistance(px, levels.takeProfitCheckpoints[0].level) : null;
  const riskPct = stopDistance == null ? null : Math.abs(stopDistance);
  const rr = riskPct > 0 && tp1Distance != null ? tp1Distance / riskPct : null;

  const dislocation = clamp(
    Math.max(Math.abs(s.c24 || 0), Math.abs(s.c12 || 0) * 1.25, Math.abs(s.c4 || 0) * 2) * 4
    + (s.volumeSpike >= 1.8 ? 18 : s.volumeSpike >= 1.2 ? 8 : 0)
    + (s.btcRel <= -3 ? 12 : 0)
    + (s.longLiq != null ? 8 : 0)
  );
  const flush = clamp(
    (s.panicFlush ? 36 : 0)
    + (s.oiFlush ? 18 : 0)
    + (s.longLiq >= 1.5 ? 14 : 0)
    + (s.fundingOk ? 10 : -15)
    + (s.wickOk ? 12 : 0)
    + (s.bidsOk ? 10 : 0)
  );
  const stabilization = clamp(
    (s.noNewLows ? 22 : 0)
    + (s.rangeFormed ? 18 : 0)
    + (s.sellFade ? 14 : 0)
    + (s.bidsOk ? 16 : 0)
    + (s.c1 > 0 ? 10 : 0)
    + (s.c4 > 0 ? 8 : 0)
    + (s.tightSpread ? 8 : -12)
  );
  const reclaim = clamp(
    (s.reclaim ? 32 : 0)
    + (market.retestHeld === true ? 18 : 0)
    + (s.higherLow ? 18 : 0)
    + (market.vwapHeld === true || market.reclaimHeld === true ? 12 : 0)
    + (s.isScannerReclaim ? 10 : 0)
  );
  const orderBook = clamp(
    45
    + (s.bidsOk ? 18 : 0)
    + (s.tightSpread ? 12 : -18)
    + (n(market.depthUsd, 0) >= 1_000_000 ? 12 : n(market.depthUsd, 0) >= 100_000 ? 5 : -14)
    + (market.bidsVanished === true ? -35 : 0)
    + (market.askWallsReloaded === true ? -18 : 0)
    + (market.askWallsAbsorbed === true ? 10 : 0)
  );
  const flow = clamp(
    42
    + (s.buyDominance >= 0.58 ? 18 : s.buyDominance >= 0.54 ? 8 : 0)
    + (s.deltaImproves ? 14 : 0)
    + (market.sellVolumeFading === true ? 12 : 0)
    + (market.aggressiveSellsFailed === true ? 10 : 0)
    + (market.positiveDeltaNoAdvance === true ? -25 : 0)
    + (market.perpsOnlyMove === true ? -18 : 0)
  );
  // Derivatives risk: high score == low risk. Missing funding/OI/liquidation
  // data must NOT be treated as "safe" — unknown derivatives risk is neutral at
  // best and is penalised, never credited. (Honesty fix: previously missing
  // funding scored the same +6 as a confirmed-healthy funding reset.)
  const fundingPresent = s.funding != null;
  const oiPresent = s.oiChange != null;
  const liqPresent = s.shortLiq != null || s.longLiq != null;
  const derivDataPresent = fundingPresent || oiPresent || liqPresent;
  const deriv = clamp(
    (derivDataPresent ? 72 : 48)
    + (fundingPresent ? (s.funding <= 0.03 ? 6 : -24) : -12)
    + (s.shortLiq >= 1.2 ? 8 : 0)
    + (oiPresent && s.oiChange > 12 ? -26 : 0)
    + (market.leveragedLongCrowding === true ? -28 : 0)
    + (market.perpsOnlyMove === true ? -16 : 0)
  );
  const marketRegime = clamp(regime.score == null ? 50 : regime.score);
  const riskReward = clamp(
    48
    + (rr != null ? Math.min(28, rr * 13) : -8)
    + (riskPct != null && riskPct <= 5 ? 16 : riskPct != null && riskPct <= 9 ? 6 : -14)
    + (tp1Distance != null && tp1Distance >= 5 ? 10 : -10)
    + ((s.c1 > 4 || s.c4 > 8) ? -18 : 0)
    + (market.nearestSupplyDistancePct != null && Number(market.nearestSupplyDistancePct) < 4 ? -16 : 0)
  );
  // Execution confidence must drop when the live microstructure EXECUTION
  // depends on (order book depth/spread + trade flow + derivatives) is missing.
  // Without it we cannot honestly claim a good entry, so execution is explicitly
  // penalised and the gap is surfaced in missingSignals / blocked reasons.
  const execMissing = [];
  if (market.depthUsd == null && market.orderBookDepthUsd == null) execMissing.push('orderBookDepth');
  if (market.spreadPct == null) execMissing.push('spread');
  if (!derivDataPresent) execMissing.push('derivatives');
  if (market.buyVolumeDominance == null && market.marketBuyVolumeDominance == null
      && market.cumulativeDelta == null && market.takerBuySellRatio == null
      && market.deltaImprovementPct == null) execMissing.push('flow');
  const execMissingPenalty = Math.min(12, execMissing.length * 3);

  const setup = clamp(dislocation * 0.20 + flush * 0.20 + stabilization * 0.20 + reclaim * 0.15 + deriv * 0.10 + marketRegime * 0.15);
  const execution = clamp(orderBook * 0.08 + flow * 0.08 + reclaim * 0.32 + stabilization * 0.18 + riskReward * 0.24 + marketRegime * 0.10 - execMissingPenalty);
  // UNKNOWN safety is no longer a near-free pass: an unverifiable token cannot
  // be implicitly trusted, so it carries a real confidence penalty (and blocks
  // Telegram eligibility downstream — only SAFE is alertable).
  const safetyPenalty = safety.safetyStatus === 'DANGER' ? 45 : safety.safetyStatus === 'CAUTION' ? 14 : safety.safetyStatus === 'UNKNOWN' ? 18 : 0;
  const confidence = clamp(setup * 0.40 + execution * 0.35 + marketRegime * 0.15 + (100 - missingPenalty) * 0.10 - safetyPenalty);

  return {
    DISLOCATION_SCORE: round(dislocation, 0),
    FLUSH_SCORE: round(flush, 0),
    STABILIZATION_SCORE: round(stabilization, 0),
    RECLAIM_SCORE: round(reclaim, 0),
    ORDER_BOOK_SUPPORT_SCORE: round(orderBook, 0),
    FLOW_CONFIRMATION_SCORE: round(flow, 0),
    DERIVATIVES_RISK_SCORE: round(deriv, 0),
    MARKET_REGIME_SCORE: round(marketRegime, 0),
    RISK_REWARD_SCORE: round(riskReward, 0),
    SETUP_SCORE: round(setup, 0),
    EXECUTION_SCORE: round(execution, 0),
    FINAL_CONFIDENCE: round(confidence, 0),
    dataMissingPenalty: missingPenalty,
    executionDataMissing: execMissing,
    rr,
    riskPct,
    tp1Distance,
    diagnostics: {
      setupBreakdown: `SETUP: ${round(setup, 0)} = dislocation ${round(dislocation, 0)}×20% + flush ${round(flush, 0)}×20% + stabilization ${round(stabilization, 0)}×20% + reclaim ${round(reclaim, 0)}×15% + derivatives ${round(deriv, 0)}×10% + regime ${round(marketRegime, 0)}×15%`,
      executionBreakdown: `EXECUTION: ${round(execution, 0)} = orderbook ${execMissing.includes('orderBookDepth') || execMissing.includes('spread') ? 'N/A' : round(orderBook, 0)}×8% + flow ${execMissing.includes('flow') ? 'N/A' : round(flow, 0)}×8% + reclaim ${round(reclaim, 0)}×32% + stabilization ${round(stabilization, 0)}×18% + RR ${round(riskReward, 0)}×24% + regime ${round(marketRegime, 0)}×10%${execMissingPenalty ? ` - penalty ${execMissingPenalty}` : ''}`
    }
  };
}

function positionSizeGuidance(status, confidence) {
  const base = {
    EARLY_ENTRY_READY: [25, 40],
    STANDARD_ENTRY_READY: [40, 60],
    AGGRESSIVE_ENTRY_READY: [20, 40],
    EXTENDED_ENTRY: [10, 25],
    CHASE_RISK: [0, 15],
    RISK_OFF_BLOCKED: [0, 0],
    INVALIDATED: [0, 0],
  }[status] || [0, 0];
  if (base[1] === 0) return '0% planned position';
  if (confidence < 55) return '0% planned position - confidence too low';
  if (confidence < 65) return `${base[0]}% planned position`;
  if (confidence < 75) return `${base[0]}-${Math.round((base[0] + base[1]) / 2)}% planned position`;
  return `${base[0]}-${base[1]}% planned position`;
}

function v1BlockedReason(status, scores, dataQuality, regime, hasCriticalRisk) {
  if (status === 'RISK_OFF_BLOCKED') return 'market regime blocks long mean reversion';
  if (status === 'INVALIDATED') return hasCriticalRisk ? 'safety/fundamental risk active' : 'setup invalidated';
  if (status === 'DISLOCATION_CONFIRMED') return 'waiting for long flush confirmation';
  if (status === 'LONG_FLUSH_CONFIRMED') return 'waiting for stabilization / no-new-low structure';
  if (status === 'STABILIZATION') return 'waiting for reclaim';
  if (status === 'WAIT_FOR_RECLAIM') return 'waiting for reclaim';
  if (status === 'RECLAIM_DETECTED') {
    if (scores.EXECUTION_SCORE < 65) return dataQuality.microstructureMissing
      ? 'setup valid but execution not confirmed; missing trusted flow/orderbook data lowers confidence'
      : 'setup valid but execution not confirmed';
    if (scores.RISK_REWARD_SCORE < 55) return 'setup valid but R/R is poor';
    return 'reclaim detected; waiting for entry data quality';
  }
  if (status === 'WAIT_FOR_PULLBACK') return dataQuality.microstructureMissing
    ? 'setup valid but execution not confirmed; missing trusted flow/orderbook data lowers confidence'
    : 'setup valid but execution not confirmed';
  if (status === 'CHASE_RISK') return 'price extended / chase risk; setup valid but R/R is poor';
  if (status === 'EXTENDED_ENTRY') return 'price extended; no full entry at current R/R';
  if (status.includes('ENTRY_READY')) return 'entry gates passed';
  if (status === 'WATCH') {
    if (scores.FLUSH_SCORE >= 50) return 'watching flush; waiting for stronger stabilization';
    if (scores.DISLOCATION_SCORE >= 45) return 'watching dislocation; waiting for flush confirmation';
    if (scores.RECLAIM_SCORE >= 45) return 'reclaim proxy present but setup is not valid yet';
    if (dataQuality.microstructureMissing) return 'provider unavailable / stale microstructure lowers confidence';
    return 'waiting for setup confirmation';
  }
  if (regime && regime.blocksMeanReversion) return 'market regime blocks long mean reversion';
  return 'waiting for setup confirmation';
}

function v1NextConfirmation(status, dataQuality) {
  if (status === 'RISK_OFF_BLOCKED') return 'needs BTC/ETH regime and breadth to recover';
  if (status === 'INVALIDATED') return 'needs safety/fundamental risk cleared';
  if (status === 'DISLOCATION_CONFIRMED') return 'needs long flush confirmation';
  if (status === 'LONG_FLUSH_CONFIRMED') return 'needs stabilization / no-new-low structure';
  if (status === 'STABILIZATION' || status === 'WAIT_FOR_RECLAIM') return 'needs structural reclaim';
  if (status === 'RECLAIM_DETECTED') return dataQuality.microstructureMissing
    ? 'needs execution confirmation or stronger non-micro evidence'
    : 'needs execution and R/R alignment';
  if (status === 'WAIT_FOR_PULLBACK') return 'needs pullback / higher low with execution confirmation';
  if (status === 'CHASE_RISK') return 'needs better R/R after pullback';
  if (status === 'EXTENDED_ENTRY') return 'needs pullback before standard entry';
  if (status.includes('ENTRY_READY')) return 'manage invalidation and TP plan';
  return 'needs setup confirmation';
}

function buildRadarV1Output(market, regime, stageInfo, levels, safety) {
  const rawScores = radarScorePack(market, regime, stageInfo, levels, safety);
  const missing = missingForMarket(market);
  const dataQuality = radarDataQuality(market, rawScores, missing);
  const cappedConfidence = dataQuality.microstructureMissing
    ? Math.min(rawScores.FINAL_CONFIDENCE, dataQuality.derivativesMissing ? 64 : 68)
    : rawScores.FINAL_CONFIDENCE;
  const scores = { ...rawScores, FINAL_CONFIDENCE: round(cappedConfidence, 0) };
  // Absorb v2 (Phase B): pure, additive STRICT/PROXY diagnostics. Computed here so
  // it shares the single-source dataQuality.microstructureTrusted gate. On its own
  // it changes nothing; the aggressive-entry branch below only TIGHTENS using it.
  const absorbV2 = evaluateAbsorbV2(market, regime, dataQuality);
  // Reclaim v2 (Phase C): pure, additive price-structure reclaim diagnostics.
  // RECLAIM IS NOT ABSORB. Evaluated WITHOUT a trusted microstructure provider.
  // It feeds NO gate here — it never loosens ENTRY_READY, never unlocks
  // aggressive entry, and is kept strictly separate from absorbV2.
  const reclaimV2 = evaluateReclaimV2(market, regime, dataQuality);
  const structuralStopExists = !!(levels && levels.suggestedStop && levels.stopReference);
  const tpZonesExist = !!(levels && Array.isArray(levels.takeProfitCheckpoints) && levels.takeProfitCheckpoints.length >= 3);
  const hasCriticalRisk = safety.safetyStatus === 'DANGER'
    || market.exploitRisk === true
    || market.hackRisk === true
    || market.delistingRisk === true
    || market.unlockRisk === true
    || market.newsRisk === 'high';

  let status = 'WATCH';
  let entryType = 'NONE';
  let action = 'Monitor only. Waiting for setup and execution alignment.';
  const setupValid = scores.SETUP_SCORE >= 65;
  const executionValid = scores.EXECUTION_SCORE >= 65;
  const riskRewardValid = scores.RISK_REWARD_SCORE >= 55;
  const regimeAllowsLong = scores.MARKET_REGIME_SCORE >= 50 && !regime.blocksMeanReversion;
  const setupQualitySufficient = dataQuality.sufficientForSetup;
  const hasEarlyRecovery = scores.RECLAIM_SCORE >= 50
    || market.retestHeld === true
    || market.reclaimHeld === true
    || market.vwapHeld === true
    || market.higherLowHeld === true
    || (stageInfo._signals && (stageInfo._signals.c1 > 0 || stageInfo._signals.c4 > 0));
  const extendedNow = scores.RISK_REWARD_SCORE < 62
    || (stageInfo._signals && (stageInfo._signals.c1 > 4 || stageInfo._signals.c4 > 8));
  const entryBaseValid = setupValid
    && executionValid
    && riskRewardValid
    && regimeAllowsLong
    && !hasCriticalRisk
    && structuralStopExists
    && tpZonesExist
    && scores.FINAL_CONFIDENCE >= 55;

  if (regime.blocksMeanReversion || scores.MARKET_REGIME_SCORE < 45) {
    status = 'RISK_OFF_BLOCKED';
    action = 'No new long entry. Monitor only.';
  } else if (hasCriticalRisk) {
    status = safety.safetyStatus === 'DANGER' ? 'INVALIDATED' : 'RISK_OFF_BLOCKED';
    action = 'No long entry while safety/fundamental risk is active.';
  } else if (scores.DISLOCATION_SCORE >= 70 && scores.FLUSH_SCORE < 65) {
    status = 'DISLOCATION_CONFIRMED';
    action = 'Watch for long flush and stabilization. No entry yet.';
  } else if (scores.FLUSH_SCORE >= 65 && scores.STABILIZATION_SCORE < 55) {
    status = 'LONG_FLUSH_CONFIRMED';
    action = 'Wait for no-new-low structure and fading sell pressure.';
  } else if (scores.STABILIZATION_SCORE >= 55 && scores.RECLAIM_SCORE < 50) {
    status = setupValid ? 'WAIT_FOR_RECLAIM' : 'STABILIZATION';
    action = status === 'WAIT_FOR_RECLAIM'
      ? 'Wait for VWAP/range/breakdown reclaim before entry.'
      : 'Stabilization detected. Wait for reclaim before entry.';
  } else if (setupValid && (!executionValid || !riskRewardValid)) {
    status = scores.RISK_REWARD_SCORE < 55 ? 'CHASE_RISK' : 'WAIT_FOR_PULLBACK';
    action = status === 'CHASE_RISK'
      ? 'Do not open standard position. Wait for new structure or ignore.'
      : 'Setup valid, but do not chase current impulse. Wait for shallow pullback / higher low.';
  } else if (!setupValid && executionValid) {
    status = 'WATCH';
    action = 'Execution looks better than setup quality. Wait for full setup confirmation.';
  } else if (entryBaseValid) {
    if (extendedNow) {
      status = scores.RISK_REWARD_SCORE < 45 ? 'CHASE_RISK' : 'EXTENDED_ENTRY';
      entryType = 'EXTENDED';
      action = status === 'CHASE_RISK'
        ? 'Do not open standard position. Only tiny starter allowed if strategy explicitly permits.'
        : 'No full entry. Only small starter allowed if live flow is strong.';
    } else if (scores.RECLAIM_SCORE >= 70 && (market.higherLowHeld === true || market.retestHeld === true) && dataQuality.sufficientForStandardEntry) {
      status = 'STANDARD_ENTRY_READY';
      entryType = 'STANDARD_RETEST';
      action = 'Enter standard position on first higher low / reclaim retest.';
    } else if (dataQuality.sufficientForAggressiveEntry
      && scores.ORDER_BOOK_SUPPORT_SCORE >= 72
      && scores.FLOW_CONFIRMATION_SCORE >= 68
      // Phase B: AGGRESSIVE_ABSORPTION_ENTRY now additionally requires a STRICT
      // absorb confirmation (trusted, fresh rolling microstructure + score >= 75).
      // This is a pure TIGHTENING — it only ever REMOVES a row from aggressive
      // entry (it then falls through to the already-gated EARLY/RECLAIM/WAIT
      // branches), and can never create a new ENTRY_READY. A PROXY absorb can
      // never satisfy this because STRICT_ABSORB_CONFIRMED is false in PROXY mode.
      && absorbV2.STRICT_ABSORB_CONFIRMED === true
      && absorbV2.STRICT_ABSORB_SCORE >= AGGRESSIVE_ABSORPTION_MIN) {
      status = 'AGGRESSIVE_ENTRY_READY';
      entryType = 'AGGRESSIVE_RECLAIM';
      action = 'Enter partial position now or on shallow intraday pullback. Strict absorb confirmed; do not wait for deep retest.';
    } else if (scores.DISLOCATION_SCORE >= 70
      && scores.FLUSH_SCORE >= 65
      && scores.STABILIZATION_SCORE >= 55
      && hasEarlyRecovery
      && dataQuality.sufficientForEarlyEntry
      && (!dataQuality.microstructureMissing || (scores.SETUP_SCORE >= 72 && scores.RECLAIM_SCORE >= 58))) {
      status = 'EARLY_ENTRY_READY';
      entryType = 'EARLY_REVERSAL';
      action = 'Open first tranche. Use current price or shallow intraday pullback.';
    } else {
      status = scores.RECLAIM_SCORE >= 50 ? 'RECLAIM_DETECTED' : 'WAIT_FOR_PULLBACK';
      action = 'Setup is valid, but entry type data quality is not sufficient yet.';
    }
  } else if (scores.RECLAIM_SCORE >= 50) {
    status = 'RECLAIM_DETECTED';
    action = 'Reclaim detected. Wait for execution score and risk/reward to align.';
  } else if (!setupQualitySufficient || scores.SETUP_SCORE < 45) {
    status = 'WATCH';
  }

  const execMissing = Array.isArray(scores.executionDataMissing) ? scores.executionDataMissing : [];
  const allMissingForReason = dataQuality.missingData;
  const reason = [
    `setup ${scores.SETUP_SCORE}/100, execution ${scores.EXECUTION_SCORE}/100`,
    safety.safetyStatus === 'SAFE' ? 'safety check clear' : `safety ${safety.safetyStatus}: ${(safety.reasons || [])[0] || 'missing chain data'}`,
    allMissingForReason.length ? `missing data: ${allMissingForReason.slice(0, 4).join(', ')}` : 'critical market data present',
    regime.blocksMeanReversion ? 'market regime blocks longs' : `market regime ${scores.MARKET_REGIME_SCORE}/100`,
  ];
  const dataQualityLabel = dataQuality.criticalMissing.length ? 'CRITICAL_MISSING'
    : dataQuality.score >= 80 ? 'GOOD'
    : dataQuality.score >= 60 ? 'DEGRADED'
    : 'LOW';
  const gates = {
    setupValid,
    executionValid,
    riskRewardValid,
    regimeAllowsLong,
    dataQualitySufficient: status === 'EARLY_ENTRY_READY' ? dataQuality.sufficientForEarlyEntry
      : status === 'STANDARD_ENTRY_READY' ? dataQuality.sufficientForStandardEntry
      : status === 'AGGRESSIVE_ENTRY_READY' ? dataQuality.sufficientForAggressiveEntry
      : dataQuality.sufficientForSetup,
    microstructureTrusted: dataQuality.microstructureTrusted,
    microstructureMissing: dataQuality.microstructureMissing,
  };
  const blockedReason = v1BlockedReason(status, scores, dataQuality, regime, hasCriticalRisk);
  const nextConfirmation = v1NextConfirmation(status, dataQuality);

  return {
    STATUS: status,
    ACTION: action,
    ENTRY_TYPE: entryType,
    POSITION_SIZE_GUIDANCE: positionSizeGuidance(status, scores.FINAL_CONFIDENCE),
    ENTRY_ZONE: levels.entryZone,
    STOP_LOSS_LEVEL: levels.suggestedStop,
    STOP_REFERENCE: levels.stopReference,
    HARD_INVALIDATION: levels.invalidationLevel,
    TAKE_PROFIT_LEVELS: levels.takeProfitCheckpoints,
    CONFIDENCE: scores.FINAL_CONFIDENCE,
    TIMEFRAME_CONTEXT: market.timeframeContext || '1D setup, 1H/15M execution',
    TIME_VALIDITY: status.includes('ENTRY_READY') ? 'valid until next 15m/1H structure update or reclaim failure' : 'valid until next public snapshot',
    REASON: compactReasons(reason, 4),
    INVALIDATION: status === 'RISK_OFF_BLOCKED' ? 'market regime blocks long mean reversion'
      : hasCriticalRisk ? 'safety/fundamental risk active'
      : 'loss of reclaim zone, new low below panic wick, bid depth disappearance, or BTC/ETH risk-off',
    BLOCKED_BY: blockedReason,
    NEXT_CONFIRMATION: nextConfirmation,
    // Absorb v2 structured output (Phase B). Flat ABSORB_* fields are the spec's
    // required output fields; absorbV2 carries the component sub-scores. All
    // read-only / advisory — see evaluateAbsorbV2.
    ABSORB_STATUS: absorbV2.ABSORB_STATUS,
    ABSORB_MODE: absorbV2.ABSORB_MODE,
    STRICT_ABSORB_STATUS: absorbV2.STRICT_ABSORB_STATUS,
    PROXY_ABSORB_STATUS: absorbV2.PROXY_ABSORB_STATUS,
    STRICT_ABSORB_SCORE: absorbV2.STRICT_ABSORB_SCORE,
    PROXY_ABSORB_SCORE: absorbV2.PROXY_ABSORB_SCORE,
    ABSORB_BLOCK_REASON: absorbV2.ABSORB_BLOCK_REASON,
    ABSORB_MISSING_FIELDS: absorbV2.ABSORB_MISSING_FIELDS,
    ABSORB_NEXT_REQUIRED_CONDITION: absorbV2.ABSORB_NEXT_REQUIRED_CONDITION,
    ENTRY_IMPACT: absorbV2.ENTRY_IMPACT,
    STRICT_ABSORB_CONFIRMED: absorbV2.STRICT_ABSORB_CONFIRMED,
    absorbV2,
    allRadarConditionsPassed: entryBaseValid && gates.dataQualitySufficient && status.includes('ENTRY_READY'),
    structuralStopExists,
    tpZonesExist,
    gates,
    setupValid,
    executionValid,
    riskRewardValid,
    regimeAllowsLong,
    dataQualitySufficient: gates.dataQualitySufficient,
    microstructureTrusted: dataQuality.microstructureTrusted,
    microstructureMissing: dataQuality.microstructureMissing,
    missingData: dataQuality.missingData,
    dataQuality: {
      status: dataQualityLabel,
      score: dataQuality.score,
      criticalMissing: dataQuality.criticalMissing,
      missingData: dataQuality.missingData,
      microstructureTrusted: dataQuality.microstructureTrusted,
      microstructureMissing: dataQuality.microstructureMissing,
      derivativesMissing: dataQuality.derivativesMissing,
    },
    diagnostics: {
      ...(scores.diagnostics || {}),
      riskRewardReason: status === 'CHASE_RISK' ? 'price extended / chase risk' : scores.RISK_REWARD_SCORE < 55 ? 'R/R is poor' : 'R/R acceptable',
      nextMissingTransition: nextConfirmation,
      stayedReason: blockedReason,
    },
    ...scores,
    // Reclaim v2 structured output (Phase C). Intentionally placed AFTER ...scores
    // so the spec's required RECLAIM_SCORE output field is the structured v2
    // score. The internal routing score that ...scores carries is preserved for
    // traceability on reclaimV2.legacyProxyScore and still drives the (unchanged)
    // stage routing above — Reclaim v2 itself feeds no gate.
    RECLAIM_STATUS: reclaimV2.RECLAIM_STATUS,
    RECLAIM_SCORE: reclaimV2.RECLAIM_SCORE,
    RECLAIM_CONFIDENCE: reclaimV2.RECLAIM_CONFIDENCE,
    RECLAIM_LEVEL: reclaimV2.RECLAIM_LEVEL,
    RECLAIM_LEVEL_ZONE: reclaimV2.RECLAIM_LEVEL_ZONE,
    RECLAIM_LEVEL_TYPE: reclaimV2.RECLAIM_LEVEL_TYPE,
    RECLAIM_LEVEL_SOURCE: reclaimV2.RECLAIM_LEVEL_SOURCE,
    RECLAIM_SOURCE_CONFIDENCE: reclaimV2.RECLAIM_SOURCE_CONFIDENCE,
    RECLAIM_TIMEFRAME: reclaimV2.RECLAIM_TIMEFRAME,
    DISTANCE_TO_RECLAIM_LEVEL: reclaimV2.DISTANCE_TO_RECLAIM_LEVEL,
    CLOSE_ABOVE_LEVEL: reclaimV2.CLOSE_ABOVE_LEVEL,
    RETEST_STATUS: reclaimV2.RETEST_STATUS,
    RECLAIM_FAILED_REASON: reclaimV2.RECLAIM_FAILED_REASON,
    RECLAIM_NEXT_REQUIRED_CONDITION: reclaimV2.RECLAIM_NEXT_REQUIRED_CONDITION,
    RECLAIM_REJECT_REASONS: reclaimV2.RECLAIM_REJECT_REASONS,
    RECLAIM_CLASSIFICATION: reclaimV2.RECLAIM_CLASSIFICATION,
    RECLAIM_LEVELS: reclaimV2.RECLAIM_LEVELS,
    RECLAIM_SOURCE_DATA_STATUS: reclaimV2.RECLAIM_SOURCE_DATA_STATUS,
    RECLAIM_SOURCE_FIELDS_PRESENT: reclaimV2.RECLAIM_SOURCE_FIELDS_PRESENT,
    RECLAIM_SOURCE_FIELDS_MISSING: reclaimV2.RECLAIM_SOURCE_FIELDS_MISSING,
    reclaimV2: { ...reclaimV2, legacyProxyScore: scores.RECLAIM_SCORE },
  };
}

function componentScore(positive, negative, fallback = 55) {
  let score = fallback;
  for (const p of positive) if (p) score += 9;
  for (const n1 of negative) if (n1) score -= 13;
  return clamp(score);
}

export function scoreExitQuality({ market = {}, position = {}, regime = evaluateMarketRegime([]), now = Date.now() } = {}) {
  const px = n(market.mid ?? market.lastPrice ?? market.price ?? position.currentPrice) || midPrice(market);
  const entry = n(position.entryPrice ?? position.entry);
  const pnlPct = entry > 0 && px > 0 ? ((px - entry) / entry) * 100 : n(position.pnlPct, 0);
  const openedAt = position.openedAt ? new Date(position.openedAt).getTime() : null;
  const ageMin = Number.isFinite(openedAt) ? Math.max(0, (now - openedAt) / 60000) : null;
  const s = signalBooleans(market, regime);
  const spread = n(market.spreadPct);
  const oi = n(market.openInterestChangePct);
  const funding = n(market.fundingRate);

  const momentum = componentScore([
    market.higherHighs === true || market.higherLowHeld === true,
    market.vwapHeld === true || market.reclaimHeld === true,
    n(market.followThroughPct, 0) > 1.2,
  ], [
    market.noNewHigh === true,
    market.vwapLost === true || market.reclaimLost === true,
    market.lowerHigh === true || market.rejection === true,
  ]);
  const book = componentScore([
    n(market.bidDepthRebuildPct, 0) > 8,
    spread != null && spread <= 0.08,
    market.askWallsAbsorbed === true,
  ], [
    market.bidsVanished === true,
    market.askWallsReloaded === true,
    spread != null && spread > 0.15,
  ]);
  const flow = componentScore([
    n(market.spotVolumeConfirmPct, 0) > 1,
    s.buyDominance >= 0.55,
    market.sellVolumeFading === true,
  ], [
    market.greenNoFollowThrough === true,
    market.positiveDeltaNoAdvance === true,
    market.pullbackVolumeGtBreakout === true,
    market.perpsOnlyMove === true,
  ]);
  const deriv = componentScore([
    market.spotLed === true,
    oi == null || oi < 10,
    funding == null || funding <= 0.05,
  ], [
    oi != null && oi > 18,
    funding != null && funding > 0.08,
    market.leveragedLongCrowding === true,
  ]);
  const regimeScore = regime.blocksMeanReversion ? 25 : clamp(regime.score || 55);
  const maturity = componentScore([
    pnlPct > 0 && pnlPct < 12 && (ageMin == null || ageMin < 240),
    pnlPct >= 10 && n(market.followThroughPct, 0) > 1,
  ], [
    pnlPct >= 10 && ageMin != null && ageMin > 360,
    n(position.mfePct, 0) - pnlPct > 5,
  ], 55);

  const score = clamp(momentum * 0.20 + book * 0.20 + flow * 0.20 + deriv * 0.15 + regimeScore * 0.15 + maturity * 0.10);
  return {
    score: round(score, 0),
    components: {
      momentum: round(momentum, 0),
      orderBook: round(book, 0),
      flow: round(flow, 0),
      derivatives: round(deriv, 0),
      marketRegime: round(regimeScore, 0),
      tradeMaturity: round(maturity, 0),
    },
    pnlPct: round(pnlPct, 2),
  };
}

export function classifyExitMode(score, market = {}, regime = evaluateMarketRegime([])) {
  if (regime.blocksMeanReversion || market.vwapLost === true || market.reclaimLost === true || market.bidsVanished === true) {
    return RADAR_EXIT_MODES.EXHAUSTION_MODE;
  }
  if (score > 75) return RADAR_EXIT_MODES.EXPANSION_MODE;
  if (score >= 55) return RADAR_EXIT_MODES.NORMAL_MEAN_REVERSION_MODE;
  return RADAR_EXIT_MODES.EXHAUSTION_MODE;
}

function checkpointAction(pnlPct, score) {
  const hit = pnlPct >= 16 ? 3 : pnlPct >= 11 ? 2 : pnlPct >= 6 ? 1 : 0;
  if (!hit) return null;
  if (hit === 1) {
    if (score > 75) return { status: 'TRAIL_STOP', action: 'TP1: hold core, optional small 15-20% partial' };
    if (score >= 55) return { status: 'TAKE_PROFIT_PARTIAL', action: 'TP1: take 25-35%, trail remainder' };
    if (score >= 35) return { status: 'TAKE_PROFIT_AGGRESSIVE', action: 'TP1: take 40-50%, tighten stop' };
    return { status: 'EXIT_ALL', action: 'TP1: protect profit aggressively' };
  }
  if (hit === 2) {
    if (score > 75) return { status: 'TRAIL_STOP', action: 'TP2: hold core, small 15-25% partial' };
    if (score >= 55) return { status: 'TAKE_PROFIT_PARTIAL', action: 'TP2: take 30-40%, trail remainder' };
    if (score >= 35) return { status: 'TAKE_PROFIT_AGGRESSIVE', action: 'TP2: take 50-70%' };
    return { status: 'EXIT_ALL', action: 'TP2: exit weak distribution' };
  }
  if (score > 75) return { status: 'TAKE_PROFIT_PARTIAL', action: 'TP3: take 25-40% and trail runner; never hold 100%' };
  if (score >= 55) return { status: 'TAKE_PROFIT_AGGRESSIVE', action: 'TP3: take 60-80% and leave small runner' };
  return { status: 'EXIT_ALL', action: 'TP3: exit; continuation quality below threshold' };
}

export function buildExitGuidance({ market = {}, position = null, regime = evaluateMarketRegime([]), now = Date.now() } = {}) {
  if (!position) {
    return {
      STATUS: 'NO_ACTION',
      ACTION: 'No open/simulated position context supplied.',
      TAKE_PROFIT_LEVEL: null,
      STOP_LOSS_LEVEL: null,
      MODE: 'NO_POSITION',
      EXIT_QUALITY_SCORE: null,
      CONFIDENCE: 35,
      TIME_VALIDITY: 'until next public snapshot',
      REASON: 'RADAR is advisory and needs position context for exit guidance.',
      INVALIDATION: null,
    };
  }

  const px = n(market.mid ?? market.lastPrice ?? market.price ?? position.currentPrice) || midPrice(market);
  const entry = n(position.entryPrice ?? position.entry);
  const quality = scoreExitQuality({ market, position, regime, now });
  const mode = classifyExitMode(quality.score, market, regime);
  const pnlPct = quality.pnlPct || 0;
  const checkpoint = checkpointAction(pnlPct, quality.score);
  const levels = buildPriceLevels({ ...market, mid: px });
  let status = checkpoint ? checkpoint.status : (quality.score >= 75 ? 'HOLD' : quality.score >= 55 ? 'TRAIL_STOP' : 'WAIT_FOR_CONFIRMATION');
  let action = checkpoint ? checkpoint.action : (quality.score >= 75 ? 'Hold while structure expands; trail below higher low/VWAP.' : quality.score >= 55 ? 'Trail structurally; take partial if reclaim fails.' : 'Wait up to 15-30 minutes for continuation or reduce.');

  const emergency = regime.blocksMeanReversion || market.vwapLost === true || market.reclaimLost === true || market.bidsVanished === true || market.sellVolumeSpike === true || market.positiveDeltaNoAdvance === true;
  if (emergency) {
    status = regime.blocksMeanReversion ? 'RISK_OFF_EXIT' : (quality.score < 35 ? 'EXIT_ALL' : 'TAKE_PROFIT_AGGRESSIVE');
    action = regime.blocksMeanReversion ? 'Market regime broke down; protect capital/profit.' : 'Emergency profit protection triggered by structure/flow deterioration.';
  }

  if (pnlPct >= 6 && status === 'HOLD') status = 'TRAIL_STOP';
  const stop = pnlPct >= 6 && entry > 0 ? Math.max(entry, levels.suggestedStop || 0) : levels.suggestedStop;
  return {
    STATUS: status,
    ACTION: action,
    TAKE_PROFIT_LEVEL: px > 0 ? {
      TP1: round(px * 1.06, 8),
      TP2: round(px * 1.11, 8),
      TP3: round(px * 1.16, 8),
    } : null,
    STOP_LOSS_LEVEL: stop ? round(stop, 8) : null,
    MODE: mode,
    EXIT_QUALITY_SCORE: quality.score,
    CONFIDENCE: round(clamp(quality.score * 0.65 + (market.depthUsd != null ? 15 : 5) + (regime.score || 50) * 0.15), 0),
    TIME_VALIDITY: '15-30 minutes or until VWAP/reclaim/HL changes',
    REASON: `score ${quality.score}; pnl ${round(pnlPct, 2)}%; ${mode}`,
    INVALIDATION: emergency ? 'VWAP/reclaim/HL or market regime already violated' : 'VWAP/reclaim/last valid higher low fails',
    COMPONENTS: quality.components,
  };
}

function completeness(missingSignals) {
  const tracked = [
    'orderBookDepthWithin1Pct',
    'spreadPct',
    'midPrice',
    'openInterestChangePct',
    'fundingRate',
    'longLiquidationSpike',
    'shortLiquidationSpike',
    'marketSellRatio',
    'bidDepthRebuildPct',
    'vwap/reclaim/retest',
  ];
  const missing = new Set(missingSignals);
  const present = tracked.filter((x) => !missing.has(x)).length;
  return round((present / tracked.length) * 100, 0);
}

// ── Microstructure blocking diagnostics (READ-ONLY, gate-free) ───────────────
// Pure observability: explains WHY Absorb./Reclaim cannot pass for a row by
// distinguishing the static first-slice fields (order-book depth / spread /
// funding) from the rolling-window + structural fields the absorption/reclaim
// gates actually require. It NEVER changes a score, stage, gate, or Telegram
// eligibility — every value here is descriptive only. Presence is detected
// exactly the way signalBooleans()/classifyRadarStage() read each field, so the
// reported "missing" list matches the real blocker rather than guessing.
// Strict presence test: null/undefined/'' are ABSENT, but a genuinely measured
// 0 counts as present. (The shared n() helper coerces null->0, so it must NOT be
// used to decide presence here — that would report absent fields as present.)
function microPresent(v) {
  return v != null && v !== '' && Number.isFinite(Number(v));
}
// NOTE: predicates count only REAL measured order-flow / order-book fields. The
// price-derived heuristic flags (sellAggressionFading, deltaImproves) are NOT
// treated as microstructure here — they can be inferred from candles and would
// otherwise mask a row that has no genuine rolling data.
const ABSORPTION_FIELD_GROUPS = Object.freeze([
  { key: 'absorptionScore', has: (m) => microPresent(m.absorptionScore) },
  { key: 'supportRetest', has: (m) => m.supportRetested === true || m.liquidationLowRetested === true || microPresent(m.distanceToSupportPct) },
  { key: 'aggressiveSellsFailed', has: (m) => m.aggressiveSellsFailed != null || microPresent(m.marketSellRatio) },
  { key: 'bidAbsorption', has: (m) => m.bidAbsorption != null || microPresent(m.bidDepthRebuildPct) || microPresent(m.bidDepthChangePct) },
  { key: 'deltaImprovement', has: (m) => microPresent(m.deltaImprovementPct) || microPresent(m.marketBuyVolumeDominance) || microPresent(m.buyVolumeDominance) || microPresent(m.cumulativeDelta) || microPresent(m.takerBuySellRatio) },
]);
const RECLAIM_FIELD_GROUPS = Object.freeze([
  { key: 'structuralReclaim', has: (m) => m.reclaimConfirmed === true || m.vwapReclaimed === true || m.rangeHighReclaimed === true || m.retestHeld === true },
  { key: 'higherLow', has: (m) => m.higherLowHeld === true || microPresent(m.higherLow ?? m.higherLowLevel ?? m.retestLow) },
  { key: 'noNewLow', has: (m) => m.noNewLows === true || microPresent(m.noNewLowMinutes) },
  { key: 'reclaimLevel', has: (m) => microPresent(m.reclaimLevel ?? m.vwap ?? m.anchoredVwap ?? m.rangeHigh ?? m.breakdownLevel) },
  { key: 'squeezeTrigger', has: (m) => microPresent(m.shortLiquidationSpike) || microPresent(m.buyVolumeDominance) || microPresent(m.marketBuyVolumeDominance) },
]);

function radarMicrostructureDiagnostics(m, checklist = null) {
  const hasDepth = microPresent(m.depthUsdWithin1Pct ?? m.orderBookDepthWithin1Pct ?? m.depthUsd ?? m.orderBookDepthUsd);
  const hasSpread = microPresent(m.spreadPct);
  const hasFunding = microPresent(m.fundingRate);
  const hasStaticMicrostructure = hasDepth || hasSpread || hasFunding;

  const missingAbsorptionFields = ABSORPTION_FIELD_GROUPS.filter((g) => !g.has(m)).map((g) => g.key);
  const missingReclaimFields = RECLAIM_FIELD_GROUPS.filter((g) => !g.has(m)).map((g) => g.key);
  // Rolling absorption data exists exactly when classifyRadarStage's
  // realAbsorptionData would be true: at least one genuinely measured absorption
  // order-flow / order-book field is present. Kept in lock-step so the UI never
  // claims "rolling present" while the absorption gate still treats it as absent.
  const hasRollingMicrostructure = m.absorptionScore != null
    || microPresent(m.bidDepthRebuildPct)
    || m.bidAbsorption != null
    || m.aggressiveSellsFailed != null;

  const absorptionStatus = checklist && checklist.absorption ? checklist.absorption.status : null;
  const reclaimStatus = checklist && checklist.squeezeOrReclaim ? checklist.squeezeOrReclaim.status : null;

  let absorptionBlockedReason = null;
  if (absorptionStatus !== 'PASS') {
    if (!hasRollingMicrostructure) {
      absorptionBlockedReason = hasStaticMicrostructure
        ? 'static order-book/funding only; no rolling absorption data (delta/bid-rebuild/aggressive-sell fields)'
        : 'no microstructure data at all (price-only row)';
    } else if (missingAbsorptionFields.length) {
      absorptionBlockedReason = `incomplete absorption inputs: ${missingAbsorptionFields.join(', ')}`;
    } else {
      absorptionBlockedReason = 'absorption inputs present but threshold not met';
    }
  }

  let reclaimBlockedReason = null;
  if (reclaimStatus !== 'PASS') {
    if (missingReclaimFields.includes('structuralReclaim')) {
      reclaimBlockedReason = 'no structural reclaim evidence (needs reclaim/VWAP/range-high or held retest from kline structure)';
    } else if (missingReclaimFields.length) {
      reclaimBlockedReason = `incomplete reclaim structure: ${missingReclaimFields.join(', ')}`;
    } else {
      reclaimBlockedReason = 'reclaim structure present but squeeze/regime not confirmed';
    }
  }

  return {
    hasStaticMicrostructure,
    hasRollingMicrostructure,
    staticFieldsPresent: { depth: hasDepth, spread: hasSpread, funding: hasFunding },
    missingAbsorptionFields,
    missingReclaimFields,
    absorptionBlockedReason,
    reclaimBlockedReason,
  };
}

// ── Absorb v2: STRICT vs PROXY separation (Phase B) ──────────────────────────
// Splits "is this dump being absorbed?" into two explicit, independently-scored
// branches so the UI never shows a bare "Absorb: ?" and a proxy reading can
// never masquerade as a confirmed absorb.
//
//   STRICT_ABSORB — the ONLY branch allowed to CONFIRM absorption. Requires
//   trusted, FRESH rolling microstructure (order-flow / order-book) data. Each
//   component is scored from a REAL measured field only; a field that is absent
//   scores 0 and is surfaced in ABSORB_MISSING_FIELDS — it is never inferred
//   from candles. A STRICT confirmation is a PRECONDITION (not a trigger) for
//   AGGRESSIVE_ABSORPTION_ENTRY; the entry gate still requires every existing
//   setup/execution/RR/regime/data-quality/safety/Telegram gate to pass.
//
//   PROXY_ABSORB — information-only. Used when no trusted rolling provider is
//   available but candle/volume/structure data exist. It can raise WATCH /
//   PARTIAL_EVIDENCE awareness but can NEVER produce ABSORB_CONFIRMED, unlock
//   aggressive entry, or unlock Telegram.
//
// This function is PURE and additive: on its own it changes no score, stage,
// gate, ENTRY_READY status, or Telegram eligibility. The single place that
// consumes STRICT_ABSORB_CONFIRMED (buildRadarV1Output's aggressive branch) only
// ever makes entry STRICTER, never looser.
const STRICT_ABSORB_WEIGHTS = Object.freeze({
  aggressiveSellsFailed: 25,
  priceImpactWeakVsSellVolume: 20,
  bidDepthRebuildPct: 20,
  supportRetestHeld: 15,
  deltaImprovement: 10,
  spreadAndSlippageHealthy: 10,
});
const PROXY_ABSORB_WEIGHTS = Object.freeze({
  panicLowRejected: 20,
  noCleanNewLow: 20,
  volumeSpikeWithoutContinuationLower: 20,
  reclaimAttempt: 15,
  higherLowOrRangeHold: 15,
  relativeStrengthVsBTC: 10,
});
const STRICT_ABSORB_WATCH_MIN = 50;
const STRICT_ABSORB_CONFIRMED_MIN = 65;
const AGGRESSIVE_ABSORPTION_MIN = 75;
const PROXY_ABSORB_WATCH_MIN = 50;
const PROXY_ABSORB_PARTIAL_MIN = 65;

function evaluateAbsorbV2(market, regime, dataQuality) {
  const m = market || {};
  const dq = dataQuality || {};

  // ── STRICT components ── each { present, pass }. `present` decides whether the
  // field is surfaced as missing (never invented); `pass` decides the score.
  const spreadVal = microPresent(m.spreadPct) ? Number(m.spreadPct) : null;
  const slippageVal = microPresent(m.slippagePct) ? Number(m.slippagePct) : null;
  const bidRebuildVal = microPresent(m.bidDepthRebuildPct) ? Number(m.bidDepthRebuildPct)
    : microPresent(m.bidDepthChangePct) ? Number(m.bidDepthChangePct) : null;
  const deltaPresent = microPresent(m.deltaImprovementPct) || microPresent(m.marketBuyVolumeDominance)
    || microPresent(m.buyVolumeDominance) || microPresent(m.cumulativeDelta) || microPresent(m.takerBuySellRatio);
  const strict = {
    aggressiveSellsFailed: {
      present: m.aggressiveSellsFailed != null || microPresent(m.marketSellRatio),
      pass: m.aggressiveSellsFailed === true || (microPresent(m.marketSellRatio) && Number(m.marketSellRatio) <= 0.56),
    },
    priceImpactWeakVsSellVolume: {
      // absorptionScore is the system's measure of price holding despite sell
      // pressure (= price impact weak vs sell volume). Real field, real threshold.
      present: microPresent(m.absorptionScore),
      pass: microPresent(m.absorptionScore) && Number(m.absorptionScore) >= 70,
    },
    bidDepthRebuildPct: {
      present: bidRebuildVal != null,
      pass: bidRebuildVal != null && bidRebuildVal >= 8,
    },
    supportRetestHeld: {
      present: m.supportRetested != null || m.liquidationLowRetested != null || microPresent(m.distanceToSupportPct),
      pass: m.supportRetested === true || m.liquidationLowRetested === true
        || (microPresent(m.distanceToSupportPct) && Number(m.distanceToSupportPct) <= 0.75),
    },
    deltaImprovement: {
      present: deltaPresent,
      pass: (microPresent(m.deltaImprovementPct) && Number(m.deltaImprovementPct) > 0)
        || Number(m.marketBuyVolumeDominance ?? m.buyVolumeDominance ?? 0) >= 0.55
        || m.deltaImproves === true,
    },
    spreadAndSlippageHealthy: {
      present: spreadVal != null,
      pass: spreadVal != null && spreadVal <= 0.10 && (slippageVal == null || slippageVal <= 0.15),
    },
  };
  let strictScore = 0;
  const strictMissing = [];
  for (const key of Object.keys(STRICT_ABSORB_WEIGHTS)) {
    if (strict[key].pass) strictScore += STRICT_ABSORB_WEIGHTS[key];
    if (!strict[key].present) strictMissing.push(key);
  }

  // STRICT may only CONFIRM when trusted, fresh rolling microstructure exists.
  // microstructureTrusted is the single source of truth (radarDataQuality):
  // depth + spread + flow + rolling all present AND not stale AND provider not
  // marked untrusted. When that is false we report WHY (stale / untrusted /
  // unavailable) and STRICT can never confirm.
  const trustedRolling = dq.microstructureTrusted === true;
  let strictStatus;
  let strictConfirmed = false;
  if (trustedRolling) {
    if (strictScore >= STRICT_ABSORB_CONFIRMED_MIN) { strictStatus = 'ABSORB_CONFIRMED'; strictConfirmed = true; }
    else if (strictScore >= STRICT_ABSORB_WATCH_MIN) strictStatus = 'ABSORB_WATCH';
    else strictStatus = 'ABSORB_REJECTED';
  } else if (m.microstructureStale === true) {
    strictStatus = 'ABSORB_DATA_STALE';
  } else if (m.staticMicrostructureTrusted === false) {
    strictStatus = 'ABSORB_PROVIDER_UNTRUSTED';
  } else {
    strictStatus = 'ABSORB_DATA_UNAVAILABLE';
  }

  // ── PROXY components ── candle / volume / structure only; NEVER order-flow.
  const s = signalBooleans(m, regime || evaluateMarketRegime([]));
  const hasCandleContext = microPresent(m.change24hPct ?? m.priceChangePercent ?? (m.diagnostics && m.diagnostics.change24hPct));
  const proxy = {
    panicLowRejected: { present: hasCandleContext, pass: s.wickOk === true },
    noCleanNewLow: { present: hasCandleContext, pass: s.noNewLows === true },
    volumeSpikeWithoutContinuationLower: { present: hasCandleContext, pass: s.volumeSpike >= 1.2 && s.c1 >= 0 },
    reclaimAttempt: { present: hasCandleContext, pass: s.reclaim === true || s.isScannerReclaim === true },
    higherLowOrRangeHold: { present: hasCandleContext, pass: s.higherLow === true || s.rangeFormed === true },
    relativeStrengthVsBTC: { present: microPresent(m.btcRelativeChangePct ?? m.relativeToBtcPct), pass: s.btcRel > 0 },
  };
  let proxyScore = 0;
  const proxyMissing = [];
  for (const key of Object.keys(PROXY_ABSORB_WEIGHTS)) {
    if (proxy[key].pass) proxyScore += PROXY_ABSORB_WEIGHTS[key];
    if (!proxy[key].present) proxyMissing.push(key);
  }
  let proxyStatus;
  if (!hasCandleContext) proxyStatus = 'ABSORB_DATA_UNAVAILABLE';
  else if (proxyScore >= PROXY_ABSORB_PARTIAL_MIN) proxyStatus = 'ABSORB_PARTIAL_EVIDENCE';
  else if (proxyScore >= PROXY_ABSORB_WATCH_MIN) proxyStatus = 'ABSORB_WATCH';
  else proxyStatus = 'ABSORB_REJECTED';

  // ── Mode + unified status ──
  let mode;
  if (trustedRolling) mode = 'STRICT';
  else if (hasCandleContext) mode = 'PROXY';
  else mode = 'DISABLED';
  const absorbStatus = mode === 'STRICT' ? strictStatus
    : mode === 'PROXY' ? proxyStatus
    : 'ABSORB_DATA_UNAVAILABLE';

  // ── Block reason (why this row is NOT a confirmed strict absorb) ──
  let blockReason = null;
  if (!strictConfirmed) {
    if (mode !== 'STRICT') {
      if (m.microstructureStale === true) blockReason = 'stale static cache';
      else if (m.staticMicrostructureTrusted === false) blockReason = 'untrusted provider';
      else blockReason = 'provider unavailable';
    } else if (!strict.aggressiveSellsFailed.present) blockReason = 'missing aggressiveSellsFailed';
    else if (!strict.priceImpactWeakVsSellVolume.present) blockReason = 'missing absorptionScore';
    else if (!strict.bidDepthRebuildPct.present) blockReason = 'missing bidDepthRebuildPct';
    else if (!strict.supportRetestHeld.present) blockReason = 'missing supportRetest';
    else if (!strict.deltaImprovement.present) blockReason = 'missing deltaImprovement';
    else if (spreadVal != null && spreadVal > 0.10) blockReason = 'spread too wide';
    else if (slippageVal != null && slippageVal > 0.15) blockReason = 'slippage too high';
    else blockReason = `strict score ${strictScore} below confirmation threshold ${STRICT_ABSORB_CONFIRMED_MIN}`;
  }
  // Regime / new-low context refines a generic score block but never overrides a
  // concrete missing-data reason.
  if (!strictConfirmed && (!blockReason || blockReason.startsWith('strict score'))) {
    if (regime && regime.blocksMeanReversion) blockReason = 'market regime blocked';
    else if (s.c12 <= -4 && s.c24 <= -8 && s.c1 < 0) blockReason = 'new low acceleration';
  }

  // ── Next required condition ──
  let nextRequired;
  if (strictConfirmed) nextRequired = 'none — strict absorb confirmed';
  else if (mode !== 'STRICT') nextRequired = 'trusted rolling microstructure provider (order book + trades + delta)';
  else if (strictMissing.length) nextRequired = `strict input: ${strictMissing[0]}`;
  else nextRequired = `raise strict score to >= ${STRICT_ABSORB_CONFIRMED_MIN} (now ${strictScore})`;

  // ── Entry impact ── proxy / unavailable are ALWAYS informational only.
  const entryImpact = strictConfirmed
    ? 'STRICT_CONFIRMED_AGGRESSIVE_ALLOWED_IF_ALL_GATES_PASS'
    : (absorbStatus === 'ABSORB_PARTIAL_EVIDENCE' || absorbStatus === 'ABSORB_WATCH')
      ? 'INFORMATIONAL_ONLY_NO_AGGRESSIVE_ENTRY'
      : 'BLOCKED_NO_ABSORB';

  return {
    ABSORB_STATUS: absorbStatus,
    ABSORB_MODE: mode,
    STRICT_ABSORB_STATUS: strictStatus,
    PROXY_ABSORB_STATUS: proxyStatus,
    STRICT_ABSORB_SCORE: strictScore,
    PROXY_ABSORB_SCORE: proxyScore,
    ABSORB_BLOCK_REASON: blockReason || 'none',
    // Always the STRICT inputs that are absent — those are the fields actually
    // required to CONFIRM an absorb. Surfaced, never invented. PROXY_MISSING_FIELDS
    // keeps the (candle-derived) proxy gaps separately for completeness.
    ABSORB_MISSING_FIELDS: strictMissing,
    PROXY_MISSING_FIELDS: proxyMissing,
    ABSORB_NEXT_REQUIRED_CONDITION: nextRequired,
    ENTRY_IMPACT: entryImpact,
    STRICT_ABSORB_CONFIRMED: strictConfirmed,
    // Component sub-scores for the Absorb Diagnostics Panel (read-only display).
    components: {
      sellPressureScore: strict.aggressiveSellsFailed.pass ? STRICT_ABSORB_WEIGHTS.aggressiveSellsFailed : 0,
      priceImpactScore: strict.priceImpactWeakVsSellVolume.pass ? STRICT_ABSORB_WEIGHTS.priceImpactWeakVsSellVolume : 0,
      bidSurvivalRebuildScore: strict.bidDepthRebuildPct.pass ? STRICT_ABSORB_WEIGHTS.bidDepthRebuildPct : 0,
      supportRetestScore: strict.supportRetestHeld.pass ? STRICT_ABSORB_WEIGHTS.supportRetestHeld : 0,
      lowRejectionScore: proxy.panicLowRejected.pass ? PROXY_ABSORB_WEIGHTS.panicLowRejected : 0,
      spreadLiquidityScore: strict.spreadAndSlippageHealthy.pass ? STRICT_ABSORB_WEIGHTS.spreadAndSlippageHealthy : 0,
    },
  };
}

// ── Reclaim v2: structured price-structure reclaim diagnostics (Phase C) ─────
// RECLAIM IS NOT ABSORB. Absorb is order-flow / execution evidence (above).
// Reclaim is PRICE-STRUCTURE evidence that price regained an important level
// after a dump. The two are evaluated independently and never mixed.
//
// Contract:
//   - PURE + ADDITIVE. evaluateReclaimV2 changes no score, stage, gate,
//     ENTRY_READY status, or Telegram eligibility. It only surfaces structured
//     RECLAIM_* diagnostics so the UI never renders a bare "Reclaim: false".
//   - Evaluates WITHOUT a trusted microstructure provider — it reads candle /
//     level / structure fields only. Trusted microstructure may RAISE the
//     confidence field, but is NEVER required to evaluate or to CONFIRM.
//   - Reclaim ALONE never unlocks an aggressive absorption entry: nothing here
//     feeds the aggressive gate (that still requires STRICT_ABSORB_CONFIRMED +
//     every existing setup/execution/RR/regime/data/safety/Telegram gate).
//   - Never fakes a reclaim: a stronger structural status is always floored by
//     the RECLAIM_SCORE thresholds, so the status can only be downgraded, never
//     inflated, relative to the measured score.
const RECLAIM_WEIGHTS = Object.freeze({
  levelImportance: 20,
  closeAboveLevelOrZone: 25,
  timeHeldAboveLevel: 15,
  retestHeld: 20,
  volumeConfirmation: 10,
  marketRegimeSupport: 10,
});
const RECLAIM_ATTEMPT_MIN = 35;
const RECLAIM_DETECTED_MIN = 50;
const RECLAIM_CONFIRMED_MIN = 65;
const RECLAIM_RETEST_HOLD_MIN = 75;

// Reclaim level candidates in spec priority order (highest priority first). Each
// reads only a REAL structural field; an absent field is skipped (never
// invented). `lostByNature` marks levels that are breakdown/support structures
// (lost during a dump by definition) vs. moving references (VWAP/MA).
const RECLAIM_LEVEL_SOURCES = Object.freeze([
  { type: 'nearest breakdown level', importance: 96, lostByNature: true, get: (m) => n(m.breakdownLevel ?? m.nearestBreakdownLevel) },
  { type: 'reclaim level (system)', importance: 90, lostByNature: true, get: (m) => n(m.reclaimLevel) },
  { type: 'flush candle high', importance: 86, lostByNature: true, get: (m) => n(m.flushHigh ?? m.flushCandleHigh ?? m.panicHigh) },
  { type: 'previous range low / support', importance: 80, lostByNature: true, get: (m) => n(m.rangeLow ?? m.previousSupport ?? m.nearestSupport) },
  { type: 'VWAP / anchored VWAP', importance: 74, lostByNature: false, get: (m) => n(m.anchoredVwap ?? m.vwap) },
  { type: 'intraday base high', importance: 66, lostByNature: true, get: (m) => n(m.baseHigh ?? m.localHigh ?? m.priorBounceHigh) },
  { type: 'local pivot before breakdown', importance: 58, lostByNature: true, get: (m) => n(m.preBreakdownPivot ?? m.pivotHigh ?? m.localPivot) },
  { type: 'MA / trend zone', importance: 50, lostByNature: false, get: (m) => n(m.maResistance ?? m.ma50 ?? m.trendZone ?? m.emaZone) },
  { type: 'entry zone high (fallback)', importance: 42, lostByNature: false, get: (m) => n(m.entryZone?.high ?? m.zone?.high ?? m.entry_zone_high) },
  { type: '24h high (fallback)', importance: 32, lostByNature: false, get: (m) => n(m.high_24h ?? m.high24h) },
  { type: '24h low (fallback)', importance: 26, lostByNature: false, get: (m) => n(m.low_24h ?? m.low24h) },
]);
const RECLAIM_SOURCE_FIELD_NAMES = Object.freeze([
  'breakdownLevel', 'nearestBreakdownLevel', 'reclaimLevel', 'flushHigh',
  'flushCandleHigh', 'panicHigh', 'rangeLow', 'previousSupport',
  'nearestSupport', 'anchoredVwap', 'vwap', 'baseHigh', 'localHigh',
  'priorBounceHigh', 'preBreakdownPivot', 'pivotHigh', 'localPivot',
  'maResistance', 'ma50', 'trendZone', 'emaZone',
  'entryZone', 'zone', 'entry_zone_high', 'high_24h', 'high24h',
  'low_24h', 'low24h',
]);

function reclaimTimeframeOf(m) {
  const explicit = String(m.reclaimTimeframe || m.timeframe || '').toUpperCase().replace(/\s+/g, '');
  if (['1D', '4H', '1H', '15M'].includes(explicit)) return explicit;
  const ctx = String(m.timeframeContext || '').toUpperCase();
  // Prefer the SETUP timeframe (the level that matters for reclaim) over the
  // execution timeframe also mentioned in a combined context string.
  if (ctx.includes('1D') || ctx.includes('DAILY')) return '1D';
  if (ctx.includes('4H')) return '4H';
  if (ctx.includes('1H')) return '1H';
  if (ctx.includes('15M') || ctx.includes('15MIN')) return '15M';
  return '1D';
}

function evaluateReclaimV2(market, regime, dataQuality) {
  const m = market || {};
  const dq = dataQuality || {};
  const reg = regime || evaluateMarketRegime([]);
  const px = m.mid || midPrice(m) || n(m.lastPrice ?? m.price);
  const timeframe = reclaimTimeframeOf(m);

  // ── Level selection (spec priority order) ── pick the first present level as
  // the primary; expose ALL present levels with metadata. One important level is
  // enough — we never require reclaiming every level.
  const c24 = n(m.change24hPct ?? m.priceChangePercent ?? m.diagnostics?.change24hPct, 0);
  const c1 = n(m.change1hPct ?? m.diagnostics?.change1hPct);
  const c4 = n(m.change4hPct ?? m.diagnostics?.change4hPct);
  const atrPct = n(m.atrPct ?? m.realizedVolatilityPct);
  const spreadPct = microPresent(m.spreadPct) ? Number(m.spreadPct) : null;
  const wickPct = n(m.wickRecoveryPct);
  const dumped = c24 <= -4 || (c4 != null && c4 <= -3);

  // Tolerance zone (NOT an exact tick): ATR + spread aware, timeframe scaled,
  // with a fixed-percentage fallback when volatility data is unavailable.
  const tfTol = { '1D': 0.40, '4H': 0.30, '1H': 0.22, '15M': 0.16 }[timeframe] || 0.35;
  let tolPct = (atrPct != null && atrPct > 0) ? atrPct * tfTol : null;
  if (spreadPct != null && spreadPct > 0) tolPct = (tolPct ?? 0) + spreadPct;
  if (!(tolPct > 0)) tolPct = 0.6; // fixed fallback (% of price)
  tolPct = Math.min(Math.max(tolPct, 0.15), 5);

  const levels = [];
  for (const src of RECLAIM_LEVEL_SOURCES) {
    const price = src.get(m);
    if (!(price > 0)) continue;
    const zoneLow = round(price * (1 - tolPct / 100), 8);
    const zoneHigh = round(price * (1 + tolPct / 100), 8);
    const distancePct = px > 0 ? round(((px - price) / price) * 100, 3) : null;
    const reclaimedThisLevel = px > 0 && px > zoneHigh;
    levels.push({
      level_price: round(price, 8),
      level_zone_low: zoneLow,
      level_zone_high: zoneHigh,
      level_type: src.type,
      timeframe,
      source: src.type,
      importance_score: src.importance,
      distance_from_current_price: distancePct,
      was_lost_during_dump: src.lostByNature ? dumped : (dumped && px > 0 && price > px),
      has_been_reclaimed: reclaimedThisLevel,
      retest_status: 'n/a',
      confidence: src.importance,
    });
  }

  const rejectReasons = [];
  let failedReason = null;
  let nextRequired = null;

  // ── Data / level availability gates ──
  if (!(px > 0)) {
    rejectReasons.push('stale OHLCV / VWAP data');
    return buildReclaimResult({
      status: 'RECLAIM_DATA_UNAVAILABLE', score: 0, confidence: 0, timeframe,
      primary: null, levels, closeAbove: false, retestStatus: 'unknown',
      classification: 'NONE', tolPct,
      failedReason: null, rejectReasons: ['data unavailable'],
      nextRequired: 'fresh OHLCV / price + at least one reclaim level',
      components: {},
    });
  }
  const primary = levels[0] || null;
  const missingSourceFields = RECLAIM_SOURCE_FIELD_NAMES.filter((k) => {
    if (k === 'entryZone' || k === 'zone') return !m[k] || !microPresent(m[k].high);
    return !microPresent(m[k]);
  });
  const presentSourceFields = RECLAIM_SOURCE_FIELD_NAMES.filter((k) => {
    if (k === 'entryZone' || k === 'zone') return m[k] && microPresent(m[k].high);
    return microPresent(m[k]);
  });

  if (!primary) {
    const hasSourceData = missingSourceFields.length < RECLAIM_SOURCE_FIELD_NAMES.length;
    rejectReasons.push(hasSourceData ? 'no relevant reclaim level found' : 'RECLAIM_DATA_SOURCE_MISSING');
    return buildReclaimResult({
      status: 'RECLAIM_LEVEL_UNDEFINED', score: 0, confidence: 0, timeframe,
      primary: null, levels, closeAbove: false, retestStatus: 'undefined',
      classification: 'NONE', tolPct,
      failedReason: null, rejectReasons,
      nextRequired: hasSourceData
        ? 'identify a valid breakdown / range / VWAP / base level to reclaim'
        : 'scanner did not supply reclaim source fields: breakdownLevel, rangeLow, vwap, baseHigh, high_24h, etc.',
      components: {},
      sourceDataStatus: hasSourceData ? 'NO_LEVEL_FOUND' : 'RECLAIM_DATA_SOURCE_MISSING',
      missingSourceFields, presentSourceFields,
    });
  }

  const zoneLow = primary.level_zone_low;
  const zoneHigh = primary.level_zone_high;
  const distancePct = primary.distance_from_current_price;
  const aboveZone = px > zoneHigh;
  const inZone = px >= zoneLow && px <= zoneHigh;
  const belowZone = px < zoneLow;

  // ── Confirmation signals (price-structure only; no order flow required) ──
  const wickOnly = m.wickOnlyReclaim === true || m.reclaimWickOnly === true;
  const hasConfirmSignal = m.reclaimConfirmed === true || m.vwapReclaimed === true
    || m.rangeHighReclaimed === true || m.closeAboveLevel === true
    || m.dailyCloseAboveZone === true || m.reclaimHeld === true;
  const heldMinutes = n(m.timeAboveLevelMinutes ?? m.holdAboveMinutes ?? m.noNewLowMinutes);
  const tfHoldMin = { '1D': 240, '4H': 120, '1H': 45, '15M': 20 }[timeframe] || 60;
  const heldAbove = m.heldAboveLevel === true || m.higherLowHeld === true
    || m.vwapHeld === true || (heldMinutes != null && heldMinutes >= tfHoldMin);
  // Timeframe-aware close confirmation. 1D/4H: a close above the zone confirms.
  // 1H/15M: stricter — require a non-wick close AND a hold/higher-low, never a
  // wick-only tag.
  let closeConfirmed;
  if (timeframe === '1H' || timeframe === '15M') {
    closeConfirmed = hasConfirmSignal && !wickOnly && (heldAbove || m.closeAboveLevel === true);
  } else {
    closeConfirmed = hasConfirmSignal && !wickOnly;
  }

  const retestHeld = m.retestHeld === true || m.reclaimRetestHeld === true
    || (m.higherLowHeld === true && hasConfirmSignal);
  const retestFailed = m.retestFailed === true || m.reclaimRetestFailed === true;
  const retestTested = retestHeld || retestFailed || m.retestTested === true || m.retestDone === true;
  const lostAfterReclaim = m.reclaimLost === true || m.vwapLost === true
    || m.reclaimedThenLost === true || (retestFailed && belowZone);

  // ── Volume + regime support ──
  const volSpike = n(m.volumeSpike, 0);
  const volumeConfirmed = m.reclaimVolumeConfirmed === true || volSpike >= 1.2
    || n(m.spotVolumeConfirmPct, 0) > 1;
  const regimeOk = !reg.blocksMeanReversion && n(reg.score, 55) >= 50;

  // ── RECLAIM_SCORE (0–100). Missing retest only zeroes ITS component — it
  // never zeroes the total. ──
  const components = {
    levelImportance: round(RECLAIM_WEIGHTS.levelImportance * (primary.importance_score / 100), 1),
    closeAboveLevelOrZone: closeConfirmed ? RECLAIM_WEIGHTS.closeAboveLevelOrZone
      : aboveZone ? round(RECLAIM_WEIGHTS.closeAboveLevelOrZone * 0.5, 1) : 0,
    timeHeldAboveLevel: heldAbove ? RECLAIM_WEIGHTS.timeHeldAboveLevel
      : aboveZone ? round(RECLAIM_WEIGHTS.timeHeldAboveLevel * 0.45, 1) : 0,
    retestHeld: retestHeld ? RECLAIM_WEIGHTS.retestHeld : 0,
    volumeConfirmation: volumeConfirmed ? RECLAIM_WEIGHTS.volumeConfirmation : 0,
    marketRegimeSupport: regimeOk ? RECLAIM_WEIGHTS.marketRegimeSupport : 0,
  };
  let score = clamp(Object.values(components).reduce((a, b) => a + b, 0));

  // ── Structural status machine (spec decision logic) ──
  let status;
  if (lostAfterReclaim) {
    status = 'RECLAIM_FAILED';
    failedReason = retestFailed ? 'retest failed' : 'price reclaimed then lost the zone';
  } else if (hasConfirmSignal) {
    if (retestHeld) status = 'RECLAIM_RETEST_HOLD';
    else if (retestTested) status = 'RECLAIM_CONFIRMED';
    else status = 'RECLAIM_CONFIRMED_NO_RETEST';
  } else if (aboveZone) {
    status = 'RECLAIM_DETECTED';
  } else if (inZone) {
    status = 'RECLAIM_ATTEMPT';
  } else {
    status = 'RECLAIM_NOT_STARTED';
  }

  // ── Honesty floor: a stronger status is only allowed if the score supports
  // it. This can only DOWNGRADE — it never inflates a reclaim. ──
  if (status === 'RECLAIM_RETEST_HOLD' && score < RECLAIM_RETEST_HOLD_MIN) {
    status = 'RECLAIM_CONFIRMED';
  }
  if ((status === 'RECLAIM_CONFIRMED' || status === 'RECLAIM_CONFIRMED_NO_RETEST') && score < RECLAIM_CONFIRMED_MIN) {
    status = aboveZone ? 'RECLAIM_DETECTED' : inZone ? 'RECLAIM_ATTEMPT' : 'RECLAIM_NOT_STARTED';
  }
  if (status === 'RECLAIM_DETECTED' && score < RECLAIM_DETECTED_MIN) {
    status = (inZone || aboveZone) ? 'RECLAIM_ATTEMPT' : 'RECLAIM_NOT_STARTED';
  }

  // ── Retest status string ──
  let retestStatus;
  if (retestHeld) retestStatus = 'held';
  else if (retestFailed) retestStatus = 'failed';
  else if (status === 'RECLAIM_CONFIRMED_NO_RETEST') retestStatus = 'not yet tested';
  else if (aboveZone || inZone) retestStatus = 'pending';
  else retestStatus = 'not yet tested';
  if (primary) primary.retest_status = retestStatus;
  for (const lvl of levels) if (lvl.has_been_reclaimed) lvl.retest_status = retestStatus;

  // ── Classification: EARLY / STANDARD / LATE / CHASE / NONE ──
  const reclaimedNow = ['RECLAIM_DETECTED', 'RECLAIM_CONFIRMED', 'RECLAIM_CONFIRMED_NO_RETEST', 'RECLAIM_RETEST_HOLD'].includes(status);
  const extendThreshold = Math.max(3, (atrPct != null && atrPct > 0 ? atrPct : 3) * 1.2);
  const extended = distancePct != null && distancePct > extendThreshold;
  const ranHot = (c1 != null && c1 > 4) || (c4 != null && c4 > 8);
  let classification = 'NONE';
  if (reclaimedNow) {
    if (retestHeld) classification = 'STANDARD_RECLAIM';
    else if (extended && ranHot) classification = 'CHASE_RECLAIM';
    else if (extended) classification = 'LATE_RECLAIM';
    else classification = 'EARLY_RECLAIM';
  }

  // ── Reject / block reasons (descriptive; gate nothing) ──
  if (status === 'RECLAIM_NOT_STARTED') rejectReasons.push('price did not enter reclaim zone');
  if (status === 'RECLAIM_ATTEMPT') rejectReasons.push('no confirmed close/hold above zone yet');
  if (status === 'RECLAIM_DETECTED' && wickOnly) rejectReasons.push('wick only, no close above level');
  if (status === 'RECLAIM_DETECTED' && !closeConfirmed) rejectReasons.push('above zone but no confirmed close/hold yet');
  if (status === 'RECLAIM_CONFIRMED_NO_RETEST') rejectReasons.push('no retest yet'); // NOT a final reject
  if (!volumeConfirmed && reclaimedNow) rejectReasons.push('volume confirmation missing');
  if (reg.blocksMeanReversion) rejectReasons.push('market regime blocked');
  if (extended && reclaimedNow) rejectReasons.push('reclaim detected but entry already extended');
  if (classification === 'CHASE_RECLAIM') rejectReasons.push('risk/reward too weak after reclaim');

  // ── Next required condition ──
  if (status === 'RECLAIM_FAILED') {
    nextRequired = 'wait for a fresh reclaim attempt and a new higher low';
  } else if (status === 'RECLAIM_NOT_STARTED') {
    nextRequired = `price must reach the reclaim zone (${zoneLow}–${zoneHigh})`;
  } else if (status === 'RECLAIM_ATTEMPT') {
    nextRequired = `close/hold above ${zoneHigh} on the ${timeframe} timeframe`;
  } else if (status === 'RECLAIM_DETECTED') {
    nextRequired = `confirm with a ${timeframe} close above ${zoneHigh} or a held higher low`;
  } else if (status === 'RECLAIM_CONFIRMED_NO_RETEST') {
    nextRequired = 'WAIT_FOR_RETEST — retest the reclaimed zone and hold as support';
  } else if (status === 'RECLAIM_CONFIRMED') {
    nextRequired = 'retest hold or execution score / RR alignment';
  } else if (status === 'RECLAIM_RETEST_HOLD') {
    nextRequired = 'execution score and risk/reward alignment';
  } else {
    nextRequired = 'identify a relevant reclaim level';
  }

  // Trusted microstructure is OPTIONAL: it may lift confidence, but Reclaim is
  // fully evaluated above without it. Never required.
  let confidence = score;
  if (dq.microstructureTrusted === true && reclaimedNow) confidence = clamp(score + 5);

  return buildReclaimResult({
    status, score, confidence, timeframe, primary, levels,
    closeAbove: closeConfirmed, retestStatus, classification, tolPct,
    failedReason, rejectReasons: compactReasons(rejectReasons, 8), nextRequired, components,
    sourceDataStatus: primary ? 'SOURCE_DATA_PRESENT' : 'NO_LEVEL_FOUND',
    missingSourceFields, presentSourceFields,
  });
}

function buildReclaimResult({
  status, score, confidence, timeframe, primary, levels, closeAbove, retestStatus,
  classification, tolPct, failedReason, rejectReasons, nextRequired, components,
  sourceDataStatus, missingSourceFields, presentSourceFields,
}) {
  return {
    RECLAIM_STATUS: status,
    RECLAIM_SCORE: round(score, 0),
    RECLAIM_CONFIDENCE: round(confidence, 0),
    RECLAIM_LEVEL: primary ? primary.level_price : null,
    RECLAIM_LEVEL_ZONE: primary ? { low: primary.level_zone_low, high: primary.level_zone_high } : null,
    RECLAIM_LEVEL_TYPE: primary ? primary.level_type : 'undefined',
    RECLAIM_LEVEL_SOURCE: primary ? primary.source : 'undefined',
    RECLAIM_SOURCE_CONFIDENCE: primary ? primary.importance_score : null,
    RECLAIM_TIMEFRAME: timeframe,
    DISTANCE_TO_RECLAIM_LEVEL: primary ? primary.distance_from_current_price : null,
    CLOSE_ABOVE_LEVEL: closeAbove === true,
    RETEST_STATUS: retestStatus,
    RECLAIM_FAILED_REASON: failedReason,
    RECLAIM_NEXT_REQUIRED_CONDITION: nextRequired,
    RECLAIM_REJECT_REASONS: rejectReasons || [],
    RECLAIM_CLASSIFICATION: classification,
    RECLAIM_LEVELS: levels || [],
    RECLAIM_TOLERANCE_PCT: round(tolPct, 3),
    RECLAIM_SOURCE_DATA_STATUS: sourceDataStatus || (primary ? 'SOURCE_DATA_PRESENT' : 'NO_LEVEL_FOUND'),
    RECLAIM_SOURCE_FIELDS_PRESENT: presentSourceFields || [],
    RECLAIM_SOURCE_FIELDS_MISSING: missingSourceFields || [],
    components: components || {},
  };
}

function missingForMarket(m) {
  const miss = [];
  if (m.depthUsd == null) miss.push('orderBookDepthWithin1Pct');
  if (m.spreadPct == null) miss.push('spreadPct');
  if (m.mid == null) miss.push('midPrice');
  if (m.openInterestChangePct == null) miss.push('openInterestChangePct');
  if (m.fundingRate == null) miss.push('fundingRate');
  if (m.longLiquidationSpike == null && m.longLiquidationUsd == null) miss.push('longLiquidationSpike');
  if (m.shortLiquidationSpike == null) miss.push('shortLiquidationSpike');
  if (m.marketSellRatio == null) miss.push('marketSellRatio');
  if (m.bidDepthRebuildPct == null && m.bidDepthChangePct == null) miss.push('bidDepthRebuildPct');
  if (!m.reclaimConfirmed && !m.vwapReclaimed && !m.rangeHighReclaimed && !m.retestHeld) miss.push('vwap/reclaim/retest');
  return miss;
}

function radarDataQuality(market, scores, missing) {
  const missingSet = new Set([...(missing || []), ...((scores && scores.executionDataMissing) || [])]);
  const px = market.mid || midPrice(market) || n(market.lastPrice ?? market.price);
  const criticalMissing = [];
  if (!(px > 0)) criticalMissing.push('price');
  if (!(n(market.quoteVolume ?? market.quoteVolume24h ?? market.volume24hUsd) > 0)) criticalMissing.push('quoteVolume');
  if (n(market.change24hPct ?? market.priceChangePercent) == null && !market.isScannerContext) criticalMissing.push('change24hPct');

  const hasDepth = microPresent(market.depthUsdWithin1Pct ?? market.orderBookDepthWithin1Pct ?? market.depthUsd ?? market.orderBookDepthUsd);
  const hasSpread = microPresent(market.spreadPct);
  const hasFlow = microPresent(market.marketBuyVolumeDominance ?? market.buyVolumeDominance)
    || microPresent(market.cumulativeDelta)
    || microPresent(market.takerBuySellRatio)
    || microPresent(market.deltaImprovementPct)
    || market.aggressiveSellsFailed != null
    || market.bidAbsorption != null;
  const hasRolling = market.absorptionScore != null
    || microPresent(market.bidDepthRebuildPct)
    || microPresent(market.bidDepthChangePct)
    || market.bidAbsorption != null
    || market.aggressiveSellsFailed != null
    || hasFlow;
  const microstructureTrusted = hasDepth && hasSpread && hasFlow && hasRolling
    && market.microstructureStale !== true
    && market.staticMicrostructureTrusted !== false;
  const microstructureMissing = !hasDepth || !hasSpread || !hasFlow;
  const derivMissing = missingSet.has('derivatives')
    || missingSet.has('openInterestChangePct')
    || missingSet.has('fundingRate')
    || missingSet.has('longLiquidationSpike')
    || missingSet.has('shortLiquidationSpike');
  const score = clamp(100 - missingSet.size * 4 - criticalMissing.length * 22 - (microstructureMissing ? 10 : 0) - (derivMissing ? 8 : 0));

  return {
    score: round(score, 0),
    criticalMissing,
    sufficientForSetup: criticalMissing.length === 0 && score >= 45,
    sufficientForEarlyEntry: criticalMissing.length === 0 && score >= 55,
    sufficientForStandardEntry: criticalMissing.length === 0 && score >= 60,
    sufficientForAggressiveEntry: criticalMissing.length === 0 && score >= 70 && microstructureTrusted,
    microstructureTrusted,
    microstructureMissing,
    derivativesMissing: derivMissing,
    missingData: Array.from(missingSet).sort(),
  };
}

// Phase B: current-snapshot Absorb funnel counters. Pure aggregation over the
// already-evaluated candidates — it derives nothing new and changes no gate.
// Durable 24h/7d rolling aggregation is intentionally left as a TODO (it needs a
// persistence layer; doing it inline would be riskier than the snapshot view).
function buildAbsorbFunnel(candidates = [], universeSize = 0) {
  const f = {
    coinsScanned: Number(universeSize) || (candidates ? candidates.length : 0),
    dislocationConfirmed: 0,
    longFlushConfirmed: 0,
    stabilizationDetected: 0,
    proxyAbsorbWatch: 0,
    proxyPartialEvidence: 0,
    strictAbsorbEvaluated: 0,
    strictAbsorbConfirmed: 0,
    aggressiveAbsorptionEntry: 0,
    blockedByMissingProvider: 0,
    blockedByStaleCache: 0,
    blockedByUntrustedProvider: 0,
    blockedByMarketRegime: 0,
    blockedBySpreadLiquidity: 0,
    blockedByMissingFields: 0,
    // TODO(durable): rolling 24h / 7d aggregation requires persistence.
    rollingWindow: 'snapshot-only',
  };
  for (const c of candidates || []) {
    if (!c) continue;
    if (c.STATUS === 'DISLOCATION_CONFIRMED') f.dislocationConfirmed++;
    if (c.STATUS === 'LONG_FLUSH_CONFIRMED') f.longFlushConfirmed++;
    if (c.STATUS === 'STABILIZATION' || c.STATUS === 'WAIT_FOR_RECLAIM') f.stabilizationDetected++;
    if (c.ABSORB_MODE === 'STRICT') f.strictAbsorbEvaluated++;
    if (c.ABSORB_MODE === 'PROXY') {
      if (c.PROXY_ABSORB_STATUS === 'ABSORB_WATCH') f.proxyAbsorbWatch++;
      if (c.PROXY_ABSORB_STATUS === 'ABSORB_PARTIAL_EVIDENCE') f.proxyPartialEvidence++;
    }
    if (c.STRICT_ABSORB_CONFIRMED === true) f.strictAbsorbConfirmed++;
    if (c.STATUS === 'AGGRESSIVE_ENTRY_READY') f.aggressiveAbsorptionEntry++;
    const br = c.ABSORB_BLOCK_REASON;
    if (br === 'provider unavailable') f.blockedByMissingProvider++;
    else if (br === 'stale static cache') f.blockedByStaleCache++;
    else if (br === 'untrusted provider') f.blockedByUntrustedProvider++;
    else if (br === 'market regime blocked') f.blockedByMarketRegime++;
    else if (br === 'spread too wide' || br === 'slippage too high') f.blockedBySpreadLiquidity++;
    else if (typeof br === 'string' && br.startsWith('missing ')) f.blockedByMissingFields++;
  }
  return f;
}

// Phase C: current-snapshot Reclaim funnel counters. Pure aggregation over the
// already-evaluated candidates — derives nothing new and changes no gate. Kept
// separate from the Absorb funnel (Reclaim is NOT Absorb). Durable 24h/7d
// rolling aggregation is intentionally left as a TODO (it needs a persistence
// layer; doing it inline would be riskier than this snapshot view).
function buildReclaimFunnel(candidates = [], universeSize = 0) {
  const f = {
    coinsScanned: Number(universeSize) || (candidates ? candidates.length : 0),
    dislocationConfirmed: 0,
    longFlushConfirmed: 0,
    stabilizationDetected: 0,
    reclaimLevelIdentified: 0,
    reclaimAttempt: 0,
    reclaimDetected: 0,
    reclaimConfirmed: 0,
    reclaimRetestHeld: 0,
    reclaimFailed: 0,
    entryBlockedByMissingRetest: 0,
    entryBlockedByWeakRR: 0,
    entryBlockedByMarketRegime: 0,
    entryBlockedByLateChase: 0,
    // TODO(durable): rolling 24h / 7d aggregation requires persistence.
    rollingWindow: 'snapshot-only',
  };
  for (const c of candidates || []) {
    if (!c) continue;
    if (c.STATUS === 'DISLOCATION_CONFIRMED') f.dislocationConfirmed++;
    if (c.STATUS === 'LONG_FLUSH_CONFIRMED') f.longFlushConfirmed++;
    if (c.STATUS === 'STABILIZATION' || c.STATUS === 'WAIT_FOR_RECLAIM') f.stabilizationDetected++;
    const rs = c.RECLAIM_STATUS;
    if (rs && rs !== 'RECLAIM_LEVEL_UNDEFINED' && rs !== 'RECLAIM_DATA_UNAVAILABLE') f.reclaimLevelIdentified++;
    if (rs === 'RECLAIM_ATTEMPT') f.reclaimAttempt++;
    if (rs === 'RECLAIM_DETECTED') f.reclaimDetected++;
    if (rs === 'RECLAIM_CONFIRMED' || rs === 'RECLAIM_CONFIRMED_NO_RETEST') f.reclaimConfirmed++;
    if (rs === 'RECLAIM_RETEST_HOLD') f.reclaimRetestHeld++;
    if (rs === 'RECLAIM_FAILED') f.reclaimFailed++;
    if (rs === 'RECLAIM_CONFIRMED_NO_RETEST') f.entryBlockedByMissingRetest++;
    if (c.RECLAIM_CLASSIFICATION === 'CHASE_RECLAIM') f.entryBlockedByWeakRR++;
    if (c.RECLAIM_CLASSIFICATION === 'LATE_RECLAIM' || c.RECLAIM_CLASSIFICATION === 'CHASE_RECLAIM') f.entryBlockedByLateChase++;
    if (Array.isArray(c.RECLAIM_REJECT_REASONS) && c.RECLAIM_REJECT_REASONS.includes('market regime blocked')) f.entryBlockedByMarketRegime++;
  }
  return f;
}

function buildPipeline(candidates, universeSize) {
  const pipeline = {
    NO_SETUP: 0,
    WATCH: 0,
    LONG_FLUSH_CONFIRMED: 0,
    STABILIZING: 0,
    SQUEEZE_CONFIRMED: 0,
    ENTRY_READY: 0,
  };
  for (const c of candidates || []) {
    if (!c || !pipeline.hasOwnProperty(c.stage)) continue;
    pipeline[c.stage] += 1;
  }
  if (!candidates.length && universeSize) pipeline.NO_SETUP = Math.max(0, Number(universeSize) || 0);
  return pipeline;
}

export function normalizeScannerSymbol(c) {
  const raw = String(c && (c.pair || c.symbol || c.base) || '').trim().toUpperCase();
  if (!raw) return '';
  const compact = raw.replace(/[^A-Z0-9]/g, '');
  if (compact.endsWith('USDT') || compact.endsWith('USDC')) return compact;
  const quote = String(c && c.quote || '').toUpperCase();
  if (quote === 'USDT' || quote === 'USDC') return compact + quote;
  return compact + 'USDT';
}

function radarStatus(state) {
  if (!state || state.lastError) return 'ERROR';
  if (Array.isArray(state.entryReady) && state.entryReady.length) return 'ENTRY_READY';
  if (Array.isArray(state.watchlist) && state.watchlist.length) return 'WATCHING';
  if (state.dataFreshnessMs != null && state.dataFreshnessMs > 120000) return 'STALE';
  return 'SCANNING';
}
const SCANNER_RECLAIM_SOURCE_KEYS = Object.freeze([
  'breakdownLevel', 'nearestBreakdownLevel', 'reclaimLevel', 'flushHigh',
  'flushCandleHigh', 'panicHigh', 'rangeLow', 'previousSupport',
  'nearestSupport', 'anchoredVwap', 'vwap', 'baseHigh', 'localHigh',
  'priorBounceHigh', 'preBreakdownPivot', 'pivotHigh', 'localPivot',
  'maResistance', 'ma50', 'trendZone', 'emaZone', 'entryZone', 'zone',
  'entry_zone_high', 'high_24h', 'high24h', 'low_24h', 'low24h',
]);

function copyScannerReclaimSources(target, source) {
  if (!target || !source || typeof source !== 'object') return target;
  for (const k of SCANNER_RECLAIM_SOURCE_KEYS) {
    if (source[k] !== undefined && target[k] === undefined) target[k] = source[k];
  }
  return target;
}

export function evaluateTradingRadar({
  markets = [],
  scannerCandidates = [],
  source = 'unknown',
  fetchedAt = null,
  receivedAt = null,
  now = Date.now(),
  positions = [],
  selectedSymbol = null,
  filters = {},
  scannerContext = {},
} = {}) {
  const nowIso = new Date(now).toISOString();
  const state = defaultTradingRadarState(nowIso);
  state.source = source;
  const freshnessBase = fetchedAt || receivedAt;
  const freshnessMs = freshnessBase ? Math.max(0, now - new Date(freshnessBase).getTime()) : null;
  state.dataFreshnessMs = Number.isFinite(freshnessMs) ? freshnessMs : null;

  try {
    const scannerMap = new Map();
    for (const c of scannerCandidates || []) {
      if (c && c.symbol) {
        let sym = normalizeScannerSymbol(c);
        if (!sym) continue;
        scannerMap.set(sym, c);
      }
    }
    
    const seenSymbols = new Set();
    const mergedMarkets = markets.map(m => {
      const sym = String(m.symbol || '').toUpperCase();
      seenSymbols.add(sym);
      const sc = scannerMap.get(sym);
      if (!sc) return m;
      const overlay = {
        scannerScore: sc.score,
        scannerPanic: sc.panic,
        scannerSignal: sc.signal,
        scannerHot: sc.hot,
        scannerTags: Array.from(new Set([...(sc.tags || []), sc.signal].filter(Boolean).map((x) => String(x).toUpperCase()))),
        source: sc.source || sc.exchange || m.source,
        exchange: sc.exchange || sc.source || m.exchange,
        listingSource: sc.listingSource || sc.source || m.listingSource,
        listingType: sc.listingType || m.listingType,
        alphaTokenId: sc.alphaTokenId || sc.tokenId || m.alphaTokenId,
        alphaPair: sc.alphaPair || m.alphaPair,
        binanceAlphaListed: sc.binanceAlphaListed === true || m.binanceAlphaListed === true || /binance[-_\s]?alpha|BINANCE_ALPHA/i.test(String(sc.source || sc.exchange || sc.listingType || '')),
        isScannerContext: true,
        change1hPct: m.change1hPct ?? sc.c1,
        change4hPct: m.change4hPct ?? sc.c4,
        change12hPct: m.change12hPct ?? sc.c12,
        change24hPct: m.change24hPct ?? sc.c24,
        priceChangePercent: m.priceChangePercent ?? sc.c24
      };
      
      const MICRO_KEYS = [
        'orderBookDepthWithin1Pct', 'depthUsdWithin1Pct', 'spreadPct', 'openInterestChangePct',
        'fundingRate', 'longLiquidationSpike', 'shortLiquidationSpike', 'marketSellRatio',
        'takerBuySellRatio', 'cumulativeDelta', 'deltaImprovementPct', 'bidDepthRebuildPct',
        'absorptionScore', 'distanceToSupportPct', 'marketBuyVolumeDominance', 'buyVolumeDominance',
        'bidAbsorption', 'aggressiveSellsFailed', 'supportRetested', 'liquidationLowRetested',
        'depthUsd', 'structuralReclaim', 'higherLow', 'noNewLow', 'reclaimLevel', 'squeezeTrigger'
      ];
      for (const k of MICRO_KEYS) {
        if (sc[k] !== undefined && overlay[k] === undefined) {
          overlay[k] = sc[k];
        }
      }
      copyScannerReclaimSources(overlay, sc);
      return { ...m, ...overlay };
    });

    for (const sc of scannerCandidates || []) {
       if (sc && sc.symbol) {
         let sym = normalizeScannerSymbol(sc);
         if (!sym) continue;
         if (!seenSymbols.has(sym)) {
            const newCandidate = {
               symbol: sym,
               lastPrice: sc.price,
               quoteVolume24h: sc.volume,
               scannerScore: sc.score,
               scannerPanic: sc.panic,
               scannerSignal: sc.signal,
               scannerHot: sc.hot,
               scannerTags: Array.from(new Set([...(sc.tags || []), sc.signal].filter(Boolean).map((x) => String(x).toUpperCase()))),
               source: sc.source || sc.exchange || null,
               exchange: sc.exchange || sc.source || null,
               listingSource: sc.listingSource || sc.source || null,
               listingType: sc.listingType || null,
               alphaTokenId: sc.alphaTokenId || sc.tokenId || null,
               alphaPair: sc.alphaPair || null,
               binanceAlphaListed: sc.binanceAlphaListed === true || /binance[-_\s]?alpha|BINANCE_ALPHA/i.test(String(sc.source || sc.exchange || sc.listingType || '')),
               isScannerContext: true,
               change1hPct: sc.c1,
               change4hPct: sc.c4,
               change12hPct: sc.c12,
               change24hPct: sc.c24,
               priceChangePercent: sc.c24,
               status: 'TRADING'
            };
            const MICRO_KEYS = [
              'orderBookDepthWithin1Pct', 'depthUsdWithin1Pct', 'spreadPct', 'openInterestChangePct',
              'fundingRate', 'longLiquidationSpike', 'shortLiquidationSpike', 'marketSellRatio',
              'takerBuySellRatio', 'cumulativeDelta', 'deltaImprovementPct', 'bidDepthRebuildPct',
              'absorptionScore', 'distanceToSupportPct', 'marketBuyVolumeDominance', 'buyVolumeDominance',
              'bidAbsorption', 'aggressiveSellsFailed', 'supportRetested', 'liquidationLowRetested',
              'depthUsd', 'structuralReclaim', 'higherLow', 'noNewLow', 'reclaimLevel', 'squeezeTrigger'
            ];
            for (const k of MICRO_KEYS) {
              if (sc[k] !== undefined && newCandidate[k] === undefined) {
                newCandidate[k] = sc[k];
              }
            }
            copyScannerReclaimSources(newCandidate, sc);
            mergedMarkets.push(newCandidate);
         }
       }
    }

    const { universe, diagnostics, missingSignals } = buildRadarUniverse(mergedMarkets, { filters });
    const regime = evaluateMarketRegime(mergedMarkets);
    const allMissing = new Set(missingSignals);
    const safetyResults = [];
    const candidates = universe.map((m) => {
      for (const miss of missingForMarket(m)) allMissing.add(miss);
      const stageInfo = classifyRadarStage(m, regime);
      const levels = buildPriceLevels(m, stageInfo);
      // Resolve token metadata (curated allowlist / row context / optional
      // provider) then classify honestly. Missing/ambiguous metadata stays
      // UNKNOWN with a specific safetyReason - never faked SAFE.
      const safety = classifyMarketSafety(m, {
        binanceAlphaListings: scannerContext.binanceAlphaListings,
        binanceAlphaSymbolMap: scannerContext.binanceAlphaSymbolMap,
      });
      safety.symbol = m.symbol;
      safetyResults.push(safety);
      const v1 = buildRadarV1Output(m, regime, stageInfo, levels, safety);
      // READ-ONLY observability: why Absorb./Reclaim are (not) passing for this
      // row. Derived from the same fields the gates read; changes no gate.
      const microDiag = radarMicrostructureDiagnostics(m, stageInfo.conditionChecklist);
      // Phase B: annotate the absorption checklist row with the EXPLICIT Absorb v2
      // state for display, so the UI never renders a bare "Absorb: ?". This is a
      // display-only annotation — the `.status` field that the stage machine and
      // the microstructure fail-closed tests rely on is intentionally left
      // untouched, so no gate, stage, or score changes here.
      if (stageInfo.conditionChecklist && stageInfo.conditionChecklist.absorption) {
        const a = stageInfo.conditionChecklist.absorption;
        a.absorbStatus = v1.ABSORB_STATUS;
        a.absorbMode = v1.ABSORB_MODE;
        a.strictAbsorbStatus = v1.STRICT_ABSORB_STATUS;
        a.proxyAbsorbStatus = v1.PROXY_ABSORB_STATUS;
        const strictUnavailable = v1.STRICT_ABSORB_STATUS === 'ABSORB_DATA_UNAVAILABLE';
        const proxyRejected = v1.PROXY_ABSORB_STATUS === 'ABSORB_REJECTED';
        const absorbDisplayStatus = strictUnavailable && proxyRejected
          ? 'ABSORB_DATA_UNAVAILABLE (proxy rejected)'
          : v1.ABSORB_STATUS;
        a.displayReason = `${absorbDisplayStatus}${v1.ABSORB_BLOCK_REASON && v1.ABSORB_BLOCK_REASON !== 'none' ? ' — ' + v1.ABSORB_BLOCK_REASON : ''}`;
      }
      // SINGLE SOURCE OF TRUTH: a candidate is ENTRY_READY only when the V1/spec
      // gate in buildRadarV1Output passes. The heuristic stage machine
      // (classifyRadarStage) can suggest a stage but can NEVER, on its own,
      // promote a candidate to ENTRY_READY in actionability, the entryReady list,
      // the banner, counts, filters, distance=100, or Telegram eligibility.
      const entryReadyV1 = ['EARLY_ENTRY_READY', 'STANDARD_ENTRY_READY', 'AGGRESSIVE_ENTRY_READY'].includes(v1.STATUS);
      const adjustedConfidence = Math.min(stageInfo.confidence, v1.FINAL_CONFIDENCE);
      const effectiveActionability = entryReadyV1 ? 'ENTRY_READY'
        : v1.STATUS === 'WAIT_FOR_PULLBACK' || v1.STATUS === 'EXTENDED_ENTRY' || v1.STATUS === 'CHASE_RISK' || v1.STATUS === 'RECLAIM_DETECTED' ? 'NEAR_ENTRY'
        : v1.STATUS === 'WAIT_FOR_RECLAIM' || v1.STATUS === 'STABILIZATION' ? 'NEEDS_CONFIRMATION'
        : v1.STATUS === 'LONG_FLUSH_CONFIRMED' ? 'NEEDS_STABILIZATION'
        : v1.STATUS === 'DISLOCATION_CONFIRMED' ? 'NEEDS_FLUSH_CONFIRMATION'
        : v1.STATUS === 'RISK_OFF_BLOCKED' || v1.STATUS === 'INVALIDATED' || safety.safetyStatus === 'DANGER' ? 'INVALIDATED'
        // Never let a heuristic stage-machine ENTRY_READY leak through the fallback.
        : stageInfo.actionability === 'ENTRY_READY' ? 'NEAR_ENTRY'
        : stageInfo.actionability;
      // distanceToEntryReadyScore = 100 is reserved exclusively for confirmed V1
      // ENTRY_READY. All other candidates are capped below 100 by classifyRadarStage.
      const distanceToEntryReadyScore = entryReadyV1
        ? 100
        : Math.min(stageInfo.distanceToEntryReadyScore, 97);
        
      // Phase D1c: CoinGecko trending attention metadata injection
      let attentionMetadata = {};
      const cgCtx = scannerContext.coingeckoTrending;
      if (
        cgCtx &&
        cgCtx.source === 'coingecko' &&
        cgCtx.kind === 'trending' &&
        cgCtx.stale === false &&
        !cgCtx.unavailableReason &&
        Array.isArray(cgCtx.items)
      ) {
        let bestMatch = null;
        for (const item of cgCtx.items) {
          if (!Number.isFinite(item.rank) || item.rank <= 0) continue;
          
          const matchResult = matchCoinGeckoTrendingToMarketSymbol(item, m.symbol);
          if (matchResult && matchResult.matched) {
            if (!bestMatch || item.rank < bestMatch.rank) {
              bestMatch = { item, matchResult };
            }
          }
        }
        if (bestMatch) {
          attentionMetadata = {
            ATTENTION_SOURCE: 'coingecko',
            ATTENTION_KIND: 'trending',
            ATTENTION_RANK: bestMatch.item.rank,
            ATTENTION_LABEL: `CG #${bestMatch.item.rank}`,
            ATTENTION_MATCH_CONFIDENCE: bestMatch.matchResult.confidence
          };
        }
      }

      return {
        symbol: m.symbol,
        ...attentionMetadata,
        stage: stageInfo.stage,
        actionability: effectiveActionability,
        distanceToEntryReadyScore,
        setupQualityScore: stageInfo.setupQualityScore,
        confidence: adjustedConfidence,
        entryType: stageInfo.entryType,
        entryZone: levels.entryZone,
        invalidationLevel: levels.invalidationLevel,
        suggestedStop: levels.suggestedStop,
        stopReference: levels.stopReference,
        takeProfitCheckpoints: levels.takeProfitCheckpoints,
        safety,
        safetyStatus: safety.safetyStatus,
        finalSafetyStatus: safety.finalSafetyStatus,
        safetyScore: safety.safetyScore,
        safetyReason: safety.safetyReason,
        safetyReasons: safety.reasons,
        safetyBasis: safety.safetyBasis,
        chainSafetyStatus: safety.chainSafetyStatus,
        chainSafetyReason: safety.chainSafetyReason,
        listingSafetyStatus: safety.listingSafetyStatus,
        listingSafetyReason: safety.listingSafetyReason,
        listingSource: safety.listingSource,
        listingType: safety.listingType,
        alphaTokenId: safety.alphaTokenId,
        alphaPair: safety.alphaPair,
        humanSymbol: safety.humanSymbol,
        alphaCandidates: safety.alphaCandidates,
        safetyConfidence: safety.confidence,
        chain: safety.chain,
        contractAddress: safety.contractAddress,
        safetySource: safety.metadataSource || safety.source,
        ...v1,
        v1Status: v1.STATUS,
        v1Action: v1.ACTION,
        v1BlockedBy: v1.BLOCKED_BY,
        v1NextConfirmation: v1.NEXT_CONFIRMATION,
        reasons: stageInfo.reasons,
        riskFlags: compactReasons([
          ...(stageInfo.riskFlags || []),
          ...(safety.safetyStatus === 'SAFE' ? [] : [`safety ${safety.safetyStatus} — entry/alert blocked until verified`]),
          ...((v1.executionDataMissing || []).length ? [`missing execution data: ${(v1.executionDataMissing || []).join(', ')}`] : []),
        ], 8),
        conditionChecklist: stageInfo.conditionChecklist,
        // Microstructure blocking diagnostics (additive, gate-free).
        hasStaticMicrostructure: microDiag.hasStaticMicrostructure,
        hasRollingMicrostructure: microDiag.hasRollingMicrostructure,
        missingAbsorptionFields: microDiag.missingAbsorptionFields,
        missingReclaimFields: microDiag.missingReclaimFields,
        absorptionBlockedReason: microDiag.absorptionBlockedReason,
        reclaimBlockedReason: microDiag.reclaimBlockedReason,
        missingSignals: missingForMarket(m).slice(0, 8),
        marketRegimeDiagnostics: regime.diagnostics,
        nextRequiredConfirmation: v1.NEXT_CONFIRMATION || stageInfo.nextRequiredConfirmation,
        blockedBy: v1.BLOCKED_BY
          || (v1.STATUS === 'INVALIDATED' || v1.STATUS === 'RISK_OFF_BLOCKED' ? v1.INVALIDATION
          : safety.safetyStatus !== 'SAFE' && entryReadyV1 ? `safety ${safety.safetyStatus} (not SAFE) blocks entry/alert`
          : stageInfo.blockedBy),
        // Telegram eligibility is fail-safe: V1 ENTRY_READY + all conditions +
        // confidence>=75 + concrete entry/stop + safety strictly SAFE. UNKNOWN or
        // DANGER safety can never be alertable here.
        telegramEligible: entryReadyV1 && v1.allRadarConditionsPassed && adjustedConfidence >= 75 && levels.entryZone != null && (levels.invalidationLevel != null || levels.suggestedStop != null) && safety.safetyStatus === 'SAFE',
        sourceSignals: Array.isArray(m.scannerTags) ? m.scannerTags : [],
        diagnostics: {
          change24hPct: round(n(m.change24hPct ?? m.priceChangePercent), 2),
          spreadPct: round(m.spreadPct, 4),
          quoteVolume: round(m.quoteVolume, 0),
          depthUsd: round(m.depthUsd, 0),
          missingSignals: missingForMarket(m).slice(0, 8),
          hasStaticMicrostructure: microDiag.hasStaticMicrostructure,
          hasRollingMicrostructure: microDiag.hasRollingMicrostructure,
          missingAbsorptionFields: microDiag.missingAbsorptionFields,
          missingReclaimFields: microDiag.missingReclaimFields,
          ...(v1.diagnostics || {}),
        },
      };
    }).sort((a, b) => {
        const v1Rank = { EARLY_ENTRY_READY: 8, STANDARD_ENTRY_READY: 8, AGGRESSIVE_ENTRY_READY: 8, ENTRY_READY: 7, EXTENDED_ENTRY: 7, CHASE_RISK: 6, WAIT_FOR_PULLBACK: 6, RECLAIM_DETECTED: 6, NEAR_ENTRY: 6, WAIT_FOR_RECLAIM: 5, STABILIZATION: 5, LONG_FLUSH_CONFIRMED: 4, NEEDS_ABSORPTION: 5, NEEDS_STABILIZATION: 4, DISLOCATION_CONFIRMED: 3, NEEDS_CONFIRMATION: 4, NEEDS_FLUSH_CONFIRMATION: 3, WATCH_ONLY: 2, RISK_OFF_BLOCKED: 1, INVALIDATED: 1 };
        const aAction = v1Rank[a.STATUS] || ({ ENTRY_READY: 7, NEAR_ENTRY: 6, NEEDS_ABSORPTION: 5, NEEDS_STABILIZATION: 4, NEEDS_CONFIRMATION: 4, NEEDS_FLUSH_CONFIRMATION: 3, WATCH_ONLY: 2, INVALIDATED: 1 }[a.actionability] || 0);
        const bAction = v1Rank[b.STATUS] || ({ ENTRY_READY: 7, NEAR_ENTRY: 6, NEEDS_ABSORPTION: 5, NEEDS_STABILIZATION: 4, NEEDS_CONFIRMATION: 4, NEEDS_FLUSH_CONFIRMATION: 3, WATCH_ONLY: 2, INVALIDATED: 1 }[b.actionability] || 0);
        if (aAction !== bAction) return bAction - aAction;
        if (a.distanceToEntryReadyScore !== b.distanceToEntryReadyScore) return b.distanceToEntryReadyScore - a.distanceToEntryReadyScore;
        if (a.setupQualityScore !== b.setupQualityScore) return b.setupQualityScore - a.setupQualityScore;
        const aLiq = (a.diagnostics && a.diagnostics.quoteVolume) || 0;
        const bLiq = (b.diagnostics && b.diagnostics.quoteVolume) || 0;
        return bLiq - aLiq;
      });

    const selected = selectedSymbol
      ? candidates.find((c) => c.symbol === String(selectedSymbol).toUpperCase()) || candidates[0] || null
      : candidates[0] || null;
    const position = Array.isArray(positions) && positions.length
      ? (selected ? positions.find((p) => String(p.symbol || '').toUpperCase() === selected.symbol) : null) || positions[0]
      : null;
    const positionSymbol = position ? String(position.symbol || '').toUpperCase() : null;
    const positionMarket = positionSymbol
      ? universe.find((m) => m.symbol === positionSymbol) || markets.find((m) => String(m.symbol || '').toUpperCase() === positionSymbol) || {}
      : (selected ? universe.find((m) => m.symbol === selected.symbol) || {} : {});

    const fullDiagnostics = {
      ...diagnostics,
      scannerRowsAvailable: Number(scannerContext.scannerRowsAvailable) || scannerCandidates.length,
      scannerRowsSent: Number(scannerContext.scannerRowsSent) || scannerCandidates.length,
      scannerRowsReceived: Number(scannerContext.scannerRowsReceived) || scannerCandidates.length,
      scannerRowsSanitized: Number(scannerContext.scannerRowsSanitized) || scannerCandidates.length,
      scannerRowsRejected: Number(scannerContext.scannerRowsRejected) || 0,
      radarRowsEvaluated: candidates.length,
      radarRowsDisplayed: 20,
      fieldMappingDetected: Array.isArray(scannerContext.fieldMappingDetected) ? scannerContext.fieldMappingDetected : [],
      rejectedByReason: { ...(scannerContext.rejectedByReason || {}), ...(diagnostics.rejected || {}) },
      topRejectedSamples: [
        ...((scannerContext.topRejectedSamples || scannerContext.rejectedSamples || []).slice(0, 10)),
        ...(diagnostics.rejectedSamples || []).slice(0, 20),
      ].slice(0, 30),
      ...buildSafetyDiagnostics(safetyResults),
    };

    state.marketRegime = regime;
    state.universeDiagnostics = fullDiagnostics;
    state.scannerCandidatesIngested = scannerCandidates.length;
    state.snapshotSymbolsIngested = markets.length;
    state.candidatesByStage = state.pipeline;
    state.candidates = candidates;
    state.watchlist = candidates.filter((c) => c.actionability !== 'ENTRY_READY').slice(0, 20);
    // entryReady is single-sourced from V1 actionability. A heuristic stage of
    // ENTRY_READY is NOT sufficient — this prevents the banner/count/status from
    // ever claiming ENTRY_READY without a real V1/spec pass.
    state.entryReady = candidates.filter((c) => c.actionability === 'ENTRY_READY').slice(0, 10);
    state.selected = selected;
    state.exitGuidance = buildExitGuidance({ market: positionMarket, position, regime, now });
    state.pipeline = buildPipeline(candidates, universe.length);
    state.absorbFunnel = buildAbsorbFunnel(candidates, universe.length);
    state.pipeline.absorbFunnel = state.absorbFunnel;
    state.reclaimFunnel = buildReclaimFunnel(candidates, universe.length);
    state.pipeline.reclaimFunnel = state.reclaimFunnel;
    state.candidatesByStage = { ...state.pipeline };
    state.missingSignals = Array.from(allMissing).sort();
    state.dataCompleteness = completeness(state.missingSignals);
    if (freshnessMs != null && freshnessMs > 120000) {
      state.missingSignals = Array.from(new Set([...state.missingSignals, 'fresh public snapshot'])).sort();
    }
    state.status = radarStatus(state);
    return state;
  } catch (err) {
    return { ...state, status: 'ERROR', lastError: err && err.message ? err.message : String(err) };
  }
}
