export const KUCOIN_PUBLIC_CANDLE_ENDPOINT = 'https://api.kucoin.com/api/ua/v1/market/kline';
export const KUCOIN_PUBLIC_CANDLE_SOURCE_TYPE = 'kucoin-public-uta-klines';
const KUCOIN_PUBLIC_HOST = 'api.kucoin.com';
const INTERVALS = Object.freeze({ '1min': { contract: '1m', ms: 60000 }, '5min': { contract: '5m', ms: 300000 }, '15min': { contract: '15m', ms: 900000 }, '1hour': { contract: '1h', ms: 3600000 }, '4hour': { contract: '4h', ms: 14400000 }, '1day': { contract: '1d', ms: 86400000 } });
const MAX_RECORDS_PER_PAGE = 1500;
function record(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function utcIso(ms) { return new Date(ms).toISOString(); }
function add(values, value) { if (!values.includes(value)) values.push(value); }
export function assertKuCoinPublicCandleUrl(value) { const url = value instanceof URL ? value : new URL(value); if (url.protocol !== 'https:' || url.hostname !== KUCOIN_PUBLIC_HOST || url.username || url.password || url.pathname !== '/api/ua/v1/market/kline') throw new Error('untrusted_kucoin_public_url'); return url; }
export function parseKuCoinUtcDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('invalid_utc_date');
  const ms = Date.parse(value + 'T00:00:00.000Z');
  if (!Number.isFinite(ms) || utcIso(ms).slice(0, 10) !== value) throw new Error('invalid_utc_date');
  return ms;
}
export function normalizeKuCoinSymbol(symbol, quote) {
  const normalized = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
  const normalizedQuote = typeof quote === 'string' ? quote.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{2,20}-[A-Z0-9]{2,10}$/.test(normalized) || !['USDT', 'USDC'].includes(normalizedQuote) || !normalized.endsWith('-' + normalizedQuote)) throw new Error('invalid_kucoin_symbol');
  return normalized;
}
export function kucoinInterval(interval) {
  const mapped = INTERVALS[interval];
  if (!mapped) throw new Error('unsupported_kucoin_interval');
  return mapped;
}
export function normalizeKuCoinCandleRow(row, intervalMs) {
  if (!Array.isArray(row) || row.length < 7) throw new Error('invalid_kucoin_candle_row');
  const startSeconds = Number(row[0]); const open = Number(row[1]); const high = Number(row[2]); const low = Number(row[3]); const close = Number(row[4]); const volume = Number(row[5]); const quoteVolume = Number(row[6]);
  const openMs = startSeconds * 1000;
  if (![openMs, open, high, low, close, volume, quoteVolume].every(finite) || openMs < 0) throw new Error('invalid_kucoin_candle_row');
  return { openTime: utcIso(openMs), closeTime: utcIso(openMs + intervalMs), open, high, low, close, volume, quoteVolume, sourceStatus: 'AVAILABLE' };
}
export function buildKuCoinHistoricalDataset({ symbol, quote, interval, fromMs, toMs, rows, fetchedAt }) {
  const mapping = kucoinInterval(interval);
  const safeSymbol = normalizeKuCoinSymbol(symbol, quote);
  if (!finite(fromMs) || !finite(toMs) || fromMs >= toMs) throw new Error('invalid_kucoin_range');
  const candles = rows.map((row) => normalizeKuCoinCandleRow(row, mapping.ms)).filter((candle) => Date.parse(candle.openTime) >= fromMs && Date.parse(candle.openTime) < toMs).sort((a, b) => a.openTime.localeCompare(b.openTime));
  const seen = new Set(); const duplicates = []; const gaps = []; let prior = null;
  for (const candle of candles) { const openMs = Date.parse(candle.openTime); if (seen.has(openMs)) add(duplicates, openMs); if (prior != null && openMs - prior > mapping.ms) gaps.push({ start: utcIso(prior + mapping.ms), end: utcIso(openMs), status: 'UNKNOWN' }); seen.add(openMs); prior = openMs; }
  return { schemaVersion: 'historical-market-data/v1', datasetVersion: 'kucoin-public-candles/v1', provenance: { provider: 'kucoin', venue: 'kucoin', product: 'spot', quote: quote.toUpperCase(), symbol: safeSymbol, sourceType: KUCOIN_PUBLIC_CANDLE_SOURCE_TYPE, sourceUrl: KUCOIN_PUBLIC_CANDLE_ENDPOINT, fetchedAt, importedAt: fetchedAt }, interval: mapping.contract, range: { start: utcIso(fromMs), end: utcIso(toMs), timezone: 'UTC' }, candles, gaps, corrections: duplicates.map((openMs) => ({ openTime: utcIso(openMs), status: 'DUPLICATE_SOURCE_ROW' })), depth: { status: 'UNKNOWN' } };
}
export async function fetchKuCoinPublicCandles({ product = 'spot', symbol, quote, interval, fromMs, toMs, fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = 15000 } = {}) {
  if (product !== 'spot') throw new Error('unsupported_product');
  if (typeof fetchImpl !== 'function') throw new Error('missing_fetch_implementation');
  const mapping = kucoinInterval(interval); const safeSymbol = normalizeKuCoinSymbol(symbol, quote);
  if (!finite(fromMs) || !finite(toMs) || fromMs >= toMs) throw new Error('invalid_kucoin_range');
  const rawRows = []; let cursor = fromMs; let page = 0;
  while (cursor < toMs) {
    const pageEnd = Math.min(toMs, cursor + mapping.ms * MAX_RECORDS_PER_PAGE);
    const url = new URL(KUCOIN_PUBLIC_CANDLE_ENDPOINT); url.searchParams.set('tradeType', 'SPOT'); url.searchParams.set('symbol', safeSymbol); url.searchParams.set('interval', interval); url.searchParams.set('startAt', String(Math.floor(cursor / 1000))); url.searchParams.set('endAt', String(Math.floor(pageEnd / 1000)));
    assertKuCoinPublicCandleUrl(url); let response; let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); try { response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal }); if (response?.ok === true) break; lastError = new Error('http_' + (response?.status ?? 'unknown')); } catch (error) { lastError = error; } finally { clearTimeout(timer); } }
    if (!response || response.ok !== true) throw new Error('kucoin_public_candles_request_failed:' + (lastError?.name ?? 'unknown'));
    let payload; try { payload = await response.json(); } catch { throw new Error('kucoin_public_candles_invalid_json'); }
    const rows = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload?.data?.list) ? payload.data.list : null);
    if (!record(payload) || payload.code !== '200000' || !rows) throw new Error('kucoin_public_candles_invalid_response');
    rawRows.push(...rows); page += 1;
    if (page > 1000) throw new Error('kucoin_public_candles_page_limit');
    cursor = pageEnd;
  }
  const fetchedAt = now().toISOString();
  const dataset = buildKuCoinHistoricalDataset({ symbol: safeSymbol, quote, interval, fromMs, toMs, rows: rawRows, fetchedAt });
  return { dataset, request: { endpoint: KUCOIN_PUBLIC_CANDLE_ENDPOINT, product: 'spot', symbol: safeSymbol, interval, fromMs, toMs, pages: page, publicOnly: true }, sourceWarnings: dataset.gaps.length ? ['candle_gap'] : [] };
}
