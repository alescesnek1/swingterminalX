import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAbsorptionFromPointsAndOrderbook, analyzeReclaimFromPoints } from '../netlify/functions/_price-history-signals.mjs';

function points(prices, volumes = []) {
  return prices.map((price_usd, i) => ({ symbol: 'BTC', sampled_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), price_usd, volume_24h_usd: volumes[i] ?? 100 }));
}
const bidBook = { best_bid: 100, best_ask: 100.1, spread_bps: 10, imbalance: 0.35 };
const askBook = { best_bid: 100, best_ask: 100.1, spread_bps: 10, imbalance: -0.35 };

test('reclaim returns UNKNOWN for insufficient history and bad input does not throw', () => {
  const result = analyzeReclaimFromPoints({ symbol: 'btc', points: points([100, 101]) });
  assert.deepEqual({ ok: result.ok, signal: result.signal, status: result.status }, { ok: true, signal: 'UNKNOWN', status: 'INSUFFICIENT_HISTORY' });
  assert.doesNotThrow(() => analyzeReclaimFromPoints({ points: { invalid: true } }));
});

test('reclaim sorts safely, ignores invalid price rows, and detects bullish reclaim', () => {
  const input = points([90, 95, 100, 98, 101, 102]);
  input.push({ sampled_at: 'bad-time', price_usd: 999 }, { sampled_at: new Date().toISOString(), price_usd: 'bad' });
  const result = analyzeReclaimFromPoints({ symbol: 'btc', points: input.reverse(), options: { lookback: 4, confirmations: 2 } });
  assert.equal(result.signal, 'BULLISH_RECLAIM');
  assert.equal(result.level, 100);
  assert.equal(result.pointsUsed, 6);
});

test('reclaim detects failed reclaim and no reclaim', () => {
  const failed = analyzeReclaimFromPoints({ symbol: 'btc', points: points([90, 95, 100, 98, 101, 99]), options: { lookback: 4, confirmations: 2 } });
  const noReclaim = analyzeReclaimFromPoints({ symbol: 'btc', points: points([90, 95, 100, 98, 99, 97]), options: { lookback: 4, confirmations: 2 } });
  assert.equal(failed.signal, 'FAILED_RECLAIM');
  assert.equal(noReclaim.signal, 'NO_RECLAIM');
});

test('absorption handles insufficient history and malformed orderbook safely', () => {
  const insufficient = analyzeAbsorptionFromPointsAndOrderbook({ symbol: 'btc', points: points([100, 99]), orderbook: { bids: 'bad' } });
  assert.equal(insufficient.signal, 'UNKNOWN');
  assert.equal(insufficient.status, 'INSUFFICIENT_HISTORY');
  const malformed = analyzeAbsorptionFromPointsAndOrderbook({ symbol: 'btc', points: points([110, 108, 106, 104, 104, 104, 104, 104], [100, 100, 100, 100, 220, 220, 220, 220]), orderbook: { imbalance: 'bad' } });
  assert.equal(malformed.orderbookUsed, false);
  assert.doesNotThrow(() => analyzeAbsorptionFromPointsAndOrderbook({ points: null, orderbook: null }));
});

test('absorption detects bullish holding volume and valid bid book raises confidence', () => {
  const input = points([110, 108, 106, 104, 104, 104.2, 104.4, 104.6], [100, 100, 100, 100, 130, 130, 130, 130]);
  const historyOnly = analyzeAbsorptionFromPointsAndOrderbook({ symbol: 'btc', points: input, options: { recentWindow: 4 } });
  const supported = analyzeAbsorptionFromPointsAndOrderbook({ symbol: 'btc', points: input, orderbook: bidBook, options: { recentWindow: 4 } });
  assert.equal(supported.signal, 'BULLISH_ABSORPTION');
  assert.equal(supported.orderbookUsed, true);
  assert.equal(supported.orderbookSupport, 'bid');
  assert.equal(historyOnly.confidence, 'low');
  assert.equal(supported.confidence, 'medium');
});

test('absorption detects bearish ask pressure and no absorption without a volume spike', () => {
  const bearish = analyzeAbsorptionFromPointsAndOrderbook({ symbol: 'btc', orderbook: askBook, options: { recentWindow: 4 }, points: points([90, 94, 98, 102, 102.1, 102.2, 102.15, 102.1], [100, 100, 100, 100, 220, 220, 220, 220]) });
  const noSpike = analyzeAbsorptionFromPointsAndOrderbook({ symbol: 'btc', points: points([110, 108, 106, 104, 104, 104, 104, 104]) });
  assert.equal(bearish.signal, 'BEARISH_ABSORPTION');
  assert.equal(bearish.orderbookSupport, 'ask');
  assert.equal(noSpike.signal, 'NO_ABSORPTION');
});
