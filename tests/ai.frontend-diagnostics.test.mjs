// ─────────────────────────────────────────────────────────────
// AI frontend diagnostics + scanner/RADAR isolation guards
//
//   • the AI modal renders model + fallback + sanitized provider
//     error (no raw JSON dump, no generic "Chyba"-only path)
//   • scanner / RADAR share NO code with the Gemini orchestrator, so
//     an AI failure can never take them down
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { evaluateTradingRadar } from '../scripts/radar/trading-radar.mjs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('AI modal surfaces model + fallback + provider diagnostics', () => {
  const js = read('../apps/edge/public/js/ai-analysis.js');
  // fallback / grounding diagnostics in the meta line
  assert.match(js, /Using fallback model/);
  assert.match(js, /m\.fallback_used/);
  assert.match(js, /m\.grounding_disabled/);
  // structured 502 error: model attempted, tried models, fallback, provider error, next action
  assert.match(js, /error\?\.model/);
  assert.match(js, /tried_models/);
  assert.match(js, /Fallback:/);
  assert.match(js, /provider_error/);
  assert.match(js, /Další krok/);
});

test('edge AI error payloads carry sanitized provider diagnostics', () => {
  const analyze = read('../apps/edge/netlify/edge-functions/analyze.js');
  assert.match(analyze, /provider_error/);
  assert.match(analyze, /reason_code/);
  assert.match(analyze, /fallback_used/);
  const briefing = read('../apps/edge/netlify/edge-functions/briefing.js');
  assert.match(briefing, /provider_error/);
  assert.match(briefing, /reason_code/);
});

test('scanner/RADAR keep working independent of the AI/Gemini layer', () => {
  // 1. Source-level proof of isolation: RADAR never imports the orchestrator.
  const radarSrc = read('../scripts/radar/trading-radar.mjs');
  assert.doesNotMatch(radarSrc, /orchestrator/i);
  assert.doesNotMatch(radarSrc, /gemini/i);
  assert.doesNotMatch(radarSrc, /generateContent/i);

  // 2. Behavioral proof: RADAR renders candidates with zero AI involvement.
  const state = evaluateTradingRadar({
    markets: [
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 900e6, bidPrice: 70000, askPrice: 70001, spreadPct: 0.01, depthUsdWithin1Pct: 5e6, change24hPct: 1 },
      { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 700e6, bidPrice: 3500, askPrice: 3501, spreadPct: 0.01, depthUsdWithin1Pct: 4e6, change24hPct: 0.8 },
    ],
    now: Date.now(),
  });
  assert.ok(state && Array.isArray(state.candidates));
});

// ─────────────────────────────────────────────────────────────
// Native accounts must be able to use AI.
//
// Regression guard for the reported failure: with NATIVE_AUTH_ENABLED=true an
// account created in the admin panel has NO Supabase session at all. This file
// used to read `window.__supabase.auth.getSession()` directly, so every AI
// action for such a user died client-side with 401 "Neautorizovaný přístup" —
// and the 401 branch then reloaded the page, bouncing them back to the login
// gate. The scanner, RADAR and admin panel worked the whole time, because they
// resolve the token through AuthClient.
// ─────────────────────────────────────────────────────────────
test('the AI client resolves its token through AuthClient (both identity sources)', () => {
  const js = read('../apps/edge/public/js/ai-analysis.js');

  const tokenFn = js.slice(js.indexOf('async function getAccessToken'), js.indexOf('function _reportNoSession'));
  assert.ok(tokenFn.length > 0, 'getAccessToken() must still exist');
  assert.match(tokenFn, /window\.AuthClient/, 'AuthClient must be the primary token source');
  assert.ok(
    tokenFn.indexOf('window.AuthClient') < tokenFn.indexOf('__supabase'),
    'Supabase must only be the fallback, never the first (or only) source',
  );
});

test('a missing token neither loops the page nor hides the reason', () => {
  const js = read('../apps/edge/public/js/ai-analysis.js');

  // Every "no token" path must be logged + recorded, not just drawn.
  assert.equal((js.match(/_reportNoSession\(\);/g) || []).length, 3,
    'all three AI entry points (analysis, briefing, market briefing) must report a missing session');
  assert.match(js, /reload: false/, 'a locally-detected missing token must not schedule a page reload');

  // A server 401 may reload ONCE per page, never in a loop.
  assert.match(js, /_reloadScheduled/);
  assert.match(js, /if \(opts\.reload === false \|\| _reloadScheduled\)/);
});
