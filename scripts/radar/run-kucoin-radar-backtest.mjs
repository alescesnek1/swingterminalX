import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchKuCoinPublicCandles, parseKuCoinUtcDate } from './kucoin-public-candles.mjs';
import { runRadarBacktest } from './radar-backtest-engine.mjs';
import { validateHistoricalMarketDataset, assessRadarHistoricalReconstruction } from './historical-data-contract.mjs';
import { RADAR_TRADE_INTENT_CANDIDATE_FIXTURES } from '../../tests/fixtures/radar-trade-intent-candidates.mjs';

const ALLOWED_FLAGS = new Set(['product', 'symbol', 'quote', 'interval', 'from', 'to', 'fixture', 'initial-equity', 'risk-model', 'notional', 'maker-fee-bps', 'taker-fee-bps', 'spread-bps', 'slippage-bps', 'output']);
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function requireString(value, name) { if (typeof value !== 'string' || !value.trim()) throw new Error('missing_' + name); return value.trim(); }
function numeric(value, name) { const parsed = Number(value); if (!finite(parsed) || parsed < 0) throw new Error('invalid_' + name); return parsed; }
function sourceSummary(dataset) { return { provenance: dataset.provenance, interval: dataset.interval, range: dataset.range, candleCount: dataset.candles.length, gaps: dataset.gaps, corrections: dataset.corrections, depth: dataset.depth }; }

export function parseKuCoinRadarBacktestArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith('--')) throw new Error('unexpected_argument');
    const key = part.slice(2);
    if (!ALLOWED_FLAGS.has(key) || values[key] != null || i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error('invalid_cli_argument');
    values[key] = argv[i + 1]; i += 1;
  }
  for (const name of ALLOWED_FLAGS) if (values[name] == null) throw new Error('missing_' + name);
  if (values.product !== 'spot') throw new Error('unsupported_product');
  if (values['risk-model'] !== 'fixedNotional') throw new Error('unsupported_risk_model');
  const fromMs = parseKuCoinUtcDate(requireString(values.from, 'from')); const toMs = parseKuCoinUtcDate(requireString(values.to, 'to'));
  if (fromMs >= toMs) throw new Error('invalid_kucoin_range');
  return { product: values.product, symbol: requireString(values.symbol, 'symbol').toUpperCase(), quote: requireString(values.quote, 'quote').toUpperCase(), interval: requireString(values.interval, 'interval'), fromMs, toMs, fixtureName: requireString(values.fixture, 'fixture'), initialEquity: numeric(values['initial-equity'], 'initial_equity'), riskModel: values['risk-model'], notional: numeric(values.notional, 'notional'), costAssumptions: { makerFeeBps: numeric(values['maker-fee-bps'], 'maker_fee_bps'), takerFeeBps: numeric(values['taker-fee-bps'], 'taker_fee_bps'), spreadBps: numeric(values['spread-bps'], 'spread_bps'), slippageBps: numeric(values['slippage-bps'], 'slippage_bps') }, output: requireString(values.output, 'output') };
}

export function selectRadarFixture(name) {
  const fixture = RADAR_TRADE_INTENT_CANDIDATE_FIXTURES.find((item) => item.name === name);
  if (!fixture) throw new Error('unknown_radar_fixture');
  return fixture;
}

export function kucoinBacktestCacheKey(settings) { return ['kucoin', 'spot', settings.symbol, settings.interval, String(settings.fromMs), String(settings.toMs), 'historical-market-data-v1'].join('__').replace(/[^A-Z0-9_.-]/gi, '_'); }
export function kucoinBacktestCachePath(settings, cwd = process.cwd()) { return resolveLocalOutput('artifacts/backtests/cache/' + kucoinBacktestCacheKey(settings) + '.json', cwd); }
async function defaultReadCache(target) { try { return JSON.parse(await fs.readFile(target, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return null; throw new Error('invalid_kucoin_cache'); } }
async function defaultWriteCache(target, value) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, JSON.stringify(value, null, 2) + '\n', 'utf8'); }

export function resolveLocalOutput(output, cwd = process.cwd()) {
  const value = requireString(output, 'output');
  if (path.isAbsolute(value)) throw new Error('output_must_be_relative');
  const root = path.resolve(cwd); const target = path.resolve(root, value);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('output_outside_workspace');
  return target;
}

