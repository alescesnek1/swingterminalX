import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  runMorningBriefing,
  buildBriefingMessage,
  gatherBriefingData,
  buildMarketContext,
  buildAiContext,
  mapCanonicalTicker,
  mapCanonicalCandidate,
  maxDataAgeMs,
  fmtAge,
  parseAiBlocks,
  isMorningBriefingHardDisabled,
  localDayString,
  localHour,
  escapeHtml,
  MORNING_BRIEFING_CODES,
  MORNING_BRIEFING_DATA_SOURCES,
  MORNING_BRIEFING_DATA_REASONS,
  DEFAULT_MAX_DATA_AGE_MS,
  DISCLAIMER,
  MACRO_UNAVAILABLE,
} from '../scripts/briefing/morning-briefing.mjs';
import { buildModelChain, sanitizeProviderBody, summarizeBriefing } from '../scripts/briefing/gemini-node.mjs';
import { isTelegramHardDisabled } from '../netlify/functions/cron-alerts.mjs';

// 08:00 Europe/Prague on 2026-06-17 is 06:00 UTC (CEST, UTC+2).
const NOW = new Date('2026-06-17T06:00:00Z');
const TODAY = '2026-06-17';

function fakeFleet() {
  return {
    tradingRadar: {
      marketRegime: {
        status: 'RISK_OFF', score: 42, breadthPct: 38,
        btc: { symbol: 'BTCUSDT', change24hPct: -2.1 },
        eth: { symbol: 'ETHUSDT', change24hPct: -1.4 },
        reasons: ['65% of top red', 'median 24h -3%'],
        blocksMeanReversion: false,
      },
      candidates: [
        { symbol: 'SOLUSDT', stage: 'STABILIZING', actionability: 'NEEDS_CONFIRMATION', distanceToEntryReadyScore: 72, safetyStatus: 'SAFE', safetyBasis: 'Binance CEX listing', confidence: 68, reasons: ['long flush confirmed, base forming'], riskFlags: ['spread above ideal'], executionDataMissing: [], diagnostics: { change24hPct: -6.2 }, blockedBy: 'needs reclaim confirmation' },
        { symbol: 'FOOUSDT', stage: 'WATCH', actionability: 'WATCH_ONLY', distanceToEntryReadyScore: 55, safetyStatus: 'UNKNOWN', safetyBasis: 'no listing match', confidence: 40, reasons: ['relative drop <sharp>'], riskFlags: [], executionDataMissing: ['orderbook', 'funding'], diagnostics: { change24hPct: -4.0 }, blockedBy: 'missing microstructure' },
        { symbol: 'BARUSDT', stage: 'LONG_FLUSH_CONFIRMED', actionability: 'NEEDS_STABILIZATION', distanceToEntryReadyScore: 48, safetyStatus: 'CAUTION', confidence: 35, reasons: ['panic flush'], riskFlags: ['high volatility'], executionDataMissing: [], diagnostics: { change24hPct: -9.1 } },
      ],
      entryReady: [],
      universeDiagnostics: { safetyUnknown: 1, safetyDanger: 0 },
    },
    autoMarketSnapshot: {
      fetchedAt: '2026-06-17T05:59:00Z',
      markets: [
        { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', priceChangePercent: -2.1, quoteVolume: 9e9 },
        { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', priceChangePercent: -1.4, quoteVolume: 5e9 },
        { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', priceChangePercent: -6.2, quoteVolume: 8e8 },
        { symbol: 'FETUSDT', baseAsset: 'FET', quoteAsset: 'USDT', priceChangePercent: 7.5, quoteVolume: 3e8 },
        { symbol: 'WIFUSDT', baseAsset: 'WIF', quoteAsset: 'USDT', priceChangePercent: 5.1, quoteVolume: 2e8 },
      ],
    },
    lastRegime: { regime: 'RISK_OFF' },
  };
}

// The fixtures carry FIXED timestamps, so every freshness assertion must state
// its reference time — a test that used the wall clock would go stale on its own.
function dataFor(fleet = fakeFleet(), now = NOW, canonical = null, env = {}) {
  const context = buildMarketContext({ canonical, fleet, env, nowMs: now.getTime() });
  return gatherBriefingData(fleet, env, context);
}

// Shape returned by getAtomizedMarketContext() (netlify/functions/_market-context-store.mjs):
// raw DB rows, snake_case, numbers as strings.
function fakeCanonical({
  observedAt = '2026-06-17T05:58:00Z',
  computedAt = '2026-06-17T05:58:30Z',
  status = 'READY',
  tickers = null,
  candidates = null,
} = {}) {
  return {
    ok: true,
    market: {
      observedAt,
      freshness: 'FRESH',
      tickers: tickers || [
        { market: 'spot', symbol: 'BTCUSDT', base_asset: 'BTC', quote_asset: 'USDT', last_price: '63080.64', price_change_percent: '-1.79', quote_volume: '9000000000' },
        // Same symbol on the other venue — must NOT be counted twice.
        { market: 'futures', symbol: 'BTCUSDT', base_asset: 'BTC', quote_asset: 'USDT', last_price: '63090.10', price_change_percent: '-1.81', quote_volume: '12000000000' },
        { market: 'spot', symbol: 'ETHUSDT', base_asset: 'ETH', quote_asset: 'USDT', last_price: '2600', price_change_percent: '-1.69', quote_volume: '5000000000' },
        { market: 'spot', symbol: 'SOLUSDT', base_asset: 'SOL', quote_asset: 'USDT', last_price: '140', price_change_percent: '4.20', quote_volume: '800000000' },
      ],
      dataQuality: {},
    },
    radar: {
      status,
      computedAt,
      readSource: 'atomized_state',
      marketRegime: { status: 'MIXED', score: 58, breadthPct: 33.3, reasons: ['BTC weak'] },
      universeDiagnostics: { safetyUnknown: 1, safetyDanger: 0 },
      candidates: candidates || [
        {
          market: 'spot', symbol: 'SOLUSDT', status: 'STABILIZING', entry_ready: false, setup_score: 71,
          computed_at: computedAt,
          payload: { symbol: 'SOLUSDT', stage: 'STABILIZING', safetyStatus: 'SAFE', distanceToEntryReadyScore: 71, reasons: ['base forming after flush'], riskFlags: [], executionDataMissing: [] },
        },
        {
          market: 'spot', symbol: 'FOOUSDT', status: 'WATCH', entry_ready: false, setup_score: 44,
          computed_at: computedAt,
          // Payload claims ENTRY_READY while the canonical column says false.
          payload: { symbol: 'FOOUSDT', stage: 'WATCH', actionability: 'ENTRY_READY', safetyStatus: 'UNKNOWN', distanceToEntryReadyScore: 44, reasons: ['scanner context (score 9)'], executionDataMissing: ['orderbook'] },
        },
      ],
    },
  };
}

function makeStore(initial = fakeFleet()) {
  const state = { fleet: initial };
  return {
    state,
    loadFleet: async () => state.fleet,
    mutateFleet: async (fn) => { const r = await fn(state.fleet); return r; },
  };
}

function recorder() {
  const calls = [];
  return { calls, send: async (token, chatId, text) => { calls.push({ token, chatId, text }); return { ok: true }; } };
}

const ENABLED_ENV = {
  MORNING_BRIEFING_TELEGRAM_ENABLED: 'true',
  TG_BOT_TOKEN: 'test-token',
  TG_CHAT_ID: '123456',
  MORNING_BRIEFING_TIMEZONE: 'Europe/Prague',
  MORNING_BRIEFING_HOUR_LOCAL: '8',
};

const aiOk = async () => ({
  ok: true,
  text: 'MACRO: Rates steady, USD soft, equities risk-on into the open.\nBUSINESS: Spot BTC ETF inflows continued for a fifth session.\nTONE: Cautiously constructive despite breadth weakness.',
  meta: { model: 'gemini-2.5-flash', triedModels: ['gemini-2.5-flash'], fallbackUsed: false, groundingDisabled: false },
  providerErrors: [],
});
const aiFail = async () => ({ ok: false, meta: { model: null, triedModels: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'], fallbackUsed: false, groundingDisabled: false }, providerErrors: ['HTTP 429 gemini-2.5-flash: quota'] });

// ── timezone helpers ──────────────────────────────────────────────────────
test('localDayString / localHour resolve Europe/Prague correctly (CEST)', () => {
  assert.equal(localDayString(NOW, 'Europe/Prague'), TODAY);
  assert.equal(localHour(NOW, 'Europe/Prague'), 8);
  // Just before midnight UTC is already next day in Prague.
  assert.equal(localDayString(new Date('2026-06-17T22:30:00Z'), 'Europe/Prague'), '2026-06-18');
});

// ── env gating ──────────────────────────────────────────────────────────--
test('default env: briefing disabled, sends 0', async () => {
  const r = recorder();
  const { loadFleet, mutateFleet } = makeStore();
  const diag = await runMorningBriefing({ env: {}, now: NOW, loadFleet, mutateFleet, sendMessage: r.send });
  assert.equal(diag.sent, 0);
  assert.equal(diag.briefingEnabled, false);
  assert.equal(diag.code, MORNING_BRIEFING_CODES.DISABLED_BY_ENV);
  assert.equal(r.calls.length, 0);
});

test('MORNING_BRIEFING_TELEGRAM_ENABLED=false sends 0', async () => {
  const r = recorder();
  const { loadFleet, mutateFleet } = makeStore();
  const diag = await runMorningBriefing({ env: { ...ENABLED_ENV, MORNING_BRIEFING_TELEGRAM_ENABLED: 'false' }, now: NOW, loadFleet, mutateFleet, sendMessage: r.send });
  assert.equal(diag.sent, 0);
  assert.equal(diag.code, MORNING_BRIEFING_CODES.DISABLED_BY_ENV);
  assert.equal(r.calls.length, 0);
});

test('missing TG_BOT_TOKEN sends 0', async () => {
  const r = recorder();
  const { loadFleet, mutateFleet } = makeStore();
  const diag = await runMorningBriefing({ env: { ...ENABLED_ENV, TG_BOT_TOKEN: '' }, now: NOW, loadFleet, mutateFleet, sendMessage: r.send });
  assert.equal(diag.sent, 0);
  assert.equal(diag.code, MORNING_BRIEFING_CODES.MISSING_CREDENTIALS);
  assert.equal(r.calls.length, 0);
});

test('missing TG_CHAT_ID sends 0', async () => {
  const r = recorder();
  const { loadFleet, mutateFleet } = makeStore();
  const diag = await runMorningBriefing({ env: { ...ENABLED_ENV, TG_CHAT_ID: '' }, now: NOW, loadFleet, mutateFleet, sendMessage: r.send });
  assert.equal(diag.sent, 0);
  assert.equal(diag.code, MORNING_BRIEFING_CODES.MISSING_CREDENTIALS);
  assert.equal(r.calls.length, 0);
});

test('TELEGRAM_ENABLED=false kill switch disables briefing', async () => {
  const r = recorder();
  const { loadFleet, mutateFleet } = makeStore();
  const diag = await runMorningBriefing({ env: { ...ENABLED_ENV, TELEGRAM_ENABLED: 'false' }, now: NOW, loadFleet, mutateFleet, sendMessage: r.send });
  assert.equal(diag.sent, 0);
  assert.equal(diag.code, MORNING_BRIEFING_CODES.DISABLED_BY_ENV);
});

test('CRON_ALERTS_ENABLED=false kill switch disables briefing', async () => {
  const r = recorder();
  const { loadFleet, mutateFleet } = makeStore();
  const diag = await runMorningBriefing({ env: { ...ENABLED_ENV, CRON_ALERTS_ENABLED: 'false' }, now: NOW, loadFleet, mutateFleet, sendMessage: r.send });
  assert.equal(diag.sent, 0);
  assert.equal(diag.code, MORNING_BRIEFING_CODES.DISABLED_BY_ENV);
});

test('briefing gate does NOT depend on RADAR_TELEGRAM_ENABLED', () => {
  // Enabling the briefing with RADAR unset must keep the briefing enabled,
  // and must NOT enable the RADAR gate.
  const env = { ...ENABLED_ENV };
  assert.equal(isMorningBriefingHardDisabled(env), false);
  // RADAR gate still requires its own flag and stays disabled.
  assert.equal(isTelegramHardDisabled(env), true);
  // And disabling RADAR explicitly does not affect the briefing gate.
  assert.equal(isMorningBriefingHardDisabled({ ...env, RADAR_TELEGRAM_ENABLED: 'false' }), false);
});

// ── send / dedup ─────────────────────────────────────────────────────────--
test('sends once when enabled and credentials exist, then skips same local day', async () => {
  const r = recorder();
  const { loadFleet, mutateFleet, state } = makeStore();

  const first = await runMorningBriefing({ env: ENABLED_ENV, now: NOW, loadFleet, mutateFleet, sendMessage: r.send, summarize: aiOk });
  assert.equal(first.sent, 1);
  assert.equal(first.code, MORNING_BRIEFING_CODES.SENT);
  assert.equal(r.calls.length, 1);
  assert.equal(state.fleet.morningBriefing.lastSentDate, TODAY);

  // Second run the same local day must skip.
  const second = await runMorningBriefing({ env: ENABLED_ENV, now: new Date('2026-06-17T06:30:00Z'), loadFleet, mutateFleet, sendMessage: r.send, summarize: aiOk });
  assert.equal(second.sent, 0);
  assert.equal(second.code, MORNING_BRIEFING_CODES.ALREADY_SENT);
  assert.equal(r.calls.length, 1, 'no second Telegram send');
});

test('outside the morning window: skips without sending', async () => {
  const r = recorder();
  const { loadFleet, mutateFleet } = makeStore();
  // 12:00 UTC = 14:00 Prague, not the 08:00 target.
  const diag = await runMorningBriefing({ env: ENABLED_ENV, now: new Date('2026-06-17T12:00:00Z'), loadFleet, mutateFleet, sendMessage: r.send });
  assert.equal(diag.sent, 0);
  assert.equal(diag.code, MORNING_BRIEFING_CODES.OUTSIDE_WINDOW);
  assert.equal(r.calls.length, 0);
});

test('force bypasses window and dedup', async () => {
  const r = recorder();
  const initial = fakeFleet();
  initial.morningBriefing = { lastSentDate: TODAY };
  const { loadFleet, mutateFleet } = makeStore(initial);
  const diag = await runMorningBriefing({ env: ENABLED_ENV, now: new Date('2026-06-17T12:00:00Z'), force: true, loadFleet, mutateFleet, sendMessage: r.send, summarize: aiOk });
  assert.equal(diag.sent, 1);
  assert.equal(r.calls.length, 1);
});

// ── dry run ─────────────────────────────────────────────────────────────--
test('dry run returns preview and sends 0', async () => {
  const r = recorder();
  const { loadFleet, mutateFleet, state } = makeStore();
  const diag = await runMorningBriefing({ env: ENABLED_ENV, now: NOW, dryRun: true, loadFleet, mutateFleet, sendMessage: r.send, summarize: aiOk });
  assert.equal(diag.sent, 0);
  assert.equal(diag.code, MORNING_BRIEFING_CODES.DRY_RUN);
  assert.ok(diag.preview && diag.preview.length > 0, 'preview present');
  assert.equal(r.calls.length, 0, 'no send on dry run');
  assert.equal(state.fleet.morningBriefing, undefined, 'dry run does not persist state');
});

// ── AI behavior ─────────────────────────────────────────────────────────--
test('AI success adds summarized macro/business sections', async () => {
  const r = recorder();
  const { loadFleet, mutateFleet } = makeStore();
  const diag = await runMorningBriefing({ env: ENABLED_ENV, now: NOW, loadFleet, mutateFleet, sendMessage: r.send, summarize: aiOk });
  assert.equal(diag.aiUsed, true);
  const msg = r.calls[0].text;
  assert.ok(msg.includes('Rates steady'), 'macro summary present');
  assert.ok(msg.includes('ETF inflows'), 'business summary present');
});

test('AI failure sends degraded market-only briefing', async () => {
  const r = recorder();
  const { loadFleet, mutateFleet } = makeStore();
  const diag = await runMorningBriefing({ env: ENABLED_ENV, now: NOW, loadFleet, mutateFleet, sendMessage: r.send, summarize: aiFail });
  assert.equal(diag.sent, 1);
  assert.equal(diag.aiUsed, false);
  const msg = r.calls[0].text;
  assert.ok(msg.includes(MACRO_UNAVAILABLE), 'macro-unavailable line present');
  assert.ok(msg.includes('AI summary unavailable'), 'AI-unavailable note present');
  // Provider errors are surfaced but sanitized (no raw key, capped).
  assert.ok(diag.providerErrors.length >= 1);
});

// ── message content ─────────────────────────────────────────────────────--
test('message always includes the disclaimer', async () => {
  const data = dataFor();
  const msg = buildBriefingMessage({ data, dateStr: TODAY, ai: null, aiUsed: false });
  assert.ok(msg.includes(DISCLAIMER));
  assert.ok(msg.includes('Terminal-X Morning Market Briefing — 2026-06-17'));
});

test('message includes a coins-to-watch section with symbols', async () => {
  const data = dataFor();
  const msg = buildBriefingMessage({ data, dateStr: TODAY, ai: null, aiUsed: false });
  assert.ok(msg.includes('Coins to watch today'));
  assert.ok(/\b(FET|WIF|SOL|BAR|FOO)\b/.test(msg), 'at least one watch symbol present');
  assert.ok(data.coinCount > 0);
});

test('message includes RADAR blockers when there is no ENTRY_READY', async () => {
  const data = dataFor();
  assert.equal(data.radarSummary.entryReadyCount, 0);
  const msg = buildBriefingMessage({ data, dateStr: TODAY, ai: null, aiUsed: false });
  assert.ok(msg.includes('No confirmed ENTRY_READY'));
  assert.ok(msg.includes('Blocked by'), 'blockers line present when candidates are blocked');
});

test('briefing never labels a non-ENTRY_READY candidate as entry', async () => {
  const data = dataFor();
  const msg = buildBriefingMessage({ data, dateStr: TODAY, ai: null, aiUsed: false });
  // No candidate in the fixture is ENTRY_READY, so the ✅ entry-ready marker
  // must not appear.
  assert.ok(!msg.includes('ENTRY_READY ✅'));
});

// ── escaping ────────────────────────────────────────────────────────────--
test('Telegram HTML escaping works', () => {
  assert.equal(escapeHtml('<b>a & b>'), '&lt;b&gt;a &amp; b&gt;');
  // A candidate reason carrying angle brackets must be escaped in the message.
  const data = dataFor();
  const msg = buildBriefingMessage({ data, dateStr: TODAY, ai: null, aiUsed: false });
  assert.ok(!msg.includes('<sharp>'), 'raw angle-bracket text not present');
  assert.ok(msg.includes('&lt;sharp&gt;'), 'escaped form present');
});

test('parseAiBlocks tolerates label-free output', () => {
  assert.deepEqual(parseAiBlocks('MACRO: a\nBUSINESS: b\nTONE: c'), { macro: 'a', business: 'b', tone: 'c' });
  const blob = parseAiBlocks('just a paragraph with no labels');
  assert.equal(blob.macro, 'just a paragraph with no labels');
});

// ── gemini node helper ──────────────────────────────────────────────────--
test('buildModelChain honors env order and never empties', () => {
  const chain = buildModelChain({ GEMINI_MODEL_PRIMARY: 'm-primary', GEMINI_MODEL_FALLBACK: 'm-fallback' });
  assert.equal(chain[0], 'm-primary');
  assert.equal(chain[1], 'm-fallback');
  assert.ok(chain.length >= 3);
  assert.ok(buildModelChain({}).length >= 1);
});

test('sanitizeProviderBody strips keys', () => {
  assert.ok(!sanitizeProviderBody('error key=AIzaSECRET123456 detail').includes('AIzaSECRET'));
  assert.ok(!sanitizeProviderBody('{"key":"AIzaSECRET1234567890"}').includes('AIzaSECRET'));
});

test('summarizeBriefing degrades (no throw) without an API key', async () => {
  const res = await summarizeBriefing({}, { env: {}, fetchImpl: globalThis.fetch });
  assert.equal(res.ok, false);
  assert.ok(Array.isArray(res.providerErrors));
});

test('summarizeBriefing retries SAME model without grounding on a 400', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, hasTools: !!body.tools });
    if (body.tools) {
      return { ok: false, status: 400, text: async () => 'Unknown name "googleSearch"' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'MACRO: ok\nBUSINESS: ok\nTONE: ok' }] } }] }) };
  };
  const res = await summarizeBriefing({ x: 1 }, { env: { GEMINI_API_KEY: 'k' }, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.meta.groundingDisabled, true);
  assert.equal(res.meta.fallbackUsed, true);
  assert.equal(calls.length, 2, 'one grounded attempt + one stripped retry on same model');
});

