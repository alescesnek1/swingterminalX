// Safety enrichment + explainability: every state carries a reason; the shipped
// UI label helper renders a visible compact reason for every row.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { resolveTokenMetadata, METADATA_REASONS, __clearTokenMetadataCache } from '../scripts/safety/token-metadata.mjs';
import { classifyMarketSafety, evaluateKnownSafety, buildSafetyDiagnostics, SAFETY_REASONS } from '../scripts/safety/chain-safety.mjs';
import { evaluateTradingRadar } from '../scripts/radar/trading-radar.mjs';
import { evaluateConfirmedRadarEntryReady, TELEGRAM_CODES } from '../netlify/functions/cron-alerts.mjs';

const MID = '·';

// Extract the shipped UI helper and run it in-process to test rendered labels.
const TERMINAL_JS = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
function loadFormatSafetyLabel() {
  const m = TERMINAL_JS.match(/function formatSafetyLabel\(status, reason, source, chain, contract\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'formatSafetyLabel must exist in shipped JS');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '\nreturn formatSafetyLabel;')();
}
const fmt = loadFormatSafetyLabel();

test('backend safety result always includes status/reason/source/chain/contract/blocksTelegram', () => {
  for (const m of [{ symbol: 'BTCUSDT' }, { symbol: 'BSBUSDT' }, { symbol: 'WETHUSDT' }, { symbol: 'FOOBAR' }, { symbol: 'XYZUSDT', chain: 'bsc', contractAddress: '0xdef', contractVerified: false }]) {
    const s = classifyMarketSafety(m);
    for (const k of ['safetyStatus', 'safetyReason', 'safetySource', 'blocksTelegram']) {
      assert.ok(s[k] !== undefined && s[k] !== '', `${m.symbol} missing ${k}`);
    }
    assert.ok('chain' in s && 'contractAddress' in s);
    assert.equal(s.blocksTelegram, s.safetyStatus !== 'SAFE');
  }
});

test('CEX-only symbol -> UNKNOWN + CEX_ONLY_NO_CONTRACT_CONTEXT + source cex-only', () => {
  const s = classifyMarketSafety({ symbol: 'BSBUSDT' });
  assert.equal(s.safetyStatus, 'UNKNOWN');
  assert.equal(s.safetyReason, SAFETY_REASONS.CEX_ONLY_NO_CONTRACT_CONTEXT);
  assert.equal(s.safetySource, 'cex-only');
});

test('allowlisted majors SAFE; non-mapped/ambiguous/provider-fail honest', () => {
  assert.equal(classifyMarketSafety({ symbol: 'XLMUSDT', baseAsset: 'XLM' }).safetyStatus, 'SAFE');
  assert.equal(classifyMarketSafety({ symbol: 'FOOBAR' }).safetyReason, SAFETY_REASONS.MISSING_CONTRACT_METADATA);
  assert.equal(classifyMarketSafety({ symbol: 'WETHUSDT' }).safetyReason, SAFETY_REASONS.AMBIGUOUS_CONTRACT_MAPPING);
  __clearTokenMetadataCache();
  assert.equal(classifyMarketSafety({ symbol: 'NEWTOKEN', baseAsset: 'NEWTOKEN' }, { fetchImpl: () => { throw new Error('429'); } }).safetyReason, SAFETY_REASONS.METADATA_FETCH_FAILED);
  assert.equal(classifyMarketSafety({ symbol: 'XYZUSDT', chain: 'bsc', contractAddress: '0xdef', contractVerified: false }).safetyStatus, 'CAUTION');
  assert.equal(classifyMarketSafety({ symbol: 'SIRENUSDT', chain: 'bsc', contractAddress: '0xabc', contractVerified: true, topHolderPercent: 38 }).safetyStatus, 'DANGER');
});

test('no token is marked SAFE by symbol-only guessing', () => {
  for (const sym of ['BSBUSDT', 'HYPEUSDT', 'WILDUSDT', 'JTOUSDT', 'RANDOMUSDT']) {
    assert.notEqual(classifyMarketSafety({ symbol: sym }).safetyStatus, 'SAFE');
  }
});

test('Telegram gate: UNKNOWN/CAUTION/DANGER block; SAFE passes', () => {
  const base = {
    symbol: 'SOLUSDT', STATUS: 'STANDARD_ENTRY_READY', actionability: 'ENTRY_READY', telegramEligible: true,
    allRadarConditionsPassed: true, entryZone: { low: 1, high: 1.1 }, invalidationLevel: 0.9, suggestedStop: 0.9,
    TAKE_PROFIT_LEVELS: [{ level: 1.2 }, { level: 1.3 }, { level: 1.4 }], tpZonesExist: true, executionDataMissing: [],
    EXECUTION_SCORE: 70, SETUP_SCORE: 74, RISK_REWARD_SCORE: 64, MARKET_REGIME_SCORE: 61, confidence: 82, stale: false,
  };
  for (const st of ['UNKNOWN', 'CAUTION', 'DANGER']) {
    assert.equal(evaluateConfirmedRadarEntryReady({ ...base, safetyStatus: st }).code, TELEGRAM_CODES.SKIPPED_SAFETY_NOT_SAFE);
  }
  assert.equal(evaluateConfirmedRadarEntryReady({ ...base, safetyStatus: 'SAFE' }).ok, true);
});

