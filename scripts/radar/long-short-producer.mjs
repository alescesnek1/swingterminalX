#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildLongShortContext } from './long-short-context.mjs';
import { normalizeLongShortSnapshot } from './long-short-snapshot.mjs';

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
}

const DEFAULT_PERIOD = '5m';
const SUPPORTED_PERIODS = new Set(['5m', '15m', '30m', '1h']);
const DEFAULT_TOP_N = 20;
const MAX_TOP_N = 20;
const DEFAULT_LIMIT = 2;
const MAX_LIMIT = 2;
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

export function resolveLongShortSymbol(candidate = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const futuresPair = stablePair(candidate.futures_pair ?? candidate.futuresPair);
  if (futuresPair) return futuresPair;
  for (const key of ['pair', 'symbol']) {
    const symbol = stablePair(candidate[key]);
    if (symbol) return symbol;
  }
  return null;
}

export function normalizeLongShortProducerOptions(opts = {}) {
  const period = SUPPORTED_PERIODS.has(String(opts.period || '').trim()) ? String(opts.period).trim() : DEFAULT_PERIOD;
  return {
    topN: clampPositiveInteger(opts.topN, DEFAULT_TOP_N, MAX_TOP_N),
    limit: clampPositiveInteger(opts.limit, DEFAULT_LIMIT, MAX_LIMIT),
    period,
    baseUrl: typeof opts.baseUrl === 'string' && opts.baseUrl ? opts.baseUrl.replace(/\/+$/, '') : PUBLIC_FAPI_BASE,
  };
}

export function selectLongShortTargets(candidates = [], opts = {}) {
  const { topN } = normalizeLongShortProducerOptions(opts);
  const out = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const symbol = resolveLongShortSymbol(candidate);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, candidate });
    if (out.length >= topN) break;
  }
  return out;
}

function parseCandidatesJson(value) {
  if (!value) return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.radarCandidates)) return parsed.radarCandidates;
  if (parsed && Array.isArray(parsed.candidates)) return parsed.candidates;
  return [];
}

async function fetchCandidates({ controlUrl, workerToken, fetchImpl }) {
  if (!controlUrl) return [];
  const url = `${controlUrl.replace(/\/+$/, '')}/api/bot/radar-candidates`;
  const res = await fetchImpl(url, { headers: { 'X-BOT-WORKER-TOKEN': workerToken, Accept: 'application/json' } });
  if (!res || !res.ok) throw new Error(`radar-candidates HTTP ${res ? res.status : 'failed'}`);
  const json = await res.json();
  return Array.isArray(json.radarCandidates) ? json.radarCandidates : [];
}

