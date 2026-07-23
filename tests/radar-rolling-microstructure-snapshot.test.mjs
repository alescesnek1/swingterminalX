import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  getFreshRollingMicrostructureForSymbol,
  normalizeRollingMicrostructureSnapshot,
} from '../scripts/radar/rolling-microstructure-snapshot.mjs';

const NOW = 1_800_000_000_000;

function completeRow(overrides = {}) {
  return {
    bidDepthRebuildPct: '18.5',
    marketSellRatio: '0.47',
    openInterestChangePct: '-3.2',
    longLiquidationSpike: '2.1',
    flow: {
      takerBuySellRatio: '1.24',
      cumulativeDeltaPct: '4.5',
      aggressiveSellExhaustion: 'true',
    },
    ...overrides,
  };
}

function snapshot(data, overrides = {}) {
  return { provider: 'manual-public', updatedAtMs: NOW - 1000, trusted: true, data, ...overrides };
}

test('valid complete snapshot normalizes', () => {
  const s = normalizeRollingMicrostructureSnapshot(snapshot({ btcusdt: completeRow() }), { nowMs: NOW });
  assert.deepEqual(Object.keys(s.data), ['BTCUSDT']);
  assert.equal(s.trusted, true);
  assert.equal(s.stale, false);
  assert.equal(s.data.BTCUSDT.bidDepthRebuildPct, 18.5);
  assert.equal(s.data.BTCUSDT.flow.aggressiveSellExhaustion, true);
  assert.equal(s.data.BTCUSDT.strictReady, true);
  assert.deepEqual(s.data.BTCUSDT.missingFields, []);
});

test('invalid symbols rejected', () => {
  const s = normalizeRollingMicrostructureSnapshot(snapshot({ 'BTC-USDT': completeRow(), ETHUSDT: completeRow() }), { nowMs: NOW });
  assert.deepEqual(Object.keys(s.data), ['ETHUSDT']);
  assert.deepEqual(s.diagnostics.invalidSymbols, ['BTC-USDT']);
});

test('invalid numeric fields dropped', () => {
  const s = normalizeRollingMicrostructureSnapshot(snapshot({ SOLUSDT: completeRow({ bidDepthRebuildPct: 'x', marketSellRatio: Infinity }) }), { nowMs: NOW });
  assert.equal(s.data.SOLUSDT.bidDepthRebuildPct, undefined);
  assert.equal(s.data.SOLUSDT.marketSellRatio, undefined);
  assert.ok(s.data.SOLUSDT.missingFields.includes('bidDepthRebuildPct'));
  assert.ok(s.data.SOLUSDT.missingFields.includes('marketSellRatio'));
});

test('stale snapshot returns null', () => {
  const old = snapshot({ BTCUSDT: completeRow() }, { updatedAtMs: NOW - 11 * 60 * 1000 });
  assert.equal(getFreshRollingMicrostructureForSymbol(old, 'BTCUSDT', { nowMs: NOW }), null);
});

test('untrusted snapshot returns null', () => {
  const s = snapshot({ BTCUSDT: completeRow() }, { trusted: false });
  assert.equal(getFreshRollingMicrostructureForSymbol(s, 'BTCUSDT', { nowMs: NOW }), null);
});

test('missing required rolling fields are reported', () => {
  const s = normalizeRollingMicrostructureSnapshot(snapshot({ BTCUSDT: { bidDepthRebuildPct: 5, flow: { takerBuySellRatio: 1.1 } } }), { nowMs: NOW });
  assert.deepEqual(s.diagnostics.missingFieldsBySymbol.BTCUSDT, [
    'marketSellRatio',
    'openInterestChangePct',
    'longLiquidationSpike',
    'flow.cumulativeDeltaPct',
    'flow.aggressiveSellExhaustion',
  ]);
});

test('complete trusted fresh symbol returns rolling data', () => {
  const row = getFreshRollingMicrostructureForSymbol(snapshot({ BTCUSDT: completeRow() }), 'btcusdt', { nowMs: NOW });
  assert.equal(row.strictReady, true);
  assert.equal(row.openInterestChangePct, -3.2);
});

test('missing fields are never invented or zero-filled', () => {
  const s = normalizeRollingMicrostructureSnapshot(snapshot({ BTCUSDT: { flow: {} } }), { nowMs: NOW });
  assert.equal(s.data.BTCUSDT.bidDepthRebuildPct, undefined);
  assert.equal(s.data.BTCUSDT.marketSellRatio, undefined);
  assert.equal(s.data.BTCUSDT.longLiquidationSpike, undefined);
  assert.ok(!Object.values(s.data.BTCUSDT).includes(0));
});

