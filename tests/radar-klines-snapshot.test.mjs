import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  getFreshClosedKlinesForSymbol,
  normalizeKlinesSnapshot,
} from '../scripts/radar/klines-snapshot.mjs';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function candle(i, overrides = {}) {
  const openTime = NOW - (10 - i) * HOUR;
  return {
    openTime,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 1000 + i,
    closeTime: openTime + HOUR - 1,
    ...overrides,
  };
}

function snapshot(data, overrides = {}) {
  return {
    timeframe: '1h',
    updatedAtMs: NOW - 1000,
    data,
    ...overrides,
  };
}

test('valid snapshot normalizes symbols and candles', () => {
  const normalized = normalizeKlinesSnapshot(snapshot({
    btcusdt: [
      [NOW - 3 * HOUR, '100', '110', '90', '105', '1234', NOW - 2 * HOUR - 1],
      candle(9),
    ],
  }), { nowMs: NOW });

  assert.deepEqual(Object.keys(normalized.data), ['BTCUSDT']);
  assert.equal(normalized.timeframe, '1h');
  assert.equal(normalized.diagnostics.requested, 1);
  assert.equal(normalized.diagnostics.stored, 1);
  assert.deepEqual(normalized.data.BTCUSDT[0], {
    openTime: NOW - 3 * HOUR,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 1234,
    closeTime: NOW - 2 * HOUR - 1,
  });
});

test('invalid symbols are rejected', () => {
  const normalized = normalizeKlinesSnapshot(snapshot({
    'BTC-USDT': [candle(1)],
    'ETH_USDT': [candle(2)],
    'THIS_SYMBOL_NAME_IS_WAY_TOO_LONG': [candle(3)],
    ethusdt: [candle(4)],
  }), { nowMs: NOW });

  assert.deepEqual(Object.keys(normalized.data), ['ETHUSDT']);
  assert.deepEqual(normalized.diagnostics.invalidSymbols, [
    'BTC-USDT',
    'ETH_USDT',
    'THIS_SYMBOL_NAME_IS_WAY_TOO_LONG',
  ]);
  assert.equal(normalized.diagnostics.skipped, 3);
});

test('invalid candles are dropped', () => {
  const normalized = normalizeKlinesSnapshot(snapshot({
    SOLUSDT: [
      candle(1),
      { openTime: NOW, open: 'x', high: 1, low: 1, close: 1, volume: 1, closeTime: NOW + HOUR },
      { openTime: NOW, open: 1, high: 1, low: 1, close: 1, volume: Infinity, closeTime: NOW + HOUR },
      candle(2),
    ],
  }), { nowMs: NOW });

  assert.equal(normalized.data.SOLUSDT.length, 2);
  assert.equal(normalized.diagnostics.invalidCandles, 2);
});

test('forming latest candle is dropped', () => {
  const normalized = normalizeKlinesSnapshot(snapshot({
    ADAUSDT: [
      candle(1),
      candle(2),
      candle(3, { openTime: NOW - 30 * 60 * 1000, closeTime: NOW + 30 * 60 * 1000 }),
    ],
  }), { nowMs: NOW });

  assert.equal(normalized.data.ADAUSDT.length, 2);
  assert.equal(normalized.data.ADAUSDT.at(-1).openTime, candle(2).openTime);
});

test('stale snapshot returns null', () => {
  const stale = snapshot({ BTCUSDT: [candle(1), candle(2)] }, { updatedAtMs: NOW - 3 * HOUR });
  assert.equal(getFreshClosedKlinesForSymbol(stale, 'BTCUSDT', { nowMs: NOW, minCandles: 2 }), null);
});

test('fresh snapshot returns closed candles', () => {
  const fresh = snapshot({ BTCUSDT: [candle(1), candle(2), candle(3)] });
  const klines = getFreshClosedKlinesForSymbol(fresh, 'BTCUSDT', { nowMs: NOW, minCandles: 3 });

  assert.equal(klines.length, 3);
  assert.deepEqual(Object.keys(klines[0]), ['openTime', 'open', 'high', 'low', 'close', 'volume', 'closeTime']);
});

test('symbol lookup is case-insensitive', () => {
  const fresh = snapshot({ BTCUSDT: [candle(1), candle(2)] });
  const klines = getFreshClosedKlinesForSymbol(fresh, 'btcusdt', { nowMs: NOW, minCandles: 2 });

  assert.equal(klines.length, 2);
});

test('hard caps are enforced', () => {
  const data = {};
  for (let i = 0; i < 60; i += 1) {
    data[`S${i}USDT`] = Array.from({ length: 150 }, (_, j) => candle(j));
  }

  const normalized = normalizeKlinesSnapshot(snapshot(data, { limit: 500, topN: 500 }), { nowMs: NOW });
  assert.equal(normalized.limit, 120);
  assert.equal(normalized.topN, 50);
  assert.equal(Object.keys(normalized.data).length, 50);
  assert.equal(normalized.data.S0USDT.length, 120);
});

test('no fetch/http/env/file IO imports are used', () => {
  const source = readFileSync(new URL('../scripts/radar/klines-snapshot.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /\bimport\b/);
  assert.doesNotMatch(source, /\bfetch\b/);
  assert.doesNotMatch(source, /https?:\/\//i);
  assert.doesNotMatch(source, /\bprocess\.env\b/);
  assert.doesNotMatch(source, /\b(?:fs|node:fs|readFile|writeFile)\b/);
});

test('module has no dependency on bot.mjs, trading-radar.mjs, fleet store, Telegram, worker, or package changes', () => {
  const source = readFileSync(new URL('../scripts/radar/klines-snapshot.mjs', import.meta.url), 'utf8');
  const forbidden = [
    'bot.mjs',
    'trading-radar.mjs',
    '_fleet-store.mjs',
    'telegram',
    'worker',
    'package.json',
    'package-lock.json',
  ];

  for (const term of forbidden) {
    assert.ok(!source.toLowerCase().includes(term.toLowerCase()), `must not reference ${term}`);
  }
});
