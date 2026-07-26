import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildKuCoinHistoricalDataset, parseKuCoinUtcDate } from '../scripts/radar/kucoin-public-candles.mjs';
import { formatKuCoinRadarBacktestReport, parseKuCoinRadarBacktestArgs, runKuCoinRadarBacktest } from '../scripts/radar/run-kucoin-radar-backtest.mjs';

const argv = ['--product', 'spot', '--symbol', 'SOL-USDT', '--quote', 'USDT', '--interval', '1hour', '--from', '2026-07-24', '--to', '2026-07-25', '--fixture', 'valid-entry-ready', '--initial-equity', '1000', '--risk-model', 'fixedNotional', '--notional', '100', '--maker-fee-bps', '10', '--taker-fee-bps', '10', '--spread-bps', '5', '--slippage-bps', '5', '--output', 'artifacts/backtests/test.json'];
function rows() { const start = parseKuCoinUtcDate('2026-07-24'); return [[String(start / 1000 + 43200), '140', '141', '139', '140', '10', '1400'], [String(start / 1000 + 46800), '140', '146', '139', '145', '10', '1450']]; }

test('CLI parsing is explicit and rejects unsupported product or sizing', () => {
  const parsed = parseKuCoinRadarBacktestArgs(argv);
  assert.equal(parsed.product, 'spot');
  assert.equal(parsed.notional, 100);
  assert.equal(parsed.output, 'artifacts/backtests/test.json');
  assert.throws(() => parseKuCoinRadarBacktestArgs(argv.map((part) => part === 'spot' ? 'futures' : part)), /unsupported_product/);
  assert.throws(() => parseKuCoinRadarBacktestArgs(argv.filter((part) => part !== '--output' && part !== 'artifacts/backtests/test.json')), /missing_output/);
});

test('local CLI report uses a cached public dataset, writes JSON, and states limitations', async () => {
  const settings = parseKuCoinRadarBacktestArgs(argv);
  const dataset = buildKuCoinHistoricalDataset({ symbol: settings.symbol, quote: settings.quote, interval: settings.interval, fromMs: settings.fromMs, toMs: settings.toMs, rows: rows(), fetchedAt: '2026-07-24T12:00:00.000Z' });
  let cacheWrite; let reportWrite;
  const completed = await runKuCoinRadarBacktest(settings, { cwd: process.cwd(), now: () => new Date('2026-07-24T12:00:00.000Z'), readCache: async () => null, writeCache: async (_target, value) => { cacheWrite = value; }, writeReport: async (_target, value) => { reportWrite = value; }, fetchCandles: async () => ({ dataset, request: { endpoint: 'https://api.kucoin.com/api/ua/v1/market/kline', publicOnly: true }, sourceWarnings: [] }) });
  assert.equal(completed.report.localOnly, true);
  assert.equal(completed.report.nonLive, true);
  assert.equal(completed.report.dataset.provenance.provider, 'kucoin');
  assert.equal(completed.report.artifact.format, 'json');
  assert.equal(cacheWrite.cacheVersion, 'kucoin-public-candles-cache/v1');
  assert.equal(reportWrite.reportVersion, 'kucoin-radar-backtest-report/v1');
  assert.match(completed.text, /No private API calls, no orders, no live trading\./);
  assert.ok(completed.report.limitations.some((item) => item.includes('not reconstructed')));
  assert.ok(completed.report.reconstruction.notReconstructable.includes('strict_absorb') === false, 'fixture evidence is explicitly labelled as fixture-only instead');
});

test('CLI imports only the local backtest/public data/fixture modules and no live integration modules', () => {
  const source = fs.readFileSync(new URL('../scripts/radar/run-kucoin-radar-backtest.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(imports.filter((item) => !item.startsWith('node:')), ['./kucoin-public-candles.mjs', './radar-backtest-engine.mjs', './historical-data-contract.mjs', '../../tests/fixtures/radar-trade-intent-candidates.mjs']);
  assert.doesNotMatch(imports.join(' '), /telegram|worker|binance|execution-adapter|private-endpoint/i);
});