test('boolean fields normalize safely', () => {
  const trueRow = normalizeRollingMicrostructureSnapshot(snapshot({ BTCUSDT: completeRow({ flow: { takerBuySellRatio: 1, cumulativeDeltaPct: 2, aggressiveSellExhaustion: 'TRUE' } }) }), { nowMs: NOW });
  const falseRow = normalizeRollingMicrostructureSnapshot(snapshot({ ETHUSDT: completeRow({ flow: { takerBuySellRatio: 1, cumulativeDeltaPct: 2, aggressiveSellExhaustion: 'false' } }) }), { nowMs: NOW });
  assert.equal(trueRow.data.BTCUSDT.flow.aggressiveSellExhaustion, true);
  assert.equal(falseRow.data.ETHUSDT.flow.aggressiveSellExhaustion, false);
});

test('no fetch/http/env/file IO imports', () => {
  const source = readFileSync(new URL('../scripts/radar/rolling-microstructure-snapshot.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\b/);
  assert.doesNotMatch(source, /\bfetch\b|https?:\/\//i);
  assert.doesNotMatch(source, /process\.env|node:fs|readFile|writeFile/);
});

test('no dependency on bot/trading-radar/fleet/UI/Telegram/worker/package', () => {
  const source = readFileSync(new URL('../scripts/radar/rolling-microstructure-snapshot.mjs', import.meta.url), 'utf8').toLowerCase();
  for (const term of ['bot.mjs', 'trading-radar', '_fleet-store', 'terminal.js', 'telegram', 'worker', 'package.json']) {
    assert.ok(!source.includes(term), `must not reference ${term}`);
  }
});

test('fresh rolling snapshot from producer with slightly misaligned clock is not immediately stale', () => {
  const producerNow = NOW + 15000; // 15s in the future
  const s = snapshot({ BTCUSDT: completeRow() }, { updatedAtMs: producerNow });
  const normalized = normalizeRollingMicrostructureSnapshot(s, { nowMs: NOW });
  assert.equal(normalized.stale, false);
});

test('preserves validated local-foundation measurement metadata and optional rolling fields', () => {
  const s = normalizeRollingMicrostructureSnapshot(snapshot({ BTCUSDT: completeRow({
    absorptionScore: 71,
    deltaImprovementPct: 4,
    marketBuyVolumeDominance: 0.61,
    aggressiveSellsFailed: true,
    supportRetestHeld: true,
    spreadAndSlippageHealthy: true,
    rollingMeasuredAt: new Date(NOW - 500).toISOString(),
    rollingWindowSec: 300,
    samples: { aggTrades: 60, depthSnapshots: 2, ignored: 99 },
    source: 'binance-futures-public',
  }) }), { nowMs: NOW });
  const row = s.data.BTCUSDT;
  assert.equal(row.absorptionScore, 71);
  assert.equal(row.marketBuyVolumeDominance, 0.61);
  assert.equal(row.aggressiveSellsFailed, true);
  assert.equal(row.samples.aggTrades, 60);
  assert.equal(row.samples.ignored, undefined);
  assert.equal(row.source, 'binance-futures-public');
});


test('foundation metadata is required and stale or thin readings are dropped before merge', () => {
  const base = completeRow({
    absorptionScore: 80,
    rollingMeasuredAt: new Date(NOW - 500).toISOString(),
    rollingWindowSec: 300,
    samples: { aggTrades: 60, depthSnapshots: 2 },
  });
  const thin = normalizeRollingMicrostructureSnapshot(snapshot({ BTCUSDT: { ...base, samples: { aggTrades: 9, depthSnapshots: 2 } } }), { nowMs: NOW });
  assert.equal(thin.data.BTCUSDT.foundationRejected, true);
  assert.equal(thin.data.BTCUSDT.absorptionScore, undefined);
  assert.equal(thin.data.BTCUSDT.flow, undefined);
  const stale = normalizeRollingMicrostructureSnapshot(snapshot({ BTCUSDT: { ...base, rollingMeasuredAt: new Date(NOW - 11 * 60 * 1000).toISOString() } }), { nowMs: NOW });
  assert.equal(stale.data.BTCUSDT.foundationRejected, true);
  assert.equal(stale.data.BTCUSDT.bidDepthRebuildPct, undefined);
});