test('RADAR engine: candidates carry safetyReason/safetySource; diagnostics plainUnknownCount === 0', () => {
  const mk = (sym, base, v) => ({ symbol: sym, baseAsset: base, quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: v, bidPrice: 1, askPrice: 1.001, spreadPct: 0.02, change24hPct: -5 });
  const radar = evaluateTradingRadar({ markets: [mk('BTCUSDT', 'BTC', 900e6), mk('BSBUSDT', 'BSB', 50e6), mk('WETHUSDT', 'WETH', 60e6)], now: Date.now() });
  for (const c of radar.candidates) {
    assert.ok(c.safetyReason, `${c.symbol} missing safetyReason`);
    assert.ok(c.safetySource, `${c.symbol} missing safetySource`);
  }
  const d = radar.universeDiagnostics;
  assert.equal(d.plainUnknownCount, 0);
  assert.ok(d.unknownWithReasonCount >= 1);
  assert.ok(Array.isArray(d.topUnknownReasons) && d.topUnknownReasons.length >= 1);
  assert.ok(Array.isArray(d.topUnknownSymbols));
});

test('diagnostics: plainUnknownCount counts reasonless UNKNOWN (and is 0 for honest rows)', () => {
  const honest = buildSafetyDiagnostics([
    classifyMarketSafety({ symbol: 'BTCUSDT', baseAsset: 'BTC' }),
    classifyMarketSafety({ symbol: 'BSBUSDT', baseAsset: 'BSB' }),
  ]);
  assert.equal(honest.plainUnknownCount, 0);
  const broken = buildSafetyDiagnostics([{ symbol: 'X', safetyStatus: 'UNKNOWN', safetyReason: '' }]);
  assert.equal(broken.plainUnknownCount, 1);
});

// ---- UI label helper: every state renders a visible compact reason ----
test('formatSafetyLabel renders required compact labels', () => {
  assert.equal(fmt('SAFE', 'ALLOWLISTED', 'curated-allowlist').labelShort, `SAFE ${MID} curated asset`);
  assert.equal(fmt('SAFE', 'RESOLVED', 'market-row').labelShort, `SAFE ${MID} verified contract`);
  assert.equal(fmt('UNKNOWN', 'CEX_ONLY_NO_CONTRACT_CONTEXT', 'cex-only').labelShort, `UNKNOWN ${MID} CEX-only`);
  assert.equal(fmt('UNKNOWN', 'MISSING_CONTRACT_METADATA', 'none').labelShort, `UNKNOWN ${MID} missing metadata`);
  assert.equal(fmt('UNKNOWN', 'AMBIGUOUS_CONTRACT_MAPPING', 'none').labelShort, `UNKNOWN ${MID} ambiguous`);
  assert.equal(fmt('UNKNOWN', 'METADATA_FETCH_FAILED', 'provider').labelShort, `UNKNOWN ${MID} provider failed`);
  assert.equal(fmt('CAUTION', 'UNVERIFIED_CONTRACT', 'market-row').labelShort, `CAUTION ${MID} unverified contract`);
  assert.equal(fmt('DANGER', 'HOLDER_CONCENTRATION', 'market-row').labelShort, `DANGER ${MID} risky contract`);
});

test('formatSafetyLabel never renders a reasonless UNKNOWN', () => {
  // missing status + missing reason
  const a = fmt(null, null, null);
  assert.equal(a.labelShort.startsWith('UNKNOWN ' + MID), true);
  assert.notEqual(a.labelShort, 'UNKNOWN');
  assert.match(a.labelFull, /\((MISSING_CONTRACT_METADATA|CEX_ONLY_NO_CONTRACT_CONTEXT)\)/);
  // CEX source but empty reason -> CEX-only
  assert.equal(fmt('UNKNOWN', '', 'scanner').labelShort, `UNKNOWN ${MID} CEX-only`);
  // every non-SAFE blocks telegram + tooltip says so
  const b = fmt('UNKNOWN', 'CEX_ONLY_NO_CONTRACT_CONTEXT', 'cex-only');
  assert.equal(b.blocksTelegram, true);
  assert.match(b.tooltip, /Telegram blocked: safety is not SAFE/);
  assert.match(b.tooltip, /Reason: CEX_ONLY_NO_CONTRACT_CONTEXT/);
});

test('shipped JS wires label helper into scanner / RADAR / detail / cockpit', () => {
  assert.match(TERMINAL_JS, /function formatSafetyLabel\(/);
  // scanner cell renders the label short text, not bare status
  assert.match(TERMINAL_JS, /const f = formatSafetyLabel\(s\.status, s\.code, s\.source, s\.chain, s\.contract\);/);
  assert.match(TERMINAL_JS, /\$\{_esc\(f\.labelShort\)\}/);
  // RADAR matrix cell uses helper
  assert.match(TERMINAL_JS, /formatSafetyLabel\(c\.safetyStatus, c\.safetyReason, c\.safetySource, c\.chain, c\.contractAddress\)/);
  // detail panel shows full reason code
  assert.match(TERMINAL_JS, /detailSafetyF\.labelFull/);
  // cockpit telegram-blocked note
  assert.match(TERMINAL_JS, /Telegram blocked: safety is not SAFE/);
});
