// Source guards for the market-wide funding CONTEXT block added to the
// /api/funding-divergence edge function (M2). The endpoint is not Node-importable
// (its ./lib/security.js pulls an https:// module), so these are text guards.
// They prove the context block is additive, context-only, and never touches the
// divergence-signal classification, a signed/order endpoint, or Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(
  new URL('../apps/edge/netlify/edge-functions/funding-divergence.js', import.meta.url),
  'utf8',
);

test('funding-divergence attaches a context-only funding_context block', () => {
  assert.match(src, /function buildFundingContext\(/);
  assert.match(src, /funding_context: buildFundingContext\(premiumData, tickerByPair\)/);
  assert.match(src, /context_only: true/);
  assert.match(src, /top_positive/);
  assert.match(src, /top_negative/);
  // USDⓈ-M perps only; dated/quarterly futures skipped.
  assert.match(src, /pair\.includes\('_'\)/);
  assert.match(src, /\(USDT\|USDC\)\$/);
});

test('funding-divergence signal classification is untouched by the context block', () => {
  // The trap classifier and signal push must still be present and unchanged.
  assert.match(src, /const decision = classify\(fundingPct, priceChangePct\)/);
  assert.match(src, /if \(!decision\) continue;/);
  assert.match(src, /signals\.push\(/);
  for (const s of ['SHORTS_TRAPPED', 'LONGS_TRAPPED', 'CROWDED_LONG']) assert.match(src, new RegExp(s));
  // funding_context must NOT be spread into or merged with the signals array.
  assert.doesNotMatch(src, /signals\.push\([^)]*funding_context/);
});

test('funding-divergence context block introduces no signed/order/Telegram path', () => {
  // buildFundingContext reuses already-fetched data — no new fetch, no signing.
  assert.doesNotMatch(src, /signature/i);
  assert.doesNotMatch(src, /\/order|\/sapi|\/dapi/);
  assert.doesNotMatch(src, /timestamp=|apikey/i);
  // No Telegram SEND path (the safety-note comment mentioning "Telegram" is fine).
  assert.doesNotMatch(src, /sendTelegram|api\.telegram\.org|TELEGRAM_BOT|sendMessage\(/i);
  assert.doesNotMatch(src, /coinee/i);
  // still exactly the two public bulk endpoints it already used
  assert.match(src, /fapi\.binance\.com\/fapi\/v1\/premiumIndex/);
  assert.match(src, /fapi\.binance\.com\/fapi\/v1\/ticker\/24hr/);
});
