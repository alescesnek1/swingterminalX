// Advisory Scanner "Lead Score" — pure scoring model + UI wiring.
//
// Lead Score is advisory context only. These tests pin BOTH halves of that
// promise: the score fails closed on missing data, and it never reaches
// RADAR / ENTRY_READY / Telegram / trading.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  computeLeadScore,
  buildLeadScoreDisplay,
  leadScoreInputFromRow,
  leadScoreForRow,
  LEAD_SCORE_ADVISORY_NOTE,
  LEAD_SCORE_BASES,
} from '../apps/edge/public/js/scanner-lead-score.js';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');
const terminalCss = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');
const marketsJs = fs.readFileSync(new URL('../apps/edge/netlify/edge-functions/markets.js', import.meta.url), 'utf8');
const leadScoreJs = fs.readFileSync(new URL('../apps/edge/public/js/scanner-lead-score.js', import.meta.url), 'utf8');

// Source-scan assertions below are about what the CODE does. The module's
// header comment necessarily names the things it must not touch (that is the
// contract it documents), so comments are stripped before scanning.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const leadScoreCode = stripComments(leadScoreJs);

// premium, volumeRatio, moveGap, oi, funding, flow + the two futures-only
// components. A row with nothing readable reports all of them as missing.
const ALL_COMPONENT_COUNT = 8;

// Reference inputs. `aligned` is a quiet market; `led` is a loudly
// futures-driven one. Individual tests clone and perturb them.
const ALIGNED = {
  spotPrice: 100,
  futuresPrice: 100.005,          // +0.005 % basis — noise
  spotQuoteVolume24h: 100_000_000,
  futuresQuoteVolume24h: 90_000_000, // spot is the bigger venue
  spotChange24hPct: 2.0,
  futuresChange24hPct: 2.05,      // 0.05 pp gap — noise
};
const LED = {
  spotPrice: 100,
  futuresPrice: 100.7,            // +0.70 % basis
  spotQuoteVolume24h: 100_000_000,
  futuresQuoteVolume24h: 1_600_000_000, // 16x spot turnover
  spotChange24hPct: 4.0,
  futuresChange24hPct: 6.2,       // +2.2 pp ahead of spot
  fundingPct: 0.062,
  openInterestChangePct: 16,
  takerBuyRatio: 0.76,
};

// ── UNKNOWN / fail-closed ─────────────────────────────────────

test('UNKNOWN when no data at all is present', () => {
  for (const input of [undefined, null, {}, 'nonsense', 42]) {
    const r = computeLeadScore(input);
    assert.equal(r.label, 'UNKNOWN', `input ${JSON.stringify(input)}`);
    assert.equal(r.score, null);
    assert.equal(r.direction, 'unknown');
    assert.equal(r.confidence, 'none');
    assert.deepEqual(r.present, []);
    // Nothing was readable, so every component the model knows about is listed.
    assert.equal(r.missing.length, ALL_COMPONENT_COUNT);
  }
});

test('UNKNOWN when only perp-side data exists — nothing compares futures to spot', () => {
  // Funding + OI + flow describe the perp in isolation. Loud as they are,
  // they say nothing about the futures side LEADING spot.
  const r = computeLeadScore({ fundingPct: 0.09, openInterestChangePct: 40, takerBuyRatio: 0.9 });
  assert.equal(r.label, 'UNKNOWN');
  assert.equal(r.score, null);
  assert.ok(r.missing.includes('futures/spot premium'));
  assert.ok(r.missing.includes('futures/spot 24h volume'));
  assert.ok(r.missing.includes('futures vs spot 24h move'));
});

