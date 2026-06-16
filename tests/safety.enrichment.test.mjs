// Safety enrichment honesty matrix: metadata resolver + classification +
// CEX-only model + RADAR wiring + diagnostics + UI reason rendering.
// No fake SAFE; Telegram still requires SAFE.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { resolveTokenMetadata, METADATA_REASONS, __clearTokenMetadataCache } from '../scripts/safety/token-metadata.mjs';
import { classifyMarketSafety, evaluateKnownSafety, buildSafetyDiagnostics, SAFETY_REASONS } from '../scripts/safety/chain-safety.mjs';
import { evaluateTradingRadar } from '../scripts/radar/trading-radar.mjs';
import { evaluateConfirmedRadarEntryReady, TELEGRAM_CODES } from '../netlify/functions/cron-alerts.mjs';

test('current allowlisted majors still SAFE (native + ERC20)', () => {
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'NEARUSDT', 'INJUSDT', 'UNIUSDT', 'XLMUSDT', 'LINKUSDT']) {
    const s = classifyMarketSafety({ symbol: sym, baseAsset: sym.replace(/USDT$/, '') });
    assert.equal(s.safetyStatus, 'SAFE', `${sym} expected SAFE`);
    assert.equal(s.safetyReason, SAFETY_REASONS.ALLOWLISTED);
    assert.ok(s.chain && s.contractAddress);
  }
});

test('row-supplied verified contract resolves SAFE/RESOLVED', () => {
  const s = evaluateKnownSafety({ chain: 'ethereum', contractAddress: '0xabc', contractVerified: true, topHolderPercent: 4 });
  assert.equal(s.safetyStatus, 'SAFE');
  assert.equal(s.safetyReason, SAFETY_REASONS.RESOLVED);
});

test('unknown non-mapped on-chain token stays UNKNOWN + MISSING_CONTRACT_METADATA', () => {
  const s = classifyMarketSafety({ symbol: 'FOOBAR' }); // no quote, no contract, not CEX
  assert.equal(s.safetyStatus, 'UNKNOWN');
  assert.equal(s.safetyReason, SAFETY_REASONS.MISSING_CONTRACT_METADATA);
});

test('CEX-only symbol without contract -> UNKNOWN + CEX_ONLY_NO_CONTRACT_CONTEXT', () => {
  for (const m of [{ symbol: 'BSBUSDT' }, { symbol: 'HYPEUSDT' }, { symbol: 'XYZ', baseAsset: 'XYZ', isScannerContext: true }]) {
    const s = classifyMarketSafety(m);
    assert.equal(s.safetyStatus, 'UNKNOWN');
    assert.equal(s.safetyReason, SAFETY_REASONS.CEX_ONLY_NO_CONTRACT_CONTEXT, `${m.symbol} expected CEX-only`);
  }
});

test('ambiguous symbol stays UNKNOWN + AMBIGUOUS_CONTRACT_MAPPING', () => {
  const s = classifyMarketSafety({ symbol: 'WETHUSDT' });
  assert.equal(s.safetyStatus, 'UNKNOWN');
  assert.equal(s.safetyReason, SAFETY_REASONS.AMBIGUOUS_CONTRACT_MAPPING);
});

