#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeKlinesSnapshot } from './klines-snapshot.mjs';

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
  } catch (err) {
    return false;
  }
}

const DEFAULT_TIMEFRAME = '1h';
const SUPPORTED_TIMEFRAMES = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d']);
const DEFAULT_TOP_N = 20;
const MAX_TOP_N = 50;
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 120;
const PUBLIC_FAPI_BASE = 'https://fapi.binance.com';
const STABLE_PAIR_RE = /^[A-Z0-9]{2,24}(USDT|USDC)$/;

function clampPositiveInteger(value, fallback, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function cleanSymbol(value) {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,24}$/.test(symbol)) return null;
  return symbol;
}

function isStablePair(value) {
  const symbol = cleanSymbol(value);
  return symbol && STABLE_PAIR_RE.test(symbol) ? symbol : null;
}

export function resolveKlineSymbol(candidate = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;

  const futuresPair = isStablePair(candidate.futures_pair ?? candidate.futuresPair);
  if (futuresPair) return futuresPair;

  for (const key of ['pair', 'symbol']) {
    const symbol = isStablePair(candidate[key]);
    if (symbol) return symbol;
  }

  return null;
}

export function normalizeProducerOptions(opts = {}) {
  const topN = clampPositiveInteger(opts.topN, DEFAULT_TOP_N, MAX_TOP_N);
  const limit = clampPositiveInteger(opts.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const timeframe = SUPPORTED_TIMEFRAMES.has(String(opts.timeframe || '').trim()) ? String(opts.timeframe).trim() : DEFAULT_TIMEFRAME;
  const baseUrl = typeof opts.baseUrl === 'string' && opts.baseUrl ? opts.baseUrl.replace(/\/+$/, '') : PUBLIC_FAPI_BASE;
  return { topN, limit, timeframe, baseUrl };
}

export function selectKlineTargets(candidates = [], opts = {}) {
  const { topN } = normalizeProducerOptions(opts);
  const out = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const symbol = resolveKlineSymbol(candidate);
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

async function fetchKlines({ symbol, timeframe, limit, baseUrl, fetchImpl }) {
  const url = new URL('/fapi/v1/klines', baseUrl);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', timeframe);
  url.searchParams.set('limit', String(limit));
  const res = await fetchImpl(url.toString(), { headers: { Accept: 'application/json' } });
  if (!res || !res.ok) throw new Error(`klines HTTP ${res ? res.status : 'failed'}`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('klines response must be an array');
  return json;
}

async function postSnapshot({ controlUrl, workerToken, workerId, snapshot, fetchImpl }) {
  const url = `${controlUrl.replace(/\/+$/, '')}/api/bot/radar-klines`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-BOT-WORKER-TOKEN': workerToken,
    },
    body: JSON.stringify({ workerId, snapshot }),
  });
  if (!res || !res.ok) throw new Error(`radar-klines POST HTTP ${res ? res.status : 'failed'}`);
  return res.json();
}

export async function runKlinesProducer(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  const workerToken = opts.workerToken ?? process.env.BOT_WORKER_TOKEN ?? '';
  const controlUrl = opts.controlUrl ?? process.env.BOT_CONTROL_URL ?? process.env.URL ?? '';
  const workerId = String(opts.workerId || 'manual-klines-producer').slice(0, 80);
  const options = normalizeProducerOptions(opts);
  const diagnostics = { attempted: 0, fetched: 0, failed: 0, errors: [], posted: false };

  if (!workerToken) throw new Error('BOT_WORKER_TOKEN is required');
  if (!controlUrl) throw new Error('controlUrl or BOT_CONTROL_URL is required');

  const candidates = opts.candidates || parseCandidatesJson(opts.candidatesJson) || await fetchCandidates({ controlUrl, workerToken, fetchImpl });
  const targets = selectKlineTargets(candidates, options);
  const data = {};

  for (const target of targets) {
    diagnostics.attempted += 1;
    try {
      data[target.symbol] = await fetchKlines({ symbol: target.symbol, timeframe: options.timeframe, limit: options.limit, baseUrl: options.baseUrl, fetchImpl });
      diagnostics.fetched += 1;
    } catch (err) {
      diagnostics.failed += 1;
      diagnostics.errors.push({ symbol: target.symbol, error: err && err.message ? String(err.message).slice(0, 180) : 'fetch failed' });
    }
  }

  const snapshot = normalizeKlinesSnapshot({
    timeframe: options.timeframe,
    limit: options.limit,
    topN: options.topN,
    updatedAtMs: Date.now(),
    data,
  }, { limit: options.limit, topN: options.topN, timeframe: options.timeframe });

  const postResult = await postSnapshot({ controlUrl, workerToken, workerId, snapshot, fetchImpl });
  diagnostics.posted = true;
  return { ok: true, targets: targets.map((t) => t.symbol), snapshot, diagnostics, postResult };
}

function readCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--control-url') opts.controlUrl = argv[++i];
    else if (a === '--worker-id') opts.workerId = argv[++i];
    else if (a === '--candidates-json') opts.candidatesJson = argv[++i];
    else if (a === '--top-n') opts.topN = argv[++i];
    else if (a === '--limit') opts.limit = argv[++i];
    else if (a === '--timeframe') opts.timeframe = argv[++i];
    else if (a === '--base-url') opts.baseUrl = argv[++i];
  }
  return opts;
}

if (isMainModule()) {
  runKlinesProducer(readCliArgs(process.argv.slice(2)))
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
      console.error(JSON.stringify({ ok: false, error: err && err.message ? err.message : 'klines producer failed' }));
      process.exitCode = 1;
    });
}