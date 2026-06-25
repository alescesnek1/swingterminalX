import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTradingRadar } from '../scripts/radar/trading-radar.mjs';

const NOW = new Date('2026-06-12T10:00:00Z').getTime();
const BTC = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 900e6, bidPrice: 70000, askPrice: 70007, spreadPct: 0.01, change24hPct: 1.2 };

const FALLBACK_RECLAIM_MARKET = {
  symbol: 'FALLBACKUSDT', baseAsset: 'FALLBACK', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 250e6, bidPrice: 1.83, askPrice: 1.84,
  change24hPct: -9.5, high_24h: 2.134, low_24h: 1.498, signal: 'SHORT'
};

const MISSING_SOURCE_MARKET = {
  symbol: 'MISSINGUSDT', baseAsset: 'MISSING', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 250e6, bidPrice: 1.83, askPrice: 1.84,
  change24hPct: -9.5, signal: 'SHORT'
};

function candidateFor(symbol, extraMarkets = []) {
  const state = evaluateTradingRadar({ markets: [BTC, ...extraMarkets], source: 'test', now: NOW });
  return { state, c: state.candidates.find((x) => x.symbol === symbol) };
}

test('1: Reclaim fallback source is labelled as fallback in the returned object', () => {
  const { c } = candidateFor('FALLBACKUSDT', [FALLBACK_RECLAIM_MARKET]);
  
  const rv = c.reclaimV2;
  assert.ok(rv, 'reclaimV2 should exist');
  assert.ok(rv.primary, 'primary reclaim level should be built from fallback');
  assert.match(rv.primary.source, /fallback/i, 'source should indicate fallback');
  
  assert.ok(Array.isArray(rv.missingSourceFields));
  assert.ok(rv.missingSourceFields.includes('breakdownLevel'));
  assert.ok(Array.isArray(rv.presentSourceFields));
  assert.ok(rv.presentSourceFields.includes('high_24h'));
  assert.equal(c.telegramEligible, false);
});

test('2: Missing explicit reclaim source is visible and gracefully handled', () => {
  const { c } = candidateFor('MISSINGUSDT', [MISSING_SOURCE_MARKET]);
  
  const rv = c.reclaimV2;
  assert.ok(rv, 'reclaimV2 should exist');
  assert.equal(rv.primary, null, 'no primary reclaim level can be built');
  
  assert.equal(rv.RECLAIM_SOURCE_DATA_STATUS, 'RECLAIM_DATA_SOURCE_MISSING');
  assert.ok(Array.isArray(rv.missingSourceFields));
  assert.ok(rv.missingSourceFields.includes('high_24h'));
  assert.equal(c.telegramEligible, false);
});
