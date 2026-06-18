import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main } from '../scripts/radar/radar-microstructure-producer.mjs';
import {
  resolveFapiSymbolForCandidate,
  normalizeFapiSymbolCandidate,
  enrichRadarCandidatesMicrostructure,
  radarMicrostructureConfigFromEnv,
} from '../scripts/auto/microstructure-enrichment.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const producerPath = path.join(__dirname, '../scripts/radar/radar-microstructure-producer.mjs');

// Default (no MARKET_DATA_PROVIDER) is the fail-closed "none" provider: it must
// make ZERO external calls and report provider-unavailable, exiting 0.
test('default provider is none: provider-unavailable, no fetch, exit 0', () => {
  const env = { ...process.env };
  delete env.MARKET_DATA_PROVIDER;
  const result = spawnSync('node', [producerPath], { env, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, 'none provider exits 0');
  assert.match(result.stdout, /provider=none reason=provider-unavailable measured=0 posted=false/);
});

test('MARKET_DATA_PROVIDER=none: provider-unavailable, no fetch, exit 0', () => {
  const result = spawnSync('node', [producerPath], {
    env: { ...process.env, MARKET_DATA_PROVIDER: 'none', WORKER_RADAR_MICROSTRUCTURE_ENABLED: 'true' },
    encoding: 'utf8'
  });
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /"provider":"none"/);
  assert.match(result.stdout, /provider=none reason=provider-unavailable/);
});

// Token/base-URL config only matters in the explicit binance-public diagnostic
// mode (the only mode that performs external fetch + control-plane POST).
test('binance-public + missing token fails closed', () => {
  const result = spawnSync('node', [producerPath], {
    env: { ...process.env, MARKET_DATA_PROVIDER: 'binance-public', BOT_WORKER_TOKEN: '' },
    encoding: 'utf8'
  });
  assert.ok(result.stderr.includes('Missing BOT_WORKER_TOKEN.'));
  assert.strictEqual(result.status, 1);
});

test('binance-public + missing base URL fails closed', () => {
  const result = spawnSync('node', [producerPath], {
    env: { ...process.env, MARKET_DATA_PROVIDER: 'binance-public', BOT_WORKER_TOKEN: 'token', CONTROL_BASE_URL: '' },
    encoding: 'utf8'
  });
  assert.ok(result.stderr.includes('Missing CONTROL_BASE_URL or BOT_BASE_URL.'));
  assert.strictEqual(result.status, 1);
});

test('no order/signed endpoints imported', () => {
  const src = fs.readFileSync(producerPath, 'utf8');
  const forbidden = [/\/fapi\/v1\/order/, /\/dapi\//, /\/sapi\//, /futures\/order/i, /marginType/, /sideEffectType/, /\bleverage=/, /\/margin\/order/, /\/borrow/, /\/repay/, /\/withdraw/];
  for (const re of forbidden) {
    assert.doesNotMatch(src, re, `Must not import/use ${re}`);
  }
});

test('no ENTRY_READY/Telegram changes', () => {
  const src = fs.readFileSync(producerPath, 'utf8');
  assert.doesNotMatch(src, /ENTRY_READY/);
  assert.doesNotMatch(src, /Telegram/i);
});

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

test('candidates -> BEATUSDT map posts static fields', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body });
    const u = String(url);
    if (u.includes('/api/bot/radar-candidates')) {
      return jsonResponse({
        ok: true,
        radarCandidates: [{ pair: 'BEAT', futures_pair: 'BEATUSDT' }]
      });
    }
    if (u.includes('/fapi/v1/depth')) {
      return jsonResponse({
        bids: [['1.0', '100']],
        asks: [['1.01', '100']]
      });
    }
    if (u.includes('/fapi/v1/premiumIndex')) {
      return jsonResponse({ lastFundingRate: '0.0001' });
    }
    if (u.includes('/api/bot/radar-microstructure')) {
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: true });
  };

  const oldEnv = { ...process.env };
  // Selecting binance-public IS the enable signal — no legacy ENABLED flag.
  process.env.MARKET_DATA_PROVIDER = 'binance-public';
  delete process.env.WORKER_RADAR_MICROSTRUCTURE_ENABLED;
  process.env.WORKER_RADAR_MICROSTRUCTURE_TOP_N = '5';
  process.env.BOT_WORKER_TOKEN = 'testtoken';
  process.env.CONTROL_BASE_URL = 'http://localhost';

  try {
    await main();

    // Check that we fetched candidates
    assert.ok(calls.some(c => c.url.includes('/api/bot/radar-candidates')));

    // Check that we posted microstructure
    const postCall = calls.find(c => c.url.includes('/api/bot/radar-microstructure'));
    assert.ok(postCall);
    assert.strictEqual(postCall.method, 'POST');

    const body = JSON.parse(postCall.body);
    assert.strictEqual(body.provider, 'binance-public', 'post body tags the diagnostic provider');
    assert.ok(body.data['BEATUSDT']);
    assert.strictEqual(body.data['BEATUSDT'].orderBookDepthWithin1Pct, 200);
    assert.strictEqual(body.data['BEATUSDT'].depthUsdWithin1Pct, 201);
    assert.strictEqual(body.data['BEATUSDT'].fundingRate, 0.0001);

  } finally {
    globalThis.fetch = realFetch;
    process.env = oldEnv;
  }
});

