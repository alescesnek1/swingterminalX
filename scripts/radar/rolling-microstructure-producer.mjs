#!/usr/bin/env node
/**
 * Disabled-by-default local foundation for rolling strict-Absorb measurements.
 * It is intentionally one-shot, public-data-only, and posts only when a second
 * explicit flag is supplied. It never marks a snapshot trusted.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { computeRollingAbsorption, classifyMakerFlag } from './rolling-microstructure-core.mjs';

const PUBLIC_FAPI_BASE = 'https://fapi.binance.com';
const SYMBOL_RE = /^[A-Z0-9]{2,24}(USDT|USDC)$/;
const DEFAULT_WINDOW_MS = 300_000;
const MAX_TOP_N = 10;

function isMainModule() {
  return Boolean(process.argv[1]) && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
}
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}
function bool(env, key) { return env && env[key] === 'true'; }
function asSymbol(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  for (const key of ['futures_pair', 'futuresPair', 'pair', 'symbol']) {
    const value = String(candidate[key] ?? '').trim().toUpperCase();
    if (SYMBOL_RE.test(value)) return value;
  }
  return null;
}

export function normalizeRollingProducerOptions({ env = process.env, ...opts } = {}) {
  return {
    enabled: bool(env, 'WORKER_RADAR_ROLLING_ENABLED'),
    postEnabled: bool(env, 'WORKER_RADAR_ROLLING_POST_ENABLED'),
    controlUrl: String(opts.controlUrl ?? env.CONTROL_BASE_URL ?? '').replace(/\/+$/, ''),
    workerToken: String(opts.workerToken ?? env.BOT_WORKER_TOKEN ?? ''),
    workerId: String(opts.workerId ?? env.WORKER_RADAR_ROLLING_WORKER_ID ?? 'local-rolling-microstructure'),
    topN: positiveInteger(opts.topN ?? env.WORKER_RADAR_ROLLING_TOP_N, 5, MAX_TOP_N),
    windowMs: positiveInteger(opts.windowMs ?? env.WORKER_RADAR_ROLLING_WINDOW_MS, DEFAULT_WINDOW_MS),
    minSamples: positiveInteger(opts.minSamples ?? env.WORKER_RADAR_ROLLING_MIN_SAMPLES, 10, 10_000),
    baseUrl: String(opts.baseUrl ?? PUBLIC_FAPI_BASE).replace(/\/+$/, ''),
  };
}

export function selectRollingTargets(candidates = [], options = {}) {
  const topN = positiveInteger(options.topN, 5, MAX_TOP_N);
  const seen = new Set();
  return (Array.isArray(candidates) ? candidates : []).flatMap((candidate) => {
    const symbol = asSymbol(candidate);
    if (!symbol || seen.has(symbol) || seen.size >= topN) return [];
    seen.add(symbol);
    return [{ symbol, candidate }];
  });
}

function depthSummary(depth) {
  const bids = Array.isArray(depth?.bids) ? depth.bids : [];
  const asks = Array.isArray(depth?.asks) ? depth.asks : [];
  const bestBid = finite(bids[0]?.[0]);
  const bestAsk = finite(asks[0]?.[0]);
  if (!(bestBid > 0 && bestAsk > bestBid)) return null;
  const mid = (bestBid + bestAsk) / 2;
  let bidDepth = 0;
  for (const row of bids) {
    const price = finite(row?.[0]); const qty = finite(row?.[1]);
    if (price > 0 && qty > 0 && price >= mid * 0.99) bidDepth += price * qty;
  }
  if (!(bidDepth > 0)) return null;
  return { bidDepth, spreadPct: ((bestAsk - bestBid) / mid) * 100 };
}

function validTradeCounts(trades, now, windowMs) {
  let valid = 0; let buyNotional = 0; let sellNotional = 0;
  for (const trade of Array.isArray(trades) ? trades : []) {
    const timestamp = finite(trade?.T); const price = finite(trade?.p); const qty = finite(trade?.q);
    const side = classifyMakerFlag(trade?.m);
    if (!(timestamp >= now - windowMs && timestamp <= now && price > 0 && qty > 0 && side)) continue;
    valid += 1;
    if (side === 'buy') buyNotional += price * qty; else sellNotional += price * qty;
  }
  return { valid, buyNotional, sellNotional };
}

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (!response || !response.ok) throw new Error(`HTTP ${response?.status ?? 'FAILED'}`);
  return response.json();
}

async function collectSymbol({ fetchImpl, baseUrl, symbol, now, windowMs }) {
  const tradeUrl = new URL('/fapi/v1/aggTrades', baseUrl);
  tradeUrl.searchParams.set('symbol', symbol);
  tradeUrl.searchParams.set('startTime', String(now - windowMs));
  tradeUrl.searchParams.set('endTime', String(now));
  tradeUrl.searchParams.set('limit', '1000');
  const depthUrl = new URL('/fapi/v1/depth', baseUrl);
  depthUrl.searchParams.set('symbol', symbol);
  depthUrl.searchParams.set('limit', '100');
  const [trades, firstDepth, secondDepth] = await Promise.all([getJson(fetchImpl, tradeUrl), getJson(fetchImpl, depthUrl), getJson(fetchImpl, depthUrl)]);
  const first = depthSummary(firstDepth); const second = depthSummary(secondDepth);
  const counts = validTradeCounts(trades, now, windowMs);
  const fields = computeRollingAbsorption({
    trades,
    snapshots: first && second ? { before: first, after: second } : undefined,
    context: second ? { spreadPct: second.spreadPct } : undefined,
    config: { windowMs },
  }, now);
  const row = {
    rollingMeasuredAt: new Date(now).toISOString(),
    rollingWindowSec: Math.floor(windowMs / 1000),
    samples: { aggTrades: counts.valid, depthSnapshots: first && second ? 2 : 0 },
    source: 'binance-futures-public',
  };
  for (const key of ['absorptionScore', 'bidDepthRebuildPct', 'aggressiveSellsFailed', 'deltaImprovementPct', 'marketBuyVolumeDominance', 'supportRetestHeld', 'spreadAndSlippageHealthy']) {
    if (fields[key] !== undefined) row[key] = fields[key];
  }
  // Existing display/gate readers understand these aliases. They are only added
  // when measured; a missing value stays absent, never false or zero-filled.
  if (fields.supportRetestHeld !== undefined) row.supportRetested = fields.supportRetestHeld;
  if (counts.buyNotional + counts.sellNotional > 0) {
    row.marketSellRatio = counts.sellNotional / (counts.buyNotional + counts.sellNotional);
    row.flow = { cumulativeDeltaPct: fields.deltaImprovementPct, takerBuySellRatio: counts.sellNotional > 0 ? counts.buyNotional / counts.sellNotional : undefined };
    Object.keys(row.flow).forEach((key) => row.flow[key] === undefined && delete row.flow[key]);
    if (!Object.keys(row.flow).length) delete row.flow;
  }
  return row;
}

export async function buildRollingSnapshotFromSamples({ candidates = [], fetchImpl, options = {}, now = Date.now() } = {}) {
  const data = {}; const errors = [];
  for (const { symbol } of selectRollingTargets(candidates, options)) {
    try {
      const row = await collectSymbol({ fetchImpl, baseUrl: options.baseUrl, symbol, now, windowMs: options.windowMs });
      // A row without a valid trade sample is not a measurement and is omitted.
      if (row.samples.aggTrades >= options.minSamples) data[symbol] = row;
    } catch (error) {
      errors.push({ symbol, reason: error?.message?.slice(0, 120) || 'sample-failed' });
    }
  }
  return {
    provider: 'local-rolling-foundation',
    updatedAtMs: now,
    // Deliberately false: this foundation cannot activate Strict Absorb.
    trusted: false,
    data,
    diagnostics: { requested: selectRollingTargets(candidates, options).length, stored: Object.keys(data).length, errors },
  };
}

export async function postRollingSnapshot({ controlUrl, workerToken, workerId, snapshot, fetchImpl }) {
  const response = await fetchImpl(`${controlUrl}/api/bot/radar-rolling-microstructure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-BOT-WORKER-TOKEN': workerToken },
    body: JSON.stringify({ workerId, snapshot }),
  });
  if (!response || !response.ok) throw new Error(`POST HTTP ${response?.status ?? 'FAILED'}`);
  return response.json();
}

export async function runRollingMicrostructureProducer({ env = process.env, fetchImpl = globalThis.fetch, logger = console, candidates = [], now = Date.now(), ...opts } = {}) {
  const options = normalizeRollingProducerOptions({ env, ...opts });
  const log = typeof logger?.log === 'function' ? logger.log.bind(logger) : () => {};
  if (!options.enabled) {
    log('[rolling-microstructure] disabled; set WORKER_RADAR_ROLLING_ENABLED=true for a local one-shot dry run.');
    return { ok: true, disabled: true, posted: false, snapshot: null };
  }
  if (options.postEnabled && !options.workerToken) return { ok: false, reason: 'BOT_WORKER_TOKEN_REQUIRED', posted: false };
  if (options.postEnabled && !options.controlUrl) return { ok: false, reason: 'CONTROL_BASE_URL_REQUIRED', posted: false };
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'FETCH_IMPLEMENTATION_REQUIRED', posted: false };
  const snapshot = await buildRollingSnapshotFromSamples({ candidates, fetchImpl, options, now });
  if (!options.postEnabled) return { ok: true, dryRun: true, posted: false, snapshot };
  const postResult = await postRollingSnapshot({ controlUrl: options.controlUrl, workerToken: options.workerToken, workerId: options.workerId, snapshot, fetchImpl });
  return { ok: true, dryRun: false, posted: true, snapshot, postResult };
}

if (isMainModule()) {
  runRollingMicrostructureProducer()
    .then((result) => { console.log(JSON.stringify({ ok: result.ok, disabled: result.disabled === true, dryRun: result.dryRun === true, posted: result.posted === true, reason: result.reason || null, symbols: Object.keys(result.snapshot?.data || {}) })); if (!result.ok) process.exitCode = 1; })
    .catch((error) => { console.error(JSON.stringify({ ok: false, reason: error?.message || 'rolling-producer-failed' })); process.exitCode = 1; });
}