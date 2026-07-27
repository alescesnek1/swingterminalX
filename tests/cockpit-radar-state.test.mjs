import test from 'node:test';
import assert from 'node:assert/strict';
import { runCockpitRadarStateRead } from '../netlify/functions/cockpit-radar-state.mjs';

const NOW = Date.now();
const verified = { getIdentity: async () => ({ ok: true, verified: true, userId: 'u1' }) };

function request(query = 'symbol=BTCUSDT', method = 'GET') {
  return new Request(`https://example.test/api/cockpit-radar-state?${query}`, { method, headers: { origin: 'https://example.test' } });
}
function stateRow(overrides = {}) {
  return {
    market: 'spot', symbol: 'BTCUSDT', status: 'EARLY_ENTRY_READY', entry_type: 'EARLY_REVERSAL', entry_ready: true,
    computed_at: new Date(NOW - 60_000), observed_at: new Date(NOW - 120_000),
    setup_score: 74, execution_score: 68, risk_reward_score: 72, market_regime_score: 61, confidence: 69,
    dislocation_score: 80, flush_score: 70, stabilization_score: 60, reclaim_score: 65,
    order_book_support_score: 70, flow_confirmation_score: 66, derivatives_risk_score: 55,
    reclaim_status: 'RECLAIM_CONFIRMED', absorb_status: 'ABSORB_CONFIRMED', absorb_mode: 'STRICT',
    strict_absorb_status: 'ABSORB_CONFIRMED', strict_absorb_score: 71, strict_absorb_confirmed: true,
    entry_zone_low: 0.285, entry_zone_high: 0.315, stop_loss: 0.238, hard_invalidation: 0.22,
    tp1_level: 0.4, tp2_level: 0.53, tp3_level: 0.71,
    position_size_pct_low: 25, position_size_pct_high: 40, position_size_guidance: '25-40% planned position',
    timeframe_context: '1D setup, 1H/15M execution', time_validity: 'valid until next 1H close',
    data_status: 'ready', missing_inputs: ['OPEN_INTEREST'],
    ...overrides,
  };
}
function storeWith(state, capture = {}) {
  return { getRadarCandidateState: async (_db, symbol, options) => { capture.symbol = symbol; capture.options = options; return { ok: true, state }; } };
}
const database = {};

// ── auth + method boundaries, before any database work ──────────────────────
test('OPTIONS preflight is answered without touching auth or the database', async () => {
  const res = await runCockpitRadarStateRead(request('symbol=BTCUSDT', 'OPTIONS'), {
    getIdentity: async () => { throw new Error('auth must not run'); },
    loadStore: async () => { throw new Error('store must not load'); },
  });
  assert.equal(res.status, 204);
});

test('a non-GET method is rejected', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await runCockpitRadarStateRead(request('symbol=BTCUSDT', method), verified);
    assert.equal(res.status, 405);
    assert.equal((await res.json()).reason, 'METHOD_NOT_ALLOWED');
  }
});

test('an unverified or failing identity is 401 and never reaches the store', async () => {
  const guard = { loadStore: async () => { throw new Error('store must not load'); } };
  const decodeOnly = await runCockpitRadarStateRead(request(), { ...guard, getIdentity: async () => ({ ok: true, verified: false }) });
  assert.equal(decodeOnly.status, 401);
  const rejected = await runCockpitRadarStateRead(request(), { ...guard, getIdentity: async () => ({ ok: false }) });
  assert.equal(rejected.status, 401);
  const threw = await runCockpitRadarStateRead(request(), { ...guard, getIdentity: async () => { throw new Error('bad token'); } });
  assert.equal(threw.status, 401);
  // An auth module that cannot even be imported must fail closed, not open.
  const noAuth = await runCockpitRadarStateRead(request(), { ...guard, loadAuth: async () => { throw new Error('missing'); } });
  assert.equal(noAuth.status, 401);
});

// ── input validation happens before the database ────────────────────────────
test('a missing or malformed symbol is a 400, not a database error', async () => {
  const guard = { ...verified, loadStore: async () => { throw new Error('store must not load'); } };
  for (const query of ['', 'symbol=', 'symbol=!!!', 'symbol=B', 'symbol=BTC-USDT', 'symbol=' + 'A'.repeat(33)]) {
    const res = await runCockpitRadarStateRead(request(query), guard);
    assert.equal(res.status, 400, `${query} is refused`);
    assert.equal((await res.json()).reason, 'INVALID_SYMBOL');
  }
});

