// ─────────────────────────────────────────────────────────────
// AI / Gemini orchestrator — fallback + diagnostics guards
//
// Covers the V6 AI hotfix (production 400 incident):
//   • env-configurable model order (GEMINI_MODEL_PRIMARY/_FALLBACK/_LIGHT)
//   • primary 400 → grounding-strip recovery on the SAME model
//   • primary 400 (unrecoverable) → fallback model
//   • both fail → useful GeminiApiError payload, never a crash
//   • request body is the valid contents[].parts[].text shape
//   • API key is never emitted in a sanitized provider body
//   • market briefing shares the same fallback helper (buildModelChain)
//
// The orchestrator targets Deno Edge. We shim Deno.env + global fetch
// BEFORE importing it (it reads both lazily inside functions).
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';

// ── Env shim (mutable per test) ──
const ENV = {};
globalThis.Deno = { env: { get: (k) => (k in ENV ? ENV[k] : undefined) } };

// ── fetch mock — tests install a handler that maps (url, init) → spec ──
let fetchHandler = null;
const fetchCalls = [];
globalThis.fetch = async (url, init = {}) => {
  fetchCalls.push({ url: String(url), init });
  const spec = fetchHandler(String(url), init);
  return makeResponse(spec);
};

function makeResponse({ status = 200, json, sse }) {
  const ok = status >= 200 && status < 300;
  const bodyText = sse != null
    ? sse
    : (typeof json === 'string' ? json : JSON.stringify(json ?? {}));
  const enc = new TextEncoder();
  return {
    ok,
    status,
    async text() { return bodyText; },
    async json() { return JSON.parse(bodyText); },
    get body() {
      if (sse == null) return null;
      let sent = false;
      return {
        getReader() {
          return {
            async read() {
              if (sent) return { value: undefined, done: true };
              sent = true;
              return { value: enc.encode(bodyText), done: false };
            },
            releaseLock() {},
          };
        },
      };
    },
  };
}

// A well-formed non-streaming generateContent frame.
const frame = (text) => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
// A single SSE chunk the stream parser understands.
const sseChunk = (text) => `data: ${frame(text)}\n\n`;

function modelInUrl(url) {
  const m = /\/models\/([^:]+):/.exec(url);
  return m ? m[1] : '';
}
function bodyHasTools(init) {
  try { return !!JSON.parse(init.body).tools; } catch { return false; }
}

const MODURL = new URL('../apps/edge/netlify/edge-functions/lib/orchestrator.js', import.meta.url).href;
const orch = await import(MODURL);

function reset() {
  for (const k of Object.keys(ENV)) delete ENV[k];
  ENV.GEMINI_API_KEY = 'test-gemini-api-key';
  fetchCalls.length = 0;
  fetchHandler = null;
}

// ─────────────────────────────────────────────────────────────

test('buildModelChain honors GEMINI_MODEL_PRIMARY/_FALLBACK/_LIGHT order', () => {
  reset();
  ENV.GEMINI_MODEL_PRIMARY = 'm-primary';
  ENV.GEMINI_MODEL_FALLBACK = 'm-fallback';
  ENV.GEMINI_MODEL_LIGHT = 'm-light';
  const chain = orch.buildModelChain();
  assert.equal(chain[0], 'm-primary');
  assert.equal(chain[1], 'm-fallback');
  assert.equal(chain[2], 'm-light');
  // defaults are appended, deduped
  assert.ok(chain.includes('gemini-2.5-flash'));
  assert.equal(new Set(chain).size, chain.length, 'no duplicate models');
});

test('buildModelChain falls back to DEFAULT_MODEL_CHAIN when no env set', () => {
  reset();
  const chain = orch.buildModelChain();
  assert.deepEqual(chain, orch.DEFAULT_MODEL_CHAIN);
});

test('orchestrate uses the env primary model and emits valid contents[].parts[].text', async () => {
  reset();
  ENV.GEMINI_MODEL_PRIMARY = 'm-primary';
  fetchHandler = (url) => ({ status: 200, json: JSON.parse(frame('analysis OK')) });
  // analyze.js passes the explicit model from buildModelChain()[0]
  const model = orch.buildModelChain()[0];
  const res = await orch.orchestrate('BTCUSDT', { binance_available: true, futures: { available: true } }, 'cs', model, false);
  assert.equal(res.meta.model, 'm-primary');
  assert.match(res.analysis, /analysis OK/);
  // Verify the request body shape Google requires.
  const sent = JSON.parse(fetchCalls[0].init.body);
  assert.ok(Array.isArray(sent.contents), 'contents is an array');
  assert.equal(sent.contents[0].role, 'user');
  assert.ok(Array.isArray(sent.contents[0].parts), 'parts is an array');
  assert.equal(typeof sent.contents[0].parts[0].text, 'string');
  assert.ok(sent.contents[0].parts[0].text.length > 0);
});

