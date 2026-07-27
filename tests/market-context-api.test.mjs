import test from 'node:test';
import assert from 'node:assert/strict';
import { runContextRead } from '../netlify/functions/context.mjs';
function request(method = 'GET') { return new Request('https://example.test/api/context', { method, headers: { Origin: 'https://example.test' } }); }
test('context API rejects missing identity before database work', async () => { const response = await runContextRead(request(), { getIdentity: async () => ({ ok: false }) }); assert.equal(response.status, 401); assert.equal((await response.json()).reason, 'UNAUTHENTICATED'); });
test('context API returns the atomized read envelope without writes', async () => { const envelope = { ok: true, contextVersion: null, run: { id: 5 }, market: { observedAt: '2026-07-24T12:00:00.000Z', freshness: 'FRESH', tickers: [], microstructure: [], dataQuality: {} }, radar: { status: 'PENDING' } }; const response = await runContextRead(request(), { getIdentity: async () => ({ ok: true, verified: true }), store: { getAtomizedMarketContext: async () => envelope }, database: {} }); assert.equal(response.status, 200); assert.deepEqual(await response.json(), envelope); });
test('context API is GET-only before authentication or database work', async () => { const response = await runContextRead(request('POST'), { getIdentity: async () => { throw new Error('must not run'); } }); assert.equal(response.status, 405); });
// ── the scheduled path's 30s ceiling must not fail silently ──────────────────
// Netlify kills a scheduled function at 30s with no error, no log and no partial write,
// so an oversized cycle simply never publishes and the terminal freezes on its last good
// run -- indistinguishable from a market that did not move. Observed live: a 161-second
// cycle against the 30-second ceiling, data frozen for 36 minutes.
test('an oversized cycle is refused up front with the flag that fixes it', async () => {
  const mod = await import('../netlify/functions/market-context-collect-scheduled.mjs');
  const saved = { ...process.env };
  Object.assign(process.env, {
    MARKET_CONTEXT_BACKGROUND_ENABLED: '',
    MARKET_CONTEXT_COLLECT_ENABLED: 'true',
    MARKET_CONTEXT_MICROSTRUCTURE_TOP_N: '200',
    MARKET_CONTEXT_MULTI_TF_ENABLED: 'true',
    MARKET_CONTEXT_MULTI_TF_TOP_N: '500',
    MARKET_CONTEXT_FUTURES_ENABLED: 'true',
    MARKET_CONTEXT_FUTURES_MICROSTRUCTURE_TOP_N: '20',
  });
  try {
    const res = await mod.default();
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'CYCLE_EXCEEDS_SCHEDULED_CEILING');
    assert.ok(body.projectedPacingMs > body.ceilingMs, 'the projection and the ceiling are both reported');
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test('a cycle that fits is not refused, and the background path is never bounded by 30s', async () => {
  const { estimateCyclePacingMs, SCHEDULED_FUNCTION_CEILING_MS } = await import('../netlify/functions/_binance-market-context-source.mjs');
  // The shipped conservative defaults must remain runnable inline.
  const minimal = estimateCyclePacingMs({ microstructureTopN: 5, futuresMicrostructureTopN: 20, multiTimeframeSymbols: 300, includeFutures: false, includeMultiTimeframe: false });
  assert.equal(minimal.totalMs, 0);
  assert.ok(minimal.totalMs <= SCHEDULED_FUNCTION_CEILING_MS);
  // Futures weight is only counted when futures is actually enabled.
  const noFutures = estimateCyclePacingMs({ microstructureTopN: 200, futuresMicrostructureTopN: 200, includeFutures: false });
  assert.equal(noFutures.futuresWeight, 0);
  // And a futures symbol is priced at its real 27, not the spot 9.
  const withFutures = estimateCyclePacingMs({ futuresMicrostructureTopN: 10, includeFutures: true });
  assert.equal(withFutures.futuresWeight, 270);
});