// ── structural safety guards ────────────────────────────────────────────--
const fnSrc = fs.readFileSync(new URL('../netlify/functions/morning-briefing.mjs', import.meta.url), 'utf8');
const sharedSrc = fs.readFileSync(new URL('../scripts/briefing/morning-briefing.mjs', import.meta.url), 'utf8');

test('morning briefing does not enable any scanner BUY/FLUSH alert path', () => {
  // It must not import the RADAR alert sender nor define scanner alert sends.
  assert.ok(!fnSrc.includes("from './cron-alerts.mjs'"), 'does not import cron-alerts');
  assert.ok(!/sendScanner|sendBuyAlert|sendFlushAlert|FLUSH\+BUY/.test(fnSrc + sharedSrc));
});

test('morning briefing performs no order execution / worker calls', () => {
  const forbidden = /placeOrder|createOrder|executeOrder|binance.*order|live-?worker|executionIntent|orderExecution|terminal-v6/i;
  assert.ok(!forbidden.test(fnSrc), 'function file has no execution/worker references');
  assert.ok(!forbidden.test(sharedSrc), 'shared module has no execution/worker references');
});

test('RADAR ENTRY_READY Telegram gate is unchanged (still requires its own flag)', () => {
  // Fully-set briefing env must NOT make the RADAR gate pass.
  assert.equal(isTelegramHardDisabled({ ...ENABLED_ENV }), true);
  // RADAR gate still opens only on its own flag.
  assert.equal(isTelegramHardDisabled({ RADAR_TELEGRAM_ENABLED: 'true' }), false);
});

