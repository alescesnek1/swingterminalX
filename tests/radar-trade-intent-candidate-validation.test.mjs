import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  TRADE_INTENT_VALIDATION_SOURCE,
  validateRadarCandidateForTradeIntent,
} from '../scripts/radar/trade-intent-candidate-validation.mjs';

const NOW = Date.parse('2026-07-24T12:00:00.000Z');

function mapping(overrides = {}) {
  return {
    normalizedSymbol: 'SOL/USDT',
    product: 'spot',
    supported: true,
    ...overrides,
  };
}

function options(overrides = {}) {
  return { nowMs: NOW, maxAgeMs: 120000, symbolMapping: mapping(), ...overrides };
}

function validCandidate(overrides = {}) {
  return {
    symbol: 'SOLUSDT',
    STATUS: 'STANDARD_ENTRY_READY',
    actionability: 'ENTRY_READY',
    allRadarConditionsPassed: true,
    gates: {
      setupValid: true,
      executionValid: true,
      riskRewardValid: true,
      regimeAllowsLong: true,
      dataQualitySufficient: true,
    },
    safetyStatus: 'SAFE',
    dataQualitySufficient: true,
    dataQuality: { status: 'GOOD' },
    executionDataMissing: [],
    updatedAt: new Date(NOW - 1000).toISOString(),
    entryZone: { low: 140, high: 141 },
    invalidationLevel: 135,
    TAKE_PROFIT_LEVELS: [{ level: 145 }, { level: 150 }, { level: 155 }],
    tpZonesExist: true,
    STRICT_ABSORB_STATUS: 'ABSORB_CONFIRMED',
    STRICT_ABSORB_CONFIRMED: true,
    ABSORB_MODE: 'STRICT',
    ABSORB_MISSING_FIELDS: [],
    RECLAIM_STATUS: 'RECLAIM_RETEST_HOLD',
    MARKET_REGIME_SCORE: 70,
    ...overrides,
  };
}

function reasonCodes(candidate, opts) {
  return validateRadarCandidateForTradeIntent(candidate, opts).reasonCodes;
}

test('valid V1 ENTRY_READY candidate passes with a supported normalized mapping', () => {
  const result = validateRadarCandidateForTradeIntent(validCandidate(), options());
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasonCodes, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.source, TRADE_INTENT_VALIDATION_SOURCE);
  assert.deepEqual(result.normalizedInputSummary, {
    symbol: 'SOLUSDT', normalizedSymbol: 'SOL/USDT', product: 'spot',
    status: 'STANDARD_ENTRY_READY', actionability: 'ENTRY_READY', safetyStatus: 'SAFE',
    strictAbsorbStatus: 'ABSORB_CONFIRMED', reclaimStatus: 'RECLAIM_RETEST_HOLD',
    observedAt: new Date(NOW - 1000).toISOString(), freshnessMs: 1000,
  });
});

test('non-entry-ready candidates reject', () => {
  assert.ok(reasonCodes(validCandidate({ STATUS: 'WATCH', actionability: 'WATCH_ONLY' }), options()).includes('not_entry_ready'));
});

test('missing V1 output or actionability rejects', () => {
  assert.ok(reasonCodes(validCandidate({ STATUS: undefined }), options()).includes('missing_v1_output'));
  assert.ok(reasonCodes(validCandidate({ actionability: undefined }), options()).includes('not_entry_ready'));
});

test('failed or missing V1 gates reject fail-closed', () => {
  assert.ok(reasonCodes(validCandidate({ gates: { ...validCandidate().gates, executionValid: false } }), options()).includes('gates_not_passed'));
  assert.ok(reasonCodes(validCandidate({ gates: undefined }), options()).includes('gates_not_passed'));
});

test('stale candidates reject', () => {
  assert.ok(reasonCodes(validCandidate({ stale: true }), options()).includes('stale_data'));
  assert.ok(reasonCodes(validCandidate({ updatedAt: new Date(NOW - 120001).toISOString() }), options()).includes('stale_data'));
});