test('orchestrate recovers from a 400 by stripping the grounding tool (same model)', async () => {
  reset();
  fetchHandler = (url, init) => {
    if (bodyHasTools(init)) return { status: 400, json: { error: { message: "Unknown name 'googleSearch'" } } };
    return { status: 200, json: JSON.parse(frame('grounding-free analysis')) };
  };
  const res = await orch.orchestrate('ETHUSDT', { binance_available: true }, 'cs', 'gemini-2.5-flash', false);
  assert.equal(res.meta.grounding_disabled, true);
  assert.match(res.analysis, /grounding-free/);
  // two calls: with tools (400), then without (200)
  assert.equal(fetchCalls.length, 2);
  assert.equal(bodyHasTools(fetchCalls[0].init), true);
  assert.equal(bodyHasTools(fetchCalls[1].init), false);
});

test('streamWithFallback: primary 400 (unrecoverable) falls back to the next model', async () => {
  reset();
  ENV.GEMINI_MODEL_PRIMARY = 'm-bad';
  ENV.GEMINI_MODEL_FALLBACK = 'm-good';
  fetchHandler = (url) => {
    const model = modelInUrl(url);
    if (model === 'm-bad') return { status: 400, json: { error: { message: 'bad request' } } };
    return { status: 200, sse: sseChunk('streamed via fallback') };
  };
  const opened = await orch.streamWithFallback({ kind: 'analysis', symbol: 'SOLUSDT', snapshot: { binance_available: true }, userLang: 'cs', partial: false });
  assert.equal(opened.model, 'm-good');
  assert.equal(opened.fallbackUsed, true);
  assert.ok(opened.triedModels.includes('m-bad'));
  // drain the primed chunk
  assert.equal(opened.primed.value.text, 'streamed via fallback');
});

test('streamWithFallback: 400 then grounding-strip success on the SAME model', async () => {
  reset();
  ENV.GEMINI_MODEL_PRIMARY = 'm-only';
  ENV.GEMINI_MODEL_FALLBACK = 'm-only'; // dedupes to a single-model chain
  fetchHandler = (url, init) => {
    if (bodyHasTools(init)) return { status: 400, json: { error: { message: 'grounding not allowed' } } };
    return { status: 200, sse: sseChunk('recovered without grounding') };
  };
  const opened = await orch.streamWithFallback({ kind: 'analysis', symbol: 'XRPUSDT', snapshot: { binance_available: true }, userLang: 'cs' });
  assert.equal(opened.model, 'm-only');
  assert.equal(opened.groundingDisabled, true);
  assert.equal(opened.fallbackUsed, true);
});

test('streamWithFallback: every model fails → throws a useful GeminiApiError, no crash', async () => {
  reset();
  ENV.GEMINI_MODEL_PRIMARY = 'm1';
  ENV.GEMINI_MODEL_FALLBACK = 'm2';
  ENV.GEMINI_MODEL_LIGHT = 'm3';
  fetchHandler = () => ({ status: 400, json: { error: { message: 'always bad' } } });
  await assert.rejects(
    () => orch.streamWithFallback({ kind: 'analysis', symbol: 'ADAUSDT', snapshot: {}, userLang: 'cs' }),
    (err) => {
      assert.ok(err instanceof orch.GeminiApiError);
      assert.equal(err.status, 400);
      const { code, reason } = orch.classifyGeminiError(err);
      assert.equal(code, 'PROVIDER_400');
      assert.ok(typeof reason === 'string' && reason.length);
      return true;
    },
  );
});

test('runMarketBriefing shares buildModelChain + grounding recovery', async () => {
  reset();
  ENV.GEMINI_MODEL_PRIMARY = 'mb-bad';
  ENV.GEMINI_MODEL_FALLBACK = 'mb-good';
  fetchHandler = (url) => {
    const model = modelInUrl(url);
    if (model === 'mb-bad') return { status: 400, json: { error: { message: 'bad' } } };
    return { status: 200, json: JSON.parse(frame('## MARKET BRIEFING\nstuff')) };
  };
  const res = await orch.runMarketBriefing({ top_100: [], news_count: 0 }, 'cs');
  assert.equal(res.meta.model, 'mb-good');
  assert.equal(res.meta.fallback_used, true);
  assert.match(res.analysis, /MARKET BRIEFING/);
});

test('sanitizeProviderBody never leaks the API key', () => {
  reset();
  const leaky = 'GET https://x/models/y:generateContent?key=test-gemini-api-key failed; {"key":"test-gemini-api-key"}';
  const clean = orch.sanitizeProviderBody(leaky);
  assert.doesNotMatch(clean, /test-gemini-api-key/);
  assert.doesNotMatch(clean, /key=AIza/);
});

test('classifyGeminiError maps statuses to stable UI reason codes', () => {
  const mk = (status, body = '') => new orch.GeminiApiError('x', { status, body });
  assert.equal(orch.classifyGeminiError(mk(404)).code, 'INVALID_MODEL');
  assert.equal(orch.classifyGeminiError(mk(429)).code, 'QUOTA_BILLING');
  assert.equal(orch.classifyGeminiError(mk(401)).code, 'AUTH_CONFIG');
  assert.equal(orch.classifyGeminiError(mk(503)).code, 'PROVIDER_5XX');
  assert.equal(orch.classifyGeminiError(mk(0)).code, 'NETWORK');
  assert.equal(orch.classifyGeminiError(mk(400, 'token count exceeds limit')).code, 'REQUEST_TOO_LARGE');
});