// ── data provenance / freshness (regression: 2026-08-01 stale briefing) ────
// On 2026-08-01 the 08:00 briefing reported "BTC +0.6% · ETH +0.5% · Regime
// SUPPORTIVE (score 70) · breadth 53% green" and a five-coin watchlist. Those
// numbers came from fleet.tradingRadar.marketRegime frozen at 2026-07-30T13:40Z
// (autoMarketSnapshot was null — the local worker had stopped on 2026-07-28);
// BTC's real 24h change at send time was -1.79%. Nothing in the message said how
// old the data was. These tests pin the behaviour that makes that impossible.

test('canonical context is preferred over the fleet blob', () => {
  const data = dataFor(fakeFleet(), NOW, fakeCanonical());
  assert.equal(data.freshness.source, MORNING_BRIEFING_DATA_SOURCES.CANONICAL);
  assert.equal(data.freshness.marketUsable, true);
  assert.equal(data.freshness.candidatesUsable, true);
  // BTC comes from the canonical ticker (-1.79), not the fleet regime (-2.1).
  assert.equal(data.marketPulse.btcChange, -1.79);
  assert.equal(data.marketPulse.ethChange, -1.69);
});

test('canonical spot+futures duplicates are counted once', () => {
  const data = dataFor(fakeFleet(), NOW, fakeCanonical());
  // 4 canonical rows, one of which is the futures duplicate of BTCUSDT.
  assert.equal(data.marketRowsUsed, 3);
  // Breadth is computed from those rows: 1 of 3 green.
  assert.equal(data.marketPulse.breadthPct, 33.3);
});

