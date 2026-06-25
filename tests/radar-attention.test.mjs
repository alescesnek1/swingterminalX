import test from 'node:test';
import assert from 'node:assert';
import { evaluateTradingRadar } from '../scripts/radar/trading-radar.mjs';

function createMockCandidate(symbol) {
  return {
    symbol,
    lastPrice: 100,
    quoteVolume24h: 10000000,
    scannerScore: 8,
    scannerPanic: 0,
    scannerHot: 0,
    change1hPct: 1,
    change4hPct: 2,
    change12hPct: 3,
    change24hPct: 4,
    source: 'binance',
    exchange: 'binance',
  };
}

test('Without scannerContext.coingeckoTrending, evaluated candidate has no ATTENTION_* fields', (t) => {
  const result = evaluateTradingRadar({
    markets: [createMockCandidate('BTCUSDT')],
    scannerContext: {}
  });
  const c = result.candidates[0];
  assert.strictEqual(c.symbol, 'BTCUSDT');
  assert.strictEqual(c.ATTENTION_SOURCE, undefined);
  assert.strictEqual(c.ATTENTION_KIND, undefined);
  assert.strictEqual(c.ATTENTION_RANK, undefined);
  assert.strictEqual(c.ATTENTION_LABEL, undefined);
});

test('With valid trending context, matching candidate receives ATTENTION fields', (t) => {
  const result = evaluateTradingRadar({
    markets: [createMockCandidate('BTCUSDT')],
    scannerContext: {
      coingeckoTrending: {
        source: 'coingecko',
        kind: 'trending',
        stale: false,
        items: [
          { symbol: 'BTC', rank: 1 }
        ]
      }
    }
  });
  const c = result.candidates[0];
  assert.strictEqual(c.ATTENTION_SOURCE, 'coingecko');
  assert.strictEqual(c.ATTENTION_KIND, 'trending');
  assert.strictEqual(c.ATTENTION_RANK, 1);
  assert.strictEqual(c.ATTENTION_LABEL, 'CG #1');
  assert.strictEqual(c.ATTENTION_MATCH_CONFIDENCE, 'symbol');
});

test('Non-matching candidate receives no attention metadata', (t) => {
  const result = evaluateTradingRadar({
    markets: [createMockCandidate('ETHUSDT')],
    scannerContext: {
      coingeckoTrending: {
        source: 'coingecko',
        kind: 'trending',
        stale: false,
        items: [
          { symbol: 'BTC', rank: 1 }
        ]
      }
    }
  });
  const c = result.candidates[0];
  assert.strictEqual(c.ATTENTION_SOURCE, undefined);
});

test('Stale/unavailable CoinGecko snapshot produces no attention metadata', (t) => {
  const result = evaluateTradingRadar({
    markets: [createMockCandidate('BTCUSDT')],
    scannerContext: {
      coingeckoTrending: {
        source: 'coingecko',
        kind: 'trending',
        stale: true,
        items: [
          { symbol: 'BTC', rank: 1 }
        ]
      }
    }
  });
  const c = result.candidates[0];
  assert.strictEqual(c.ATTENTION_SOURCE, undefined);
});

test('Ambiguous prefix case does not attach metadata', (t) => {
  const result = evaluateTradingRadar({
    markets: [createMockCandidate('1000PEPEUSDT')],
    scannerContext: {
      coingeckoTrending: {
        source: 'coingecko',
        kind: 'trending',
        stale: false,
        items: [
          { symbol: 'PEPE', rank: 1 }
        ]
      }
    }
  });
  const c = result.candidates[0];
  assert.strictEqual(c.symbol, '1000PEPEUSDT');
  assert.strictEqual(c.ATTENTION_SOURCE, undefined);
});

test('Most important isolation test: compare all execution fields and confirm unchanged', (t) => {
  const c1 = createMockCandidate('BTCUSDT');
  c1.absorbStatus = 'ABSORB_CONFIRMED';
  c1.reclaimLevel = 50000;
  c1.telegramEligible = true;

  const resWithout = evaluateTradingRadar({
    markets: [c1],
    scannerContext: {}
  });

  const resWith = evaluateTradingRadar({
    markets: [c1],
    scannerContext: {
      coingeckoTrending: {
        source: 'coingecko',
        kind: 'trending',
        stale: false,
        items: [
          { symbol: 'BTC', rank: 1 }
        ]
      }
    }
  });

  const candWithout = resWithout.candidates[0];
  const candWith = resWith.candidates[0];

  assert.strictEqual(candWith.ATTENTION_SOURCE, 'coingecko');

  // Compare core fields
  const fieldsToCheck = [
    'status',
    'v1Status',
    'distanceToEntryReadyScore',
    'score',
    'confidence',
    'telegramEligible',
    'isEntryReady',
    'v1Action',
    'actionability',
    'setupQualityScore'
  ];

  for (const field of fieldsToCheck) {
    assert.strictEqual(candWith[field], candWithout[field], `Field ${field} must remain unchanged`);
  }
  
  assert.deepStrictEqual(candWith.conditionChecklist, candWithout.conditionChecklist, 'Checklist unchanged');
  
  // Ordering must be identical
  assert.strictEqual(resWithout.candidates.length, resWith.candidates.length);
  for (let i = 0; i < resWithout.candidates.length; i++) {
    assert.strictEqual(resWithout.candidates[i].symbol, resWith.candidates[i].symbol);
  }
});

test('valid source/kind/stale false, matching symbol, but rank missing or non-finite -> no ATTENTION_* metadata', (t) => {
  const result = evaluateTradingRadar({
    markets: [createMockCandidate('BTCUSDT')],
    scannerContext: {
      coingeckoTrending: {
        source: 'coingecko',
        kind: 'trending',
        stale: false,
        items: [
          { symbol: 'BTC', rank: undefined },
          { symbol: 'BTC', rank: -5 },
          { symbol: 'BTC', rank: null },
          { symbol: 'BTC', rank: NaN },
          { symbol: 'BTC', rank: 'top' }
        ]
      }
    }
  });
  const c = result.candidates[0];
  assert.strictEqual(c.ATTENTION_SOURCE, undefined);
  assert.strictEqual(c.ATTENTION_RANK, undefined);
});
