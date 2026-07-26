import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCollectorRollingRow, buildCollectorRollingSnapshot, COLLECTOR_ROLLING_SOURCE } from '../scripts/radar/collector-absorb-bridge.mjs';
import { validateTrustedRollingRow, getFreshRollingMicrostructureForSymbol, normalizeRollingMicrostructureSnapshot } from '../scripts/radar/rolling-microstructure-snapshot.mjs';

const NOW = 1_800_000_000_000;

function cleanTrades(count = 20, basePrice = 101) {
  const trades = [];
  for (let i = 0; i < count; i += 1) {
    trades.push({ T: NOW - (count - i) * 1000, p: basePrice + (i % 2 === 0 ? 0.01 : -0.01), q: 1 + (i % 3), m: i % 2 === 0 });
  }
  return trades;
}
function klines(count = 35, low = 100, close = 101) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const openMs = NOW - (count - i) * 60_000;
    rows.push([openMs, close, close + 1, low, close, 500, openMs + 59_999, 50_000, 120]);
  }
  return rows;
}
function fullInput(overrides = {}) {
  return {
    symbol: 'btcusdt', market: 'spot', observedAtMs: NOW, windowSec: 360,
    aggTrades: cleanTrades(), klines: klines(),
    bidQuoteDepthBefore: 1_000_000, bidQuoteDepthAfter: 1_150_000,
    spreadPct: 0.05, depthUsdWithin1Pct: 2_000_000,
    takerBuyQuote: 600_000, takerSellQuote: 400_000,
    ...overrides,
  };
}

test('sufficient clean atomic data yields a strictReady, trusted collector rolling row', () => {
  const built = buildCollectorRollingRow(fullInput(), NOW);
  assert.ok(built, 'row is built');
  assert.equal(built.symbol, 'BTCUSDT');
  assert.equal(built.row.source, COLLECTOR_ROLLING_SOURCE);
  // Every trusted field the STRICT gate needs is present and measured, not faked.
  for (const field of ['absorptionScore', 'bidDepthRebuildPct', 'aggressiveSellsFailed', 'deltaImprovementPct', 'marketBuyVolumeDominance', 'supportRetestHeld', 'spreadAndSlippageHealthy']) {
    assert.ok(Object.prototype.hasOwnProperty.call(built.row, field), `has ${field}`);
  }
  const verdict = validateTrustedRollingRow(built.row, { nowMs: NOW });
  assert.equal(verdict.ok, true, `trusted: ${verdict.reason || 'ok'}`);

  const snapshot = buildCollectorRollingSnapshot([fullInput()], { nowMs: NOW, updatedAtMs: NOW });
  const normalized = normalizeRollingMicrostructureSnapshot(snapshot, { nowMs: NOW });
  assert.equal(normalized.trusted, true, 'snapshot is trusted');
  assert.ok(getFreshRollingMicrostructureForSymbol(snapshot, 'BTCUSDT', { nowMs: NOW }), 'symbol row is fresh + trusted');
});

test('thin trade data is never trusted (STRICT cannot confirm) — honest UNKNOWN', () => {
  const built = buildCollectorRollingRow(fullInput({ aggTrades: cleanTrades(5) }), NOW);
  assert.equal(built.row.strictReady === true, false);
  assert.equal(validateTrustedRollingRow(built.row, { nowMs: NOW }).ok, false);
  // The thin symbol carries no trusted absorb field, so STRICT has nothing to
  // score. Fail-closed is enforced per symbol, not by demoting the provider.
  const snapshot = buildCollectorRollingSnapshot([fullInput({ aggTrades: cleanTrades(5) })], { nowMs: NOW, updatedAtMs: NOW });
  const normalized = normalizeRollingMicrostructureSnapshot(snapshot, { nowMs: NOW });
  assert.equal(normalized.strictReadySymbols, 0);
  const row = getFreshRollingMicrostructureForSymbol(snapshot, 'BTCUSDT', { nowMs: NOW });
  assert.equal(row.strictReady, false);
  for (const field of ['absorptionScore', 'bidDepthRebuildPct', 'aggressiveSellsFailed', 'deltaImprovementPct', 'marketBuyVolumeDominance', 'supportRetestHeld', 'spreadAndSlippageHealthy']) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, field), false, `${field} stripped`);
  }
});

test('one thin symbol no longer discards a healthy symbol measured in the same run', () => {
  const snapshot = buildCollectorRollingSnapshot([
    fullInput(),
    { ...fullInput({ aggTrades: cleanTrades(5) }), symbol: 'ETHUSDT' },
  ], { nowMs: NOW, updatedAtMs: NOW });
  const normalized = normalizeRollingMicrostructureSnapshot(snapshot, { nowMs: NOW });
  assert.equal(normalized.trusted, true, 'the provider itself is fresh and trusted');
  assert.equal(normalized.strictReadySymbols, 1);
  assert.equal(normalized.data.BTCUSDT.strictReady, true);
  assert.equal(normalized.data.ETHUSDT.strictReady, false);
  // The healthy symbol keeps its measurement; the thin one still confirms nothing.
  assert.equal(getFreshRollingMicrostructureForSymbol(snapshot, 'BTCUSDT', { nowMs: NOW }).strictReady, true);
  assert.equal(getFreshRollingMicrostructureForSymbol(snapshot, 'ETHUSDT', { nowMs: NOW }).strictReady, false);
});

test('missing depth-before (only one snapshot) drops bidDepthRebuild → not trusted', () => {
  const built = buildCollectorRollingRow(fullInput({ bidQuoteDepthBefore: null }), NOW);
  assert.equal(Object.prototype.hasOwnProperty.call(built.row, 'bidDepthRebuildPct'), false);
  assert.equal(validateTrustedRollingRow(built.row, { nowMs: NOW }).ok, false);
});

test('a window outside the honest collector band is rejected (no faked provenance)', () => {
  const built = buildCollectorRollingRow(fullInput({ windowSec: 30 }), NOW);
  assert.equal(validateTrustedRollingRow(built.row, { nowMs: NOW }).reason, 'window-invalid');
});

test('stale measurement is rejected even with complete fields', () => {
  const built = buildCollectorRollingRow(fullInput(), NOW);
  const verdict = validateTrustedRollingRow(built.row, { nowMs: NOW + 20 * 60 * 1000 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'measurement-stale');
});
