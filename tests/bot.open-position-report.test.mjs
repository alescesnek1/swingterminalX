// Regression coverage for worker-reported OPEN positions on worker-heartbeat.
//
// Why this file exists: every pre-existing heartbeat test passed
// `openPositions: []` (or omitted it), so the one branch that actually builds
// position records was never executed. It contained
// `mode: body.mode === 'live_spot' ? ...` inside a module-scope helper where
// `body` is not in scope, so a heartbeat that genuinely carried an open
// position threw `ReferenceError: body is not defined` and the endpoint
// answered 500. The worker logs that HTTP failure and keeps going
// (scripts/local-binance-worker.mjs), so the control plane silently lost
// track of open positions.
//
// The second assertion set guards the follow-on hazard: the record's
// `testnet` flag was hardcoded `true`. The worker hydrates backend records via
// hydrateOpenPositionsFromBackend() and then branches on `pos.testnet` when
// closing — a live position labelled testnet gets a SIMULATED paper close,
// reporting the position closed while real money stays exposed.
//
// No network, no Binance, no secrets. Run: `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.BOT_WORKER_TOKEN = 'test-worker-token';
process.env.BINANCE_ENV = 'testnet';
process.env.BOT_ALLOW_TESTNET_ORDERS = 'true';
process.env.BOT_ALLOW_MEMORY_STORE = 'true';
process.env.AUTH_DECODE_ONLY = 'true';
process.env.SUPABASE_JWT_SECRET = 'unit-test-secret';
delete process.env.BOT_LIVE_TRADING_ENABLED;
delete process.env.BOT_ALLOW_REAL_ORDERS;
delete process.env.BOT_GLOBAL_KILL_SWITCH;

const { default: handler } = await import('../netlify/functions/bot.mjs');

const WORKER_TOKEN = 'test-worker-token';

function workerReq(method, path, body) {
  const init = { method, headers: { 'X-BOT-WORKER-TOKEN': WORKER_TOKEN, Accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return new Request(`https://ctl.example${path}`, init);
}

async function call(req) {
  const res = await handler(req);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// The exact shape scripts/local-binance-worker.mjs sends from
// openPositionSummary() in its heartbeat body.
function heartbeat(sessionId, mode) {
  return workerReq('POST', '/api/bot/worker-heartbeat', {
    sessionId,
    workerId: `w-${sessionId}`,
    status: 'online',
    currentState: 'running',
    mode,
    openPositions: [{ symbol: 'BTCUSDT', executedQty: '0.001', orderId: '12345', baseAsset: 'BTC' }],
  });
}

test('worker-heartbeat with a NON-EMPTY openPositions array does not 500', async () => {
  const res = await call(heartbeat(`sess-open-pos-${Date.now()}`, 'testnet'));
  assert.notEqual(res.status, 500, 'reporting an open position must not crash the control plane');
  assert.equal(res.status, 200);
});

test('a testnet-reported open position is recorded as testnet, not live', async () => {
  const sid = `sess-open-pos-testnet-${Date.now()}`;
  await call(heartbeat(sid, 'testnet'));

  const ws = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${encodeURIComponent(sid)}&workerId=w-${encodeURIComponent(sid)}`));
  assert.equal(ws.status, 200);
  assert.equal(ws.json.openPositionsCount, 1, 'the reported position must reach the control plane');

  const pos = ws.json.openPositions[0];
  assert.equal(pos.symbol, 'BTCUSDT');
  assert.equal(pos.mode, 'testnet');
  assert.equal(pos.testnet, true);
  assert.equal(pos.realProductionOrder, false);
});

test('a live_spot open position is recorded as live — testnet must NOT stay true', async () => {
  const sid = `sess-open-pos-live-${Date.now()}`;
  await call(heartbeat(sid, 'live_spot'));

  const ws = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${encodeURIComponent(sid)}&workerId=w-${encodeURIComponent(sid)}`));
  assert.equal(ws.status, 200);
  assert.equal(ws.json.openPositionsCount, 1);

  const pos = ws.json.openPositions[0];
  assert.equal(pos.mode, 'live_spot');
  assert.equal(
    pos.testnet,
    false,
    'a live position marked testnet:true is closed by SIMULATION in the worker — real money would stay exposed',
  );
  assert.equal(pos.realProductionOrder, true);
});

test('mode fails closed: an absent or unknown mode is never treated as live', async () => {
  for (const mode of [undefined, '', 'LIVE_SPOT', 'live', 'paper', 'shadow']) {
    const sid = `sess-open-pos-mode-${Date.now()}-${String(mode)}`;
    await call(heartbeat(sid, mode));
    const ws = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${encodeURIComponent(sid)}&workerId=w-${encodeURIComponent(sid)}`));
    assert.equal(ws.json.openPositionsCount, 1, `mode=${String(mode)}: position still recorded`);
    const pos = ws.json.openPositions[0];
    assert.equal(pos.mode, 'testnet', `mode=${String(mode)} must not be promoted to live_spot`);
    assert.equal(pos.realProductionOrder, false, `mode=${String(mode)} must not claim a real production order`);
  }
});
