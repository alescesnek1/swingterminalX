// RADAR server-side Pressure Zones projection — unit + isolation guards.
// computeRadarPressureZones derives a COMPACT, context-only proxy block from the
// same fresh closed klines the structural-reclaim step already reads. It exposes
// no raw candles and must never influence any gate/score/actionability.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeRadarPressureZones } from '../scripts/radar/trading-radar.mjs';

const TR_SRC = fs.readFileSync(new URL('../scripts/radar/trading-radar.mjs', import.meta.url), 'utf8');

const BASE = 1_700_000_000_000;
const HOUR = 3600000;

// Deterministic 1h klines with a clear swing low (idx 12 @88), swing high
// (idx 24 @118), and a volume node (idx 30-33). Array form + explicit closeTime
// so the snapshot normaliser treats the last candle as closed (not dropped).
function makeCandles(count = 34) {
  const out = [];
  for (let i = 0; i < count; i++) {
    let open = 100, close = 100, high = 101, low = 99, volume = 1000;
    if (i === 12) { low = 88; close = 90; open = 96; high = 97; }
    else if (i === 11 || i === 13) { low = 94; }
    else if (i === 10 || i === 14) { low = 96; }
    if (i === 24) { high = 118; close = 116; open = 104; low = 103; }
    else if (i === 23 || i === 25) { high = 110; }
    else if (i === 22 || i === 26) { high = 108; }
    if (i >= 30 && i <= 33) { volume = 20000; }
    const openTime = BASE + i * HOUR;
    out.push([openTime, open, high, low, close, volume, openTime + HOUR - 1]);
  }
  return out;
}

function snapshot(candles, over = {}) {
  return { timeframe: '1h', updatedAtMs: BASE + 34 * HOUR, data: { FOOUSDT: candles }, ...over };
}
const NOW = BASE + 34 * HOUR; // last candle already closed at NOW

test('computeRadarPressureZones returns a compact available block from fresh klines', () => {
  const pz = computeRadarPressureZones({ symbol: 'FOOUSDT' }, snapshot(makeCandles()), NOW);
  assert.equal(pz.available, true);
  assert.equal(pz.proxy, true);
  assert.equal(pz.label, 'PRESSURE ZONES · derived proxy — not liquidation data');
  assert.equal(pz.source, 'closed-klines');
  assert.equal(pz.timeframe, '1h');
  assert.equal(typeof pz.candlesUsed, 'number');
  assert.ok(pz.candlesUsed >= 30);
  assert.equal(typeof pz.referencePrice, 'number');
  assert.equal(pz.disclaimer, 'Derived proxy from closed candles; not liquidation data; not order-book data.');
  assert.ok(Array.isArray(pz.zones));
  assert.ok(pz.zones.length <= 3, 'capped at 3 nearest zones');
  for (const z of pz.zones) {
    assert.ok(Number.isFinite(z.price) && z.price > 0);
    assert.ok(['support', 'resistance', 'pivot'].includes(z.type));
    assert.ok(Number.isFinite(z.strength));
    assert.ok(Array.isArray(z.basis));
  }
});

test('computeRadarPressureZones → NO_CLOSED_KLINES when snapshot missing/stale/symbol absent', () => {
  const stale = computeRadarPressureZones({ symbol: 'FOOUSDT' }, snapshot(makeCandles(), { updatedAtMs: BASE - 3 * HOUR }), NOW);
  assert.deepEqual(stale, { available: false, proxy: true, reason: 'NO_CLOSED_KLINES' });
  const noSnap = computeRadarPressureZones({ symbol: 'FOOUSDT' }, null, NOW);
  assert.equal(noSnap.reason, 'NO_CLOSED_KLINES');
  const otherSym = computeRadarPressureZones({ symbol: 'BARUSDT' }, snapshot(makeCandles()), NOW);
  assert.equal(otherSym.reason, 'NO_CLOSED_KLINES');
  const noSymbol = computeRadarPressureZones({}, snapshot(makeCandles()), NOW);
  assert.equal(noSymbol.reason, 'NO_CLOSED_KLINES');
});

