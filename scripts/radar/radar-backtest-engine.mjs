import { validateRadarCandidateForTradeIntent } from './trade-intent-candidate-validation.mjs';
import { validateHistoricalMarketDataset } from './historical-data-contract.mjs';

const MODES = new Set(['spot', 'futures']);
const QUOTES = new Set(['USDT', 'USDC']);
function record(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function num(v) { return typeof v === 'number' && Number.isFinite(v); }
function add(a, v) { if (!a.includes(v)) a.push(v); }
function round(v) { return Math.round(v * 1e8) / 1e8; }
function event(type, details = {}) { return { type, ...details }; }
function stopOf(c) { return c.HARD_INVALIDATION ?? c.invalidationLevel ?? c.STOP_LOSS_LEVEL ?? c.suggestedStop; }
function targetOf(c) { const levels = c.TAKE_PROFIT_LEVELS ?? c.takeProfitCheckpoints; const first = Array.isArray(levels) ? levels[0] : null; return record(first) ? first.level : first; }
function emptySummary() { return { trades: 0, wins: 0, losses: 0, winRate: 0, grossPnl: 0, fees: 0, netPnl: 0, maxDrawdown: 0, exposureTime: 0, openPositions: 0 }; }
function costsOf(value) { const c = record(value) ? value : {}; return { makerFeeBps: c.makerFeeBps ?? 0, takerFeeBps: c.takerFeeBps ?? 0, slippageBps: c.slippageBps ?? 0, spreadBps: c.spreadBps ?? 0 }; }
function validCosts(c) { return Object.values(c).every((v) => num(v) && v >= 0); }
function fills(value) { const kind = value?.kind ?? value ?? 'candleClose'; return ['candleClose', 'nextOpen', 'conservativeIntrabar'].includes(kind) ? kind : null; }
function plansOf(input) { return Array.isArray(input.tradePlans) ? input.tradePlans : input.candidateFixture ? [{ candidateFixture: input.candidateFixture, entryCandleIndex: 0 }] : []; }
function ledger(balance) { return { initialBalance: balance, realizedPnl: 0, unrealizedPnl: 0, fees: 0, fundingFees: 0, equity: balance, availableBalance: balance, marginUsed: 0 }; }
function result(ok, reasonCodes, warnings, summary, events, assumptions, riskDecisions, equityCurve, quoteLedgers, positions) { return { ok, reasonCodes, warnings, summary, events, assumptions, riskDecisions, equityCurve, quoteLedgers, positions }; }

function sizingFor(sizing, balance, entry, stop, limits) {
  const reasons = [];
  if (!record(sizing) || !['fixedNotional', 'percentEquity', 'riskAtStopPercentEquity'].includes(sizing.model)) return { reasons: ['invalid_sizing_model'] };
  let notional;
  if (sizing.model === 'fixedNotional') notional = sizing.fixedNotional;
  if (sizing.model === 'percentEquity') notional = balance * sizing.percentEquity;
  if (sizing.model === 'riskAtStopPercentEquity') {
    if (!num(stop) || stop <= 0 || stop >= entry) return { reasons: ['missing_stop'] };
    const riskAmount = balance * sizing.riskAtStopPercentEquity;
    notional = riskAmount * entry / (entry - stop);
  }
  if (!num(notional) || notional <= 0) return { reasons: ['invalid_sizing_model'] };
  const quantity = notional / entry;
  const realRisk = num(stop) && stop < entry ? quantity * (entry - stop) : 0;
  if (num(limits.maxExposurePerTrade) && notional > limits.maxExposurePerTrade) add(reasons, 'max_exposure_exceeded');
  if (num(limits.maxRealRiskAtStop) && realRisk > limits.maxRealRiskAtStop) add(reasons, 'max_real_risk_exceeded');
  return { reasons, notional, quantity, realRisk };
}

// A simulated trade may only ever mix prices from ONE price domain. The entry comes
// from the dataset's candles while stop/target come from the candidate fixture, so
// nothing structurally prevented a fixture captured on a DIFFERENT symbol from being
// replayed against this dataset. Observed: a candidate whose levels were stop 135 /
// target 145 replayed against a dataset trading near 73,900 entered at 73,939 and
// "hit its take profit" at 144.89 — a -99.9% loss reported as a take-profit exit.
//
// The invariant is therefore explicit: the levels must bracket the entry, and both
// must lie inside the price band the dataset actually traded in. A violation is a
// VETO — never a trade, never a PnL number — because a number produced across two
// price domains is not a worse estimate, it is a different market's arithmetic.
const LEVEL_BAND_TOLERANCE = 0.5; // ±50% around the dataset's own high/low band

function datasetPriceBand(candles) {
  let low = Infinity; let high = -Infinity;
  for (const candle of candles) {
    if (num(candle?.low)) low = Math.min(low, candle.low);
    if (num(candle?.high)) high = Math.max(high, candle.high);
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return { low: low * (1 - LEVEL_BAND_TOLERANCE), high: high * (1 + LEVEL_BAND_TOLERANCE) };
}

// Returns the reason codes for an incompatible level set; empty when consistent.
export function levelDomainReasons(entry, stop, target, band) {
  const reasons = [];
  if (!num(entry) || entry <= 0) return ['unknown_state'];
  if (num(stop) && stop >= entry) add(reasons, 'levels_not_bracketing_entry');
  if (num(target) && target <= entry) add(reasons, 'levels_not_bracketing_entry');
  if (band) {
    for (const level of [stop, target]) {
      if (num(level) && (level < band.low || level > band.high)) add(reasons, 'levels_outside_market_range');
    }
  }
  return reasons;
}

function fillRatio(value) { return num(value) && value > 0 && value <= 1 ? value : null; }
function utcDay(value) { const ms = Date.parse(value); return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null; }
function fundingFeesFor(dataset, notional, entryTime, exitTime, warnings) { const futures = dataset?.futures; if (!record(futures)) return 0; const events = Array.isArray(futures.fundingEvents) ? futures.fundingEvents : null; if (events) { let fee = 0; for (const item of events) { const at = Date.parse(item?.time); if (Number.isFinite(at) && at > Date.parse(entryTime) && at <= Date.parse(exitTime) && num(item.rate)) fee += notional * item.rate; } return fee; } if (num(futures.fundingRate)) return notional * futures.fundingRate; add(warnings, 'funding_unknown'); return 0; }
function fillPrice(kind, candles, index) {
  const candle = candles[index];
  if (!candle) return null;
  if (kind === 'candleClose') return { price: candle.close, startIndex: index + 1, time: candle.closeTime };
  if (kind === 'nextOpen') { const next = candles[index + 1]; return next ? { price: next.open, startIndex: index + 2, time: next.openTime } : null; }
  return { price: candle.high, startIndex: index + 1, time: candle.closeTime };
}

export function runRadarBacktest(input) {
  const reasonCodes = []; const warnings = []; const events = []; const riskDecisions = []; const equityCurve = []; const positions = [];
  if (!record(input)) return result(false, ['missing_backtest_input'], warnings, emptySummary(), [event('unknown_state', { reasonCodes: ['missing_backtest_input'] })], {}, riskDecisions, equityCurve, {}, positions);
  const mode = input.mode; const quote = input.quote; const clockMs = input.clockMs; const costs = costsOf(input.costAssumptions); const fillModel = fills(input.fillModel); const feeModel = input.feeModel === 'maker' ? 'maker' : 'taker';
  const leverage = mode === 'futures' ? (input.leverage ?? 1) : 1; const marginMode = mode === 'futures' ? (input.marginMode ?? 'isolated') : 'cash'; const limits = record(input.riskLimits) ? input.riskLimits : {};
  const balances = record(input.quoteBalances) ? input.quoteBalances : {}; const balance = balances[quote]; const plans = plansOf(input); const closeAtDatasetEnd = input.closeAtDatasetEnd === true; const partialEntryRatio = input.partialFillRatio === undefined ? 1 : fillRatio(input.partialFillRatio); const partialExitRatio = input.partialExitRatio === undefined ? 1 : fillRatio(input.partialExitRatio);
  const assumptions = { sizingModel: input.sizing?.model ?? null, fillModel, feeModel, costAssumptions: costs, mode, quote, leverage, marginMode, closeAtDatasetEnd, intrabarPriority: 'stop_first', reduceOnlyExit: true, crossMargin: false, averagingDown: false, martingale: false, funding: record(input.dataset?.futures) ? { status: input.dataset.futures.status ?? 'UNKNOWN', fundingRate: input.dataset.futures.fundingRate ?? null } : { status: 'UNKNOWN', fundingRate: null }, liquidation: record(input.dataset?.futures?.liquidationDistance) ? input.dataset.futures.liquidationDistance : { status: 'UNKNOWN' }, partialFillPolicy: { entryRatio: partialEntryRatio, exitRatio: partialExitRatio, unfilledEntry: 'cancelled', remainingExit: 'mark_to_dataset_end' }, gapPolicy: input.gapPolicy ?? 'reject', dailyBoundaryPolicy: input.dailyBoundaryPolicy ?? 'UTC', candidateFreshnessAtFill: input.candidateFreshnessAtFill === true, fundingPolicy: input.fundingPolicy ?? 'known_only' };
  const ledgers = {};
  for (const q of QUOTES) if (num(balances[q])) { ledgers[q] = ledger(balances[q]); equityCurve.push({ quote: q, time: null, equity: balances[q], realizedPnl: 0, unrealizedPnl: 0 }); }
  const summary = emptySummary();
  if (!MODES.has(mode)) add(reasonCodes, 'unsupported_product');
  if (!QUOTES.has(quote)) add(reasonCodes, 'unsupported_quote');
  if (!num(clockMs) || !fillModel || !validCosts(costs) || !plans.length || !partialEntryRatio || !partialExitRatio) add(reasonCodes, 'invalid_backtest_assumptions');
  if (!num(balance)) add(reasonCodes, 'unknown_balance');
  if (mode === 'futures' && (!num(leverage) || leverage < 1 || leverage > 2 || marginMode !== 'isolated')) add(reasonCodes, leverage > 2 ? 'leverage_too_high' : 'unsupported_product');
  if (reasonCodes.length) { events.push(event('unknown_state', { reasonCodes })); return result(false, reasonCodes, warnings, summary, events, assumptions, riskDecisions, equityCurve, ledgers, positions); }

  const datasetResult = validateHistoricalMarketDataset(input.dataset);
  events.push(event('dataset_validated', { ok: datasetResult.ok, reasonCodes: datasetResult.reasonCodes, warnings: datasetResult.warnings, datasetVersion: datasetResult.datasetVersion }));
  warnings.push(...datasetResult.warnings);
  if (!datasetResult.ok) return result(false, datasetResult.reasonCodes, warnings, summary, events, assumptions, riskDecisions, equityCurve, ledgers, positions);
  if (Array.isArray(input.dataset.gaps) && input.dataset.gaps.length) { const codes = ['candle_gap']; events.push(event('unknown_state', { reasonCodes: codes, gapPolicy: assumptions.gapPolicy })); return result(false, codes, warnings, summary, events, assumptions, riskDecisions, equityCurve, ledgers, positions); }
  if (input.dataset.provenance.product !== mode || input.dataset.provenance.quote !== quote) { const code = input.dataset.provenance.product !== mode ? 'unsupported_product' : 'unsupported_quote'; events.push(event('unknown_state', { reasonCodes: [code] })); return result(false, [code], warnings, summary, events, assumptions, riskDecisions, equityCurve, ledgers, positions); }

  const candles = [...input.dataset.candles].sort((a, b) => String(a.openTime).localeCompare(String(b.openTime))); const feeBps = feeModel === 'maker' ? costs.makerFeeBps : costs.takerFeeBps; const executionBps = costs.slippageBps + costs.spreadBps / 2; let dailyPnl = num(input.dailyRealizedPnl?.[quote]) ? input.dailyRealizedPnl[quote] : 0;
  for (let planIndex = 0; planIndex < plans.length; planIndex += 1) {
    const plan = record(plans[planIndex]) ? plans[planIndex] : {}; const fixture = plan.candidateFixture; const candidate = fixture?.candidate;
    const candidateResult = validateRadarCandidateForTradeIntent(candidate, { nowMs: clockMs, maxAgeMs: input.candidateMaxAgeMs ?? 120000, symbolMapping: fixture?.symbolMapping });
    events.push(event('candidate_validated', { planIndex, ok: candidateResult.ok, reasonCodes: candidateResult.reasonCodes }));
    if (!candidateResult.ok) { const candidateReasons = [...candidateResult.reasonCodes]; if (input.sizing?.model === 'riskAtStopPercentEquity' && !num(stopOf(candidate ?? {}))) add(candidateReasons, 'missing_stop'); riskDecisions.push({ planIndex, decision: 'vetoed', reasonCodes: candidateReasons }); events.push(event('risk_vetoed', { planIndex, reasonCodes: candidateReasons })); continue; }
    const evidence = validateHistoricalMarketDataset(input.dataset, { requiredRadarFields: ['strict_absorb', 'actionability'], historicalCandidateFixture: fixture });
    if (!evidence.ok) { riskDecisions.push({ planIndex, decision: 'vetoed', reasonCodes: evidence.reasonCodes }); events.push(event('unknown_state', { planIndex, reasonCodes: evidence.reasonCodes })); continue; }
    const entryFill = fillPrice(fillModel, candles, plan.entryCandleIndex ?? 0);
    const stop = stopOf(candidate); const target = targetOf(candidate);
    const decisionCodes = [];
    if (input.candidateFreshnessAtFill === true) { const updatedAt = Date.parse(candidate?.updatedAt ?? candidate?.capturedAt ?? ''); const fillAt = Date.parse(entryFill?.time ?? ''); const maxAge = input.candidateMaxAgeMs ?? 120000; if (!Number.isFinite(updatedAt) || !Number.isFinite(fillAt) || fillAt - updatedAt > maxAge) add(decisionCodes, 'stale_data'); }
    if (!entryFill || !num(entryFill.price) || entryFill.price <= 0) add(decisionCodes, 'unknown_state');
    if (!num(stop) || stop <= 0) add(decisionCodes, 'missing_stop');
    const active = positions.filter((p) => p.status === 'OPEN').length;
    if (num(limits.maxOpenPositions) && active >= limits.maxOpenPositions) add(decisionCodes, 'max_open_positions_exceeded');
    if (mode === 'futures' && assumptions.liquidation.status === 'UNKNOWN') { add(warnings, 'liquidation_unknown'); add(decisionCodes, 'liquidation_unknown'); }
    const baseEntry = entryFill?.price; const entryPrice = num(baseEntry) ? baseEntry * (1 + executionBps / 10000) : null;
    // Price-domain invariant, BEFORE sizing: a level set that does not belong to this
    // market can never become a position, a fill, or a PnL figure.
    for (const code of levelDomainReasons(entryPrice, stop, target, datasetPriceBand(candles))) add(decisionCodes, code);
    const size = num(entryPrice) ? sizingFor(input.sizing, ledgers[quote].equity, entryPrice, stop, limits) : { reasons: ['unknown_state'] };
    for (const code of size.reasons) add(decisionCodes, code);
    if (num(limits.maxDailyLoss) && dailyPnl - (size.realRisk ?? 0) <= -limits.maxDailyLoss) add(decisionCodes, 'max_daily_loss_exceeded');
    const blocking = decisionCodes.filter((code) => code !== 'liquidation_unknown');
    if (blocking.length) { riskDecisions.push({ planIndex, decision: 'vetoed', reasonCodes: decisionCodes }); events.push(event('risk_vetoed', { planIndex, reasonCodes: decisionCodes })); continue; }
    riskDecisions.push({ planIndex, decision: 'approved', reasonCodes: decisionCodes }); events.push(event('intent_created', { planIndex, symbol: candidateResult.normalizedInputSummary.normalizedSymbol, quote, notional: round(size.notional) })); events.push(event('risk_approved', { planIndex, reasonCodes: decisionCodes, leverage, marginMode }));
    const filled = { notional: size.notional * partialEntryRatio, quantity: size.quantity * partialEntryRatio, realRisk: size.realRisk * partialEntryRatio }; const entryFee = entryPrice * filled.quantity * feeBps / 10000; const position = { id: 'position-' + (planIndex + 1), planIndex, quote, mode, status: 'OPEN', entryPrice: round(entryPrice), entryTime: entryFill.time, quantity: round(filled.quantity), notional: round(filled.notional), requestedNotional: round(size.notional), filledNotional: round(filled.notional), unfilledNotional: round(size.notional - filled.notional), entryFillRatio: partialEntryRatio, unfilledEntryPolicy: 'cancelled', realRisk: round(filled.realRisk), stop, target, leverage, marginUsed: round(mode === 'futures' ? filled.notional / leverage : filled.notional), entryFee: round(entryFee), exitFee: 0, fundingFee: 0, realizedPnl: 0, unrealizedPnl: 0 };
    positions.push(position); ledgers[quote].marginUsed += position.marginUsed; events.push(event('simulated_entry', { planIndex, positionId: position.id, price: position.entryPrice, time: position.entryTime, quantity: position.quantity, fee: position.entryFee, fillRatio: partialEntryRatio, unfilledPolicy: 'cancelled' }));
    let exit = null;
    for (const candle of candles.slice(entryFill.startIndex)) {
      if (candle.gapAfter === true) { add(warnings, 'candle_gap'); exit = { kind: 'simulated_stop', price: stop, time: candle.closeTime, gapPolicy: 'conservative_stop_on_gap' }; break; }
      const stopHit = candle.low <= stop; const targetHit = num(target) && candle.high >= target;
      if (stopHit || targetHit) { if (stopHit && targetHit) { add(warnings, 'ambiguous_intrabar_stop_first'); riskDecisions.push({ planIndex, decision: 'conservative_exit', reasonCodes: ['ambiguous_intrabar_stop_first'] }); } exit = { kind: stopHit ? 'simulated_stop' : 'simulated_take_profit', price: stopHit ? stop : target, time: candle.closeTime }; break; }
    }
    if (!exit && closeAtDatasetEnd) { const last = candles[candles.length - 1]; exit = { kind: 'dataset_end_close', price: last.close, time: last.closeTime }; }
    if (!exit) { const last = candles[candles.length - 1]; const mark = last.close * (1 - executionBps / 10000); position.unrealizedPnl = round((mark - entryPrice) * filled.quantity - entryFee); ledgers[quote].unrealizedPnl += position.unrealizedPnl; ledgers[quote].equity = round(ledgers[quote].initialBalance + ledgers[quote].realizedPnl + ledgers[quote].unrealizedPnl); ledgers[quote].availableBalance = round(ledgers[quote].equity - ledgers[quote].marginUsed); equityCurve.push({ quote, time: last.closeTime, equity: ledgers[quote].equity, realizedPnl: round(ledgers[quote].realizedPnl), unrealizedPnl: round(ledgers[quote].unrealizedPnl) }); events.push(event('unknown_state', { planIndex, detail: 'position_open_at_dataset_end' })); continue; }
    const exitPrice = exit.price * (1 - executionBps / 10000); const exitQuantity = filled.quantity * partialExitRatio; const remainingQuantity = filled.quantity - exitQuantity; const exitFee = exitPrice * exitQuantity * feeBps / 10000; const fundingFee = mode === 'futures' ? fundingFeesFor(input.dataset, filled.notional * partialExitRatio, position.entryTime, exit.time, warnings) : 0; const gross = (exitPrice - entryPrice) * exitQuantity; const net = gross - (entryFee * partialExitRatio) - exitFee - fundingFee;
    position.exitPrice = round(exitPrice); position.exitTime = exit.time; position.exitFee = round(exitFee); position.fundingFee = round(fundingFee); position.exitFillRatio = partialExitRatio; position.filledExitQuantity = round(exitQuantity); position.remainingQuantity = round(remainingQuantity); position.realizedPnl = round(net); ledgers[quote].realizedPnl += net; ledgers[quote].fees += entryFee + exitFee; ledgers[quote].fundingFees += fundingFee; dailyPnl += net;
    if (remainingQuantity > 0) { const last = candles[candles.length - 1]; const mark = last.close * (1 - executionBps / 10000); position.unrealizedPnl = round((mark - entryPrice) * remainingQuantity - (entryFee * (1 - partialExitRatio))); position.remainingExitPolicy = 'mark_to_dataset_end'; ledgers[quote].unrealizedPnl += position.unrealizedPnl; ledgers[quote].marginUsed -= position.marginUsed * partialExitRatio; events.push(event(exit.kind, { planIndex, positionId: position.id, price: round(exitPrice), time: exit.time, fillRatio: partialExitRatio, partial: true })); events.push(event('unknown_state', { planIndex, positionId: position.id, detail: 'partial_exit_remaining_open' })); } else { position.status = 'CLOSED'; ledgers[quote].marginUsed -= position.marginUsed; events.push(event(exit.kind, { planIndex, positionId: position.id, price: round(exitPrice), time: exit.time })); }
    ledgers[quote].equity = round(ledgers[quote].initialBalance + ledgers[quote].realizedPnl + ledgers[quote].unrealizedPnl); ledgers[quote].availableBalance = round(ledgers[quote].equity - ledgers[quote].marginUsed); equityCurve.push({ quote, time: exit.time, equity: ledgers[quote].equity, realizedPnl: round(ledgers[quote].realizedPnl), unrealizedPnl: round(ledgers[quote].unrealizedPnl) });
    events.push(event('simulated_exit', { planIndex, positionId: position.id, reason: exit.kind, netPnl: round(net), reduceOnly: true, fillRatio: partialExitRatio }));
    const entryMs = Date.parse(position.entryTime); const exitMs = Date.parse(exit.time); summary.exposureTime += Number.isFinite(entryMs) && Number.isFinite(exitMs) ? Math.max(0, exitMs - entryMs) : 0;
  }
  for (const q of Object.keys(ledgers)) { const l = ledgers[q]; l.equity = round(l.initialBalance + l.realizedPnl + l.unrealizedPnl); l.availableBalance = round(l.equity - l.marginUsed); }
  const relevant = ledgers[quote]; const closed = positions.filter((p) => p.status === 'CLOSED'); summary.trades = positions.length; summary.wins = closed.filter((p) => p.realizedPnl > 0).length; summary.losses = closed.filter((p) => p.realizedPnl < 0).length; summary.closedTrades = closed.length;
  // Win rate is a property of DECIDED trades. Dividing by every opened position let a
  // position still open at the dataset end silently drag the rate down, which reads as
  // a loss that never happened; `openPositions` reports those separately.
  summary.winRate = closed.length ? summary.wins / closed.length : 0; summary.grossPnl = round(closed.reduce((sum, p) => sum + p.realizedPnl + p.entryFee + p.exitFee + p.fundingFee, 0)); summary.fees = round(relevant?.fees ?? 0); summary.netPnl = round((relevant?.realizedPnl ?? 0) + (relevant?.unrealizedPnl ?? 0)); let peakEquity = -Infinity; let maxDrawdown = 0; for (const point of equityCurve.filter((point) => point.quote === quote)) { peakEquity = Math.max(peakEquity, point.equity); maxDrawdown = Math.max(maxDrawdown, peakEquity - point.equity); } summary.maxDrawdown = round(maxDrawdown); summary.openPositions = positions.filter((p) => p.status === 'OPEN').length;
  return result(true, reasonCodes, warnings, summary, events, assumptions, riskDecisions, equityCurve, ledgers, positions);
}


export function runRadarPortfolioBacktest(scenario) {
  const events = []; const riskDecisions = []; const reasonCodes = []; const warnings = [];
  if (!record(scenario) || scenario.schemaVersion !== 'radar-portfolio-scenario/v1' || scenario.scenarioVersion !== 1 || !Array.isArray(scenario.tradePlans)) return { ok: false, reasonCodes: ['unknown_state'], warnings, events: [event('unknown_state', { reasonCodes: ['unknown_state'] })], riskDecisions, quoteLedgers: {}, results: [], assumptions: {} };
  const assumptions = { ...scenario.assumptions, tieBreaker: 'timestamp_ascending_then_priority_then_symbol_then_fixture_id' };
  const balances = { ...(scenario.assumptions?.quoteBalances ?? {}) }; const daily = {}; let globalDaily = 0; let currentDay = null; const active = []; const results = [];
  const jobs = [...scenario.tradePlans].sort((a, b) => {
    const ta = Date.parse(a.scheduledAt ?? scenario.createdAt); const tb = Date.parse(b.scheduledAt ?? scenario.createdAt);
    if (ta !== tb) return ta - tb; const pa = a.priority ?? 0; const pb = b.priority ?? 0;
    if (pa !== pb) return pa - pb; const sa = String(a.symbol ?? ''); const sb = String(b.symbol ?? '');
    if (sa !== sb) return sa.localeCompare(sb); return String(a.fixtureId ?? '').localeCompare(String(b.fixtureId ?? ''));
  });
  for (const job of jobs) {
    const jobDay = utcDay(job.scheduledAt ?? scenario.createdAt); if ((scenario.assumptions?.dailyBoundaryPolicy ?? 'UTC') === 'UTC' && jobDay && currentDay && jobDay !== currentDay) { for (const quote of Object.keys(daily)) delete daily[quote]; globalDaily = 0; events.push(event('daily_boundary_reset', { day: jobDay })); } if (jobDay) currentDay = jobDay;
    const globalLimit = scenario.assumptions?.riskLimits?.globalDailyLoss; if (num(globalLimit) && globalDaily <= -globalLimit) { const veto = { job: job.fixtureId, decision: 'vetoed', reasonCodes: ['max_daily_loss_exceeded'] }; riskDecisions.push(veto); events.push(event('risk_vetoed', veto)); results.push({ job, ok: false, reasonCodes: veto.reasonCodes }); continue; }
    const maxOpen = scenario.assumptions?.riskLimits?.maxOpenPositions;
    if (Number.isFinite(maxOpen) && active.length >= maxOpen) {
      const veto = { job: job.fixtureId, decision: 'vetoed', reasonCodes: ['max_open_positions_exceeded'] }; riskDecisions.push(veto); events.push(event('risk_vetoed', veto)); results.push({ job, ok: false, reasonCodes: veto.reasonCodes }); continue;
    }
    const run = runRadarBacktest({ ...scenario.assumptions, ...job, dataset: job.dataset, candidateFixture: job.candidateFixture, quoteBalances: balances, dailyRealizedPnl: daily, tradePlans: job.tradePlans, riskLimits: scenario.assumptions.riskLimits });
    results.push({ job, ...run }); events.push(...run.events.map((entry) => ({ ...entry, symbol: job.symbol, fixtureId: job.fixtureId }))); riskDecisions.push(...run.riskDecisions.map((entry) => ({ ...entry, symbol: job.symbol, fixtureId: job.fixtureId })));
    for (const [quote, ledger] of Object.entries(run.quoteLedgers)) if (ledger && Number.isFinite(ledger.equity)) balances[quote] = ledger.equity;
    for (const position of run.positions) if (position.status === 'CLOSED') { daily[position.quote] = (daily[position.quote] ?? 0) + position.realizedPnl; globalDaily += position.realizedPnl; } else if (position.status === 'OPEN') active.push(position);
    if (!run.ok) reasonCodes.push(...run.reasonCodes);
    warnings.push(...run.warnings.filter((code) => !warnings.includes(code)));
  }
  const quoteLedgers = Object.fromEntries(Object.entries(balances).map(([quote, equity]) => [quote, { equity, dailyRealizedPnl: daily[quote] ?? 0, openPositions: active.filter((p) => p.quote === quote).length }]));
  return { ok: reasonCodes.length === 0, reasonCodes: [...new Set(reasonCodes)], warnings, events, riskDecisions, quoteLedgers, results, assumptions };
}
