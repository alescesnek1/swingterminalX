// Tests for the RADAR valuation (oversold / overbought) DISPLAY layer:
//   1. the pure display models in apps/edge/public/js/price-history-signals-panel.js
//   2. the terminal.js / CSS / index.html wiring that renders them
//   3. the end-to-end shape: the RADAR evaluator attaches a valuation block to
//      every candidate and the bot enriches it from the database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  radarValuationDisplayModel,
  radarValuationSummaryModel,
} from '../apps/edge/public/js/price-history-signals-panel.js';
import { buildValuationContext, computeHistoryValuation, mergeValuationHistory } from '../scripts/radar/valuation-bands.mjs';
import { evaluateTradingRadar } from '../scripts/radar/trading-radar.mjs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const terminalCss = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');
const botSrc = fs.readFileSync(new URL('../netlify/functions/bot.mjs', import.meta.url), 'utf8');

const HOUR = 3600000;
const T0 = Date.parse('2026-08-01T00:00:00.000Z');

function storedPoints(from, to, n, stepMs = HOUR) {
  const start = T0 - (n - 1) * stepMs;
  return Array.from({ length: n }, (_, i) => ({
    price_usd: String(from + ((to - from) * (i / (n - 1)))),
    sampled_at: new Date(start + i * stepMs).toISOString(),
  }));
}

// ── pure display model ──────────────────────────────────────────────────────

test('a candidate with no valuation block renders explicitly UNKNOWN, never FAIR', () => {
  for (const c of [null, undefined, {}, { symbol: 'BTCUSDT' }, { valuation: 'nope' }]) {
    const m = radarValuationDisplayModel(c);
    assert.equal(m.band, 'UNKNOWN');
    assert.equal(m.labelShort, 'UNKNOWN');
    assert.equal(m.direction, 'UNKNOWN');
    assert.equal(m.scoreText, '--');
    assert.equal(m.present, false);
    assert.match(m.cssClass, /radar-val-pill--unknown/);
    assert.equal(m.isEntrySignal, false);
  }
});

test('an oversold band renders the cyan attention pill, a signed score, and the not-a-signal caveat', () => {
  const c = { valuation: buildValuationContext({ market: { change24hPct: -34, change12hPct: -22, change7dPct: -50 } }) };
  const m = radarValuationDisplayModel(c);
  assert.equal(m.direction, 'OVERSOLD');
  assert.match(m.labelShort, /OVERSOLD/);
  assert.match(m.cssClass, /radar-val-pill--oversold/);
  assert.ok(m.scoreText.startsWith('-'), `expected a negative score, got ${m.scoreText}`);
  assert.equal(m.confidence, 'low');
  assert.match(m.basisText, /momentum only/);
  assert.match(m.tooltip, /not a fundamental valuation/);
  assert.match(m.tooltip, /-100 oversold/);
  assert.ok(m.blockers.some((b) => /advisory only — a valuation band is a context read/.test(b)));
});

test('an overbought band renders the amber caution pill and a positive score', () => {
  const c = { valuation: buildValuationContext({ market: { change24hPct: 34, change12hPct: 22, change7dPct: 50 } }) };
  const m = radarValuationDisplayModel(c);
  assert.equal(m.direction, 'OVERBOUGHT');
  assert.match(m.cssClass, /radar-val-pill--overbought/);
  assert.ok(m.scoreText.startsWith('+'), `expected a signed positive score, got ${m.scoreText}`);
});

test('a history-backed band exposes the evidence rows an operator can check', () => {
  const base = buildValuationContext({ market: { change24hPct: -18, atrPct: 5 } });
  const merged = mergeValuationHistory(base, computeHistoryValuation(storedPoints(100, 62, 40), { now: T0 }));
  const m = radarValuationDisplayModel({ valuation: merged });
  assert.equal(m.historyAvailable, true);
  assert.match(m.basisText, /stored price history/);
  const keys = m.detail.map((d) => d.k);
  assert.ok(keys.includes('Range position'));
  assert.ok(keys.includes('Sampled RSI'));
  assert.ok(keys.includes('vs window mean'));
  assert.ok(keys.includes('History points'));
  // The RSI must be labelled as sampled, not presented as a candle RSI.
  assert.match(m.detail.find((d) => d.k === 'Sampled RSI').v, /sampled points not candles/);
});

test('a momentum-only band says so in the detail rows rather than showing a blank history', () => {
  const m = radarValuationDisplayModel({ valuation: buildValuationContext({ market: { change24hPct: -12 } }) });
  const stored = m.detail.find((d) => d.k === 'Stored history');
  assert.ok(stored, 'the missing history layer must be stated');
  assert.match(stored.v, /no stored price history/);
  assert.ok(m.detail.some((d) => d.k === 'Volatility' && /not volatility-normalized/.test(d.v)));
});

