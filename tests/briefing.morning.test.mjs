import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  runMorningBriefing,
  buildBriefingMessage,
  gatherBriefingData,
  parseAiBlocks,
  isMorningBriefingHardDisabled,
  localDayString,
  localHour,
  escapeHtml,
  MORNING_BRIEFING_CODES,
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
  const data = gatherBriefingData(fakeFleet());
  const msg = buildBriefingMessage({ data, dateStr: TODAY, ai: null, aiUsed: false });
  assert.ok(msg.includes(DISCLAIMER));
  assert.ok(msg.includes('Terminal-X Morning Market Briefing — 2026-06-17'));
});

test('message includes a coins-to-watch section with symbols', async () => {
  const data = gatherBriefingData(fakeFleet());
  const msg = buildBriefingMessage({ data, dateStr: TODAY, ai: null, aiUsed: false });
  assert.ok(msg.includes('Coins to watch today'));
  assert.ok(/\b(FET|WIF|SOL|BAR|FOO)\b/.test(msg), 'at least one watch symbol present');
  assert.ok(data.coinCount > 0);
});

test('message includes RADAR blockers when there is no ENTRY_READY', async () => {
  const data = gatherBriefingData(fakeFleet());
  assert.equal(data.radarSummary.entryReadyCount, 0);
  const msg = buildBriefingMessage({ data, dateStr: TODAY, ai: null, aiUsed: false });
  assert.ok(msg.includes('No confirmed ENTRY_READY'));
  assert.ok(msg.includes('Blocked by'), 'blockers line present when candidates are blocked');
});

test('briefing never labels a non-ENTRY_READY candidate as entry', async () => {
  const data = gatherBriefingData(fakeFleet());
  const msg = buildBriefingMessage({ data, dateStr: TODAY, ai: null, aiUsed: false });
  // No candidate in the fixture is ENTRY_READY, so the ✅ entry-ready marker
  // must not appear.
  assert.ok(!msg.includes('ENTRY_READY ✅'));
});

// ── escaping ────────────────────────────────────────────────────────────--
test('Telegram HTML escaping works', () => {
  assert.equal(escapeHtml('<b>a & b>'), '&lt;b&gt;a &amp; b&gt;');
  // A candidate reason carrying angle brackets must be escaped in the message.
  const data = gatherBriefingData(fakeFleet());
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