test('a frozen fleet state is NEVER rendered as current market numbers', () => {
  // Exactly the production state of 2026-08-01: no market snapshot at all, and a
  // regime block frozen two days earlier claiming BTC +0.58% / SUPPORTIVE.
  const fleet = {
    autoMarketSnapshot: null,
    radarContext: { receivedAt: '2026-07-30T13:40:01.685Z', scannerCandidates: [] },
    tradingRadar: {
      updatedAt: '2026-07-30T13:40:01.685Z',
      source: 'no_public_snapshot',
      marketRegime: {
        status: 'SUPPORTIVE', score: 70, breadthPct: 53,
        btc: { symbol: 'BTCUSDT', change24hPct: 0.58 },
        eth: { symbol: 'ETHUSDT', change24hPct: 0.5 },
        reasons: ['BTC not in active breakdown', 'breadth supportive enough'],
      },
      candidates: [
        { symbol: 'ZAMAUSDT', stage: 'STABILIZING', actionability: 'NEEDS_CONFIRMATION', distanceToEntryReadyScore: 70, safetyStatus: 'UNKNOWN', reasons: ['scanner context (score 7)'], diagnostics: { change24hPct: -10.87 } },
      ],
      entryReady: [],
      universeDiagnostics: {},
    },
  };
  const now = new Date('2026-08-01T06:02:22Z');
  const data = dataFor(fleet, now);
  assert.equal(data.freshness.marketUsable, false);
  assert.equal(data.freshness.marketReason, MORNING_BRIEFING_DATA_REASONS.NO_MARKET_SNAPSHOT);
  assert.equal(data.freshness.candidatesUsable, false);
  assert.equal(data.freshness.candidatesReason, MORNING_BRIEFING_DATA_REASONS.RADAR_STALE);
  // The withheld pulse must be UNKNOWN, not the frozen figures.
  assert.equal(data.marketPulse.btcChange, null);
  assert.equal(data.marketPulse.ethChange, null);
  assert.equal(data.marketPulse.breadthPct, null);
  assert.equal(data.marketPulse.regimeStatus, 'UNKNOWN');
  assert.equal(data.marketPulse.regimeScore, null);
  assert.equal(data.coinCount, 0, 'no watchlist from stale scanner context');
  assert.equal(data.radarSummary.candidateCount, 0);

  const msg = buildBriefingMessage({ data, dateStr: '2026-08-01', ai: null, aiUsed: false });
  assert.ok(!msg.includes('+0.6%'), 'stale BTC number must not appear');
  assert.ok(!msg.includes('+0.5%'), 'stale ETH number must not appear');
  assert.ok(!msg.includes('SUPPORTIVE'), 'stale regime must not appear');
  assert.ok(!msg.includes('53%'), 'stale breadth must not appear');
  assert.ok(!msg.includes('ZAMA'), 'stale watchlist symbol must not appear');
  assert.ok(msg.includes('BTC UNKNOWN'), 'pulse reported as UNKNOWN');
  assert.ok(msg.includes('PARTIAL BRIEFING'), 'partial-data banner present');
  assert.ok(msg.includes('Data provenance'), 'provenance section present');
  assert.ok(msg.includes('1 d 16 h'), 'RADAR context age stated');
  assert.ok(/DATA: market pulse withheld/.test(msg), 'withheld market data listed as a risk');
  assert.ok(/DATA: RADAR watchlist withheld/.test(msg), 'withheld watchlist listed as a risk');
});

