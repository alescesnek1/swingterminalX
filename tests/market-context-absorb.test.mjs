import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMeasurementAbsorb, attachAbsorbRows } from '../netlify/functions/_market-context-absorb.mjs';
import { validateTrustedRollingRow } from '../scripts/radar/rolling-microstructure-snapshot.mjs';

const NOW = 1_800_000_000_000;

// Raw Binance shapes, exactly as the collector holds them: agg trades as
// {a,p,q,m,T} with STRING numerics, klines as arrays with string OHLCV.
function rawTrades(count = 24, basePrice = 101) {
  const trades = [];
  for (let i = 0; i < count; i += 1) trades.push({ a: i, T: NOW - (count - i) * 1000, p: String(basePrice + (i % 2 === 0 ? 0.01 : -0.01)), q: String(1 + (i % 3)), m: i % 2 === 0, M: true });
  return trades;
}
function rawKlines(count = 40, low = 100, close = 101) {
  const rows = [];
  for (let i = 0; i < count; i += 1) { const openMs = NOW - (count - i) * 60_000; rows.push([openMs, String(close), String(close + 1), String(low), String(close), '500', openMs + 59_999, '5000', 12]); }
  return rows;
}
function micro(overrides = {}) {
  return {
    market: 'spot', symbol: 'BTCUSDT',
    aggTrades: rawTrades(), klines1m: rawKlines(),
    depthSummary: { levels: { bids: 100, asks: 100 }, bestBid: 100.9, bestAsk: 101.1, spreadBps: 5, bidQuote: 1_150_000, askQuote: 850_000 },
    tradesSummary: { count: 24, takerBuyQuote: 600_000, takerSellQuote: 400_000 },
    ...overrides,
  };
}

test('absorb is computed from the raw in-memory collector shapes and passes STRICT validation', () => {
  const row = buildMeasurementAbsorb(micro(), { bidQuoteDepthBefore: 1_000_000, windowSec: 180, observedAtMs: NOW });
  assert.ok(row, 'a row was built');
  assert.equal(row.source, 'netlify-atomic-collector');
  assert.equal(row.rollingWindowSec, 180);
  // The string numerics survive: every trusted field is a real measured value.
  for (const field of ['absorptionScore', 'bidDepthRebuildPct', 'aggressiveSellsFailed', 'deltaImprovementPct', 'marketBuyVolumeDominance', 'supportRetestHeld', 'spreadAndSlippageHealthy']) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, field), `has ${field}`);
  }
  const verdict = validateTrustedRollingRow(row, { nowMs: NOW });
  assert.equal(verdict.ok, true, `trusted: ${verdict.reason || 'ok'}`);
});

test('no depth baseline yields a non-trusted row, never a fabricated rebuild', () => {
  const row = buildMeasurementAbsorb(micro(), { bidQuoteDepthBefore: null, windowSec: 180, observedAtMs: NOW });
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'bidDepthRebuildPct'), false);
  assert.equal(validateTrustedRollingRow(row, { nowMs: NOW }).ok, false);
});

test('attach reports how many symbols got a depth baseline, not just how many were measured', () => {
  const baseline = { windowSec: 180, bidDepth: new Map([['spot:BTCUSDT', 1_000_000]]) };
  const { rows, diagnostics } = attachAbsorbRows([micro(), micro({ symbol: 'ETHUSDT' })], baseline, new Date(NOW).toISOString());
  assert.equal(diagnostics.absorbComputed, 2);
  assert.equal(diagnostics.absorbWithDepthBaseline, 1, 'only BTCUSDT had an N-1 depth');
  assert.equal(diagnostics.absorbWindowSec, 180);
  assert.equal(validateTrustedRollingRow(rows[0].absorb, { nowMs: NOW }).ok, true);
  assert.equal(validateTrustedRollingRow(rows[1].absorb, { nowMs: NOW }).ok, false);
});

test('a missing baseline does not throw and leaves every row honestly non-trusted', () => {
  const { rows, diagnostics } = attachAbsorbRows([micro()], null, new Date(NOW).toISOString());
  assert.equal(diagnostics.absorbWithDepthBaseline, 0);
  assert.equal(diagnostics.absorbWindowSec, null);
  assert.equal(validateTrustedRollingRow(rows[0].absorb, { nowMs: NOW }).reason, 'window-invalid');
});

// Regression: request pacing spreads a cycle over minutes, but absorption was
// measured against the run's single observedAt — stamped only once every symbol
// was done. Symbols read early then had every trade fall outside the window,
// producing rows with NO absorption fields, and STRICT coverage went to zero.
test('each symbol is measured against its own read time, not the cycle end', () => {
  const fiveMinutesLater = NOW + 5 * 60_000;
  const early = { ...micro(), fetchedAtMs: NOW };
  const baseline = { windowSec: 180, bidDepth: new Map([['spot:BTCUSDT', 1_000_000]]) };

  const { rows, diagnostics } = attachAbsorbRows([early], baseline, new Date(fiveMinutesLater).toISOString());
  assert.equal(diagnostics.absorbSkewedSymbols, 1, 'the skew is measured and reported');
  assert.equal(validateTrustedRollingRow(rows[0].absorb, { nowMs: NOW }).ok, true, 'still a complete measurement');
  for (const field of ['absorptionScore', 'bidDepthRebuildPct', 'aggressiveSellsFailed', 'deltaImprovementPct', 'marketBuyVolumeDominance']) {
    assert.ok(Object.prototype.hasOwnProperty.call(rows[0].absorb, field), `${field} survives the skew`);
  }

  // Without the per-symbol time the same input yields nothing at all.
  const naive = buildMeasurementAbsorb(micro(), { bidQuoteDepthBefore: 1_000_000, windowSec: 180, observedAtMs: fiveMinutesLater });
  assert.equal(Object.prototype.hasOwnProperty.call(naive, 'absorptionScore'), false);
});
