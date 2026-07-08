// Trade Readiness summary — context-only operator layer. Pure presentation over
// existing candidate fields: it mirrors gate status, never re-decides a gate, and
// returns no ENTRY_READY/BUY/SELL/signal/telegram/score/execution field.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildTradeReadinessSummary } from '../scripts/radar/trading-radar.mjs';

const TR_SRC = fs.readFileSync(new URL('../scripts/radar/trading-radar.mjs', import.meta.url), 'utf8');

test('not actionable when actionability is not ENTRY_READY; contextOnly always true', () => {
  const r = buildTradeReadinessSummary({ actionability: 'NEEDS_CONFIRMATION', safetyStatus: 'SAFE', hasRollingMicrostructure: false });
  assert.equal(r.contextOnly, true);
  assert.equal(r.actionable, false);
  assert.equal(r.headline, 'READY: no, waiting for confirmed gates');
  assert.deepEqual(Object.keys(r).sort(), ['actionable', 'blockers', 'contextOnly', 'headline', 'missing', 'nextCheck', 'supportive'].sort());
});

test('actionable mirrors the existing gate actionability only (no new gate)', () => {
  const r = buildTradeReadinessSummary({ actionability: 'ENTRY_READY', safetyStatus: 'SAFE', hasRollingMicrostructure: true });
  assert.equal(r.actionable, true);
  assert.match(r.headline, /^READY: yes/);
  assert.match(r.headline, /confirmed by RADAR gates/);
});

test('blockers are derived from existing gate/safety/data fields', () => {
  const r = buildTradeReadinessSummary({
    actionability: 'NEEDS_CONFIRMATION',
    safetyStatus: 'UNKNOWN',
    blockedBy: 'R/R is poor',
    hasRollingMicrostructure: false,
    absorptionBlockedReason: 'rolling absorption producer not running',
    reclaimBlockedReason: 'reclaim not held',
  });
  const blob = r.blockers.join(' | ');
  assert.match(blob, /safety unknown/i);
  assert.match(blob, /R\/R is poor/);
  assert.match(blob, /rolling flow\/absorption data missing/);
  assert.match(blob, /strict absorb not confirmed/);
  assert.match(blob, /reclaim not confirmed/);
});

test('none-value block reasons do not become blockers', () => {
  const r = buildTradeReadinessSummary({
    actionability: 'ENTRY_READY', safetyStatus: 'SAFE', hasRollingMicrostructure: true,
    blockedBy: '--', absorptionBlockedReason: 'none', reclaimBlockedReason: 'not blocked',
  });
  assert.deepEqual(r.blockers, []);
});

test('pressure zones + funding + structure are SUPPORTING context, never blockers', () => {
  const r = buildTradeReadinessSummary({
    actionability: 'NEEDS_CONFIRMATION', safetyStatus: 'SAFE', hasRollingMicrostructure: true,
    pressureZones: { available: true, referencePrice: 100, zones: [{ price: 100.5, type: 'support', strength: 60, basis: ['swing-low'] }] },
    fundingRate: 0.05,
    structurePresent: true,
  });
  const sup = r.supportive.join(' | ');
  assert.match(sup, /pressure zone nearby \(support @ 100\.5\)/);
  assert.match(sup, /funding extreme \(0\.05%\)/);
  assert.match(sup, /structure present/);
  // and none of those appear as blockers
  const blk = r.blockers.join(' | ').toLowerCase();
  assert.equal(blk.includes('pressure'), false);
  assert.equal(blk.includes('funding'), false);
  assert.equal(blk.includes('structure'), false);
});

test('a far pressure zone / mild funding is NOT surfaced as supporting', () => {
  const r = buildTradeReadinessSummary({
    actionability: 'NEEDS_CONFIRMATION', safetyStatus: 'SAFE', hasRollingMicrostructure: true,
    pressureZones: { available: true, referencePrice: 100, zones: [{ price: 130, type: 'resistance', strength: 60, basis: ['swing-high'] }] },
    fundingRate: 0.001,
  });
  assert.equal(r.supportive.join(' ').includes('pressure zone'), false);
  assert.equal(r.supportive.join(' ').includes('funding'), false);
});

test('missing data is reported as-is (never fabricated)', () => {
  const r = buildTradeReadinessSummary({ actionability: 'NEEDS_CONFIRMATION', safetyStatus: 'SAFE', hasRollingMicrostructure: false, missingData: ['orderbook', 'OI'] });
  assert.ok(r.missing.includes('orderbook'));
  assert.ok(r.missing.includes('OI'));
  assert.ok(r.missing.includes('rolling flow'));
  // with no inputs, nothing is invented
  const empty = buildTradeReadinessSummary({ actionability: 'ENTRY_READY', safetyStatus: 'SAFE', hasRollingMicrostructure: true });
  assert.deepEqual(empty.missing, []);
});

test('summary carries no ENTRY_READY/BUY/SELL/signal/telegram/score/execution field or word', () => {
  const r = buildTradeReadinessSummary({
    actionability: 'ENTRY_READY', safetyStatus: 'SAFE', hasRollingMicrostructure: true,
    pressureZones: { available: true, referencePrice: 100, zones: [{ price: 100.2, type: 'pivot', strength: 50, basis: ['volume-node'] }] },
    fundingRate: -0.02, structurePresent: true,
  });
  for (const k of ['signal', 'telegram', 'entryReady', 'scoreOverride', 'action', 'buy', 'sell', 'execution']) {
    assert.equal(k in r, false, `must not expose field ${k}`);
  }
  const blob = JSON.stringify(r);
  for (const w of ['ENTRY_READY', 'BUY', 'SELL', 'telegram', 'Telegram', 'scoreOverride', '"signal"']) {
    assert.equal(blob.includes(w), false, `must not contain "${w}"`);
  }
});

test('tolerates junk input without throwing', () => {
  for (const junk of [undefined, null, 'x', 42, []]) {
    const r = buildTradeReadinessSummary(junk);
    assert.equal(r.contextOnly, true);
    assert.equal(r.actionable, false);
  }
});

test('isolation: buildTradeReadinessSummary is projected after gate work, referenced only at output', () => {
  const refs = (TR_SRC.match(/buildTradeReadinessSummary\s*\(/g) || []).length;
  assert.equal(refs, 2, 'expected one definition + one call site');
  assert.match(TR_SRC, /const tradeReadiness = buildTradeReadinessSummary\(\{/);
  // computed after the V1 gate + actionability for the row
  const gateIdx = TR_SRC.indexOf('const entryReadyV1 =');
  const callIdx = TR_SRC.indexOf('const tradeReadiness = buildTradeReadinessSummary(');
  assert.ok(gateIdx > 0 && callIdx > gateIdx, 'readiness must be computed after gates');
  // never merged onto the scoring market object
  assert.doesNotMatch(TR_SRC, /\.\.\.computed,[\s\S]{0,60}tradeReadiness/);
});