test('every briefing states its data source and age', () => {
  const data = dataFor(fakeFleet(), NOW, fakeCanonical());
  const msg = buildBriefingMessage({ data, dateStr: TODAY, ai: null, aiUsed: false });
  assert.ok(msg.includes('Data provenance'));
  assert.ok(msg.includes('canonical context store'));
  assert.ok(/Market data: \d+ min old · observed 2026-06-17T05:58:00.000Z/.test(msg), 'market age + timestamp present');
  assert.ok(!msg.includes('PARTIAL BRIEFING'), 'no partial banner when everything is fresh');
});

test('stale canonical market data is withheld, not printed', () => {
  const stale = fakeCanonical({ observedAt: '2026-06-17T04:00:00Z', computedAt: '2026-06-17T04:00:10Z' });
  const data = dataFor({ autoMarketSnapshot: null, tradingRadar: {} }, NOW, stale);
  assert.equal(data.freshness.marketUsable, false);
  assert.equal(data.freshness.marketReason, MORNING_BRIEFING_DATA_REASONS.MARKET_STALE);
  assert.equal(data.freshness.candidatesReason, MORNING_BRIEFING_DATA_REASONS.RADAR_STALE);
  const msg = buildBriefingMessage({ data, dateStr: TODAY, ai: null, aiUsed: false });
  assert.ok(msg.includes('BTC UNKNOWN'));
  assert.ok(msg.includes('market data is 2 h old'), 'explicit age in the reason');
});

