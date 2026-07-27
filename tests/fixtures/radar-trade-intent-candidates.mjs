export const RADAR_TRADE_INTENT_FIXTURE_VERSION = 1;
export const RADAR_TRADE_INTENT_FIXTURE_SCHEMA_VERSION = 'radar-trade-intent-candidate/v1';
export const RADAR_TRADE_INTENT_REPLAY_CLOCK_MS = Date.parse('2026-07-24T12:00:00.000Z');
export const RADAR_TRADE_INTENT_REPLAY_CAPTURED_AT = '2026-07-24T12:00:00.000Z';

const VALID_MAPPING = Object.freeze({
  normalizedSymbol: 'SOL/USDT',
  product: 'spot',
  supported: true,
});

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
    updatedAt: '2026-07-24T11:59:00.000Z',
    entryZone: { low: 140, high: 141 },
    invalidationLevel: 135,
    TAKE_PROFIT_LEVELS: [{ level: 145 }, { level: 150 }, { level: 155 }],
    STRICT_ABSORB_STATUS: 'ABSORB_CONFIRMED',
    STRICT_ABSORB_CONFIRMED: true,
    ABSORB_MODE: 'STRICT',
    ABSORB_MISSING_FIELDS: [],
    RECLAIM_STATUS: 'RECLAIM_RETEST_HOLD',
    ...overrides,
  };
}

function fixture(name, candidate, expectedValidation, symbolMapping = VALID_MAPPING) {
  return Object.freeze({
    name,
    fixtureVersion: RADAR_TRADE_INTENT_FIXTURE_VERSION,
    schemaVersion: RADAR_TRADE_INTENT_FIXTURE_SCHEMA_VERSION,
    source: 'trading-radar-v1',
    capturedAt: RADAR_TRADE_INTENT_REPLAY_CAPTURED_AT,
    candidate,
    symbolMapping,
    expectedValidation,
  });
}

export const RADAR_TRADE_INTENT_CANDIDATE_FIXTURES = Object.freeze([
  fixture('valid-entry-ready', validCandidate(), { ok: true, reasonCodes: [] }),
  fixture('non-entry-ready', validCandidate({ STATUS: 'WATCH', actionability: 'WATCH_ONLY' }), { ok: false, reasonCodes: ['not_entry_ready'] }),
  fixture('stale-candidate', validCandidate({ updatedAt: '2026-07-24T11:57:59.999Z' }), { ok: false, reasonCodes: ['stale_data'] }),
  fixture('strict-absorb-stale', validCandidate({ STRICT_ABSORB_STATUS: 'ABSORB_DATA_STALE', STRICT_ABSORB_CONFIRMED: false }), { ok: false, reasonCodes: ['strict_absorb_stale'] }),
  fixture('strict-absorb-unknown', validCandidate({ STRICT_ABSORB_STATUS: undefined, STRICT_ABSORB_CONFIRMED: undefined, ABSORB_MODE: undefined }), { ok: false, reasonCodes: ['strict_absorb_unknown'] }),
  fixture('reclaim-failed', validCandidate({ RECLAIM_STATUS: 'RECLAIM_ATTEMPT' }), { ok: false, reasonCodes: ['reclaim_not_confirmed'] }),
  fixture('missing-levels', validCandidate({ TAKE_PROFIT_LEVELS: [] }), { ok: false, reasonCodes: ['missing_levels'] }),
  fixture('unmapped-symbol', validCandidate(), { ok: false, reasonCodes: ['symbol_unmapped'] }, null),
  fixture('unsupported-product', validCandidate(), { ok: false, reasonCodes: ['unsupported_product'] }, { normalizedSymbol: 'SOL/USDT', product: 'margin', supported: true }),
]);
