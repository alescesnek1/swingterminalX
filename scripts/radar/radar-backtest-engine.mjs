import { validateRadarCandidateForTradeIntent } from './trade-intent-candidate-validation.mjs';
import { validateHistoricalMarketDataset } from './historical-data-contract.mjs';

const MODES = new Set(['spot', 'futures']);
const QUOTES = new Set(['USDT', 'USDC']);

function record(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function add(values, code) { if (!values.includes(code)) values.push(code); }
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function emptySummary() { return { trades: 0, wins: 0, losses: 0, winRate: 0, grossPnl: 0, fees: 0, netPnl: 0, maxDrawdown: 0, exposureTime: 0, openPositions: 0 }; }
function event(type, details = {}) { return { type, ...details }; }
function round(value) { return Math.round(value * 1e8) / 1e8; }
function candidateStop(candidate) { return candidate.HARD_INVALIDATION ?? candidate.invalidationLevel ?? candidate.STOP_LOSS_LEVEL ?? candidate.suggestedStop; }
function candidateTarget(candidate) {
  const levels = candidate.TAKE_PROFIT_LEVELS ?? candidate.takeProfitCheckpoints;
  const first = Array.isArray(levels) ? levels[0] : null;
  return record(first) ? first.level : first;
}
function safeCosts(value) {
  const costs = record(value) ? value : {};
  return {
    makerFeeBps: costs.makerFeeBps ?? 0,
    takerFeeBps: costs.takerFeeBps ?? 0,
    slippageBps: costs.slippageBps ?? 0,
    spreadBps: costs.spreadBps ?? 0,
  };
}
function validCosts(costs) { return Object.values(costs).every((value) => finite(value) && value >= 0); }
function emptyResult(reasonCodes, warnings, events, assumptions = {}) {
  return { ok: false, reasonCodes, warnings, summary: emptySummary(), events, assumptions };
}

export function runRadarBacktest(input) {
  const events = [];
  const reasonCodes = [];
  const warnings = [];
  if (!record(input)) return emptyResult(['missing_backtest_input'], warnings, [event('unknown_state', { reasonCodes: ['missing_backtest_input'] })]);

  const dataset = input.dataset;
  const fixture = input.candidateFixture;
  const mode = input.mode;
  const quote = input.quote;
  const clockMs = input.clockMs;
  const costs = safeCosts(input.costAssumptions);
  const feeModel = input.feeModel === 'maker' ? 'maker' : 'taker';
  const fillModel = record(input.fillModel) ? input.fillModel : { kind: 'candle_close' };
  const closeAtDatasetEnd = input.closeAtDatasetEnd === true;
  const positionSize = input.positionSize ?? 1;
  const leverage = mode === 'futures' ? (input.leverage ?? 1) : 1;
  const marginMode = mode === 'futures' ? (input.marginMode ?? 'isolated') : 'cash';
  const assumptions = {
    mode: typeof mode === 'string' ? mode : null,
    quote: typeof quote === 'string' ? quote : null,
    fillModel: fillModel.kind ?? null,
    feeModel,
    costAssumptions: costs,
    positionSize: finite(positionSize) ? positionSize : null,
    leverage: finite(leverage) ? leverage : null,
    marginMode,
    closeAtDatasetEnd,
    intrabarPriority: 'stop_first',
    funding: record(dataset?.futures) ? { status: dataset.futures.status ?? 'UNKNOWN', fundingRate: dataset.futures.fundingRate ?? null, markPrice: dataset.futures.markPrice ?? null, indexPrice: dataset.futures.indexPrice ?? null } : { status: 'UNKNOWN', fundingRate: null, markPrice: null, indexPrice: null },
    liquidation: record(dataset?.futures?.liquidationDistance) ? dataset.futures.liquidationDistance : { status: 'UNKNOWN' },
  };

  if (!MODES.has(mode) || !QUOTES.has(quote) || !Number.isFinite(clockMs) || !validCosts(costs) || !finite(positionSize) || positionSize <= 0) {
    add(reasonCodes, 'invalid_backtest_assumptions');
    events.push(event('unknown_state', { reasonCodes: [...reasonCodes] }));
    return emptyResult(reasonCodes, warnings, events, assumptions);
  }
  if (mode === 'futures' && (!finite(leverage) || leverage < 1 || leverage > 2 || marginMode !== 'isolated')) {
    add(reasonCodes, 'risk_limit_invalid');
    events.push(event('risk_vetoed', { reasonCodes: [...reasonCodes] }));
    return emptyResult(reasonCodes, warnings, events, assumptions);
  }

  const datasetValidation = validateHistoricalMarketDataset(dataset);
  events.push(event('dataset_validated', { ok: datasetValidation.ok, reasonCodes: datasetValidation.reasonCodes, warnings: datasetValidation.warnings, datasetVersion: datasetValidation.datasetVersion }));
  warnings.push(...datasetValidation.warnings);
  if (!datasetValidation.ok) {
    reasonCodes.push(...datasetValidation.reasonCodes);
    events.push(event('unknown_state', { reasonCodes: [...reasonCodes] }));
    return emptyResult(reasonCodes, warnings, events, assumptions);
  }
  if (dataset?.provenance?.product !== mode || dataset?.provenance?.quote !== quote) {
    add(reasonCodes, dataset?.provenance?.product !== mode ? 'unsupported_product' : 'unsupported_quote');
    events.push(event('unknown_state', { reasonCodes: [...reasonCodes] }));
    return emptyResult(reasonCodes, warnings, events, assumptions);
  }

  const candidate = record(fixture) ? fixture.candidate : null;
  const candidateValidation = validateRadarCandidateForTradeIntent(candidate, {
    nowMs: clockMs,
    maxAgeMs: input.candidateMaxAgeMs ?? 120000,
    symbolMapping: fixture?.symbolMapping,
  });
  events.push(event('candidate_validated', { ok: candidateValidation.ok, reasonCodes: candidateValidation.reasonCodes, source: candidateValidation.source }));
  if (!candidateValidation.ok) {
    reasonCodes.push(...candidateValidation.reasonCodes);
    events.push(event('unknown_state', { reasonCodes: [...reasonCodes] }));
    return emptyResult(reasonCodes, warnings, events, assumptions);
  }

  const evidenceValidation = validateHistoricalMarketDataset(dataset, {
    requiredRadarFields: ['strict_absorb', 'actionability'],
    historicalCandidateFixture: fixture,
  });
  if (!evidenceValidation.ok) {
    reasonCodes.push(...evidenceValidation.reasonCodes);
    warnings.push(...evidenceValidation.warnings.filter((code) => !warnings.includes(code)));
    events.push(event('unknown_state', { reasonCodes: [...reasonCodes], evidence: 'historical_candidate_required' }));
    return emptyResult(reasonCodes, warnings, events, assumptions);
  }

  const stop = candidateStop(candidate);
  const target = candidateTarget(candidate);
  if (!finite(stop) || !finite(target) || stop <= 0 || target <= 0) {
    add(reasonCodes, 'unknown_state');
    events.push(event('unknown_state', { reasonCodes: [...reasonCodes], detail: 'candidate_levels_missing' }));
    return emptyResult(reasonCodes, warnings, events, assumptions);
  }
  events.push(event('intent_created', { symbol: candidateValidation.normalizedInputSummary.normalizedSymbol, mode, quote, stop, target }));
  events.push(event('risk_approved', { leverage, marginMode, fundingStatus: assumptions.funding.status, liquidationStatus: assumptions.liquidation.status ?? 'UNKNOWN' }));

  const candles = Array.isArray(dataset.candles) ? dataset.candles : [];
  const first = candles[0];
  const baseEntry = fillModel.kind === 'configured' ? fillModel.entryPrice : first?.close;
  if (!finite(baseEntry) || baseEntry <= 0) {
    add(reasonCodes, 'unknown_state');
    events.push(event('unknown_state', { reasonCodes: [...reasonCodes], detail: 'entry_price_missing' }));
    return emptyResult(reasonCodes, warnings, events, assumptions);
  }
  const executionBps = costs.slippageBps + (costs.spreadBps / 2);
  const entryPrice = baseEntry * (1 + executionBps / 10000);
  const feeBps = feeModel === 'maker' ? costs.makerFeeBps : costs.takerFeeBps;
  const entryFee = entryPrice * positionSize * feeBps / 10000;
  const entryTime = first?.closeTime ?? null;
  events.push(event('simulated_entry', { price: round(entryPrice), time: entryTime, size: positionSize, fee: round(entryFee) }));

  let exit = null;
  for (const candle of candles.slice(1)) {
    if (candle.low <= stop) { exit = { kind: 'simulated_stop', basePrice: stop, time: candle.closeTime }; break; }
    if (candle.high >= target) { exit = { kind: 'simulated_take_profit', basePrice: target, time: candle.closeTime }; break; }
  }
  if (!exit && closeAtDatasetEnd && candles.length) {
    exit = { kind: 'dataset_end_close', basePrice: candles[candles.length - 1].close, time: candles[candles.length - 1].closeTime };
  }

  const summary = emptySummary();
  summary.trades = 1;
  if (!exit) {
    summary.fees = round(entryFee);
    summary.netPnl = round(-entryFee);
    summary.maxDrawdown = round(Math.max(0, -summary.netPnl));
    summary.openPositions = 1;
    events.push(event('unknown_state', { detail: 'position_open_at_dataset_end' }));
    return { ok: true, reasonCodes, warnings, summary, events, assumptions };
  }
  const exitPrice = exit.basePrice * (1 - executionBps / 10000);
  const exitFee = exitPrice * positionSize * feeBps / 10000;
  const grossPnl = (exitPrice - entryPrice) * positionSize;
  const fees = entryFee + exitFee;
  const netPnl = grossPnl - fees;
  events.push(event(exit.kind, { price: round(exitPrice), time: exit.time }));
  events.push(event('simulated_exit', { reason: exit.kind, price: round(exitPrice), time: exit.time, grossPnl: round(grossPnl), fees: round(fees), netPnl: round(netPnl) }));
  summary.wins = netPnl > 0 ? 1 : 0;
  summary.losses = netPnl < 0 ? 1 : 0;
  summary.winRate = summary.wins / summary.trades;
  summary.grossPnl = round(grossPnl);
  summary.fees = round(fees);
  summary.netPnl = round(netPnl);
  summary.maxDrawdown = round(Math.max(0, -netPnl));
  const entryMs = Date.parse(entryTime); const exitMs = Date.parse(exit.time);
  summary.exposureTime = Number.isFinite(entryMs) && Number.isFinite(exitMs) ? Math.max(0, exitMs - entryMs) : 0;
  return { ok: true, reasonCodes, warnings, summary, events, assumptions };
}