test('a PENDING canonical RADAR withholds the watchlist but keeps the market pulse', () => {
  const pending = fakeCanonical({ status: 'PENDING' });
  const data = dataFor(fakeFleet(), NOW, pending);
  assert.equal(data.freshness.source, MORNING_BRIEFING_DATA_SOURCES.CANONICAL);
  assert.equal(data.freshness.marketUsable, true);
  assert.equal(data.freshness.candidatesUsable, false);
  assert.equal(data.freshness.candidatesReason, MORNING_BRIEFING_DATA_REASONS.RADAR_PENDING);
  const msg = buildBriefingMessage({ data, dateStr: TODAY, ai: null, aiUsed: false });
  assert.ok(msg.includes('BTC -1.8%'), 'fresh pulse still shown');
  assert.ok(msg.includes('Candidates tracked: UNKNOWN'));
  assert.ok(msg.includes('not as an all-clear'));
});

test('a failed canonical read falls back to the fleet ONLY when the fleet is fresh, and says so', () => {
  const data = dataFor(fakeFleet(), NOW, { ok: false, reason: 'DB_UNAVAILABLE' });
  assert.equal(data.freshness.source, MORNING_BRIEFING_DATA_SOURCES.FLEET);
  assert.equal(data.freshness.marketUsable, true, 'fixture snapshot is 1 min old');
  const msg = buildBriefingMessage({ data, dateStr: TODAY, ai: null, aiUsed: false });
  assert.ok(msg.includes('legacy fleet snapshot'), 'fallback source is labelled');
  assert.ok(msg.includes('canonical read failed: DB_UNAVAILABLE'), 'canonical failure surfaced in risks');
});

test('mapCanonicalCandidate never promotes a payload to ENTRY_READY', () => {
  const rows = fakeCanonical().radar.candidates;
  const foo = mapCanonicalCandidate(rows[1]);
  assert.equal(foo.symbol, 'FOOUSDT');
  assert.notEqual(foo.actionability, 'ENTRY_READY', 'payload claim ignored when entry_ready=false');
  const ready = mapCanonicalCandidate({ symbol: 'BARUSDT', entry_ready: true, status: 'ENTRY_READY', payload: { symbol: 'BARUSDT' } });
  assert.equal(ready.actionability, 'ENTRY_READY');
});

test('mapCanonicalTicker keeps missing values null (never 0)', () => {
  const row = mapCanonicalTicker({ market: 'spot', symbol: 'xyzusdt', price_change_percent: null, quote_volume: null, last_price: '1.5' });
  assert.equal(row.symbol, 'XYZUSDT');
  assert.equal(row.priceChangePercent, null);
  assert.equal(row.quoteVolume, null);
  assert.equal(row.lastPrice, 1.5);
  assert.equal(mapCanonicalTicker(null), null);
});

test('AI context carries freshness and hides withheld numbers', () => {
  const fresh = buildAiContext(dataFor(fakeFleet(), NOW, fakeCanonical()));
  assert.equal(fresh.data_freshness.market_data_usable, true);
  assert.equal(fresh.market_pulse.btc_change_24h, -1.79);

  const withheld = buildAiContext(dataFor({ autoMarketSnapshot: null, tradingRadar: {} }, NOW));
  assert.equal(withheld.market_pulse, null, 'no numbers handed to the model');
  assert.equal(withheld.radar, null);
  assert.equal(withheld.data_freshness.market_data_usable, false);
  assert.equal(withheld.data_freshness.market_data_withheld_reason, MORNING_BRIEFING_DATA_REASONS.NO_MARKET_SNAPSHOT);
});

test('the AI prompt forbids narrating withheld market data', () => {
  const geminiSrc = fs.readFileSync(new URL('../scripts/briefing/gemini-node.mjs', import.meta.url), 'utf8');
  assert.ok(geminiSrc.includes('data_freshness'), 'prompt references the freshness block');
  assert.ok(/market_data_usable is false/.test(geminiSrc), 'prompt states the withheld-data rule');
});