test('provider failure -> UNKNOWN + METADATA_FETCH_FAILED', () => {
  __clearTokenMetadataCache();
  const s = classifyMarketSafety({ symbol: 'NEWTOKEN', baseAsset: 'NEWTOKEN' }, { fetchImpl: () => { throw new Error('429'); } });
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

test('adding a curated token requires chain + contract + curated source', () => {
  for (const sym of ['BTC', 'ETH', 'XLM', 'NEAR', 'INJ', 'UNI', 'AAVE', 'ARB']) {
    const meta = resolveTokenMetadata({ baseAsset: sym });
    assert.equal(meta.reason, METADATA_REASONS.ALLOWLISTED);
    assert.ok(meta.chain, `${sym} must have chain`);
    assert.ok(meta.contractAddress, `${sym} must have contract/native ref`);
    assert.equal(meta.source, 'curated-allowlist');
  }
});

test('no token is marked SAFE by symbol-only guessing', () => {
  for (const sym of ['RANDOMUSDT', 'SCAMUSDT', 'BSBUSDT', 'HYPEUSDT', 'WILDUSDT', 'JTOUSDT']) {
    const s = classifyMarketSafety({ symbol: sym });
    assert.notEqual(s.safetyStatus, 'SAFE', `${sym} must not be SAFE`);
  }
  const meta = resolveTokenMetadata({ symbol: 'RANDOMUSDT' });
  assert.equal(meta.allowlisted, false);
  assert.equal(meta.contractAddress, null);
});

test('Telegram gate: UNKNOWN / CAUTION / DANGER block; SAFE passes if all other gates pass', () => {
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
  assert.equal(evaluateConfirmedRadarEntryReady({ ...base, safetyStatus: 'SAFE' }).ok, true);
});

test('RADAR engine: allowlisted SAFE, CEX-only stays UNKNOWN + non-eligible, diagnostics present', () => {
  const BTC = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 900e6, bidPrice: 70000, askPrice: 70001, spreadPct: 0.01, change24hPct: 1 };
  const BSB = { symbol: 'BSBUSDT', baseAsset: 'BSB', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 50e6, bidPrice: 1, askPrice: 1.001, spreadPct: 0.02, change24hPct: -9 };
  const radar = evaluateTradingRadar({ markets: [BTC, BSB], now: Date.now() });
  const btc = radar.candidates.find((c) => c.symbol === 'BTCUSDT');
  const bsb = radar.candidates.find((c) => c.symbol === 'BSBUSDT');
  assert.equal(btc.safetyStatus, 'SAFE');
  assert.equal(btc.safetyReason, SAFETY_REASONS.ALLOWLISTED);
  assert.equal(bsb.safetyStatus, 'UNKNOWN');
  assert.equal(bsb.safetyReason, SAFETY_REASONS.CEX_ONLY_NO_CONTRACT_CONTEXT);
  assert.equal(bsb.telegramEligible, false);
  const d = radar.universeDiagnostics;
  assert.ok(d.safetySafeCount >= 1);
  assert.ok(d.cexOnlyNoContextCount >= 1);
  assert.ok(typeof d.safetyCoveragePct === 'number');
  assert.ok(d.resolverSourceBreakdown && d.resolverSourceBreakdown.curatedAllowlist >= 1);
  assert.ok(d.resolverSourceBreakdown.cexOnly >= 1);
});

test('buildSafetyDiagnostics: coverage %, counts, source breakdown', () => {
  const rows = [
    classifyMarketSafety({ symbol: 'BTCUSDT', baseAsset: 'BTC' }),
    classifyMarketSafety({ symbol: 'BSBUSDT', baseAsset: 'BSB' }),
    classifyMarketSafety({ symbol: 'WETHUSDT' }),
    classifyMarketSafety({ symbol: 'XYZUSDT', chain: 'bsc', contractAddress: '0xdef', contractVerified: false }),
    classifyMarketSafety({ symbol: 'FOOBAR' }),
  ];
  const d = buildSafetyDiagnostics(rows);
  assert.equal(d.safetySafeCount, 1);
  assert.equal(d.safetyCautionCount, 1);
  assert.equal(d.safetyUnknownCount, 3);
  assert.equal(d.cexOnlyNoContextCount, 1);
  assert.equal(d.ambiguousContractMappingCount, 1);
  assert.equal(d.missingContractMetadataCount, 1);
  assert.equal(d.safetyCoveragePct, 40); // 2 classified (SAFE+CAUTION) / 5
  assert.equal(d.resolverSourceBreakdown.curatedAllowlist, 1);
  assert.equal(d.resolverSourceBreakdown.cexOnly, 1);
  assert.equal(d.resolverSourceBreakdown.ambiguous, 1);
});

test('UI: improved reason strings + CEX-only + Telegram-blocked present in shipped JS', () => {
  const js = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
  assert.match(js, /CEX-only, no contract context/);
  assert.match(js, /curated verified asset/);
  assert.match(js, /ambiguous contract mapping/);
  assert.match(js, /missing contract metadata/);
  // scanner tooltip shows reason + source/chain/contract
  assert.match(js, /src:'\+s\.source/);
  // RADAR detail rows
  assert.match(js, /Safety reason/);
  assert.match(js, /<span>Chain<\/span>/);
  assert.match(js, /<span>Contract<\/span>/);
  assert.match(js, /<span>Safety source<\/span>/);
  // Cockpit telegram-blocked
  assert.match(js, /Telegram blocked: safety is not SAFE/);
});
