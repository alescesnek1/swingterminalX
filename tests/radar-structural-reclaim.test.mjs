import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStructuralReclaimLevels } from '../scripts/radar/structural-reclaim.mjs';

function makeSingleSwingBreakFixture() {
  const klines = [];
  // 40 candles total
  for (let i = 0; i < 40; i++) {
    let open = 100, close = 100, high = 101, low = 99, volume = 1000;
    
    // Create exactly one clear swing low at index 15 with low 90
    if (i === 15) {
      low = 90;
      close = 92;
    } else if (i === 14 || i === 16) {
      low = 95; // higher than 90
    } else if (i === 13 || i === 17) {
      low = 96;
    } else if (i === 12 || i === 18) {
      low = 97;
    }

    // A closed breakdown candle at index 25
    if (i === 25) {
      open = 95;
      close = 85; // close below 90
      low = 84;
      high = 96;
    }

    klines.push({ open, high, low, close, volume });
  }
  return klines;
}

function makeFormingOnlyBreakFixture() {
  const klines = [];
  for (let i = 0; i < 40; i++) {
    let open = 100, close = 100, high = 101, low = 99, volume = 1000;
    
    // Clear swing low 90 at index 15
    if (i === 15) {
      low = 90;
      close = 92;
    } else if (i === 14 || i === 16) {
      low = 95; 
    } else if (i === 13 || i === 17) {
      low = 96;
    } else if (i === 12 || i === 18) {
      low = 97;
    }

    // No closed breakdown. The final latest candle closes below 90.
    if (i === 39) {
      open = 95;
      close = 85; 
      low = 84;
      high = 96;
    }

    klines.push({ open, high, low, close, volume });
  }
  return klines;
}

test('1: Detects obvious broken support as computedBreakdownLevel', () => {
  const klines = makeSingleSwingBreakFixture();
  const res = computeStructuralReclaimLevels(klines);
  assert.ok(res);
  assert.equal(res.computedBreakdownLevel, 90);
});

test('2: Returns computedReclaimLevel equal to broken swing-low support with explicit reason', () => {
  const klines = makeSingleSwingBreakFixture();
  const res = computeStructuralReclaimLevels(klines);
  assert.ok(res);
  assert.equal(res.computedReclaimLevel, 90);
  assert.equal(typeof res.computedStructuralReason, 'string');
  assert.match(res.computedStructuralReason, /Swing low at index 15/);
});

test('3: Excludes latest candle by default, forming-candle breakdown does not count', () => {
  const klines = makeFormingOnlyBreakFixture();
  const res = computeStructuralReclaimLevels(klines);
  assert.equal(res, null, 'Default must exclude latest candle, returning null');
  
  const resInclude = computeStructuralReclaimLevels(klines, { includeLastCandle: true });
  assert.ok(resInclude, 'With includeLastCandle true, forming breakdown counts');
  assert.equal(resInclude.computedBreakdownLevel, 90);
});

test('4: Returns null for monotonic bleed with no confirmed swing', () => {
  const klines = [];
  let price = 100;
  for (let i = 0; i < 40; i++) {
    klines.push({ open: price, high: price + 1, low: price - 2, close: price - 1, volume: 1000 });
    price -= 1;
  }
  const res = computeStructuralReclaimLevels(klines);
  assert.equal(res, null);
});

test('5: Returns null for insufficient candles', () => {
  const klines = makeSingleSwingBreakFixture().slice(0, 20); // only 20 candles
  const res = computeStructuralReclaimLevels(klines, { minCandles: 30 });
  assert.equal(res, null);
});

test('6: Never returns current price / stop / invalidation because those inputs are not API inputs (leakage test)', () => {
  const klines = makeSingleSwingBreakFixture();
  const forbidden = [12345, 111, 112, 113];
  const opts = { currentPrice: 12345, stopLoss: 111, hardInvalidation: 112, invalidationLevel: 113 };
  const res = computeStructuralReclaimLevels(klines, opts);
  assert.ok(res);
  assert.equal(res.computedBreakdownLevel, 90);
  for (const v of Object.values(res)) {
    if (typeof v === 'number') {
      assert.ok(!forbidden.includes(v), `Value ${v} should not equal forbidden inputs`);
    }
  }
});

test('7: Handles Binance array klines', () => {
  const binanceKlines = [];
  for (let i = 0; i < 40; i++) {
    let open = "100", close = "100", high = "101", low = "99", volume = "1000";
    if (i === 15) {
      low = "90";
      close = "92";
    } else if (i === 14 || i === 16) { low = "95"; }
    else if (i === 13 || i === 17) { low = "96"; }
    else if (i === 12 || i === 18) { low = "97"; }

    if (i === 25) {
      open = "95";
      close = "85";
    }
    binanceKlines.push([Date.now(), open, high, low, close, volume, Date.now()]);
  }
  const res = computeStructuralReclaimLevels(binanceKlines);
  assert.ok(res);
  assert.equal(res.computedBreakdownLevel, 90);
});

test('8: Handles normalized object input', () => {
  const klines = makeSingleSwingBreakFixture();
  const res = computeStructuralReclaimLevels(klines);
  assert.ok(res);
  assert.equal(res.computedBreakdownLevel, 90);
});

test('9: Handles invalid candles without throwing', () => {
  const klines = makeSingleSwingBreakFixture();
  klines[5] = null;
  klines[8] = { open: "abc", high: 100, low: 90, close: NaN, volume: 10 };
  const res = computeStructuralReclaimLevels(klines);
  assert.ok(res); // Should gracefully drop bad candles and still find structure
});

test('10: computedFlushHigh is null unless breakdown candle passes displacement criteria', () => {
  const klinesDisp = makeSingleSwingBreakFixture();
  // Ensure the fixture has a non-zero median body!
  for (let k of klinesDisp) {
    if (k.open === k.close) k.close = k.open * 0.995; // 0.5% median body
  }
  const resDisp = computeStructuralReclaimLevels(klinesDisp);
  assert.ok(resDisp.computedFlushHigh === 96, 'Should have flush high for large displacement');

  const klinesSmall = makeSingleSwingBreakFixture();
  for (let k of klinesSmall) {
    if (k.open === k.close) k.close = k.open * 0.995; // 0.5% median body
  }
  // Modify the breakdown candle to be tiny
  klinesSmall[25].open = 89.1;
  klinesSmall[25].close = 89.0;
  klinesSmall[25].high = 89.2;
  const resNoDisp = computeStructuralReclaimLevels(klinesSmall);
  assert.ok(resNoDisp);
  assert.equal(resNoDisp.computedFlushHigh, null, 'Flush high should be null because body is tiny');
});