// ── summary model ───────────────────────────────────────────────────────────

test('a missing valuation summary reads as unavailable, not as zero oversold coins', () => {
  const m = radarValuationSummaryModel({});
  assert.equal(m.present, false);
  assert.equal(m.historyAvailable, false);
  assert.equal(m.historyUnavailableReason, 'VALUATION_SUMMARY_MISSING');
  assert.match(m.text, /unavailable/i);
});

test('the summary line states the counts and the stored-history coverage', () => {
  const m = radarValuationSummaryModel({
    valuationSummary: {
      oversoldTotal: 4, overboughtTotal: 2, fair: 9, unknown: 5,
      momentumOnly: 12, historyBacked: 8,
      historyAvailable: true, historyUnavailableReason: null,
      historySymbolsWithData: 8, historySymbolsRequested: 40, historyTopN: 40,
    },
  });
  assert.equal(m.present, true);
  assert.match(m.text, /4 oversold, 9 fair, 2 overbought, 5 unknown/);
  assert.match(m.text, /8\/40 of the top 40 candidates/);
  assert.match(m.note, /not an entry signal/);
});

test('a degraded stored-history layer is called out in the summary line with its reason', () => {
  const m = radarValuationSummaryModel({
    valuationSummary: { oversoldTotal: 1, overboughtTotal: 0, fair: 3, unknown: 0, historyAvailable: false, historyUnavailableReason: 'DB_UNAVAILABLE' },
  });
  assert.equal(m.historyAvailable, false);
  assert.match(m.text, /stored-history layer unavailable \(DB_UNAVAILABLE\)/);
  assert.match(m.text, /momentum only/);
});

// ── terminal.js / CSS / index.html wiring ───────────────────────────────────