// ── fapi symbol resolver ─────────────────────────────────────────────────────

test('resolver: BEATUSDT candidate with futures_pair:null still resolves to BEATUSDT', () => {
  const c = { symbol: 'BEATUSDT', base: 'BEAT', pair: 'BEATUSDT', futures_pair: null, spot_pair: null, alphaPair: null, quote: 'USDT' };
  const r = resolveFapiSymbolForCandidate(c);
  assert.strictEqual(r.fapiSymbol, 'BEATUSDT');
  assert.strictEqual(r.skipReason, null);
  // pair is checked before symbol; either is the valid source here.
  assert.ok(['pair', 'symbol'].includes(r.source));
});

test('resolver: futures_pair wins over pair/symbol when present', () => {
  const r = resolveFapiSymbolForCandidate({ pair: 'BEAT', futures_pair: 'BEATUSDT', symbol: 'BEAT' });
  assert.strictEqual(r.fapiSymbol, 'BEATUSDT');
  assert.strictEqual(r.source, 'futures_pair');
});

test('resolver: alphaPair is NEVER used as an fapi symbol', () => {
  const r = resolveFapiSymbolForCandidate({ base: null, pair: null, symbol: null, futures_pair: null, alphaPair: 'FOOUSDT' });
  assert.strictEqual(r.fapiSymbol, null);
  assert.strictEqual(r.skipReason, 'no-valid-fapi-symbol');
});

test('resolver: contractAddress / chain are never read; symbol still wins', () => {
  const r = resolveFapiSymbolForCandidate({ symbol: 'BTCUSDT', contractAddress: '0xabcdef0123456789', chain: 'eth' });
  assert.strictEqual(r.fapiSymbol, 'BTCUSDT');
});

test('resolver: `${base}USDT` last resort only when base set and quote USDT/missing', () => {
  assert.strictEqual(resolveFapiSymbolForCandidate({ base: 'BEAT', quote: 'USDT' }).fapiSymbol, 'BEATUSDT');
  assert.strictEqual(resolveFapiSymbolForCandidate({ base: 'BEAT' }).fapiSymbol, 'BEATUSDT'); // quote missing
  assert.strictEqual(resolveFapiSymbolForCandidate({ base: 'BEAT', quote: 'BTC' }).fapiSymbol, null); // non-stable quote
});

test('resolver: invalid/spot-only shapes are skipped safely (no coercion)', () => {
  for (const c of [
    { pair: 'BTC-PERP' },              // strips '-' -> BTCPERP, no stable suffix
    { symbol: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01' }, // contract address
    { pair: 'BTC:USDT' },              // colon form rejected
    { pair: 'ALPHAUSDT' },             // contains ALPHA
    { pair: 'BTC USDT' },              // whitespace rejected
    { pair: 'X' },                     // too short / no quote
    {},                                // nothing usable
  ]) {
    assert.strictEqual(resolveFapiSymbolForCandidate(c).fapiSymbol, null, JSON.stringify(c));
  }
});

test('normalizeFapiSymbolCandidate: strips separators, enforces stable suffix', () => {
  assert.strictEqual(normalizeFapiSymbolCandidate('beat/usdt'), 'BEATUSDT');
  assert.strictEqual(normalizeFapiSymbolCandidate('BEAT_USDT'), 'BEATUSDT');
  assert.strictEqual(normalizeFapiSymbolCandidate('BTCUSDC'), 'BTCUSDC');
  assert.strictEqual(normalizeFapiSymbolCandidate('BTCETH'), null);
  assert.strictEqual(normalizeFapiSymbolCandidate('ALPHAUSDT'), null);
});

// ── enrichment with the resolver + diagnostics ──────────────────────────────

test('enrich: BEATUSDT (futures_pair:null) is measured on fapi, with diagnostics', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/fapi/v1/depth')) return jsonResponse({ bids: [['1.0', '100']], asks: [['1.01', '100']] });
    if (u.includes('/fapi/v1/premiumIndex')) return jsonResponse({ lastFundingRate: '0.0001' });
    if (u.includes('/api/v3/depth')) return jsonResponse({ bids: [], asks: [] }); // spot has none
    return jsonResponse({}, 400);
  };

  const diagnostics = { perCandidate: [] };
  const data = await enrichRadarCandidatesMicrostructure(
    [{ symbol: 'BEATUSDT', base: 'BEAT', pair: 'BEATUSDT', futures_pair: null, spot_pair: null, quote: 'USDT' }],
    { config: { enabled: true, topN: 5, cacheMs: 10000 }, fetchImpl, now: Date.now, diagnostics }
  );

  assert.ok(data['BEATUSDT'], 'BEATUSDT measured');
  assert.strictEqual(data['BEATUSDT'].orderBookDepthWithin1Pct, 200);
  assert.strictEqual(data['BEATUSDT'].fundingRate, 0.0001);
  // It must hit fapi (not rely on spot) for the order book.
  assert.ok(calls.some((u) => u.includes('/fapi/v1/depth')));

  assert.strictEqual(diagnostics.candidatesReceived, 1);
  assert.strictEqual(diagnostics.candidatesScanned, 1);
  assert.strictEqual(diagnostics.attempted, 1);
  assert.strictEqual(diagnostics.measured, 1);
  assert.strictEqual(diagnostics.skippedNoFapiSymbol, 0);
  const rec = diagnostics.perCandidate[0];
  assert.strictEqual(rec.index, 0);
  assert.strictEqual(rec.fapiSymbol, 'BEATUSDT');
  assert.strictEqual(rec.measured, true);
});

