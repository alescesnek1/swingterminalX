#!/usr/bin/env node
import { normalizeRollingMicrostructureSnapshot } from './rolling-microstructure-snapshot.mjs';

const DEFAULT_TOP_N = 20;
const MAX_TOP_N = 50;
const PUBLIC_FAPI_BASE = 'https://fapi.binance.com';
const STABLE_PAIR_RE = /^[A-Z0-9]{2,24}(USDT|USDC)$/;

function clampPositiveInteger(value, fallback, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function stablePair(value) {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,24}$/.test(symbol)) return null;
  return STABLE_PAIR_RE.test(symbol) ? symbol : null;
}

export function resolveRollingSymbol(candidate = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const futuresPair = stablePair(candidate.futures_pair ?? candidate.futuresPair);
  if (futuresPair) return futuresPair;
  for (const key of ['pair', 'symbol']) {
    const symbol = stablePair(candidate[key]);
    if (symbol) return symbol;
  }
  return null;
}

export function normalizeRollingProducerOptions(opts = {}) {
  return {
    topN: clampPositiveInteger(opts.topN, DEFAULT_TOP_N, MAX_TOP_N),
    baseUrl: typeof opts.baseUrl === 'string' && opts.baseUrl ? opts.baseUrl.replace(/\/+$/, '') : PUBLIC_FAPI_BASE,
    mode: opts.mode === 'evaluate' ? 'evaluate' : 'collect',
  };
}

export function selectRollingTargets(candidates = [], opts = {}) {
  const { topN } = normalizeRollingProducerOptions(opts);
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const symbol = resolveRollingSymbol(c);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, candidate: c });
    if (out.length >= topN) break;
  }
  return out;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function depthTotal(depth) {
  const bids = Array.isArray(depth?.bids) ? depth.bids : [];
  let total = 0;
  for (const row of bids) {
    const price = num(row && row[0]);
    const qty = num(row && row[1]);
    if (price > 0 && qty > 0) total += price * qty;
  }
  return total;
}

function tradeFlow(trades) {
  const rows = Array.isArray(trades) ? trades : [];
  let buy = 0;
  let sell = 0;
  for (const t of rows) {
    const price = num(t.p);
    const qty = num(t.q);
    if (!(price > 0 && qty > 0)) continue;
    const notional = price * qty;
    if (t.m === true) sell += notional;
    else buy += notional;
  }
  const total = buy + sell;
  return {
    marketSellRatio: total > 0 ? sell / total : null,
    takerBuySellRatio: sell > 0 ? buy / sell : null,
    cumulativeDeltaPct: total > 0 ? ((buy - sell) / total) * 100 : null,
    aggressiveSellExhaustion: total > 0 ? sell <= buy : null,
  };
}

function previousSample(previousSnapshot, symbol) {
  const history = previousSnapshot?.diagnostics?.history;
  if (history && history[symbol]) return history[symbol];
  const row = previousSnapshot?.data?.[symbol];
  return row?.diagnostics?.sample || null;
}

export function buildRollingSnapshotFromSamples(samples, opts = {}) {
  const options = normalizeRollingProducerOptions(opts);
  const previous = opts.previousSnapshot || null;
  const data = {};
  const history = {};
  const diagnostics = { attempted: 0, computed: 0, missingBySymbol: {}, history };

  for (const sample of samples || []) {
    const symbol = stablePair(sample.symbol);
    if (!symbol) continue;
    diagnostics.attempted += 1;
    const prev = previousSample(previous, symbol);
    const currentDepth = depthTotal(sample.depth);
    const currentOi = num(sample.openInterest?.openInterest);
    const flow = tradeFlow(sample.trades);
    const row = { diagnostics: { sample: { depthTotal: currentDepth, openInterest: currentOi, sampledAtMs: sample.sampledAtMs || Date.now() } } };
    history[symbol] = row.diagnostics.sample;

    if (prev && currentDepth > 0 && num(prev.depthTotal) > 0) row.bidDepthRebuildPct = ((currentDepth - Number(prev.depthTotal)) / Number(prev.depthTotal)) * 100;
    else row.diagnostics.missingBidDepthRebuildPct = 'requires at least two depth samples';

    if (flow.marketSellRatio !== null) row.marketSellRatio = flow.marketSellRatio;
    if (flow.takerBuySellRatio !== null || flow.cumulativeDeltaPct !== null || flow.aggressiveSellExhaustion !== null) {
      row.flow = {};
      if (flow.takerBuySellRatio !== null) row.flow.takerBuySellRatio = flow.takerBuySellRatio;
      if (flow.cumulativeDeltaPct !== null) row.flow.cumulativeDeltaPct = flow.cumulativeDeltaPct;
      if (flow.aggressiveSellExhaustion !== null) row.flow.aggressiveSellExhaustion = flow.aggressiveSellExhaustion;
    }

    if (prev && currentOi > 0 && num(prev.openInterest) > 0) row.openInterestChangePct = ((currentOi - Number(prev.openInterest)) / Number(prev.openInterest)) * 100;
    else row.diagnostics.missingOpenInterestChangePct = 'requires at least two open interest samples';

    if (Array.isArray(sample.forceOrders) && sample.forceOrders.length > 0) row.longLiquidationSpike = sample.forceOrders.length;
    else row.diagnostics.missingLongLiquidationSpike = 'public liquidation data unavailable or empty';

    data[symbol] = row;
    diagnostics.computed += 1;
  }

  const normalized = normalizeRollingMicrostructureSnapshot({
    provider: 'manual-public-rolling',
    updatedAtMs: Date.now(),
    timeframe: 'rolling',
    trusted: true,
    data,
    diagnostics,
  });
  normalized.trusted = Object.values(normalized.data).some((row) => row.strictReady === true);
  return normalized;
}