// Regression (production hotfix): the original model demanded a futures-vs-spot
// comparison for ANY score, so every spot-only listing (most of the Binance
// USD-stable universe) and every futures-only perp read UNKNOWN, which is what
// made the shipped column useless.
test('a spot-only listing scores SPOT_ONLY / LOW, not UNKNOWN', () => {
  const r = computeLeadScore({ spotPrice: 100, spotQuoteVolume24h: 5e7, spotChange24hPct: 3 });
  assert.equal(r.basis, 'SPOT_ONLY');
  assert.equal(r.label, 'LOW');
  assert.equal(r.score, 0);
  assert.equal(r.direction, 'unknown');
  assert.match(r.basisNote, /No futures venue found/);
  // It must still say what it could not see.
  assert.ok(r.missing.includes('futures/spot premium'));
  assert.ok(r.missing.includes('funding rate'));
});

test('null / empty-string / boolean inputs are rejected before Number() can coerce them to 0', () => {
  // The Number(null) === 0 trap: a missing futures price must NOT become a
  // real reading of zero (which would fabricate a -100 % basis).
  const r = computeLeadScore({
    spotPrice: 100, futuresPrice: null,
    spotQuoteVolume24h: '', futuresQuoteVolume24h: 5e7,
    spotChange24hPct: false, futuresChange24hPct: 3,
    fundingPct: null, openInterestChangePct: '', takerBuyRatio: null,
  });
  // Not one of the three PAIRED components may exist: each needs both legs,
  // and every missing leg here is null / '' / false. If any had coerced to 0
  // we would be publishing a fabricated -100 % premium or a 0x volume ratio.
  for (const key of ['premium', 'volumeRatio', 'moveGap']) assert.ok(!r.present.includes(key), key);
  assert.notEqual(r.basis, 'FULL_SPOT_FUTURES');
  // funding / OI / flow were null or '' — they must not have become readings.
  for (const key of ['funding', 'oi', 'flow']) assert.ok(!r.present.includes(key), key);

  // With nothing readable at all it still fails closed to UNKNOWN.
  const empty = computeLeadScore({
    spotPrice: null, futuresPrice: null, spotQuoteVolume24h: '', futuresQuoteVolume24h: null,
    spotChange24hPct: false, futuresChange24hPct: null, fundingPct: null,
    openInterestChangePct: '', takerBuyRatio: null,
  });
  assert.equal(empty.label, 'UNKNOWN');
  assert.equal(empty.score, null);
  assert.equal(empty.basis, 'NO_USABLE_DATA');
  assert.equal(empty.missing.length, ALL_COMPONENT_COUNT);
});

test('a zero or negative price/volume is treated as not reported, never as a reading', () => {
  const r = computeLeadScore({ ...ALIGNED, futuresPrice: 0, futuresQuoteVolume24h: -1 });
  assert.ok(!r.present.includes('premium'));
  assert.ok(!r.present.includes('volumeRatio'));
  assert.ok(r.present.includes('moveGap'));
});

test('an out-of-range taker ratio is rejected rather than clamped', () => {
  const r = computeLeadScore({ ...ALIGNED, takerBuyRatio: 1.4 });
  assert.ok(!r.present.includes('flow'));
  assert.ok(r.missing.includes('taker buy/sell flow'));
});

// ── LOW / MED / HIGH / EXTREME ────────────────────────────────

test('LOW when spot and futures are aligned with weak pressure', () => {
  const r = computeLeadScore(ALIGNED);
  assert.equal(r.label, 'LOW');
  assert.ok(r.score < 25, `score ${r.score}`);
  assert.equal(r.conflict, false);
  // Weak readings must not be dressed up as a direction.
  assert.equal(r.direction, 'unknown');
});

test('MED when futures influence exists but the evidence is incomplete', () => {
  const r = computeLeadScore({
    spotPrice: 100, futuresPrice: 100.18,          // +0.18 % basis
    spotQuoteVolume24h: 100_000_000, futuresQuoteVolume24h: 800_000_000, // 8x
    fundingPct: 0.02,
    // move gap, OI and flow absent
  });
  assert.equal(r.label, 'MED');
  assert.ok(r.score >= 25 && r.score < 55, `score ${r.score}`);
  assert.equal(r.direction, 'futures-led up');
  assert.ok(r.missing.includes('futures vs spot 24h move'));
  assert.ok(r.missing.includes('open interest change'));
});