test('freshness bound is env-tunable and defaults to 15 minutes', () => {
  assert.equal(maxDataAgeMs({}), DEFAULT_MAX_DATA_AGE_MS);
  assert.equal(maxDataAgeMs({}), 15 * 60 * 1000);
  assert.equal(maxDataAgeMs({ MORNING_BRIEFING_MAX_DATA_AGE_MIN: '45' }), 45 * 60 * 1000);
  assert.equal(maxDataAgeMs({ MORNING_BRIEFING_MAX_DATA_AGE_MIN: 'nonsense' }), DEFAULT_MAX_DATA_AGE_MS);
  // A wider bound makes an older state usable again — but only explicitly.
  const stale = fakeCanonical({ observedAt: '2026-06-17T04:00:00Z', computedAt: '2026-06-17T04:00:00Z' });
  const data = dataFor(fakeFleet(), NOW, stale, { MORNING_BRIEFING_MAX_DATA_AGE_MIN: '180' });
  assert.equal(data.freshness.marketUsable, true);
});

test('fmtAge renders minutes / hours / days', () => {
  assert.equal(fmtAge(30 * 1000), 'under 1 min');
  assert.equal(fmtAge(4 * 60 * 1000), '4 min');
  assert.equal(fmtAge(3 * 3600 * 1000 + 12 * 60 * 1000), '3 h 12 min');
  assert.equal(fmtAge(2 * 86400 * 1000 + 3600 * 1000), '2 d 1 h');
  assert.equal(fmtAge(null), 'unknown age');
});

test('runMorningBriefing reports data provenance in its diagnostics', async () => {
  const r = recorder();
  const { loadFleet, mutateFleet } = makeStore();
  const diag = await runMorningBriefing({
    env: ENABLED_ENV, now: NOW, loadFleet, mutateFleet, sendMessage: r.send,
    loadMarketContext: async () => fakeCanonical(),
  });
  assert.equal(diag.sent, 1);
  assert.equal(diag.dataSource, MORNING_BRIEFING_DATA_SOURCES.CANONICAL);
  assert.equal(diag.marketDataUsable, true);
  assert.equal(diag.radarDataUsable, true);
  assert.ok(diag.marketDataAgeMs >= 0);
});

test('a throwing canonical read never crashes the briefing', async () => {
  const r = recorder();
  const { loadFleet, mutateFleet } = makeStore();
  const diag = await runMorningBriefing({
    env: ENABLED_ENV, now: NOW, loadFleet, mutateFleet, sendMessage: r.send,
    loadMarketContext: async () => { throw new Error('boom'); },
  });
  assert.equal(diag.sent, 1, 'still sends, on the labelled fallback');
  assert.equal(diag.dataSource, MORNING_BRIEFING_DATA_SOURCES.FLEET);
  assert.ok(diag.providerErrors.some((e) => /market context read failed/.test(e)), 'failure is reported, not swallowed');
});

