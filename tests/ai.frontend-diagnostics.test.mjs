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