test('HIGH when the futures-vs-spot pair comparisons agree strongly', () => {
  const r = computeLeadScore({
    spotPrice: 100, futuresPrice: 100.5,
    spotQuoteVolume24h: 100_000_000, futuresQuoteVolume24h: 400_000_000,
    spotChange24hPct: 3, futuresChange24hPct: 4.2,
    fundingPct: 0.045,
  });
  assert.equal(r.label, 'HIGH');
  assert.ok(r.score >= 55 && r.score < 80, `score ${r.score}`);
  assert.equal(r.direction, 'futures-led up');
  assert.equal(r.conflict, false);
});

test('EXTREME when premium, volume, OI, funding and flow all agree', () => {
  const r = computeLeadScore(LED);
  assert.equal(r.label, 'EXTREME');
  assert.ok(r.score >= 80, `score ${r.score}`);
  assert.equal(r.direction, 'futures-led up');
  assert.equal(r.confidence, 'high');
  assert.deepEqual(r.missing, []);
  assert.equal(r.coverage, 1);
});

test('the same strength on the short side reads as futures-led down', () => {
  const r = computeLeadScore({
    ...LED,
    futuresPrice: 99.3,
    spotChange24hPct: -4.0, futuresChange24hPct: -6.2,
    fundingPct: -0.062,
    takerBuyRatio: 0.24,
  });
  assert.equal(r.direction, 'futures-led down');
  assert.equal(r.label, 'EXTREME');
});

// ── basis: degraded scoring paths (production hotfix) ─────────

test('full spot+futures reports FULL_SPOT_FUTURES and is never UNKNOWN', () => {
  for (const input of [ALIGNED, LED]) {
    const r = computeLeadScore(input);
    assert.equal(r.basis, 'FULL_SPOT_FUTURES');
    assert.notEqual(r.label, 'UNKNOWN');
    assert.ok(Number.isInteger(r.score));
  }
});

test('a futures-only row with price/change/volume scores FUTURES_ONLY, not UNKNOWN', () => {
  const r = computeLeadScore({
    futuresPrice: 0.42, futuresQuoteVolume24h: 9e8, futuresChange24hPct: 14.2, fundingPct: 0.05,
  });
  assert.equal(r.basis, 'FUTURES_ONLY');
  assert.notEqual(r.label, 'UNKNOWN');
  assert.ok(r.score > 0, `score ${r.score}`);
  // Direction is the perp's own push — it must NOT claim a lead over spot.
  assert.equal(r.direction, 'futures pressure up');
  assert.match(r.basisNote, /No matched spot leg found — score uses futures pressure only\./);
});

test('futures-only turnover scales across orders of magnitude, not linearly', () => {
  const at = (vol) => computeLeadScore({ futuresPrice: 1, futuresQuoteVolume24h: vol, futuresChange24hPct: 5 }).score;
  const small = at(1e7);
  const mid = at(3e8);
  const big = at(5e9);
  assert.ok(small < mid && mid < big, `${small} < ${mid} < ${big}`);
  // A sub-floor perp contributes nothing from turnover.
  assert.ok(at(1e6) <= small);
});

test('futures-only: funding / OI / taker flow missing does NOT force UNKNOWN', () => {
  const r = computeLeadScore({ futuresPrice: 2, futuresQuoteVolume24h: 4e8, futuresChange24hPct: 8 });
  assert.equal(r.basis, 'FUTURES_ONLY');
  assert.notEqual(r.label, 'UNKNOWN');
  assert.ok(r.missing.includes('funding rate'));
  assert.ok(r.missing.includes('open interest change'));
  assert.ok(r.missing.includes('taker buy/sell flow'));
});

