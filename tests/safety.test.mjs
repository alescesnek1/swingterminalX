// Phase 1 honesty guards for the safety layer + Telegram safety gate:
//   - DANGER blocks entry-ready + Telegram
//   - UNKNOWN blocks Telegram eligibility (only SAFE is alertable)
//   - empty / sentinel ABI is NOT treated as a verified contract
import test from 'node:test';
import assert from 'node:assert/strict';

import { checkBscScanTokenSafety, evaluateKnownSafety } from '../scripts/safety/chain-safety.mjs';
import { evaluateTradingRadar } from '../scripts/radar/trading-radar.mjs';
import { isRadarTelegramQualifiedCandidate } from '../netlify/functions/cron-alerts.mjs';

const BTC = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 900e6, bidPrice: 70000, askPrice: 70001, spreadPct: 0.01, depthUsdWithin1Pct: 5e6, change24hPct: 1 };
const ETH = { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 700e6, bidPrice: 3500, askPrice: 3501, spreadPct: 0.01, depthUsdWithin1Pct: 4e6, change24hPct: 0.8 };
const FULL = {
  symbol: 'SIRENUSDT', baseAsset: 'SIREN', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 300e6, bidPrice: 10, askPrice: 10.002, spreadPct: 0.02,
  change24hPct: -10, change12hPct: -8, change4hPct: 2, change1hPct: 1.4, volumeSpike: 2.5, atrPct: 4,
  longLiquidationSpike: 2.1, shortLiquidationSpike: 1.4, openInterestChangePct: -6, marketSellRatio: 0.52,
  fundingRate: -0.01, wickRecoveryPct: 45, noNewLowMinutes: 45, rangeFormed: true, sellAggressionFading: true,
  bidDepthRebuildPct: 16, reclaimConfirmed: true, retestHeld: true, higherLowHeld: true, marketBuyVolumeDominance: 0.59,
  vwap: 9.8, flushLow: 8.6, higherLow: 9.35, depthUsdWithin1Pct: 2_000_000, depthUsd: 2_000_000,
};

function entryCandidate(over = {}) {
  return {
    symbol: 'SOLUSDT', STATUS: 'STANDARD_ENTRY_READY', stage: 'ENTRY_READY', actionability: 'ENTRY_READY',
    telegramEligible: true, safetyStatus: 'SAFE', allRadarConditionsPassed: true, confidence: 82,
    entryZone: { low: 139.5, high: 141.2 }, invalidationLevel: 132.4, suggestedStop: 131.8, ...over,
  };
}

test('DANGER safety blocks entry-ready status and Telegram eligibility', () => {
  const danger = evaluateTradingRadar({
    markets: [BTC, ETH, { ...FULL, chain: 'bsc', contractAddress: '0xabc', topHolderPercent: 38, contractVerified: true }],
    now: Date.now(),
  }).candidates.find((c) => c.symbol === 'SIRENUSDT');
  assert.equal(danger.safetyStatus, 'DANGER');
  assert.notEqual(danger.actionability, 'ENTRY_READY');
  assert.equal(danger.telegramEligible, false);
  assert.equal(isRadarTelegramQualifiedCandidate(entryCandidate({ safetyStatus: 'DANGER' })), false);
});

test('UNKNOWN safety blocks Telegram eligibility (only SAFE is alertable)', () => {
  assert.equal(isRadarTelegramQualifiedCandidate(entryCandidate({ safetyStatus: 'UNKNOWN' })), false);
  assert.equal(isRadarTelegramQualifiedCandidate(entryCandidate({ safetyStatus: 'CAUTION' })), false);
  assert.equal(isRadarTelegramQualifiedCandidate(entryCandidate({ safetyStatus: 'SAFE' })), true);
});

test('engine: a row with no chain/contract resolves UNKNOWN and is never Telegram-eligible', () => {
  // FULL has no chain/contractAddress → safety UNKNOWN. Even if it otherwise
  // looks entry-ready, UNKNOWN safety must keep telegramEligible false.
  const c = evaluateTradingRadar({ markets: [BTC, ETH, FULL], now: Date.now() }).candidates.find((x) => x.symbol === 'SIRENUSDT');
  assert.equal(c.safetyStatus, 'UNKNOWN');
  assert.equal(c.telegramEligible, false);
});

test('BscScan adapter: empty ABI is NOT treated as verified', async () => {
  const fetchEmpty = async () => ({ ok: true, json: async () => ({ result: [{ SourceCode: '', ABI: '' }] }) });
  const empty = await checkBscScanTokenSafety({ contractAddress: '0xEmptyAbi', chain: 'bsc', apiKey: 'k', fetchImpl: fetchEmpty });
  assert.equal(empty.contractVerified, false);

  const fetchSentinel = async () => ({ ok: true, json: async () => ({ result: [{ SourceCode: '', ABI: 'Contract source code not verified' }] }) });
  const sentinel = await checkBscScanTokenSafety({ contractAddress: '0xSentinel', chain: 'bsc', apiKey: 'k', fetchImpl: fetchSentinel });
  assert.equal(sentinel.contractVerified, false);

  const fetchReal = async () => ({ ok: true, json: async () => ({ result: [{ SourceCode: 'contract C {}', ABI: '[{"type":"function"}]' }] }) });
  const real = await checkBscScanTokenSafety({ contractAddress: '0xReal', chain: 'bsc', apiKey: 'k', fetchImpl: fetchReal });
  assert.equal(real.contractVerified, true);
});

test('evaluateKnownSafety never marks missing chain/contract as SAFE', () => {
  assert.equal(evaluateKnownSafety({}).safetyStatus, 'UNKNOWN');
  assert.equal(evaluateKnownSafety({ chain: 'bsc' }).safetyStatus, 'UNKNOWN');
});