export function formatKuCoinRadarBacktestReport(report) {
  const summary = report.backtest.summary; const costs = report.backtest.assumptions.costAssumptions;
  // "trades: 0" alone reads like "the strategy found nothing" when the truth may be
  // "the plan was refused and nothing was ever simulated". The veto reasons are part
  // of the result, not debug detail.
  const vetoes = (Array.isArray(report.backtest.riskDecisions) ? report.backtest.riskDecisions : []).filter((d) => d && d.decision === 'vetoed');
  const vetoCodes = [...new Set(vetoes.flatMap((d) => Array.isArray(d.reasonCodes) ? d.reasonCodes : []))];
  const vetoLine = vetoes.length
    ? `NO TRADE SIMULATED - ${vetoes.length} plan(s) vetoed: ${vetoCodes.join(', ')}`
    : `plans vetoed: 0`;
  return [
    'KuCoin public-data RADAR backtest MVP (LOCAL ONLY - NOT LIVE)',
    'symbol: ' + report.market.symbol,
    'product: ' + report.market.product + ' | quote: ' + report.market.quote + ' | interval: ' + report.market.interval,
    'date range: ' + report.market.range.start + ' to ' + report.market.range.end,
    'candles loaded: ' + report.market.candleCount + ' | gaps detected: ' + report.dataset.gaps.length,
    'candidate fixture: ' + report.fixture.name + ' | validation: ' + (report.fixture.validation.ok ? 'PASS' : 'REJECTED'),
    'fixture market: ' + (report.fixture.selectedSymbolMapping?.normalizedSymbol ?? 'UNMAPPED'),
    vetoLine,
    'trades: ' + summary.trades + ' (closed ' + (summary.closedTrades ?? 0) + ') | wins/losses: ' + summary.wins + '/' + summary.losses + ' | win rate: ' + summary.winRate,
    'gross PnL: ' + summary.grossPnl + ' | fees: ' + summary.fees + ' | spread/slippage bps: ' + costs.spreadBps + '/' + costs.slippageBps,
    'net PnL: ' + summary.netPnl + ' | max drawdown: ' + summary.maxDrawdown + ' | open position at end: ' + summary.openPositions,
    'warnings / UNKNOWN: ' + [...report.backtest.warnings, ...report.reconstruction.notReconstructable].join(', '),
    'artifact: ' + report.artifact.output,
    'No private API calls, no orders, no live trading.',
  ].join('\n');
}