test('full basis: funding / OI / taker flow missing does NOT force UNKNOWN', () => {
  const r = computeLeadScore({
    spotPrice: 100, futuresPrice: 100.3,
    spotQuoteVolume24h: 1e8, futuresQuoteVolume24h: 5e8,
    spotChange24hPct: 2, futuresChange24hPct: 3,
  });
  assert.equal(r.basis, 'FULL_SPOT_FUTURES');
  assert.notEqual(r.label, 'UNKNOWN');
  assert.equal(r.missing.length, 3);
});

test('a lone perp metric with no futures venue reading stays UNKNOWN', () => {
  // Funding/OI/flow describe a perp but carry no price, turnover or move, so
  // there is no pressure magnitude to report.
  const r = computeLeadScore({ fundingPct: 0.09, openInterestChangePct: 40, takerBuyRatio: 0.9 });
  assert.equal(r.label, 'UNKNOWN');
  assert.equal(r.basis, 'NO_USABLE_DATA');
});

test('no usable market data stays UNKNOWN with a stated basis', () => {
  for (const input of [{}, null, undefined, { spotPrice: null, futuresPrice: '' }]) {
    const r = computeLeadScore(input);
    assert.equal(r.label, 'UNKNOWN');
    assert.equal(r.score, null);
    assert.equal(r.basis, 'NO_USABLE_DATA');
    assert.ok(r.basisNote.length > 0);
  }
});

test('one weak futures-only component alone cannot produce EXTREME or HIGH', () => {
  const r = computeLeadScore({ futuresPrice: 1, futuresChange24hPct: 0.4 });
  assert.equal(r.basis, 'FUTURES_ONLY');
  assert.equal(r.present.length, 1);
  assert.notEqual(r.label, 'EXTREME');
  assert.notEqual(r.label, 'HIGH');
});

test('futures-only caps at HIGH unless at least three components are strong', () => {
  // Two maxed components, everything else missing: loud, but not EXTREME.
  const two = computeLeadScore({ futuresPrice: 1, futuresQuoteVolume24h: 2e10, futuresChange24hPct: 40 });
  assert.equal(two.basis, 'FUTURES_ONLY');
  assert.notEqual(two.label, 'EXTREME');
  assert.ok(two.score <= 79, `score ${two.score}`);

  // Five strong components clears the ceiling.
  const many = computeLeadScore({
    futuresPrice: 1, futuresQuoteVolume24h: 2e10, futuresChange24hPct: 40,
    fundingPct: 0.09, openInterestChangePct: 30, takerBuyRatio: 0.85,
  });
  assert.ok(many.score > two.score, `${many.score} !> ${two.score}`);
  assert.equal(many.label, 'EXTREME');
});

test('a degraded basis never outscores the same evidence with a spot leg attached', () => {
  const futuresOnly = computeLeadScore({ futuresPrice: 1, futuresQuoteVolume24h: 2e10, futuresChange24hPct: 40 });
  assert.ok(futuresOnly.score <= 79, 'futures-only is discounted and capped');
  assert.equal(futuresOnly.basis, 'FUTURES_ONLY');
});

test('every reported basis is one of the declared set', () => {
  const inputs = [ALIGNED, LED, {}, { spotPrice: 5 }, { futuresPrice: 5, futuresChange24hPct: 2 },
    { spotPrice: 1, futuresPrice: 1 }, { fundingPct: 0.03 }];
  for (const i of inputs) {
    assert.ok(LEAD_SCORE_BASES.includes(computeLeadScore(i).basis), JSON.stringify(i));
  }
});

// ── confidence / conflict / caps ──────────────────────────────

test('mixed, conflicting evidence lowers the score and the confidence', () => {
  const agreeing = computeLeadScore(LED);
  const conflicting = computeLeadScore({
    ...LED,
    // Premium says futures are bid; the 24h move and funding say the
    // opposite. That is a contradiction, not a stronger signal.
    spotChange24hPct: 6.2, futuresChange24hPct: 4.0,
    fundingPct: -0.062,
  });
  assert.equal(conflicting.conflict, true);
  assert.equal(conflicting.direction, 'mixed');
  assert.equal(conflicting.confidence, 'low');
  assert.ok(conflicting.score < agreeing.score, `${conflicting.score} !< ${agreeing.score}`);
  assert.notEqual(conflicting.label, 'EXTREME');
});

