export const BINANCE_ALPHA_EXCHANGE_INFO_URL = 'https://www.binance.com/bapi/defi/v1/public/alpha-trade/get-exchange-info';

const ACTIVE_STATUSES = new Set(['TRADING', 'ACTIVE', 'ENABLED', 'ONLINE', '1', 'TRUE']);
const INACTIVE_STATUSES = new Set(['BREAK', 'HALT', 'HALTED', 'SUSPENDED', 'OFFLINE', 'DELISTED', 'DISABLED', '0', 'FALSE']);
const STABLE_QUOTES = ['USDT', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'USD'];

function upper(v) { return String(v == null ? '' : v).trim().toUpperCase(); }

export function normalizeAlphaPairSymbol(input = {}) {
  const symbol = upper(input.symbol || input.pair || input.alphaSymbol || input.alphaPair || input.tradingPair);
  if (symbol.includes('/')) return symbol.replace(/\s+/g, '');
  const base = upper(input.baseAsset || input.baseToken || input.base || input.baseAssetName || input.tokenSymbol);
  const quote = upper(input.quoteAsset || input.quoteToken || input.quote || input.quoteAssetName);
  if (base && quote) return `${base}/${quote}`;
  const compact = symbol.replace(/[^A-Z0-9]/g, '');
  for (const q of STABLE_QUOTES) {
    if (compact.length > q.length && compact.endsWith(q)) return `${compact.slice(0, -q.length)}/${q}`;
  }
  return compact;
}

function normalizeStatus(row = {}) {
  const raw = upper(row.status || row.tradingStatus || row.symbolStatus || row.state || row.enableTrading || row.isTrading);
  if (!raw) return { status: 'UNKNOWN', active: false };
  if (ACTIVE_STATUSES.has(raw)) return { status: raw === 'TRUE' || raw === '1' ? 'TRADING' : raw, active: true };
  if (INACTIVE_STATUSES.has(raw)) return { status: raw, active: false };
  return { status: raw, active: false };
}

function firstString(row = {}, keys = []) {
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}

function collectRows(payload) {
  const data = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
  if (Array.isArray(data)) {
    const flattened = [];
    for (const item of data) {
      if (item && typeof item === 'object') {
        let usedNested = false;
        for (const key of ['symbols', 'symbolList', 'list', 'rows', 'pairs', 'exchangeInfo']) {
          if (Array.isArray(item[key])) {
            flattened.push(...item[key]);
            usedNested = true;
          }
        }
        if (!usedNested) flattened.push(item);
      }
    }
    return flattened;
  }
  if (!data || typeof data !== 'object') return [];
  for (const key of ['symbols', 'symbolList', 'list', 'rows', 'pairs', 'exchangeInfo']) {
    if (Array.isArray(data[key])) return data[key];
  }
  if (data.data && data.data !== data) return collectRows(data);
  return [];
}

export function parseBinanceAlphaExchangeInfo(payload) {
  const rows = collectRows(payload);
  const listings = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const pair = normalizeAlphaPairSymbol(row);
    if (!pair) continue;
    const [baseFromPair, quoteFromPair] = pair.includes('/') ? pair.split('/') : [null, null];
    const baseAsset = upper(row.baseAsset || row.baseToken || row.base || row.baseAssetName || row.tokenSymbol || baseFromPair);
    const quoteAsset = upper(row.quoteAsset || row.quoteToken || row.quote || row.quoteAssetName || quoteFromPair);
    const statusInfo = normalizeStatus(row);
    const symbol = pair.includes('/') ? pair.replace('/', '') : pair;
    listings.push({
      symbol,
      pair: pair.includes('/') ? pair : (baseAsset && quoteAsset ? `${baseAsset}/${quoteAsset}` : pair),
      alphaSymbol: firstString(row, ['alphaSymbol', 'symbol', 'pair', 'tradingPair']) || pair,
      baseAsset,
      quoteAsset,
      alphaTokenId: firstString(row, ['tokenId', 'tokenID', 'alphaTokenId', 'baseAssetId', 'baseTokenId', 'tokenListId', 'cmcId']) || (/^ALPHA_\d+$/i.test(baseAsset) ? baseAsset : null),
      status: statusInfo.status,
      active: statusInfo.active,
      source: 'binance-alpha',
      exchange: 'binance-alpha',
      listingType: 'BINANCE_ALPHA',
      raw: row,
    });
  }
  return listings;
}

export async function fetchBinanceAlphaExchangeInfo({ fetchImpl = globalThis.fetch, url = BINANCE_ALPHA_EXCHANGE_INFO_URL } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, listings: [], error: 'fetch unavailable' };
  try {
    const res = await fetchImpl(url);
    if (!res || !res.ok) throw new Error(`Binance Alpha exchangeInfo HTTP ${res ? res.status : 'unknown'}`);
    const json = await res.json();
    return { ok: true, listings: parseBinanceAlphaExchangeInfo(json), error: null };
  } catch (err) {
    return { ok: false, listings: [], error: err && err.message ? err.message : String(err) };
  }
}
