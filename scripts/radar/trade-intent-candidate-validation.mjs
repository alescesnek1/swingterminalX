export const TRADE_INTENT_VALIDATION_SOURCE = 'trading-radar-v1';

const ENTRY_READY_STATUSES = new Set([
  'EARLY_ENTRY_READY',
  'STANDARD_ENTRY_READY',
  'AGGRESSIVE_ENTRY_READY',
]);

const VALID_RECLAIM_STATUSES = new Set([
  'RECLAIM_CONFIRMED',
  'RECLAIM_CONFIRMED_NO_RETEST',
  'RECLAIM_RETEST_HOLD',
]);

const REQUIRED_GATES = Object.freeze([
  'setupValid',
  'executionValid',
  'riskRewardValid',
  'regimeAllowsLong',
  'dataQualitySufficient',
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function addReason(reasons, code) {
  if (!reasons.includes(code)) reasons.push(code);
}

function finiteTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function entryZone(candidate) {
  return candidate.ENTRY_ZONE ?? candidate.entryZone ?? null;
}

function hasLevels(candidate) {
  const zone = entryZone(candidate);
  const hasZone = isRecord(zone) && Number.isFinite(Number(zone.low)) && Number.isFinite(Number(zone.high));
  const stop = candidate.HARD_INVALIDATION ?? candidate.invalidationLevel ?? candidate.STOP_LOSS_LEVEL ?? candidate.suggestedStop;
  const targets = candidate.TAKE_PROFIT_LEVELS ?? candidate.takeProfitCheckpoints;
  const hasTargets = Array.isArray(targets)
    && targets.length >= 3
    && targets.slice(0, 3).every((target) => Number.isFinite(Number(isRecord(target) ? target.level : target)));
  return hasZone && Number.isFinite(Number(stop)) && hasTargets;
}

function normalizeSummary(candidate, mapping, freshnessMs) {
  const safeCandidate = isRecord(candidate) ? candidate : {};
  const safeMapping = isRecord(mapping) ? mapping : {};
  const observedAt = safeCandidate.updatedAt
    ?? safeCandidate.sourceFetchedAt
    ?? safeCandidate.fetchedAt
    ?? safeCandidate.receivedAt
    ?? null;
  return {
    symbol: typeof safeCandidate.symbol === 'string' ? safeCandidate.symbol.toUpperCase() : null,
    normalizedSymbol: typeof safeMapping.normalizedSymbol === 'string' ? safeMapping.normalizedSymbol : null,
    product: typeof safeMapping.product === 'string' ? safeMapping.product : null,
    status: typeof (safeCandidate.STATUS ?? safeCandidate.v1Status) === 'string' ? (safeCandidate.STATUS ?? safeCandidate.v1Status) : null,
    actionability: typeof safeCandidate.actionability === 'string' ? safeCandidate.actionability : null,
    safetyStatus: typeof safeCandidate.safetyStatus === 'string' ? safeCandidate.safetyStatus : null,
    strictAbsorbStatus: typeof safeCandidate.STRICT_ABSORB_STATUS === 'string' ? safeCandidate.STRICT_ABSORB_STATUS : null,
    reclaimStatus: typeof safeCandidate.RECLAIM_STATUS === 'string' ? safeCandidate.RECLAIM_STATUS : null,
    observedAt,
    freshnessMs: Number.isFinite(freshnessMs) ? freshnessMs : null,
  };
}

export function validateRadarCandidateForTradeIntent(candidate, options = {}) {
  const reasonCodes = [];
  const warnings = [];
  const safeOptions = isRecord(options) ? options : {};
  const mapping = isRecord(safeOptions.symbolMapping) ? safeOptions.symbolMapping : null;

  if (candidate == null) {
    return {
      ok: false,
      reasonCodes: ['missing_candidate'],
      warnings,
      normalizedInputSummary: normalizeSummary(candidate, mapping, null),
      source: TRADE_INTENT_VALIDATION_SOURCE,
    };
  }

  if (!isRecord(candidate) || !isRecord(options)) {
    return {
      ok: false,
      reasonCodes: ['unknown_state'],
      warnings,
      normalizedInputSummary: normalizeSummary(candidate, mapping, null),
      source: TRADE_INTENT_VALIDATION_SOURCE,
    };
  }

  const status = candidate.STATUS ?? candidate.v1Status;
  if (typeof status !== 'string' || !status) addReason(reasonCodes, 'missing_v1_output');
  else if (!ENTRY_READY_STATUSES.has(status)) addReason(reasonCodes, 'not_entry_ready');
  if (candidate.actionability !== 'ENTRY_READY') addReason(reasonCodes, 'not_entry_ready');
  if (candidate.allRadarConditionsPassed !== true) addReason(reasonCodes, 'gates_not_passed');

  const gates = candidate.gates;
  if (!isRecord(gates)) {
    addReason(reasonCodes, 'gates_not_passed');
    addReason(reasonCodes, 'unknown_state');
  } else if (REQUIRED_GATES.some((key) => gates[key] !== true)) {
    addReason(reasonCodes, 'gates_not_passed');
  }

  if (candidate.safetyStatus !== 'SAFE') addReason(reasonCodes, 'safety_failed');
  if (candidate.dataQualitySufficient !== true
      || !isRecord(candidate.dataQuality)
      || !['GOOD', 'DEGRADED'].includes(candidate.dataQuality.status)
      || !Array.isArray(candidate.executionDataMissing)
      || candidate.executionDataMissing.length > 0) {
    addReason(reasonCodes, 'unknown_state');
  }

  const observedAt = candidate.updatedAt
    ?? candidate.sourceFetchedAt
    ?? candidate.fetchedAt
    ?? candidate.receivedAt;
  const observedMs = finiteTime(observedAt);
  const nowMs = Number.isFinite(safeOptions.nowMs) ? safeOptions.nowMs : null;
  const maxAgeMs = Number.isFinite(safeOptions.maxAgeMs) && safeOptions.maxAgeMs >= 0 ? safeOptions.maxAgeMs : 120000;
  const freshnessMs = observedMs != null && nowMs != null ? nowMs - observedMs : null;
  if (candidate.stale === true || candidate.microstructureStale === true || (freshnessMs != null && (freshnessMs < 0 || freshnessMs > maxAgeMs))) {
    addReason(reasonCodes, 'stale_data');
  } else if (observedMs == null || nowMs == null) {
    addReason(reasonCodes, 'unknown_state');
  }

  if (!hasLevels(candidate)) addReason(reasonCodes, 'missing_levels');

  const strictStatus = candidate.STRICT_ABSORB_STATUS;
  const strictMode = candidate.ABSORB_MODE;
  const strictMissing = Array.isArray(candidate.ABSORB_MISSING_FIELDS) && candidate.ABSORB_MISSING_FIELDS.length > 0;
  if (strictStatus === 'ABSORB_DATA_STALE') addReason(reasonCodes, 'strict_absorb_stale');
  else if (strictStatus === 'ABSORB_PROVIDER_UNTRUSTED') addReason(reasonCodes, 'strict_absorb_untrusted');
  else if (strictMode === 'PROXY') addReason(reasonCodes, 'strict_absorb_proxy');
  else if (strictMissing) addReason(reasonCodes, 'strict_absorb_incomplete');
  else if (strictStatus !== 'ABSORB_CONFIRMED' || candidate.STRICT_ABSORB_CONFIRMED !== true || strictMode !== 'STRICT') addReason(reasonCodes, 'strict_absorb_unknown');

  if (typeof candidate.RECLAIM_STATUS !== 'string' || !candidate.RECLAIM_STATUS) addReason(reasonCodes, 'unknown_state');
  else if (!VALID_RECLAIM_STATUSES.has(candidate.RECLAIM_STATUS)) addReason(reasonCodes, 'reclaim_not_confirmed');
  if (gates && gates.regimeAllowsLong !== true) addReason(reasonCodes, 'gates_not_passed');

  if (candidate.advisoryOnly === true || candidate.advisory_only === true || candidate.affectsServerGates === false || candidate.affects_server_gates === false) {
    addReason(reasonCodes, 'advisory_only');
  }

  if (!mapping || !mapping.normalizedSymbol || typeof mapping.normalizedSymbol !== 'string') {
    addReason(reasonCodes, 'symbol_unmapped');
  } else if (mapping.supported !== true || !['spot', 'futures'].includes(mapping.product)) {
    addReason(reasonCodes, 'unsupported_product');
  }

  return {
    ok: reasonCodes.length === 0,
    reasonCodes,
    warnings,
    normalizedInputSummary: normalizeSummary(candidate, mapping, freshnessMs),
    source: TRADE_INTENT_VALIDATION_SOURCE,
  };
}