test('one weak component alone cannot produce EXTREME', () => {
  const r = computeLeadScore({ spotPrice: 100, futuresPrice: 100.05 });
  assert.equal(r.present.length, 1);
  assert.notEqual(r.label, 'EXTREME');
  assert.notEqual(r.label, 'HIGH');
  assert.ok(r.score <= 54, `score ${r.score}`);
});

test('one MAXED component alone still cannot produce EXTREME or HIGH', () => {
  // A 5 % basis saturates the premium component completely. On its own it
  // is still a single reading, so it tops out at MED.
  const r = computeLeadScore({ spotPrice: 100, futuresPrice: 105 });
  assert.equal(r.present.length, 1);
  assert.equal(r.label, 'MED');
  assert.ok(r.score <= 54, `score ${r.score}`);
});

test('two components cannot reach EXTREME however loud they are', () => {
  const r = computeLeadScore({
    spotPrice: 100, futuresPrice: 108,
    spotQuoteVolume24h: 10_000_000, futuresQuoteVolume24h: 900_000_000,
  });
  assert.equal(r.present.length, 2);
  assert.notEqual(r.label, 'EXTREME');
  assert.ok(r.score <= 79, `score ${r.score}`);
});

test('EXTREME needs at least two individually strong components', () => {
  // Three components present, but only the premium is strong.
  const r = computeLeadScore({
    spotPrice: 100, futuresPrice: 100.8,
    spotQuoteVolume24h: 100_000_000, futuresQuoteVolume24h: 130_000_000,
    spotChange24hPct: 3, futuresChange24hPct: 3.3,
  });
  assert.equal(r.present.length, 3);
  assert.notEqual(r.label, 'EXTREME');
});

test('losing components lowers the score for otherwise identical readings', () => {
  const full = computeLeadScore(LED);
  const partial = computeLeadScore({ ...LED, openInterestChangePct: null, takerBuyRatio: null, fundingPct: null });
  assert.ok(partial.score < full.score, `${partial.score} !< ${full.score}`);
  assert.ok(partial.coverage < full.coverage);
  assert.deepEqual(partial.missing, ['open interest change', 'funding rate', 'taker buy/sell flow']);
});

test('evidence and missing lists are always exposed, whatever the basis', () => {
  const inputs = [ALIGNED, LED, { spotPrice: 1, futuresPrice: 2 }, {},
    { spotPrice: 3, spotQuoteVolume24h: 1e6 },
    { futuresPrice: 3, futuresQuoteVolume24h: 1e8, futuresChange24hPct: 4 }];
  for (const input of inputs) {
    const r = computeLeadScore(input);
    assert.ok(Array.isArray(r.evidence), JSON.stringify(input));
    assert.ok(Array.isArray(r.missing));
    assert.ok(r.missing.length > 0 || r.basis === 'FULL_SPOT_FUTURES');
    // A component is either evidence or missing, never silently neither.
    if (r.basis === 'FULL_SPOT_FUTURES') assert.equal(r.evidence.length + r.missing.length, 6);
    if (r.basis === 'FUTURES_ONLY') assert.equal(r.evidence.length + r.missing.length, 5);
    assert.equal(r.advisory, LEAD_SCORE_ADVISORY_NOTE);
    assert.ok(LEAD_SCORE_BASES.includes(r.basis));
  }
});

// ── display model ─────────────────────────────────────────────

test('display model is compact: "<score> <LABEL>"', () => {
  const d = buildLeadScoreDisplay(LED);
  assert.match(d.display, /^\d{1,3} (LOW|MED|HIGH|EXTREME)$/);
  assert.equal(d.display, `${d.score} ${d.label}`);
  assert.equal(buildLeadScoreDisplay({}).display, 'UNKNOWN');
});