test('enrich: alphaPair-only candidate is skipped, never fetched as fapi symbol', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return jsonResponse({}, 400); };
  const diagnostics = { perCandidate: [] };
  const data = await enrichRadarCandidatesMicrostructure(
    [{ symbol: null, base: null, pair: null, futures_pair: null, alphaPair: 'FOOUSDT' }],
    { config: { enabled: true, topN: 5, cacheMs: 10000 }, fetchImpl, now: Date.now, diagnostics }
  );
  assert.deepStrictEqual(data, {});
  assert.strictEqual(diagnostics.skippedNoFapiSymbol, 1);
  assert.strictEqual(diagnostics.attempted, 0);
  assert.ok(!calls.some((u) => u.includes('FOOUSDT')), 'alphaPair must never be fetched');
});

// ── producer structured logs (no secret leakage) ────────────────────────────

test('producer logs counts + skip reasons and never logs the worker token', async () => {
  const realFetch = globalThis.fetch;
  const logs = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));

  const TOKEN = 'super-secret-worker-token-DO-NOT-LOG';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/bot/radar-candidates')) {
      return jsonResponse({ ok: true, radarCandidates: [
        { symbol: 'BEATUSDT', base: 'BEAT', pair: 'BEATUSDT', futures_pair: null, spot_pair: null, quote: 'USDT' },
        { symbol: null, base: null, pair: null, futures_pair: null, alphaPair: 'FOOUSDT' },
      ] });
    }
    if (u.includes('/fapi/v1/depth')) return jsonResponse({ bids: [['1.0', '100']], asks: [['1.01', '100']] });
    if (u.includes('/fapi/v1/premiumIndex')) return jsonResponse({ lastFundingRate: '0.0001' });
    if (u.includes('/api/bot/radar-microstructure')) return jsonResponse({ ok: true });
    return jsonResponse({}, 400);
  };

  const oldEnv = { ...process.env };
  process.env.MARKET_DATA_PROVIDER = 'binance-public';
  process.env.WORKER_RADAR_MICROSTRUCTURE_ENABLED = 'true';
  process.env.WORKER_RADAR_MICROSTRUCTURE_TOP_N = '5';
  process.env.BOT_WORKER_TOKEN = TOKEN;
  process.env.CONTROL_BASE_URL = 'http://localhost';

  try {
    await main();
    const text = logs.join('\n');
    assert.match(text, /candidatesReceived/);
    assert.match(text, /"scanLimit":/);
    assert.match(text, /"candidatesScanned":/);
    assert.match(text, /rank=0 /);            // per-candidate rank/index
    assert.match(text, /fapiSymbol=BEATUSDT/);
    assert.match(text, /measured=yes/);
    assert.match(text, /skip=no-valid-fapi-symbol/);
    assert.match(text, /"measured":1/);
    assert.match(text, /"posted":true/);
    // Secret must never appear in any log line.
    assert.ok(!text.includes(TOKEN), 'token must not be logged');
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.error = realErr;
    process.env = oldEnv;
  }
});

// ── deep-scan selection semantics ────────────────────────────────────────────