test('the RADAR matrix has a Value column, header caveat, and 19-column empty row', () => {
  assert.match(terminalJs, /_radarValuationModel\(c\)/);
  assert.match(terminalJs, /radar-val-pill__score/);
  assert.match(terminalJs, /<th title="Oversold \/ overbought relative to this coin's own recent range/);
  assert.match(terminalJs, /NOT a fundamental valuation and NOT an entry signal\.">Value<\/th>/);
  assert.match(terminalJs, /colspan="19"/);
  assert.doesNotMatch(terminalJs, /colspan="18" class="fleet-empty">No candidates match/);
});

test('Oversold and Overbought filter chips exist, are counted, and exclude UNKNOWN rows', () => {
  assert.match(terminalJs, /filterButton\('OVERSOLD', 'Oversold', filtersCount\.OVERSOLD\)/);
  assert.match(terminalJs, /filterButton\('OVERBOUGHT', 'Overbought', filtersCount\.OVERBOUGHT\)/);
  assert.match(terminalJs, /OVERSOLD: allCandidates\.filter\(c => _radarValuationDirection\(c\) === 'OVERSOLD'\)\.length/);
  assert.match(terminalJs, /activeFilter === 'OVERSOLD'/);
  assert.match(terminalJs, /activeFilter === 'OVERBOUGHT'/);
});

test('the Focus Candidate renders a valuation panel and the coverage note', () => {
  assert.match(terminalJs, /function _radarValuationFocusHtml/);
  assert.match(terminalJs, /radar-tech-group__title">Relative Value \/ Advisory</);
  assert.match(terminalJs, /RELATIVE VALUE &middot; ADVISORY ONLY &middot; own recent range — not fundamental, not an entry signal/);
  assert.match(terminalJs, /-100 oversold &middot; 0 fair &middot; \+100 overbought/);
  assert.match(terminalJs, /radar-valuation-note/);
  assert.match(terminalJs, /_radarValuationSummary\(radar\)/);
});

test('a failed valuation display module renders UNKNOWN and reaches the central error log', () => {
  const helper = terminalJs.slice(terminalJs.indexOf('function _radarValuationModel'), terminalJs.indexOf('function _radarValuationSummary'));
  assert.match(helper, /window\.ErrorLog\.record/);
  assert.match(helper, /radar_valuation_display_unavailable/);
  assert.match(helper, /console\.warn/);
  assert.match(helper, /band: 'UNKNOWN'/);
  assert.doesNotMatch(helper, /band: 'FAIR'/);
});

test('valuation pills are styled apart from the pass/fail gate pills and UNKNOWN stays muted', () => {
  assert.match(terminalCss, /\.radar-val-pill--oversold-deep/);
  assert.match(terminalCss, /\.radar-val-pill--oversold\b/);
  assert.match(terminalCss, /\.radar-val-pill--fair/);
  assert.match(terminalCss, /\.radar-val-pill--overbought\b/);
  assert.match(terminalCss, /\.radar-val-pill--overbought-deep/);
  assert.match(terminalCss, /\.radar-val-pill--unknown/);
  assert.match(terminalCss, /\.radar-valuation-note--degraded/);
  // Oversold must NOT reuse the green "pass" colour of the gate pills.
  const oversold = terminalCss.slice(terminalCss.indexOf('.radar-val-pill--oversold-deep'));
  assert.doesNotMatch(oversold.slice(0, 200), /#00ff80/);
});

test('the asset cache-bust token was bumped so returning users get the new column', () => {
  // The three assets this feature actually changed must all be tokenised and
  // carry the SAME token, and the pre-feature token must be gone.
  //
  // Deliberately token-agnostic: the exact literal is pinned in exactly ONE
  // place (frontend.canonical-context-cutover.test.mjs), so a future bump has a
  // single test to update instead of two that can silently drift apart.
  assert.doesNotMatch(indexHtml, /\?v=6k4\b/, 'the pre-valuation token must be gone');
  const tokenFor = (asset) => {
    const match = indexHtml.match(new RegExp(`${asset}\\?v=([0-9a-z]+)`));
    assert.ok(match, `${asset} must carry a cache-bust token`);
    return match[1];
  };
  const tokens = ['js/terminal\\.js', 'css/terminal\\.css', 'price-history-signals-panel\\.js'].map(tokenFor);
  assert.equal(new Set(tokens).size, 1, `valuation assets must share one token, got ${tokens.join(', ')}`);
});

// ── end-to-end shape ────────────────────────────────────────────────────────

test('the RADAR evaluator attaches a valuation block to every candidate', () => {
  const markets = [
    { symbol: 'BTCUSDT', status: 'TRADING', lastPrice: 60000, quoteVolume24h: 900_000_000, priceChangePercent: -3, spreadPct: 0.02 },
    { symbol: 'ETHUSDT', status: 'TRADING', lastPrice: 3000, quoteVolume24h: 400_000_000, priceChangePercent: -14, change12hPct: -9, spreadPct: 0.03 },
  ];
  const state = evaluateTradingRadar({ markets, source: 'test', now: T0 });
  assert.ok(state.candidates.length >= 2);
  for (const c of state.candidates) {
    assert.ok(c.valuation && typeof c.valuation === 'object', `${c.symbol} must carry a valuation block`);
    assert.equal(c.valuation.isEntrySignal, false);
    assert.equal(c.valuation.affectsGate, false);
    assert.equal(c.valuation.affectsTelegram, false);
    assert.equal(c.valuation.scope, 'relative_to_own_recent_range');
    assert.ok(['DEEPLY_OVERSOLD', 'OVERSOLD', 'FAIR', 'OVERBOUGHT', 'DEEPLY_OVERBOUGHT', 'UNKNOWN'].includes(c.valuation.VALUATION_BAND));
  }
  const eth = state.candidates.find((c) => c.symbol === 'ETHUSDT');
  assert.equal(eth.valuation.VALUATION_DIRECTION, 'OVERSOLD');
});

test('the valuation band never reaches a gate: no RADAR gate/score/Telegram path reads it', () => {
  const radarSrc = fs.readFileSync(new URL('../scripts/radar/trading-radar.mjs', import.meta.url), 'utf8');
  // The evaluator may only BUILD it and attach it — it must never be read by
  // scoring, gate, or eligibility code.
  const reads = radarSrc.match(/valuation/gi) || [];
  assert.ok(reads.length > 0);
  assert.doesNotMatch(radarSrc, /valuation[^\n]*(SETUP_SCORE|EXECUTION_SCORE|FINAL_CONFIDENCE|telegramEligible|entryReadyV1|allRadarConditionsPassed)/);
  assert.doesNotMatch(radarSrc, /(setupValid|executionValid|riskRewardValid|entryBaseValid|telegramEligible)[^\n]*valuation/);
  assert.match(radarSrc, /const valuation = buildValuationContext\(\{ market: m \}\)/);
});

test('the bot enriches the valuation from the database and logs a failure instead of hiding it', () => {
  assert.match(botSrc, /loadValuationHistoryForCandidates/);
  assert.match(botSrc, /applyValuationHistoryToRadar\(radar, valuationHistory\)/);
  assert.match(botSrc, /listRecentPricePointsForSymbols/);
  assert.match(botSrc, /console\.warn\('\[bot\] RADAR valuation stored-history layer unavailable'/);
  // The enrichment must run AFTER the RADAR evaluation and the telegram
  // eligibility restore, so it can never influence either.
  assert.ok(botSrc.indexOf('applyValuationHistoryToRadar(radar, valuationHistory)') > botSrc.indexOf('baselineTelegramEligibility.get(candidate.symbol)'));
});