test('display model never leaks null / undefined / NaN into any rendered string', () => {
  const cases = [
    {}, null, undefined, ALIGNED, LED,
    { spotPrice: 100, futuresPrice: null, fundingPct: null, takerBuyRatio: null },
    { spotPrice: 0, futuresPrice: 0, spotQuoteVolume24h: 0, futuresQuoteVolume24h: 0 },
    { spotPrice: 'abc', futuresPrice: 'def', spotChange24hPct: NaN, futuresChange24hPct: NaN },
    { spotChange24hPct: -3, futuresChange24hPct: -9, openInterestChangePct: 0, fundingPct: 0 },
  ];
  for (const c of cases) {
    const d = buildLeadScoreDisplay(c);
    for (const key of ['display', 'scoreText', 'label', 'direction', 'confidence', 'tooltip', 'cssClass', 'advisory', 'basis', 'basisNote', 'basisClass']) {
      const v = d[key];
      assert.equal(typeof v, 'string', `${key} for ${JSON.stringify(c)}`);
      assert.ok(v.length > 0, `${key} empty for ${JSON.stringify(c)}`);
      assert.doesNotMatch(v, /\b(null|undefined|NaN)\b/, `${key} = ${v}`);
    }
    for (const line of [...d.evidence, ...d.missing]) {
      assert.equal(typeof line, 'string');
      assert.doesNotMatch(line, /\b(null|undefined|NaN)\b/, line);
    }
    assert.ok(d.score === null || Number.isInteger(d.score));
    assert.ok(['LOW', 'MED', 'HIGH', 'EXTREME', 'UNKNOWN'].includes(d.label));
    assert.ok(['futures-led up', 'futures-led down', 'mixed', 'unknown'].includes(d.direction));
  }
});

test('tooltip carries score, label, direction, evidence, missing and the advisory disclaimer', () => {
  const d = buildLeadScoreDisplay({ ...LED, openInterestChangePct: null });
  assert.match(d.tooltip, /^Lead Score: \d{1,3} \/ 100 · (LOW|MED|HIGH|EXTREME)$/m);
  assert.match(d.tooltip, /direction: futures-led up/);
  assert.match(d.tooltip, /Confidence: /);
  assert.match(d.tooltip, /Evidence: .*futures .* vs spot/);
  assert.match(d.tooltip, /Missing: open interest change/);
  assert.ok(d.tooltip.includes(LEAD_SCORE_ADVISORY_NOTE));

  const unknown = buildLeadScoreDisplay({});
  assert.match(unknown.tooltip, /Lead Score: UNKNOWN/);
  assert.match(unknown.tooltip, /Missing: /);
  assert.ok(unknown.tooltip.includes(LEAD_SCORE_ADVISORY_NOTE));
});

// ── row adapter ───────────────────────────────────────────────

test('row adapter reads the additive _leadVenue snapshot and the supplied funding', () => {
  const row = {
    symbol: 'INJ',
    _leadVenue: {
      spot: { price: 100, quoteVolume24h: 1e8, change24hPct: 3 },
      futures: { price: 100.5, quoteVolume24h: 4e8, change24hPct: 4.2 },
    },
  };
  const input = leadScoreInputFromRow(row, { fundingPct: 0.045 });
  assert.equal(input.spotPrice, 100);
  assert.equal(input.futuresPrice, 100.5);
  assert.equal(input.futuresQuoteVolume24h, 4e8);
  assert.equal(input.fundingPct, 0.045);
  assert.equal(leadScoreForRow(row, { fundingPct: 0.045 }).label, 'HIGH');
});