// A fetchImpl where only the symbols in `validSet` return a usable fapi book;
// every other fapi/spot depth returns HTTP 400 (invalid symbol).
function fapiFetchFactory(validSet, calls = []) {
  return async (url) => {
    const u = String(url);
    calls.push(u);
    const m = u.match(/symbol=([A-Z0-9]+)/);
    const sym = m ? m[1] : '';
    if (u.includes('/fapi/v1/premiumIndex')) {
      return validSet.has(sym) ? jsonResponse({ lastFundingRate: '0.0001' }) : jsonResponse({}, 400);
    }
    if (u.includes('/fapi/v1/depth') || u.includes('/api/v3/depth')) {
      return validSet.has(sym)
        ? jsonResponse({ bids: [['1.0', '100']], asks: [['1.01', '100']] })
        : jsonResponse({ code: -1121, msg: 'Invalid symbol.' }, 400);
    }
    return jsonResponse({}, 400);
  };
}

function cand(sym) { return { symbol: sym, base: sym.replace(/USD[TC]$/, ''), pair: sym, futures_pair: null, quote: sym.endsWith('USDC') ? 'USDC' : 'USDT' }; }

test('scan: first 5 invalid but 6th valid gets measured and posted', async () => {
  const calls = [];
  const fetchImpl = fapiFetchFactory(new Set(['GOODUSDT']), calls);
  const candidates = [
    cand('AAAUSDT'), cand('BBBUSDT'), cand('CCCUSDT'), cand('DDDUSDT'), cand('EEEUSDT'),
    cand('GOODUSDT'),
  ];
  const diagnostics = { perCandidate: [] };
  const data = await enrichRadarCandidatesMicrostructure(candidates, {
    config: { enabled: true, topN: 1, scanLimit: 50, cacheMs: 10000 }, fetchImpl, now: Date.now, diagnostics,
  });
  assert.ok(data['GOODUSDT'], '6th candidate measured despite 5 invalid before it');
  assert.strictEqual(diagnostics.measured, 1);
  assert.strictEqual(diagnostics.candidatesScanned, 6);
  assert.strictEqual(diagnostics.failedFetch, 5);
  // The 5 invalid ones are classified, not silently dropped.
  assert.strictEqual(diagnostics.perCandidate[0].skipReason, 'invalid-symbol');
  assert.strictEqual(diagnostics.perCandidate[5].measured, true);
});

test('scan: stops after TOP_N measured symbols', async () => {
  const calls = [];
  // Everything is valid; with topN=2 we must stop scanning after 2 measured.
  const fetchImpl = fapiFetchFactory(new Set(['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT']), calls);
  const candidates = [cand('AAAUSDT'), cand('BBBUSDT'), cand('CCCUSDT'), cand('DDDUSDT')];
  const diagnostics = { perCandidate: [] };
  const data = await enrichRadarCandidatesMicrostructure(candidates, {
    config: { enabled: true, topN: 2, scanLimit: 50, cacheMs: 10000 }, fetchImpl, now: Date.now, diagnostics,
  });
  assert.strictEqual(Object.keys(data).length, 2);
  assert.strictEqual(diagnostics.measured, 2);
  assert.strictEqual(diagnostics.candidatesScanned, 2, 'must stop scanning once target reached');
  assert.ok(!calls.some((u) => u.includes('CCCUSDT')), 'third symbol must never be fetched');
});

test('scan: scanLimit bounds the number of attempts (no unbounded scan)', async () => {
  const calls = [];
  // Nothing is valid; with a big candidate list and scanLimit=3 we attempt only 3.
  const fetchImpl = fapiFetchFactory(new Set([]), calls);
  const candidates = Array.from({ length: 40 }, (_, i) => cand(`SYM${i}USDT`));
  const diagnostics = { perCandidate: [] };
  const data = await enrichRadarCandidatesMicrostructure(candidates, {
    config: { enabled: true, topN: 5, scanLimit: 3, cacheMs: 10000 }, fetchImpl, now: Date.now, diagnostics,
  });
  assert.deepStrictEqual(data, {});
  assert.strictEqual(diagnostics.candidatesScanned, 3);
  assert.strictEqual(diagnostics.attempted, 3);
  assert.strictEqual(diagnostics.scanLimit, 3);
});

test('scan: scanLimit is hard-capped at 100 via config', async () => {
  const cfg = radarMicrostructureConfigFromEnv({
    WORKER_RADAR_MICROSTRUCTURE_ENABLED: 'true',
    WORKER_RADAR_MICROSTRUCTURE_SCAN_LIMIT: '9999',
  });
  assert.strictEqual(cfg.scanLimit, 100);
  const def = radarMicrostructureConfigFromEnv({ WORKER_RADAR_MICROSTRUCTURE_ENABLED: 'true' });
  assert.strictEqual(def.scanLimit, 50);
});
