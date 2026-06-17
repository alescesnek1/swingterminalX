// gemini-node.mjs — Node-runtime Gemini summarizer for the Morning Market
// Briefing.
//
// WHY THIS EXISTS:
//   The production AI orchestrator (apps/edge/netlify/edge-functions/lib/
//   orchestrator.js) runs on Deno Edge and reads Deno.env — it cannot be
//   imported into a Node scheduled function. This module mirrors that
//   orchestrator's *fixed* fallback contract (see commit "fix(ai): add gemini
//   model fallback and diagnostics") in Node:
//     - env-configurable model chain: GEMINI_MODEL_PRIMARY / _FALLBACK / _LIGHT
//       (legacy GEMINI_MODEL still honored), defaulting to a non-empty chain;
//     - on a 400 whose payload carried the googleSearch grounding tool, retry
//       the SAME model once WITHOUT grounding before walking to the next model;
//     - provider error bodies are key-stripped and capped — the raw provider
//       JSON and the API key never reach a log line, the message, or the caller.
//
// SAFETY:
//   - This is summarization/formatting ONLY. It never places orders and never
//     touches RADAR / execution / worker state.
//   - No secrets in code: the API key comes from process.env.GEMINI_API_KEY.
//   - If the key is missing or every model fails, summarize() resolves with
//     { ok: false, ... } — it does NOT throw — so the briefing degrades to a
//     market-only message instead of crashing.

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Same default chain the edge orchestrator ships (Flash-first, Pro last-resort).
export const DEFAULT_MODEL_CHAIN = Object.freeze([
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.5-pro',
]);

// Build the model order from env, identical knobs to the edge orchestrator.
// Anything left unset falls through to DEFAULT_MODEL_CHAIN so a missing env can
// never produce an empty chain.
export function buildModelChain(env = process.env) {
  const legacy = env.GEMINI_MODEL;
  const primary = env.GEMINI_MODEL_PRIMARY;
  const fallback = env.GEMINI_MODEL_FALLBACK;
  const light = env.GEMINI_MODEL_LIGHT;
  const chain = [];
  for (const m of [legacy, primary, fallback, light, ...DEFAULT_MODEL_CHAIN]) {
    const id = (m || '').trim();
    if (id && !chain.includes(id)) chain.push(id);
  }
  return chain;
}

// Strip any API key (?key=… / "key": "…") and Google AIza… tokens from a
// provider body before it can reach a log or the caller. Caps length.
export function sanitizeProviderBody(text) {
  if (!text) return '';
  return String(text)
    .replace(/key=[A-Za-z0-9_\-]+/g, 'key=***')
    .replace(/"key"\s*:\s*"[^"]*"/g, '"key":"***"')
    .replace(/AIza[A-Za-z0-9_\-]{10,}/g, 'AIza***')
    .slice(0, 300);
}

// Remove the grounding (googleSearch) tool from a payload — the single most
// common 400 trigger across model revisions.
function stripGrounding(payload) {
  if (!payload || !payload.tools) return payload;
  const { tools: _drop, ...rest } = payload;
  return rest;
}

// Low-level non-streaming generateContent with 400 grounding-recovery.
// Returns { ok, text, status, groundingDisabled, error } — never throws.
async function generateContentOnce(model, payload, apiKey, fetchImpl) {
  const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;
  const doFetch = (body) => fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let res;
  let text;
  let groundingDisabled = false;
  try {
    res = await doFetch(payload);
    text = await res.text();
  } catch (err) {
    return { ok: false, status: 0, groundingDisabled, error: `network: ${err && err.message ? err.message : 'fetch failed'}` };
  }

  if (res.status === 400 && payload.tools) {
    // Grounding-strip recovery: retry the SAME model once without googleSearch.
    try {
      res = await doFetch(stripGrounding(payload));
      text = await res.text();
      groundingDisabled = true;
    } catch (err) {
      return { ok: false, status: 0, groundingDisabled: true, error: `network: ${err && err.message ? err.message : 'fetch failed'}` };
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      groundingDisabled,
      error: `HTTP ${res.status} ${model}: ${sanitizeProviderBody(text)}`,
    };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, groundingDisabled, error: `unparseable provider response from ${model}` };
  }
  const out = extractText(data);
  if (!out) {
    return { ok: false, status: res.status, groundingDisabled, error: `empty response from ${model}` };
  }
  return { ok: true, text: out, status: res.status, groundingDisabled };
}