test('row adapter never reads the dead _funding / _takerRatio placeholders', () => {
  // markets.js ships `_funding: 0` and `_takerRatio: 0.5` as hard-coded
  // placeholders. Reading them would fabricate a funding and a flow reading
  // for every coin on the board.
  assert.doesNotMatch(leadScoreCode, /_funding\b/);
  assert.doesNotMatch(leadScoreCode, /_takerRatio\b/);
  assert.doesNotMatch(leadScoreCode, /_oiDelta\b/);
  const row = { _funding: 0, _oiDelta: 0, _takerRatio: 0.5, _leadVenue: { spot: { price: 100 }, futures: { price: 101 } } };
  const r = computeLeadScore(leadScoreInputFromRow(row));
  assert.ok(r.missing.includes('funding rate'));
  assert.ok(r.missing.includes('taker buy/sell flow'));
  assert.ok(r.missing.includes('open interest change'));
});

test('a row with no venue snapshot at all scores UNKNOWN', () => {
  for (const row of [{}, null, { _leadVenue: null }, { _leadVenue: {} }, { _leadVenue: 'x' }]) {
    assert.equal(leadScoreForRow(row).label, 'UNKNOWN');
    assert.equal(leadScoreForRow(row).display, 'UNKNOWN');
  }
});

// ── Scanner UI wiring ─────────────────────────────────────────