test('missing levels reject', () => {
  assert.ok(reasonCodes(validCandidate({ entryZone: null }), options()).includes('missing_levels'));
  assert.ok(reasonCodes(validCandidate({ TAKE_PROFIT_LEVELS: [] }), options()).includes('missing_levels'));
});

test('stale, untrusted, proxy, incomplete, and unknown strict Absorb reject', () => {
  assert.ok(reasonCodes(validCandidate({ STRICT_ABSORB_STATUS: 'ABSORB_DATA_STALE', STRICT_ABSORB_CONFIRMED: false }), options()).includes('strict_absorb_stale'));
  assert.ok(reasonCodes(validCandidate({ STRICT_ABSORB_STATUS: 'ABSORB_PROVIDER_UNTRUSTED', STRICT_ABSORB_CONFIRMED: false }), options()).includes('strict_absorb_untrusted'));
  assert.ok(reasonCodes(validCandidate({ ABSORB_MODE: 'PROXY', STRICT_ABSORB_CONFIRMED: false }), options()).includes('strict_absorb_proxy'));
  assert.ok(reasonCodes(validCandidate({ ABSORB_MISSING_FIELDS: ['longLiquidationSpike'] }), options()).includes('strict_absorb_incomplete'));
  assert.ok(reasonCodes(validCandidate({ STRICT_ABSORB_STATUS: undefined, STRICT_ABSORB_CONFIRMED: undefined, ABSORB_MODE: undefined }), options()).includes('strict_absorb_unknown'));
});

test('advisory-only candidate and unmapped or unsupported product reject', () => {
  assert.ok(reasonCodes(validCandidate({ advisory_only: true }), options()).includes('advisory_only'));
  assert.ok(reasonCodes(validCandidate(), options({ symbolMapping: undefined })).includes('symbol_unmapped'));
  assert.ok(reasonCodes(validCandidate(), options({ symbolMapping: mapping({ product: 'margin' }) })).includes('unsupported_product'));
});

test('unknown data quality, freshness, reclaim, and candidate state fail closed', () => {
  assert.ok(reasonCodes(validCandidate({ dataQuality: { status: 'UNKNOWN' } }), options()).includes('unknown_state'));
  assert.ok(reasonCodes(validCandidate({ updatedAt: undefined }), options()).includes('unknown_state'));
  assert.ok(reasonCodes(validCandidate({ RECLAIM_STATUS: 'RECLAIM_ATTEMPT' }), options()).includes('reclaim_not_confirmed'));
  assert.deepEqual(validateRadarCandidateForTradeIntent(null, options()).reasonCodes, ['missing_candidate']);
  assert.deepEqual(validateRadarCandidateForTradeIntent([], options()).reasonCodes, ['unknown_state']);
  assert.deepEqual(validateRadarCandidateForTradeIntent(validCandidate(), null).reasonCodes, ['unknown_state']);
});

test('validator is pure, does not mutate frozen input, and has no external imports or client references', () => {
  const candidate = Object.freeze(validCandidate({ gates: Object.freeze(validCandidate().gates), dataQuality: Object.freeze({ status: 'GOOD' }), entryZone: Object.freeze({ low: 140, high: 141 }), TAKE_PROFIT_LEVELS: Object.freeze([{ level: 145 }, { level: 150 }, { level: 155 }]), ABSORB_MISSING_FIELDS: Object.freeze([]), executionDataMissing: Object.freeze([]) }));
  const opts = Object.freeze({ nowMs: NOW, maxAgeMs: 120000, symbolMapping: Object.freeze(mapping()) });
  assert.equal(validateRadarCandidateForTradeIntent(candidate, opts).ok, true);
  const source = fs.readFileSync(new URL('../scripts/radar/trade-intent-candidate-validation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\bfetch\s*\(/i);
  assert.doesNotMatch(source, /kucoin|binance|telegram|worker|placeorder|submitorder/i);
});