test('computeRadarPressureZones → INSUFFICIENT_CANDLES when candles present but too few', () => {
  const pz = computeRadarPressureZones({ symbol: 'FOOUSDT' }, snapshot(makeCandles(10)), NOW);
  assert.deepEqual(pz, { available: false, proxy: true, reason: 'INSUFFICIENT_CANDLES' });
});

test('computeRadarPressureZones exposes NO raw candles / timestamps and only display-only keys', () => {
  const pz = computeRadarPressureZones({ symbol: 'FOOUSDT' }, snapshot(makeCandles()), NOW);
  const blob = JSON.stringify(pz);
  // Raw-candle proof: no OHLC/timestamp JSON keys (source:'closed-klines' and the
  // candlesUsed count are provenance metadata, not raw candles, and are allowed).
  for (const leak of ['"openTime"', '"closeTime"', '"open":', '"high":', '"low":', '"close":', '"volume":', '"data":']) {
    assert.equal(blob.includes(leak), false, `raw-candle field ${leak} must not be serialized`);
  }
  // The block and its zones must carry only display keys — no gate/score field.
  const allowedTop = new Set(['available', 'proxy', 'label', 'source', 'timeframe', 'candlesUsed', 'referencePrice', 'zones', 'disclaimer']);
  for (const k of Object.keys(pz)) assert.ok(allowedTop.has(k), `unexpected top-level key: ${k}`);
  const allowedZone = new Set(['price', 'type', 'strength', 'basis']);
  for (const z of pz.zones) for (const k of Object.keys(z)) assert.ok(allowedZone.has(k), `unexpected zone key: ${k}`);
  for (const forbidden of ['action', 'entryReady', 'entry_ready', 'v1status', 'distancetoentryready', 'setupscore', 'executionscore', 'riskreward', 'telegram', 'confidence', 'absorb', 'reclaim']) {
    assert.equal(blob.toLowerCase().includes(forbidden), false, `block must not carry "${forbidden}"`);
  }
});

test('computeRadarPressureZones is a pure function of symbol+klines, independent of gate state on the market', () => {
  const plain = computeRadarPressureZones({ symbol: 'FOOUSDT' }, snapshot(makeCandles()), NOW);
  // Adding gate/score fields to the market must not change the pressure zones.
  const withGates = computeRadarPressureZones(
    { symbol: 'FOOUSDT', STATUS: 'STANDARD_ENTRY_READY', actionability: 'ENTRY_READY', confidence: 99, EXECUTION_SCORE: 100, ABSORB_STATUS: 'CONFIRMED' },
    snapshot(makeCandles()), NOW,
  );
  assert.deepEqual(withGates, plain);
});

test('isolation: pressureZones is computed after all gate work and referenced only at the output projection', () => {
  // computeRadarPressureZones appears exactly twice: its definition + one call.
  const refs = (TR_SRC.match(/computeRadarPressureZones\s*\(/g) || []).length;
  assert.equal(refs, 2, 'expected one definition + one call site');
  // The single call site is a const computed at output-shaping time, then spread
  // into the output object via shorthand.
  assert.match(TR_SRC, /const pressureZones = computeRadarPressureZones\(m, klinesSnapshot, now\)/);
  // It must NOT be threaded onto the market object used by universe/scoring.
  assert.doesNotMatch(TR_SRC, /\.\.\.computed,\s*computedStructuralKlinesSymbol[\s\S]{0,40}pressureZones/);
  // The call site sits AFTER the V1 gate + actionability are computed for the row.
  const gateIdx = TR_SRC.indexOf('const entryReadyV1 =');
  const callIdx = TR_SRC.indexOf('const pressureZones = computeRadarPressureZones(');
  assert.ok(gateIdx > 0 && callIdx > gateIdx, 'pressureZones must be projected after gate computation');
});
