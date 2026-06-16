// Safety enrichment honesty matrix: metadata resolver + classification +
// RADAR wiring + diagnostics + UI reason rendering. No fake SAFE, Telegram
// still requires SAFE.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { resolveTokenMetadata, METADATA_REASONS, __clearTokenMetadataCache } from '../scripts/safety/token-metadata.mjs';
import { classifyMarketSafety, evaluateKnownSafety, buildSafetyDiagnostics, SAFETY_REASONS } from '../scripts/safety/chain-safety.mjs';
import { evaluateTradingRadar } from '../scripts/radar/trading-radar.mjs';
import { evaluateConfirmedRadarEntryReady, TELEGRAM_CODES } from '../netlify/functions/cron-alerts.mjs';

test('known allowlisted token resolves to SAFE with ALLOWLISTED reason', () => {
  const s = classifyMarketSafety({ symbol: 'LINKUSDT' });
  assert.equal(s.safetyStatus, 'SAFE');
  assert.equal(s.safetyReason, SAFETY_REASONS.ALLOWLISTED);
  assert.equal(s.chain, 'ethereum');
  assert.ok(s.contractAddress);
});

test('row-supplied verified contract resolves SAFE/RESOLVED', () => {
  const s = evaluateKnownSafety({ chain: 'ethereum', contractAddress: '0xabc', contractVerified: true, topHolderPercent: 4 });
  assert.equal(s.safetyStatus, 'SAFE');
  assert.equal(s.safetyReason, SAFETY_REASONS.RESOLVED);
});

test('missing contract -> UNKNOWN + MISSING_CONTRACT_METADATA', () => {
  const s = classifyMarketSafety({ symbol: 'FOOBARUSDT' });
  assert.equal(s.safetyStatus, 'UNKNOWN');
  assert.equal(s.safetyReason, SAFETY_REASONS.MISSING_CONTRACT_METADATA);
});

test('ambiguous symbol -> UNKNOWN + AMBIGUOUS_CONTRACT_MAPPING', () => {
  const s = classifyMarketSafety({ symbol: 'WETHUSDT' });
  assert.equal(s.safetyStatus, 'UNKNOWN');
  assert.equal(s.safetyReason, SAFETY_REASONS.AMBIGUOUS_CONTRACT_MAPPING);
});

test('provider failure -> UNKNOWN + METADATA_FETCH_FAILED', () => {
  __clearTokenMetadataCache();
  const meta = resolveTokenMetadata({ symbol: 'NEWTOKENUSDT' }, { fetchImpl: () => { throw new Error('429 rate limit'); } });
  assert.equal(meta.reason, METADATA_REASONS.METADATA_FETCH_FAILED);
  const s = classifyMarketSafety({ symbol: 'NEWTOKENUSDT' }, { fetchImpl: () => { throw new Error('429 rate limit'); } });
  assert.equal(s.safetyStatus, 'UNKNOWN');
  assert.equal(s.safetyReason, SAFETY_REASONS.METADATA_FETCH_FAILED);
});

test('unverified contract -> CAUTION + UNVERIFIED_CONTRACT', () => {
  const s = classifyMarketSafety({ symbol: 'XYZUSDT', chain: 'bsc', contractAddress: '0xdef', contractVerified: false });
  assert.equal(s.safetyStatus, 'CAUTION');
  assert.equal(s.safetyReason, SAFETY_REASONS.UNVERIFIED_CONTRACT);
});

test('dangerous token -> DANGER', () => {
  const holderDanger = classifyMarketSafety({ symbol: 'SIRENUSDT', chain: 'bsc', contractAddress: '0xabc', contractVerified: true, topHolderPercent: 38 });
  assert.equal(holderDanger.safetyStatus, 'DANGER');
  const exploit = classifyMarketSafety({ symbol: 'HACKUSDT', chain: 'bsc', contractAddress: '0xabc', contractVerified: true, exploitRisk: true });
  assert.equal(exploit.safetyStatus, 'DANGER');
  assert.equal(exploit.safetyReason, SAFETY_REASONS.CRITICAL_EVENT_RISK);
});

test('no token is marked SAFE by symbol-only guessing', () => {
  // A symbol not in the curated allowlist, with no chain/contract and no
  // provider, must never be SAFE.
  for (const sym of ['RANDOMUSDT', 'SCAMUSDT', 'ZZZUSDT', 'PEPE2USDT']) {
    const s = classifyMarketSafety({ symbol: sym });
    assert.notEqual(s.safetyStatus, 'SAFE', `${sym} must not be SAFE`);
  }
  const meta = resolveTokenMetadata({ symbol: 'RANDOMUSDT' });
  assert.equal(meta.allowlisted, false);
  assert.equal(meta.contractAddress, null);
});