test('symbol is normalised and an unknown market filter is ignored rather than trusted', async () => {
  const capture = {};
  await runCockpitRadarStateRead(request('symbol=btcusdt&market=margin'), { ...verified, store: storeWith(stateRow(), capture), database });
  assert.equal(capture.symbol, 'BTCUSDT');
  assert.equal(capture.options.market, undefined, 'an unsupported venue is dropped, never passed through');
  const spot = {};
  await runCockpitRadarStateRead(request('symbol=BTCUSDT&market=futures'), { ...verified, store: storeWith(stateRow(), spot), database });
  assert.equal(spot.options.market, 'futures');
});

// ── the answer itself ───────────────────────────────────────────────────────
test('a scored coin returns its scores, reclaim, absorb and full trade plan', async () => {
  const res = await runCockpitRadarStateRead(request(), { ...verified, store: storeWith(stateRow()), database });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.found, true);
  assert.equal(body.state.status, 'EARLY_ENTRY_READY');
  assert.equal(body.state.entryReady, true);
  assert.equal(body.state.scores.setup, 74);
  assert.equal(body.state.scores.execution, 68);
  assert.equal(body.state.reclaim.status, 'RECLAIM_CONFIRMED');
  assert.equal(body.state.absorb.strictConfirmed, true);
  assert.equal(body.state.plan.entryZoneLow, 0.285);
  assert.equal(body.state.plan.stopLoss, 0.238);
  assert.equal(body.state.plan.tp3, 0.71);
  assert.equal(body.state.plan.positionSizePctHigh, 40);
  assert.deepEqual(body.state.missingInputs, ['OPEN_INTEREST']);
});

test('freshness is reported, so an old verdict can never be shown as current', async () => {
  const fresh = await runCockpitRadarStateRead(request(), { ...verified, store: storeWith(stateRow()), database });
  assert.equal((await fresh.json()).state.freshness, 'FRESH');
  // Older than two collector cycles.
  const old = await runCockpitRadarStateRead(request(), { ...verified, store: storeWith(stateRow({ computed_at: new Date(NOW - 20 * 60_000) })), database });
  const oldBody = await old.json();
  assert.equal(oldBody.state.freshness, 'STALE');
  assert.ok(oldBody.state.ageMs > 6 * 60 * 1000);
  // An unusable timestamp is UNKNOWN, never silently treated as fresh.
  const broken = await runCockpitRadarStateRead(request(), { ...verified, store: storeWith(stateRow({ computed_at: null })), database });
  const brokenBody = await broken.json();
  assert.equal(brokenBody.state.freshness, 'UNKNOWN');
  assert.equal(brokenBody.state.ageMs, null);
});

test('a missing score stays null so the client renders UNKNOWN, never a zero', async () => {
  const bare = stateRow({ setup_score: null, execution_score: null, stop_loss: null, tp1_level: null, position_size_pct_low: null });
  const res = await runCockpitRadarStateRead(request(), { ...verified, store: storeWith(bare), database });
  const body = await res.json();
  assert.equal(body.state.scores.setup, null);
  assert.equal(body.state.scores.execution, null);
  assert.equal(body.state.plan.stopLoss, null);
  assert.equal(body.state.plan.tp1, null);
  assert.equal(body.state.plan.positionSizePctLow, null);
});

test('an unscored coin is a distinguishable 404 NOT_SCORED, not an empty verdict', async () => {
  const res = await runCockpitRadarStateRead(request('symbol=NEWUSDT'), { ...verified, store: storeWith(null), database });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.found, false);
  assert.equal(body.reason, 'NOT_SCORED');
  assert.equal('state' in body, false);
});

test('a database failure is a 503 with a reason, never a fabricated verdict', async () => {
  const res = await runCockpitRadarStateRead(request(), { ...verified, store: { getRadarCandidateState: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }) }, database });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).reason, 'DB_UNAVAILABLE');
  const noDb = await runCockpitRadarStateRead(request(), { ...verified, loadDb: async () => { throw new Error('no db'); }, store: storeWith(stateRow()) });
  assert.equal(noDb.status, 503);
});

// ── source guard: this route reads, it never computes or sends ──────────────
test('the route is read-only: no write, no scoring, no Telegram, no worker token', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../netlify/functions/cockpit-radar-state.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /INSERT|UPDATE|DELETE|upsert/i);
  assert.doesNotMatch(src, /telegram|sendMessage/i);
  assert.doesNotMatch(src, /BOT_WORKER_TOKEN|x-bot-worker-token|SCHEDULER_SECRET/);
  assert.doesNotMatch(src, /evaluateTradingRadar|trading-radar/);
  assert.match(src, /'Cache-Control': 'no-store'/);
  assert.match(src, /path: '\/api\/cockpit-radar-state'/);
});