// Tolerant text extraction across Gemini frame shapes.
function extractText(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  const candidate = Array.isArray(parsed.candidates) ? parsed.candidates[0] : null;
  const out = [];
  if (candidate && candidate.content && Array.isArray(candidate.content.parts)) {
    for (const p of candidate.content.parts) {
      if (p && typeof p.text === 'string' && p.text.length) out.push(p.text);
    }
  }
  if (!out.length && candidate && typeof candidate.text === 'string') out.push(candidate.text);
  return out.join('').trim();
}

const BRIEFING_SYSTEM_PROMPT = `You are the morning macro strategist for the Terminal-X crypto desk.
You will receive a compact JSON snapshot of the desk's own market state (regime, BTC/ETH direction, breadth, top movers, sectors, RADAR watchlist). Your ONLY job is to summarize and add brief macro/world context.

STRICT RULES:
- This is an ADVISORY briefing. NEVER state or imply that any trade is confirmed, entered, or executed. Only the desk's RADAR may declare ENTRY_READY — if the snapshot does not say ENTRY_READY, treat everything as a watchlist idea.
- Do NOT invent prices, levels, catalysts, dates or figures that are not in the snapshot or that you cannot ground. When unsure, omit it. "N/A" is better than a fabricated fact.
- No financial advice, no leverage calls, no position sizing.
- Be concise and mobile-readable. Plain prose, short lines. No tables, no JSON, no code blocks.

OUTPUT — return ONLY these labelled blocks, each ONE short paragraph (≤ 3 sentences), nothing else:
MACRO: the broad macro/world backdrop most relevant to crypto right now (rates, USD, equities risk appetite, regulation, ETF flows). If you have no grounded macro context, write exactly: Macro/news unavailable — showing market-only briefing
BUSINESS: the single most market-moving business/institutional crypto headline theme (ETF, regulation, Fed, liquidity). Keep it to one or two sentences; if none is grounded, write: N/A
TONE: one sentence reading the overall crypto risk tone consistent with the snapshot's regime.`;

function buildPayload(context) {
  const dataString = JSON.stringify(context, null, 2);
  const combined = `=== SYSTEM INSTRUCTIONS ===\n${BRIEFING_SYSTEM_PROMPT}\n\n=== DESK SNAPSHOT (JSON) ===\n${dataString}\n\n=== TASK ===\nWrite the MACRO / BUSINESS / TONE blocks for today's morning briefing, following the rules exactly.`;
  return {
    contents: [{ role: 'user', parts: [{ text: combined }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: { temperature: 0.5 },
  };
}

/**
 * Summarize the briefing context with Gemini, walking the env model chain with
 * grounding-strip recovery. Never throws.
 *
 * @returns {Promise<{ ok:boolean, text?:string, meta:{ model:string|null,
 *   triedModels:string[], fallbackUsed:boolean, groundingDisabled:boolean },
 *   providerErrors:string[] }>}
 */
export async function summarizeBriefing(context, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const apiKey = env.GEMINI_API_KEY ? String(env.GEMINI_API_KEY).trim() : '';
  const meta = { model: null, triedModels: [], fallbackUsed: false, groundingDisabled: false };
  const providerErrors = [];

  if (!apiKey) {
    return { ok: false, meta, providerErrors: ['GEMINI_API_KEY not configured'] };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, meta, providerErrors: ['fetch unavailable in runtime'] };
  }

  const chain = buildModelChain(env);
  const payload = buildPayload(context);

  for (const model of chain) {
    meta.triedModels.push(model);
    const res = await generateContentOnce(model, payload, apiKey, fetchImpl);
    if (res.ok) {
      meta.model = model;
      meta.groundingDisabled = res.groundingDisabled;
      meta.fallbackUsed = meta.triedModels.length > 1 || res.groundingDisabled;
      return { ok: true, text: res.text, meta, providerErrors };
    }
    providerErrors.push(res.error);
    // Walk the chain on retryable statuses; stop early on a genuinely fatal one
    // the next model can't fix (e.g. 401/403 auth — bad key).
    const s = res.status;
    const retryable = s === 0 || s === 400 || s === 404 || s === 429 || (s >= 500 && s < 600);
    if (!retryable) break;
  }

  return { ok: false, meta, providerErrors };
}