test('the netlify function reads the canonical store and logs provenance', () => {
  assert.ok(fnSrc.includes('_market-context-store.mjs'), 'canonical store imported');
  assert.ok(fnSrc.includes('loadMarketContext'), 'canonical read injected');
  assert.ok(/console\.warn\('\[morning-briefing\] canonical_context/.test(fnSrc), 'canonical failure logged');
  assert.ok(/data source=\$\{diag\.dataSource\}/.test(fnSrc), 'provenance logged on every run');
});

test('an empty MORNING_BRIEFING_HOUR_LOCAL keeps the 08:00 default, not midnight', async () => {
  // Number('') === 0, so an env var set to an empty value in the Netlify UI would have
  // moved the briefing to 00:00 local time.
  const r = recorder();
  const { loadFleet, mutateFleet } = makeStore();
  for (const raw of ['', '   ', 'nonsense', null, undefined, '25', '-1', '8.5']) {
    const diag = await runMorningBriefing({
      env: { ...ENABLED_ENV, MORNING_BRIEFING_HOUR_LOCAL: raw }, now: NOW, dryRun: true,
      loadFleet, mutateFleet, sendMessage: r.send,
    });
    assert.equal(diag.targetHour, 8, `raw ${JSON.stringify(raw)} falls back to 08:00`);
  }
  const explicit = await runMorningBriefing({
    env: { ...ENABLED_ENV, MORNING_BRIEFING_HOUR_LOCAL: '6' }, now: NOW, dryRun: true,
    loadFleet, mutateFleet, sendMessage: r.send,
  });
  assert.equal(explicit.targetHour, 6, 'a real hour still overrides');
});

// ── scheduled-invocation contract (observed live 2026-08-02) ─────────────────
// Every scheduled run ended in "Function returned an unsupported value. Accepted
// types are 'Response' or 'undefined'" AFTER doing its work: the handler returned the
// diagnostics object. A healthy briefing was therefore recorded as a failed
// invocation. Every other scheduled function in the repo returns a Response.
test('the scheduled invocation returns a Response, not a bare object', async () => {
  const mod = await import('../netlify/functions/morning-briefing.mjs');
  const res = await mod.default(new Request('https://example.test/.netlify/functions/morning-briefing'));
  assert.ok(res instanceof Response, 'the runtime only accepts a Response or undefined');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.code, MORNING_BRIEFING_CODES.DISABLED_BY_ENV, 'and it still carries the diagnostics');
});

test('provenance is logged as "not evaluated" when the run stopped at a gate', () => {
  // Printing marketUsable=false for a run that never looked at any data reports a
  // measurement that was never taken.
  assert.match(fnSrc, /data provenance not evaluated \(stopped at a gate/);
  assert.match(fnSrc, /if \(diag\.dataSource === null\)/);
});

// ── spot-only mandate (regression: 2026-08-02 briefing) ─────────────────────
// Pointing the briefing at the canonical context brought FUTURES rows into its
// universe. That morning 11 of the 16 coins it named — the whole "strongest
// momentum" group and two of the three "closest to entry" — were futures-only
// listings this spot-only desk cannot buy. A suggestion that cannot be acted on is
// worse than no suggestion.
function venueCanonical() {
  const c = fakeCanonical();
  c.market.tickers = [
    { market: 'spot', symbol: 'BTCUSDT', base_asset: 'BTC', quote_asset: 'USDT', last_price: '63000', price_change_percent: '0.7', quote_volume: '500000000' },
    { market: 'spot', symbol: 'GIGGLEUSDT', base_asset: 'GIGGLE', quote_asset: 'USDT', last_price: '2', price_change_percent: '12.0', quote_volume: '90000000' },
    // Futures-only listings: no spot row anywhere, big moves and big volume.
    { market: 'futures', symbol: '1000RATSUSDT', base_asset: '1000RATS', quote_asset: 'USDT', last_price: '0.1', price_change_percent: '58.4', quote_volume: '485000000' },
    { market: 'futures', symbol: 'AKEUSDT', base_asset: 'AKE', quote_asset: 'USDT', last_price: '1', price_change_percent: '3.0', quote_volume: '592000000' },
  ];
  c.radar.candidates = [
    { market: 'spot', symbol: 'GIGGLEUSDT', status: 'STABILIZING', entry_ready: false, setup_score: 79, computed_at: c.radar.computedAt,
      payload: { symbol: 'GIGGLEUSDT', stage: 'STABILIZING', safetyStatus: 'SAFE', distanceToEntryReadyScore: 79, reasons: ['base forming'] } },
    { market: 'futures', symbol: 'AKEUSDT', status: 'STABILIZING', entry_ready: false, setup_score: 76, computed_at: c.radar.computedAt,
      payload: { symbol: 'AKEUSDT', stage: 'STABILIZING', safetyStatus: 'SAFE', distanceToEntryReadyScore: 76, reasons: ['base forming'] } },
  ];
  return c;
}

test('a futures-only listing is never suggested to a spot-only desk', () => {
  const data = dataFor(fakeFleet(), NOW, venueCanonical());
  const named = data.coinGroups.flatMap((g) => g.rows.map((r) => r.display));
  assert.ok(named.includes('BTC') || named.includes('GIGGLE'), 'spot coins are still suggested');
  assert.ok(!named.includes('1000RATS'), 'the biggest mover is futures-only → not suggested');
  assert.ok(!named.includes('AKE'), 'the biggest volume is futures-only → not suggested');
  // The RADAR watchlist and "closest to entry" obey the same rule.
  assert.deepEqual(data.radarSummary.topClosest.map((t) => t.display), ['GIGGLE']);
  const msg = buildBriefingMessage({ data, dateStr: TODAY, ai: null, aiUsed: false });
  assert.ok(!msg.includes('1000RATS'));
  assert.ok(!/\bAKE\b/.test(msg));
});

test('the exclusion is stated, never a silently shorter list', () => {
  const data = dataFor(fakeFleet(), NOW, venueCanonical());
  assert.equal(data.freshness.venueFiltered, true);
  assert.equal(data.freshness.excludedFuturesOnlyMarkets, 2);
  assert.equal(data.freshness.excludedFuturesOnlyCandidates, 1);
  const msg = buildBriefingMessage({ data, dateStr: TODAY, ai: null, aiUsed: false });
  assert.match(msg, /Spot-only desk: 2 market row\(s\) and 1 RADAR candidate\(s\) excluded as futures-only listings/);
});

test('a coin listed on BOTH venues stays eligible even when scored on futures', () => {
  const c = venueCanonical();
  // BTC has a spot row; a futures candidate for it must still be allowed through.
  c.radar.candidates.push({ market: 'futures', symbol: 'BTCUSDT', status: 'STABILIZING', entry_ready: false, setup_score: 70, computed_at: c.radar.computedAt,
    payload: { symbol: 'BTCUSDT', stage: 'STABILIZING', safetyStatus: 'SAFE', distanceToEntryReadyScore: 70, reasons: ['base forming'] } });
  const data = dataFor(fakeFleet(), NOW, c);
  assert.ok(data.radarSummary.topClosest.some((t) => t.display === 'BTC'), 'dual-listed coins are tradable on spot');
});

test('the legacy fleet path is unaffected — rows without a venue are all eligible', () => {
  const data = dataFor(fakeFleet(), NOW);
  assert.equal(data.freshness.venueFiltered, false, 'no venue information → no filtering');
  assert.equal(data.freshness.excludedFuturesOnlyMarkets, 0);
  assert.ok(data.coinCount > 0, 'the spot-only fleet snapshot still produces a watchlist');
});

test('the same coin is never listed twice under two quote pairs', () => {
  // HOMEUSDT and HOMEUSDC are different symbols but the line renders the base asset,
  // so keying the dedupe on the full symbol printed "HOME" twice with two numbers.
  const c = fakeCanonical();
  c.market.tickers = [
    { market: 'spot', symbol: 'HOMEUSDT', base_asset: 'HOME', quote_asset: 'USDT', last_price: '1', price_change_percent: '31.2', quote_volume: '9000000' },
    { market: 'spot', symbol: 'HOMEUSDC', base_asset: 'HOME', quote_asset: 'USDC', last_price: '1', price_change_percent: '31.0', quote_volume: '8000000' },
    { market: 'spot', symbol: 'FRONTUSDT', base_asset: 'FRONT', quote_asset: 'USDT', last_price: '1', price_change_percent: '26.0', quote_volume: '7000000' },
  ];
  c.radar.candidates = [];
  const data = dataFor(fakeFleet(), NOW, c);
  const named = data.coinGroups.flatMap((g) => g.rows.map((r) => r.display));
  assert.deepEqual(named.filter((x) => x === 'HOME').length, 1, 'one line per coin');
  assert.ok(named.includes('FRONT'), 'the next distinct coin takes the freed slot');
});