test('Scanner renders a column labelled exactly "Lead Score"', () => {
  assert.match(terminalJs, /leadscore:\s*\{\s*label:\s*'Lead Score'/);
  assert.match(terminalJs, /leadscore:\s*`<span data-col="leadscore"/);
  // Static SSR header fallback carries the same label.
  assert.match(indexHtml, /data-col="leadscore"[^>]*>Lead Score</);
  // Column is registered in the default order so it paints without a reset.
  assert.match(terminalJs, /const DEFAULT_COLUMN_ORDER = \[[^\]]*'leadscore'\]/);
  assert.match(terminalCss, /\.lead-score\{/);
  assert.match(terminalCss, /\.lead-score--unknown/);
  assert.match(indexHtml, /src="\/js\/scanner-lead-score\.js\?v=/);
});

test('the Lead Score cell is advisory-styled and carries its evidence tooltip', () => {
  assert.match(terminalJs, /const cls = `lead-score \$\{v\.cssClass \|\| 'lead-score--unknown'\}/);
  assert.match(terminalJs, /v\.degraded \? ' lead-score--degraded' : ''/);
  assert.match(terminalJs, /title="\$\{_esc\(v\.tooltip\)\}"/);
  assert.match(terminalCss, /\.lead-score--degraded\{border-style:dashed\}/);
  // Neutral styling only — no bullish/bearish colour on this column.
  const leadCss = terminalCss.slice(terminalCss.indexOf('.lead-score{'), terminalCss.indexOf('.lead-score--unknown') + 200);
  assert.doesNotMatch(leadCss, /var\(--grn\)|var\(--red\)/);
  // Expanded (mobile) detail shows it too.
  assert.match(terminalJs, /te-lbl">LEAD SCORE<\/span>/);
});

test('Lead Score is not sortable and is not the default sort', () => {
  // Only c24 participates in scanner sorting; the default comparator is untouched.
  assert.match(terminalJs, /function _toggleScannerSort\(key\) \{\s*\n\s*if \(key !== 'c24'\) return false;/);
  assert.match(terminalJs, /if \(!sortState \|\| sortState\.key !== 'c24'\) return _scannerDefaultCompare\(a, b\);/);
  const sortState = terminalJs.match(/let _scannerSort = \{[^}]*\}/);
  assert.ok(sortState, 'default sort state not found');
  assert.doesNotMatch(sortState[0], /leadscore/);
  // The filter/sort pipeline never mentions the column.
  const pipeline = terminalJs.slice(terminalJs.indexOf('function getFilteredSorted()'), terminalJs.indexOf('function renderList()'));
  assert.doesNotMatch(pipeline, /lead/i);
});

test('a missing Lead Score module renders UNKNOWN and logs — never a silent blank', () => {
  assert.match(terminalJs, /\[LEAD-SCORE\] scanner-lead-score\.js not loaded/);
  assert.match(terminalJs, /\[LEAD-SCORE\] scoring failed for/);
  assert.match(terminalJs, /LEAD_UNAVAILABLE = \{\s*\n?\s*display: 'UNKNOWN'/);
});

// ── venue split on the market feeds ───────────────────────────

test('/api/markets publishes both venue readings without a new upstream call', () => {
  // Both tickers were already fetched for the existing venue gauntlet.
  assert.match(marketsJs, /spot_last_price: venueNum\(spotTicker, 'lastPrice'\)/);
  assert.match(marketsJs, /futures_quote_volume_24h: venueNum\(futTicker, 'quoteVolume'\)/);
  assert.match(marketsJs, /function venueNum\(ticker, key\)/);
  // venueNum must reject the empty cases before Number() sees them.
  assert.match(marketsJs, /if \(v === null \|\| v === undefined \|\| typeof v === 'boolean'\) return null;/);
  // Payload shape changed → cache schema token must have moved with it.
  assert.match(marketsJs, /const MARKETS_SCHEMA_VERSION = 'v7_2_venue_split'/);
  // No new upstream was introduced: this pins the exact set of external
  // origins markets.js may talk to. The venue split reuses tickers that were
  // already being fetched, so this list must be identical before and after.
  const origins = [...new Set((marketsJs.match(/https?:\/\/[^/'"`\s]+/g) || []))].sort();
  assert.deepEqual(origins, [
    'http://localhost:8888',
    'https://api.binance.com',
    'https://api.coingecko.com',
    'https://fapi.binance.com',
    'https://prod.example',
    'https://www.binance.com',
  ]);
});

test('the canonical /api/context path keeps the venue it is about to discard', () => {
  assert.match(terminalJs, /_leadVenue: \{\s*\n?\s*\[t\.market === 'futures' \? 'futures' : 'spot'\]/);
  assert.match(terminalJs, /const _mergeLeadVenue = \(target, source\) =>/);
  // The merge must never overwrite a side that is already populated.
  assert.match(terminalJs, /if \(source\._leadVenue\[side\] && !target\._leadVenue\[side\]\)/);
});

// ── isolation from the trading paths ──────────────────────────

test('Lead Score never reaches RADAR, ENTRY_READY, Telegram or any trading path', () => {
  const backendFiles = [
    'netlify/functions/bot.mjs',
    'netlify/functions/cron-alerts.mjs',
    'netlify/functions/telegram.mjs',
    'netlify/functions/personal-alerts.mjs',
    'scripts/radar/trading-radar.mjs',
    'scripts/auto/auto-trader.mjs',
    'scripts/cockpit/trade-cockpit.mjs',
  ];
  for (const f of backendFiles) {
    const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /leadScore|leadscore|_leadVenue|lead_score/i, `${f} must not know about Lead Score`);
  }
  // The scoring module itself must not touch gates, alerts or execution.
  assert.doesNotMatch(leadScoreCode, /ENTRY_READY|STRICT_ABSORB|telegram|reclaim|absorb|executionIntent/i);
  // ...and it must not reach the network or the DOM.
  assert.doesNotMatch(leadScoreCode, /\bfetch\s*\(|XMLHttpRequest|WebSocket|localStorage|\bdocument\b/);
  // The only global it touches is the read-only export bridge terminal.js uses.
  const windowRefs = leadScoreCode.match(/window\.[A-Za-z_$][\w$]*/g) || [];
  assert.deepEqual([...new Set(windowRefs)], ['window.__scannerLeadScore']);
});

test('the RADAR scanner-context payload does not carry Lead Score', () => {
  const push = terminalJs.slice(
    terminalJs.indexOf('function pushScannerContextToRadar()'),
    terminalJs.indexOf('const fieldMappingDetected'),
  );
  assert.ok(push.length > 500, 'pushScannerContextToRadar not found');
  assert.doesNotMatch(push, /lead/i);
});
