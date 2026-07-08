// Pressure Zones — pure-helper unit tests + source guards.
// Pressure Zones are a DERIVED PROXY from closed-candle structure/volume only.
// These tests prove the helper is deterministic, fail-closed, honestly labelled,
// excludes the forming candle, and has no fetch / gate / Telegram / worker
// dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computePressureZones } from '../scripts/radar/pressure-zones.mjs';

const SRC = fs.readFileSync(new URL('../scripts/radar/pressure-zones.mjs', import.meta.url), 'utf8');

// Deterministic fixture: flat-ish base with one clear swing LOW (idx 12), one
// clear swing HIGH (idx 24), and a volume spike cluster around 100 (idx 30-33).
function makeFixture() {
  const klines = [];
  for (let i = 0; i < 40; i++) {
    let open = 100, close = 100, high = 101, low = 99, volume = 1000;
    if (i === 12) { low = 88; close = 90; open = 96; high = 97; }        // swing low @ 88
    else if (i === 11 || i === 13) { low = 94; }
    else if (i === 10 || i === 14) { low = 96; }
    if (i === 24) { high = 118; close = 116; open = 104; low = 103; }    // swing high @ 118
    else if (i === 23 || i === 25) { high = 110; }
    else if (i === 22 || i === 26) { high = 108; }
    if (i >= 30 && i <= 33) { volume = 20000; }                          // volume node ~100
    klines.push([Date.now() + i * 3600000, open, high, low, close, volume]);
  }
  return klines;
}

test('computePressureZones derives zones from swing highs/lows and volume nodes', () => {
  const r = computePressureZones(makeFixture());
  assert.ok(r, 'expected a result object');
  assert.equal(r.proxy, true);
  assert.ok(Array.isArray(r.zones) && r.zones.length > 0, 'expected at least one zone');
  const allBasis = new Set(r.zones.flatMap((z) => z.basis));
  assert.ok(allBasis.has('swing-low') || allBasis.has('swing-high'), 'expected a structural pivot basis');
  // the swing low @88 and swing high @118 should surface as levels
  const prices = r.zones.map((z) => z.price);
  assert.ok(prices.some((p) => Math.abs(p - 88) < 1), 'swing low ~88 should appear');
  assert.ok(prices.some((p) => Math.abs(p - 118) < 1), 'swing high ~118 should appear');
  // every zone carries proxy + a real side classification, never a fabricated 0
  for (const z of r.zones) {
    assert.equal(z.proxy, true);
    assert.ok(['support', 'resistance', 'pivot'].includes(z.side));
    assert.ok(Number.isFinite(z.price) && z.price > 0);
    assert.ok(Number.isFinite(z.strength));
  }
});

test('computePressureZones returns null on insufficient candles', () => {
  const few = makeFixture().slice(0, 10); // < default minCandles (30)
  assert.equal(computePressureZones(few), null);
  assert.equal(computePressureZones([]), null);
  assert.equal(computePressureZones(null), null);
  assert.equal(computePressureZones(undefined), null);
});

test('computePressureZones excludes the latest (forming) candle by default', () => {
  const closed = makeFixture(); // 40 closed candles
  const lastClosedClose = closed[closed.length - 1][4];
  // Append a wild still-forming candle with an extreme high.
  const forming = [Date.now() + 41 * 3600000, 100, 9999, 100, 100, 999999];
  const withForming = [...closed, forming];

  const excluded = computePressureZones(withForming);              // default: drop forming
  const included = computePressureZones(withForming, { includeLastCandle: true });

  // Reference price must be the last CLOSED close, not the forming candle.
  assert.equal(excluded.referencePrice, lastClosedClose);
  assert.equal(included.referencePrice, 100);
  // The extreme forming high (9999) must NOT create a zone when excluded…
  assert.ok(!excluded.zones.some((z) => z.price > 1000), 'forming-candle extreme leaked into zones');
  // …candlesUsed differs by exactly one between the two modes.
  assert.equal(included.candlesUsed - excluded.candlesUsed, 1);
});

test('computePressureZones always sets proxy:true and an explicit not-liquidation disclaimer', () => {
  const r = computePressureZones(makeFixture());
  assert.equal(r.proxy, true);
  assert.equal(r.label, 'PRESSURE ZONES');
  assert.match(r.basis, /derived proxy/i);
  assert.match(r.basis, /not liquidation data/i);
  assert.match(r.disclaimer, /NOT liquidation data/);
  assert.match(r.disclaimer, /NOT order-book data/);
});

test('computePressureZones is deterministic (same input → identical output)', () => {
  const f = makeFixture();
  assert.deepEqual(computePressureZones(f), computePressureZones(f));
});

test('computePressureZones never uses forbidden wording and never invents liquidation data', () => {
  // Result must not carry any liquidation/CVD/whale/absorption-confirmation claim.
  const blob = JSON.stringify(computePressureZones(makeFixture())).toLowerCase();
  for (const forbidden of ['liquidation heatmap', 'cvd', 'whale', 'confirmed liquidation', 'guaranteed absorption', 'retail sentiment']) {
    assert.equal(blob.includes(forbidden), false, `result must not include "${forbidden}"`);
  }
});

test('pressure-zones module is a pure helper: no import/require/fetch/env/network dependency', () => {
  assert.doesNotMatch(SRC, /^\s*import\s/m, 'module must not import anything');
  assert.doesNotMatch(SRC, /\brequire\s*\(/, 'module must not require anything');
  assert.doesNotMatch(SRC, /\bfetch\s*\(/, 'module must not fetch');
  assert.doesNotMatch(SRC, /\bXMLHttpRequest\b|WebSocket/, 'module must not open a network channel');
  assert.doesNotMatch(SRC, /process\.env/, 'module must not read env');
  // exactly one export — the pure helper — and no gate/alert wiring symbols
  assert.doesNotMatch(SRC, /sendTelegram|api\.telegram|fleetStore|local-binance-worker|bot\.mjs/i);
});

test('pressure-zones module uses no forbidden label wording in source', () => {
  assert.doesNotMatch(SRC, /liquidation heatmap/i, 'must never be called a liquidation heatmap');
  assert.doesNotMatch(SRC, /confirmed liquidation/i);
  assert.doesNotMatch(SRC, /guaranteed absorption/i);
  assert.doesNotMatch(SRC, /\bwhale\b/i);
  assert.doesNotMatch(SRC, /\bCVD\b/);
  assert.doesNotMatch(SRC, /retail sentiment/i);
  assert.doesNotMatch(SRC, /coinee/i);
});