test('Telegram gate: UNKNOWN / CAUTION / DANGER block; SAFE passes', () => {
  const base = {
    symbol: 'SOLUSDT', STATUS: 'STANDARD_ENTRY_READY', actionability: 'ENTRY_READY',
    telegramEligible: true, allRadarConditionsPassed: true,
    entryZone: { low: 1, high: 1.1 }, invalidationLevel: 0.9, suggestedStop: 0.9,
    TAKE_PROFIT_LEVELS: [{ level: 1.2 }, { level: 1.3 }, { level: 1.4 }], tpZonesExist: true,
    executionDataMissing: [], EXECUTION_SCORE: 70, SETUP_SCORE: 74, RISK_REWARD_SCORE: 64,
    MARKET_REGIME_SCORE: 61, confidence: 82, stale: false,
  };
  for (const st of ['UNKNOWN', 'CAUTION', 'DANGER']) {
    const ev = evaluateConfirmedRadarEntryReady({ ...base, safetyStatus: st });
    assert.equal(ev.ok, false);
    assert.equal(ev.code, TELEGRAM_CODES.SKIPPED_SAFETY_NOT_SAFE);
  }
  const safe = evaluateConfirmedRadarEntryReady({ ...base, safetyStatus: 'SAFE' });
  assert.equal(safe.ok, true);
});

test('RADAR engine attaches honest safety + reason; non-allowlisted stays non-eligible', () => {
  const BTC = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 900e6, bidPrice: 70000, askPrice: 70001, spreadPct: 0.01, change24hPct: 1 };
  const FOO = { symbol: 'FOOBARUSDT', baseAsset: 'FOOBAR', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 50e6, bidPrice: 1, askPrice: 1.001, spreadPct: 0.02, change24hPct: -9 };
  const radar = evaluateTradingRadar({ markets: [BTC, FOO], now: Date.now() });
  const btc = radar.candidates.find((c) => c.symbol === 'BTCUSDT');
  const foo = radar.candidates.find((c) => c.symbol === 'FOOBARUSDT');
  assert.equal(btc.safetyStatus, 'SAFE');
  assert.equal(btc.safetyReason, SAFETY_REASONS.ALLOWLISTED);
  assert.equal(foo.safetyStatus, 'UNKNOWN');
  assert.equal(foo.safetyReason, SAFETY_REASONS.MISSING_CONTRACT_METADATA);
  // Neither is telegram-eligible (no microstructure), and FOO is never SAFE.
  assert.equal(foo.telegramEligible, false);
  // Diagnostics carry the new counts + sample reasons.
  const d = radar.universeDiagnostics;
  assert.ok(d.safetySafeCount >= 1);
  assert.ok(d.missingContractMetadataCount >= 1);
  assert.ok(Array.isArray(d.sampleSafetyReasons) && d.sampleSafetyReasons.length >= 1);
  assert.ok('ambiguousContractMappingCount' in d);
  assert.ok('safetyProviderFailedCount' in d);
});

test('buildSafetyDiagnostics counts by status and reason', () => {
  const rows = [
    classifyMarketSafety({ symbol: 'BTCUSDT' }),
    classifyMarketSafety({ symbol: 'FOOBARUSDT' }),
    classifyMarketSafety({ symbol: 'WETHUSDT' }),
    classifyMarketSafety({ symbol: 'XYZUSDT', chain: 'bsc', contractAddress: '0xdef', contractVerified: false }),
  ];
  const d = buildSafetyDiagnostics(rows);
  assert.equal(d.safetySafeCount, 1);
  assert.equal(d.safetyCautionCount, 1);
  assert.equal(d.safetyUnknownCount, 2);
  assert.equal(d.missingContractMetadataCount, 1);
  assert.equal(d.ambiguousContractMappingCount, 1);
});

test('UI: scanner shows reason, RADAR detail shows reason/chain/contract/source, cockpit shows Telegram-blocked', () => {
  const js = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
  // scanner pill title carries STATUS - reason (not just generic UNKNOWN)
  assert.match(js, /title="\$\{_esc\(s\.status \+ ' - ' \+ s\.reason\)\}"/);
  assert.match(js, /allowlisted asset/);
  // RADAR focus detail shows reason + chain + contract + source + telegram state
  assert.match(js, /Safety reason/);
  assert.match(js, /<span>Chain<\/span>/);
  assert.match(js, /<span>Contract<\/span>/);
  assert.match(js, /<span>Safety source<\/span>/);
  // Cockpit telegram-blocked note
  assert.match(js, /Telegram blocked: safety is not SAFE/);
});