export async function runKuCoinRadarBacktest(options, dependencies = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  if (settings.product !== 'spot') throw new Error('unsupported_product');
  if (settings.riskModel !== 'fixedNotional') throw new Error('unsupported_risk_model');
  const fixture = selectRadarFixture(settings.fixtureName);
  const fetchCandles = dependencies.fetchCandles ?? fetchKuCoinPublicCandles;
  const now = dependencies.now ?? (() => new Date()); const cwd = dependencies.cwd ?? process.cwd(); const cacheKey = kucoinBacktestCacheKey(settings); const cachePath = kucoinBacktestCachePath(settings, cwd);
  const readCache = dependencies.readCache ?? defaultReadCache; const writeCache = dependencies.writeCache ?? defaultWriteCache; let cached = await readCache(cachePath);
  if (cached != null && (!cached || cached.cacheVersion !== 'kucoin-public-candles-cache/v1' || cached.cacheKey !== cacheKey || !cached.fetched)) throw new Error('invalid_kucoin_cache');
  const fetched = cached ? { ...cached.fetched, request: { ...cached.fetched.request, cache: 'hit' } } : await fetchCandles({ product: 'spot', symbol: settings.symbol, quote: settings.quote, interval: settings.interval, fromMs: settings.fromMs, toMs: settings.toMs, fetchImpl: dependencies.fetchImpl, now });
  if (!cached) await writeCache(cachePath, { cacheVersion: 'kucoin-public-candles-cache/v1', cacheKey, fetched });
  const datasetValidation = validateHistoricalMarketDataset(fetched.dataset);
  const normalizedSymbol = settings.symbol.replace('-', '/');
  // The fixture's symbolMapping is EVIDENCE about the market its candidate was
  // captured on — never a parameter to be rewritten to whatever market was requested.
  // Overwriting it defeated the mapping validation and let a SOL candidate (stop 135,
  // target 145) be simulated against BTC-USDT candles at 73,939, reporting a
  // "take profit" that lost 99.9% of the notional. A fixture that names a different
  // market is refused here; one that is deliberately unmapped/unsupported is passed
  // through untouched so the engine vetoes it on its own terms.
  const mapping = fixture.symbolMapping && typeof fixture.symbolMapping === 'object' ? fixture.symbolMapping : null;
  if (mapping && mapping.supported === true && mapping.normalizedSymbol !== normalizedSymbol) {
    throw new Error(`fixture_symbol_mismatch: fixture '${fixture.name}' was captured on ${mapping.normalizedSymbol}, requested market is ${normalizedSymbol}`);
  }
  const fixtureForMarket = fixture;
  const fixtureClockMs = Date.parse(fixture.capturedAt);
  const fixtureValidation = { ...fixture.expectedValidation, fixtureVersion: fixture.fixtureVersion, schemaVersion: fixture.schemaVersion };
  const backtest = runRadarBacktest({ dataset: fetched.dataset, candidateFixture: fixtureForMarket, mode: 'spot', quote: settings.quote, clockMs: fixtureClockMs, candidateMaxAgeMs: 120000, quoteBalances: { [settings.quote]: settings.initialEquity }, sizing: { model: 'fixedNotional', fixedNotional: settings.notional }, riskLimits: { maxExposurePerTrade: settings.notional, maxRealRiskAtStop: settings.initialEquity, maxOpenPositions: 1, maxDailyLoss: settings.initialEquity }, costAssumptions: settings.costAssumptions, closeAtDatasetEnd: true });
  const reconstruction = assessRadarHistoricalReconstruction(fetched.dataset, { historicalCandidateFixture: fixtureForMarket });
  const output = resolveLocalOutput(settings.output, cwd);
  const report = { reportVersion: 'kucoin-radar-backtest-report/v1', generatedAt: now().toISOString(), localOnly: true, nonLive: true, input: { product: settings.product, symbol: settings.symbol, quote: settings.quote, interval: settings.interval, fromMs: settings.fromMs, toMs: settings.toMs, fixture: settings.fixtureName, initialEquity: settings.initialEquity, riskModel: settings.riskModel, notional: settings.notional, costAssumptions: settings.costAssumptions }, market: { product: 'spot', symbol: settings.symbol, quote: settings.quote, interval: settings.interval, range: fetched.dataset.range, candleCount: fetched.dataset.candles.length, source: fetched.request }, dataset: sourceSummary(fetched.dataset), datasetValidation, fixture: { name: fixture.name, fixtureVersion: fixture.fixtureVersion, schemaVersion: fixture.schemaVersion, source: fixture.source, validation: fixtureValidation, selectedSymbolMapping: fixtureForMarket.symbolMapping ?? null }, reconstruction, backtest, limitations: ['public KuCoin candles only; no authenticated or private endpoint was called', 'RADAR actionability and Strict Absorb come only from the supplied stored/synthetic fixture and were not reconstructed from candles', 'fixture levels are not derived from the fetched market and this report is not a production strategy result', 'no order, exchange execution adapter, scheduler, runner, Telegram behavior, or live trading path exists in this CLI'], artifact: { output: settings.output, format: 'json' }, cache: { key: cacheKey, path: path.relative(cwd, cachePath), status: cached ? 'hit' : 'miss' } };
  const writeReport = dependencies.writeReport ?? (async (target, value) => { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, JSON.stringify(value, null, 2) + '\n', 'utf8'); });
  await writeReport(output, report);
  return { report, output, text: formatKuCoinRadarBacktestReport(report) };
}

function isMainModule() { return Boolean(process.argv[1]) && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]); }
if (isMainModule()) {
  try {
    const options = parseKuCoinRadarBacktestArgs(process.argv.slice(2));
    const completed = await runKuCoinRadarBacktest(options);
    console.log(completed.text);
  } catch (error) {
    console.error('KuCoin RADAR backtest failed: ' + (error?.message ?? 'unknown_error'));
    process.exitCode = 1;
  }
}