async function fetchJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'failed'}`);
  const json = await res.json();
  return Array.isArray(json) ? json : [];
}

async function fetchLongShortSeries({ symbol, period, limit, baseUrl, fetchImpl }) {
  const params = { symbol, period, limit: String(limit) };
  const makeUrl = (pathname) => {
    const url = new URL(pathname, baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  };
  const out = {};
  const errors = [];
  const endpoints = [
    ['topTraderPositionRatioSeries', '/futures/data/topLongShortPositionRatio'],
    ['globalAccountRatioSeries', '/futures/data/globalLongShortAccountRatio'],
    ['takerRatioSeries', '/futures/data/takerlongshortRatio'],
  ];
  for (const [key, pathname] of endpoints) {
    try {
      out[key] = await fetchJson(fetchImpl, makeUrl(pathname));
    } catch (err) {
      out[key] = [];
      errors.push({ endpoint: pathname, error: err && err.message ? String(err.message).slice(0, 120) : 'fetch failed' });
    }
  }
  return { ...out, errors };
}

function buildSnapshotFromContexts(contexts, opts = {}) {
  const options = normalizeLongShortProducerOptions(opts);
  const symbols = {};
  for (const row of contexts) {
    if (row && row.symbol) symbols[row.symbol] = row;
  }
  return normalizeLongShortSnapshot({
    source: 'binance-futures-data',
    contextOnly: true,
    updatedAt: new Date(Number(opts.nowMs ?? Date.now())).toISOString(),
    period: options.period,
    topN: options.topN,
    symbols,
  }, { nowMs: opts.nowMs });
}

async function postSnapshot({ controlUrl, workerToken, workerId, snapshot, fetchImpl }) {
  const url = `${controlUrl.replace(/\/+$/, '')}/api/bot/radar-long-short`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-BOT-WORKER-TOKEN': workerToken,
    },
    body: JSON.stringify({ workerId, snapshot }),
  });
  if (!res || !res.ok) throw new Error(`radar-long-short POST HTTP ${res ? res.status : 'failed'}`);
  return res.json();
}

export async function runLongShortProducer(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  const workerToken = opts.workerToken ?? process.env.BOT_WORKER_TOKEN ?? '';
  const controlUrl = opts.controlUrl ?? process.env.BOT_CONTROL_URL ?? process.env.URL ?? '';
  const workerId = String(opts.workerId || 'manual-long-short-producer').slice(0, 80);
  const options = normalizeLongShortProducerOptions(opts);
  const diagnostics = { attempted: 0, fetched: 0, failed: 0, errors: [], posted: false };

  if (!workerToken) throw new Error('BOT_WORKER_TOKEN is required');
  if (!controlUrl) throw new Error('controlUrl or BOT_CONTROL_URL is required');

  const candidates = opts.candidates || parseCandidatesJson(opts.candidatesJson) || await fetchCandidates({ controlUrl, workerToken, fetchImpl });
  const targets = selectLongShortTargets(candidates, options);
  const contexts = [];
  for (const target of targets) {
    diagnostics.attempted += 1;
    const series = await fetchLongShortSeries({ symbol: target.symbol, ...options, fetchImpl });
    if (series.errors.length) {
      diagnostics.errors.push(...series.errors.map((e) => ({ symbol: target.symbol, ...e })));
    }
    const context = buildLongShortContext({
      symbol: target.symbol,
      period: options.period,
      source: 'binance-futures-data',
      globalAccountRatioSeries: series.globalAccountRatioSeries,
      topTraderPositionRatioSeries: series.topTraderPositionRatioSeries,
      takerRatioSeries: series.takerRatioSeries,
      nowMs: opts.nowMs,
    });
    contexts.push(context);
    if (context.available === true) diagnostics.fetched += 1;
    else diagnostics.failed += 1;
  }
  const snapshot = buildSnapshotFromContexts(contexts, { ...options, nowMs: opts.nowMs });
  const postResult = await postSnapshot({ controlUrl, workerToken, workerId, snapshot, fetchImpl });
  diagnostics.posted = true;
  return { ok: true, targets: targets.map((t) => t.symbol), snapshot, diagnostics, postResult };
}

export function readCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--control-url') opts.controlUrl = argv[++i];
    else if (a === '--worker-id') opts.workerId = argv[++i];
    else if (a === '--candidates-json') opts.candidatesJson = argv[++i];
    else if (a === '--top-n') opts.topN = argv[++i];
    else if (a === '--period') opts.period = argv[++i];
    else if (a === '--limit') opts.limit = argv[++i];
    else if (a === '--base-url') opts.baseUrl = argv[++i];
  }
  return opts;
}

if (isMainModule()) {
  runLongShortProducer(readCliArgs(process.argv.slice(2)))
    .then((result) => {
      console.log(JSON.stringify({
        ok: result.ok,
        targets: result.targets,
        diagnostics: result.diagnostics,
        snapshotDiagnostics: result.snapshot.diagnostics,
        post: { ok: result.postResult && result.postResult.ok, stored: result.postResult && result.postResult.stored },
      }, null, 2));
    })
    .catch((err) => {
      console.error(JSON.stringify({ ok: false, error: err && err.message ? err.message : 'long/short producer failed' }));
      process.exitCode = 1;
    });
}