async function fetchJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'failed'}`);
  return res.json();
}

async function collectSample(fetchImpl, baseUrl, symbol) {
  const depthUrl = new URL('/fapi/v1/depth', baseUrl);
  depthUrl.searchParams.set('symbol', symbol);
  depthUrl.searchParams.set('limit', '100');
  const tradesUrl = new URL('/fapi/v1/aggTrades', baseUrl);
  tradesUrl.searchParams.set('symbol', symbol);
  tradesUrl.searchParams.set('limit', '100');
  const oiUrl = new URL('/fapi/v1/openInterest', baseUrl);
  oiUrl.searchParams.set('symbol', symbol);
  const forceUrl = new URL('/fapi/v1/allForceOrders', baseUrl);
  forceUrl.searchParams.set('symbol', symbol);
  forceUrl.searchParams.set('limit', '50');

  const sample = { symbol, sampledAtMs: Date.now() };
  sample.depth = await fetchJson(fetchImpl, depthUrl.toString());
  sample.trades = await fetchJson(fetchImpl, tradesUrl.toString());
  sample.openInterest = await fetchJson(fetchImpl, oiUrl.toString());
  try {
    sample.forceOrders = await fetchJson(fetchImpl, forceUrl.toString());
  } catch (err) {
    sample.forceOrders = [];
    sample.forceOrderError = err && err.message ? err.message : 'force order fetch failed';
  }
  return sample;
}

function parseCandidatesJson(value) {
  if (!value) return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.radarCandidates)) return parsed.radarCandidates;
  if (parsed && Array.isArray(parsed.candidates)) return parsed.candidates;
  return [];
}

async function postSnapshot({ controlUrl, workerToken, workerId, snapshot, fetchImpl }) {
  const url = `${controlUrl.replace(/\/+$/, '')}/api/bot/radar-rolling-microstructure`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-BOT-WORKER-TOKEN': workerToken },
    body: JSON.stringify({ workerId, snapshot }),
  });
  if (!res || !res.ok) throw new Error(`radar-rolling-microstructure POST HTTP ${res ? res.status : 'failed'}`);
  return res.json();
}

export async function runRollingMicrostructureProducer(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  const workerToken = opts.workerToken ?? process.env.BOT_WORKER_TOKEN ?? '';
  const controlUrl = opts.controlUrl ?? process.env.BOT_CONTROL_URL ?? process.env.URL ?? '';
  if (!workerToken) throw new Error('BOT_WORKER_TOKEN is required');
  if (!controlUrl) throw new Error('controlUrl or BOT_CONTROL_URL is required');
  const options = normalizeRollingProducerOptions(opts);
  
  let previousSnapshot = opts.previousSnapshot || null;
  if (!previousSnapshot && opts.previousSnapshotJson) {
    try { previousSnapshot = JSON.parse(opts.previousSnapshotJson); } catch {}
  }
  if (options.mode === 'evaluate' && !previousSnapshot) {
    try {
      const getUrl = `${controlUrl.replace(/\/+$/, '')}/api/bot/radar-rolling-microstructure`;
      const getRes = await fetchImpl(getUrl, { headers: { Accept: 'application/json', 'X-BOT-WORKER-TOKEN': workerToken } });
      if (getRes && getRes.ok) {
        const getJson = await getRes.json();
        if (getJson && getJson.snapshot) previousSnapshot = getJson.snapshot;
      }
    } catch (err) {
      // Ignored: missing previous snapshot will keep trusted fields missing
    }
  }

  const cands = opts.candidates || parseCandidatesJson(opts.candidatesJson);
  const targets = selectRollingTargets(cands || [], options);
  const samples = [];
  const errors = [];
  for (const target of targets) {
    try { samples.push(await collectSample(fetchImpl, options.baseUrl, target.symbol)); }
    catch (err) { errors.push({ symbol: target.symbol, error: err && err.message ? err.message.slice(0, 180) : 'sample failed' }); }
  }
  const snapshot = buildRollingSnapshotFromSamples(samples, { ...options, previousSnapshot });
  snapshot.diagnostics.errors = errors;
  const postResult = await postSnapshot({ controlUrl, workerToken, workerId: opts.workerId || 'manual-rolling-microstructure-producer', snapshot, fetchImpl });
  return { ok: true, targets: targets.map((t) => t.symbol), snapshot, postResult };
}

export function readCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--control-url') opts.controlUrl = argv[++i];
    else if (a === '--worker-id') opts.workerId = argv[++i];
    else if (a === '--candidates-json') opts.candidatesJson = argv[++i];
    else if (a === '--top-n') opts.topN = argv[++i];
    else if (a === '--base-url') opts.baseUrl = argv[++i];
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--previous-snapshot-json') opts.previousSnapshotJson = argv[++i];
  }
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRollingMicrostructureProducer(readCliArgs(process.argv.slice(2)))
    .then((result) => {
      console.log(JSON.stringify({
        ok: result.ok,
        targets: result.targets,
        snapshot: {
          trusted: result.snapshot.trusted,
          diagnostics: result.snapshot.diagnostics,
        },
        postResult: { ok: result.postResult && result.postResult.ok, stored: result.postResult && result.postResult.stored },
      }, null, 2));
    })
    .catch((err) => {
      console.error(JSON.stringify({ ok: false, error: err && err.message ? err.message : 'rolling microstructure producer failed' }));
      process.exitCode = 1;
    });
}