// token-metadata.mjs - conservative token metadata resolver for the safety layer.
//
// Honesty contract:
//   - NEVER guess chain/contract from a ticker alone.
//   - Binance LISTING is a separate axis from CHAIN-CONTRACT safety. A confirmed
//     active Binance listing supports listingSafetyStatus = LISTING_SAFE
//     (basis CEX_LISTING) but NEVER fakes chainSafetyStatus = SAFE.
//   - External providers (CoinGecko / GeckoTerminal) are OPTIONAL. They only run
//     when a fetch impl is injected, are cached + rate-capped, and fail soft
//     (PROVIDER_RATE_LIMITED / METADATA_FETCH_FAILED). Scanner/RADAR must keep
//     working when providers are unavailable.

import { fetchBinanceAlphaExchangeInfo, normalizeAlphaPairSymbol } from './binance-alpha-provider.mjs';

export const METADATA_REASONS = Object.freeze({
  ALLOWLISTED: 'ALLOWLISTED',
  RESOLVED: 'RESOLVED',
  MISSING_CONTRACT_METADATA: 'MISSING_CONTRACT_METADATA',
  AMBIGUOUS_CONTRACT_MAPPING: 'AMBIGUOUS_CONTRACT_MAPPING',
  METADATA_FETCH_FAILED: 'METADATA_FETCH_FAILED',
  PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  CEX_ONLY_NO_CONTRACT_CONTEXT: 'CEX_ONLY_NO_CONTRACT_CONTEXT',
});

export const LISTING_STATUS = Object.freeze({
  LISTING_SAFE: 'LISTING_SAFE',
  LISTING_CAUTION: 'LISTING_CAUTION',
  LISTING_UNKNOWN: 'LISTING_UNKNOWN',
});

const CEX_QUOTES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'USD', 'BTC', 'ETH', 'BNB'];
const MIN_ACTIVE_VOL_USD = 1_000_000;
const META_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_PROVIDER_CALLS = 25;   // hard cap per warm pass

const ALLOWLIST = Object.freeze({
  BTC: { chain: 'bitcoin', contractAddress: 'native:bitcoin', name: 'Bitcoin' },
  ETH: { chain: 'ethereum', contractAddress: 'native:ethereum', name: 'Ether' },
  BNB: { chain: 'bsc', contractAddress: 'native:bsc', name: 'BNB' },
  SOL: { chain: 'solana', contractAddress: 'native:solana', name: 'Solana' },
  ADA: { chain: 'cardano', contractAddress: 'native:cardano', name: 'Cardano' },
  AVAX: { chain: 'avalanche', contractAddress: 'native:avalanche', name: 'Avalanche' },
  DOT: { chain: 'polkadot', contractAddress: 'native:polkadot', name: 'Polkadot' },
  TRX: { chain: 'tron', contractAddress: 'native:tron', name: 'TRON' },
  XRP: { chain: 'xrpl', contractAddress: 'native:xrpl', name: 'XRP' },
  LTC: { chain: 'litecoin', contractAddress: 'native:litecoin', name: 'Litecoin' },
  ATOM: { chain: 'cosmos', contractAddress: 'native:cosmos', name: 'Cosmos' },
  NEAR: { chain: 'near', contractAddress: 'native:near', name: 'NEAR' },
  APT: { chain: 'aptos', contractAddress: 'native:aptos', name: 'Aptos' },
  SUI: { chain: 'sui', contractAddress: 'native:sui', name: 'Sui' },
  INJ: { chain: 'injective', contractAddress: 'native:injective', name: 'Injective' },
  DOGE: { chain: 'dogecoin', contractAddress: 'native:dogecoin', name: 'Dogecoin' },
  BCH: { chain: 'bitcoin-cash', contractAddress: 'native:bitcoin-cash', name: 'Bitcoin Cash' },
  ETC: { chain: 'ethereum-classic', contractAddress: 'native:ethereum-classic', name: 'Ethereum Classic' },
  XLM: { chain: 'stellar', contractAddress: 'native:stellar', name: 'Stellar' },
  XMR: { chain: 'monero', contractAddress: 'native:monero', name: 'Monero' },
  XTZ: { chain: 'tezos', contractAddress: 'native:tezos', name: 'Tezos' },
  ALGO: { chain: 'algorand', contractAddress: 'native:algorand', name: 'Algorand' },
  HBAR: { chain: 'hedera', contractAddress: 'native:hedera', name: 'Hedera' },
  ICP: { chain: 'internet-computer', contractAddress: 'native:internet-computer', name: 'Internet Computer' },
  FIL: { chain: 'filecoin', contractAddress: 'native:filecoin', name: 'Filecoin' },
  EGLD: { chain: 'multiversx', contractAddress: 'native:multiversx', name: 'MultiversX' },
  FLOW: { chain: 'flow', contractAddress: 'native:flow', name: 'Flow' },
  KAS: { chain: 'kaspa', contractAddress: 'native:kaspa', name: 'Kaspa' },
  TON: { chain: 'ton', contractAddress: 'native:ton', name: 'Toncoin' },
  RUNE: { chain: 'thorchain', contractAddress: 'native:thorchain', name: 'THORChain' },
  STX: { chain: 'stacks', contractAddress: 'native:stacks', name: 'Stacks' },
  KAVA: { chain: 'kava', contractAddress: 'native:kava', name: 'Kava' },
  MINA: { chain: 'mina', contractAddress: 'native:mina', name: 'Mina' },
  ROSE: { chain: 'oasis', contractAddress: 'native:oasis', name: 'Oasis' },
  ZIL: { chain: 'zilliqa', contractAddress: 'native:zilliqa', name: 'Zilliqa' },
  CELO: { chain: 'celo', contractAddress: 'native:celo', name: 'Celo' },
  EOS: { chain: 'eos', contractAddress: 'native:eos', name: 'EOS' },
  NEO: { chain: 'neo', contractAddress: 'native:neo', name: 'NEO' },
  VET: { chain: 'vechain', contractAddress: 'native:vechain', name: 'VeChain' },
  QTUM: { chain: 'qtum', contractAddress: 'native:qtum', name: 'Qtum' },
  WAVES: { chain: 'waves', contractAddress: 'native:waves', name: 'Waves' },
  OSMO: { chain: 'osmosis', contractAddress: 'native:osmosis', name: 'Osmosis' },
  KSM: { chain: 'kusama', contractAddress: 'native:kusama', name: 'Kusama' },
  SEI: { chain: 'sei', contractAddress: 'native:sei', name: 'Sei' },
  TIA: { chain: 'celestia', contractAddress: 'native:celestia', name: 'Celestia' },
  DASH: { chain: 'dash', contractAddress: 'native:dash', name: 'Dash' },
  ZEC: { chain: 'zcash', contractAddress: 'native:zcash', name: 'Zcash' },
  RVN: { chain: 'ravencoin', contractAddress: 'native:ravencoin', name: 'Ravencoin' },
  ONE: { chain: 'harmony', contractAddress: 'native:harmony', name: 'Harmony' },
  USDC: { chain: 'ethereum', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', name: 'USD Coin' },
  USDT: { chain: 'ethereum', contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7', name: 'Tether USD' },
  LINK: { chain: 'ethereum', contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca', name: 'Chainlink' },
  UNI: { chain: 'ethereum', contractAddress: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', name: 'Uniswap' },
  AAVE: { chain: 'ethereum', contractAddress: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', name: 'Aave' },
  MKR: { chain: 'ethereum', contractAddress: '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', name: 'Maker' },
  LDO: { chain: 'ethereum', contractAddress: '0x5a98fcbea516cf06857215779fd812ca3bef1b32', name: 'Lido DAO' },
  CRV: { chain: 'ethereum', contractAddress: '0xd533a949740bb3306d119cc777fa900ba034cd52', name: 'Curve DAO' },
  COMP: { chain: 'ethereum', contractAddress: '0xc00e94cb662c3520282e6f5717214004a7f26888', name: 'Compound' },
  SNX: { chain: 'ethereum', contractAddress: '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f', name: 'Synthetix' },
  ARB: { chain: 'arbitrum', contractAddress: '0x912ce59144191c1204e64559fe8253a0e49e6548', name: 'Arbitrum' },
});

const AMBIGUOUS = new Set(['BTCB', 'WETH', 'WBTC', 'MULTI', 'BRIDGE', 'O3', 'BIT', 'GAS', 'CAT', 'GMT', 'AGI', 'KEY', 'FT']);

// ---- module cache + provider counters (fail-soft, observable) ----
const cache = new Map();           // base -> { at, value }  (provider chain meta)
const listCache = new Map();       // 'coingecko-list' -> { at, value }
const alphaCache = new Map();      // 'binance-alpha-list' -> { at, value }
let counters = freshCounters();
function freshCounters() {
  return {
    metadataProviderCalls: 0,
    metadataProviderFailures: 0,
    metadataCacheHits: 0,
    metadataCacheMisses: 0,
    coingeckoResolvedCount: 0,
    geckoTerminalResolvedCount: 0,
    ambiguousMetadataCount: 0,
    providerRateLimitedCount: 0,
    binanceAlphaProviderCalls: 0,
    binanceAlphaProviderFailures: 0,
    binanceAlphaResolvedCount: 0,
    binanceAlphaListingSafeCount: 0,
    alphaListingUnknownCount: 0,
    alphaSymbolsSample: [],
  };
}
export function getMetadataDiagnostics() { return { ...counters }; }
export function __clearTokenMetadataCache() { cache.clear(); listCache.clear(); alphaCache.clear(); counters = freshCounters(); }

function num(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function isAddress(v) { return typeof v === 'string' && v.trim().length > 0; }

function baseInfo(input) {
  if (input && input.baseAsset) {
    return { base: String(input.baseAsset).toUpperCase(), quote: input.quoteAsset ? String(input.quoteAsset).toUpperCase() : null, hadQuote: true };
  }
  const s = String((input && (input.symbol || input.pair)) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const q of CEX_QUOTES) {
    if (s.length > q.length && s.endsWith(q)) return { base: s.slice(0, -q.length), quote: q, hadQuote: true };
  }
  return { base: s, quote: null, hadQuote: false };
}

// ---- Binance listing axis (offline; derived from the Binance-sourced row) ----
export function resolveBinanceListing(market = {}, opts = {}) {
  if (alphaContext(market)) {
    return { listed: false, active: false, exchange: null, listingStatus: 'UNKNOWN', listingSafetyStatus: LISTING_STATUS.LISTING_UNKNOWN, listingSafetyReason: 'NO_LISTING_CONTEXT' };
  }
  const sym = String(market.symbol || '').toUpperCase();
  const activeSet = opts.binanceActiveSymbols instanceof Set ? opts.binanceActiveSymbols : null;
  const statusTrading = String(market.status || '').toUpperCase() === 'TRADING';
  const inActiveSet = activeSet ? activeSet.has(sym) : false;
  const listedFlag = market.binanceListed === true || /binance/i.test(String(market.exchange || market.venue || ''));
  const vol = num(market.quoteVolume24h ?? market.volume24hUsd ?? market.quoteVolume ?? market.volume ?? market.total_volume);
  const hasVol = vol != null && vol > 0;
  const known = statusTrading || inActiveSet || listedFlag;

  if (!known) {
    return { listed: false, active: false, exchange: null, listingStatus: 'UNKNOWN', listingSafetyStatus: LISTING_STATUS.LISTING_UNKNOWN, listingSafetyReason: 'NO_LISTING_CONTEXT' };
  }
  const active = statusTrading || inActiveSet || (listedFlag && hasVol);
  if (active && hasVol && vol < MIN_ACTIVE_VOL_USD) {
    return { listed: true, active: true, exchange: 'binance', listingStatus: 'TRADING', listingSafetyStatus: LISTING_STATUS.LISTING_CAUTION, listingSafetyReason: 'LOW_LIQUIDITY_LISTING' };
  }
  if (active) {
    return { listed: true, active: true, exchange: 'binance', listingStatus: 'TRADING', listingSafetyStatus: LISTING_STATUS.LISTING_SAFE, listingSafetyReason: 'BINANCE_LISTED_ACTIVE' };
  }
  return { listed: true, active: false, exchange: 'binance', listingStatus: 'LISTED', listingSafetyStatus: LISTING_STATUS.LISTING_UNKNOWN, listingSafetyReason: 'LISTING_NOT_ACTIVE' };
}

function alphaContext(market = {}) {
  const haystack = [
    market.source, market.safetySource, market.exchange, market.venue, market.listingSource,
    market.listingType, market.marketType, market.label, market.category,
    ...(Array.isArray(market.labels) ? market.labels : []),
    ...(Array.isArray(market.tags) ? market.tags : []),
    ...(Array.isArray(market.scannerTags) ? market.scannerTags : []),
  ].filter(Boolean).join(' ');
  return market.binanceAlphaListed === true || market.alphaTokenId != null || /binance[-_\s]?alpha|alpha[-_\s]?(spot|trade|listing)|BINANCE_ALPHA/i.test(haystack);
}

function asAlphaMap(input) {
  if (input instanceof Map) return input;
  const map = new Map();
  if (input instanceof Set) {
    for (const item of input) map.set(String(item).toUpperCase().replace(/[^A-Z0-9]/g, ''), { symbol: String(item).toUpperCase(), active: true, status: 'TRADING' });
    return map;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item) continue;
      const symbol = String(item.symbol || normalizeAlphaPairSymbol(item).replace('/', '')).toUpperCase();
      if (symbol) map.set(symbol, item);
      const pair = normalizeAlphaPairSymbol(item);
      if (pair) map.set(pair.replace('/', '').toUpperCase(), item);
    }
  }
  return map;
}

export function resolveBinanceAlphaListing(market = {}, opts = {}) {
  const pair = normalizeAlphaPairSymbol(market);
  const symbol = pair.replace('/', '').toUpperCase();
  const activeMap = asAlphaMap(opts.binanceAlphaListings);
  const found = activeMap.get(symbol) || null;
  const row = found || market;
  const hasAlphaContext = Boolean(found) || alphaContext(market);
  if (!hasAlphaContext) return { listed: false, active: false, exchange: null, listingStatus: 'UNKNOWN', listingSafetyStatus: LISTING_STATUS.LISTING_UNKNOWN, listingSafetyReason: 'NO_LISTING_CONTEXT' };

  const rawStatus = String(row.status || row.tradingStatus || row.listingStatus || '').toUpperCase();
  const active = row.active === true || rawStatus === 'TRADING' || rawStatus === 'ACTIVE' || rawStatus === 'ENABLED' || market.binanceAlphaListed === true;
  const base = String(row.baseAsset || market.baseAsset || '').toUpperCase();
  const quote = String(row.quoteAsset || market.quoteAsset || '').toUpperCase();
  const common = {
    listed: true,
    active,
    exchange: 'binance-alpha',
    listingStatus: active ? 'TRADING' : (rawStatus || 'UNKNOWN'),
    source: 'binance-alpha',
    sourceName: 'Binance Alpha listing',
    listingType: 'BINANCE_ALPHA',
    symbol: symbol || String(row.symbol || market.symbol || '').toUpperCase(),
    pair: pair || row.pair || null,
    baseAsset: base || row.baseAsset || null,
    quoteAsset: quote || row.quoteAsset || null,
    alphaTokenId: row.alphaTokenId || market.alphaTokenId || row.tokenId || row.tokenID || row.baseAssetId || null,
    raw: row.raw || null,
  };
  if (!active) {
    return { ...common, listingSafetyStatus: LISTING_STATUS.LISTING_UNKNOWN, listingSafetyReason: 'BINANCE_ALPHA_NOT_CONFIRMED' };
  }
  return { ...common, listingSafetyStatus: LISTING_STATUS.LISTING_SAFE, listingSafetyReason: 'BINANCE_ALPHA_LISTED_ACTIVE' };
}

function result(base, fields) {
  return {
    baseAsset: base,
    quoteAsset: fields.quoteAsset || null,
    exchange: fields.exchange || null,
    listed: fields.listed === true,
    listingStatus: fields.listingStatus || 'UNKNOWN',
    listingSafetyStatus: fields.listingSafetyStatus || LISTING_STATUS.LISTING_UNKNOWN,
    listingSafetyReason: fields.listingSafetyReason || 'NO_LISTING_CONTEXT',
    listingType: fields.listingType || null,
    alphaTokenId: fields.alphaTokenId || null,
    chain: fields.chain || null,
    contractAddress: fields.contractAddress || null,
    chainCandidates: Array.isArray(fields.chainCandidates) ? fields.chainCandidates : [],
    name: fields.name || null,
    verified: fields.verified === true ? true : (fields.verified === false ? false : null),
    allowlisted: fields.allowlisted === true,
    ambiguous: fields.ambiguous === true,
    cexOnly: fields.cexOnly === true,
    reason: fields.reason,
    source: fields.source || null,
    sourceName: fields.sourceName || fields.source || null,
    confidence: Number.isFinite(fields.confidence) ? fields.confidence : 0,
    confidenceReasons: Array.isArray(fields.confidenceReasons) ? fields.confidenceReasons : [],
  };
}

// ---- main sync resolver (chain axis + listing axis + confidence) ----
export function resolveTokenMetadata(input = {}, opts = {}) {
  const { base, quote, hadQuote } = baseInfo(input);
  const binanceListing = resolveBinanceListing(input, opts);
  const alphaListing = resolveBinanceAlphaListing(input, opts);
  const listing = binanceListing.listed ? binanceListing : (alphaListing.listed ? alphaListing : binanceListing);
  const cexContext = hadQuote || input.cexOnly === true || input.isScannerContext === true || listing.listed
    || /binance|bybit|okx|futures|spot/i.test(String(input.venue || input.exchange || ''));
  const cr = []; // confidenceReasons

  const base_fields = {
    quoteAsset: quote, exchange: listing.exchange, listed: listing.listed,
    listingStatus: listing.listingStatus, listingSafetyStatus: listing.listingSafetyStatus, listingSafetyReason: listing.listingSafetyReason,
    listingType: listing.listingType, alphaTokenId: listing.alphaTokenId,
  };
  if (listing.listingSafetyStatus === LISTING_STATUS.LISTING_SAFE) cr.push(listing.exchange === 'binance-alpha' ? 'binance_alpha_active_listing' : 'binance_active_listing');

  if (!base) return result('', { ...base_fields, reason: METADATA_REASONS.MISSING_CONTRACT_METADATA, source: 'none', confidence: 0, confidenceReasons: cr });

  // 1) direct row chain+contract
  const rowChain = input.chain || input.network || input.contractChain;
  const rowContract = input.contractAddress || input.contract || input.tokenAddress;
  if (rowChain && isAddress(rowContract)) {
    cr.push('direct_row_chain_contract');
    return result(base, {
      ...base_fields, chain: String(rowChain).toLowerCase(), contractAddress: String(rowContract),
      name: input.tokenName || input.name || null, verified: input.contractVerified,
      reason: METADATA_REASONS.RESOLVED, source: 'market-row', sourceName: 'row metadata',
      confidence: input.contractVerified === true ? 100 : 90, confidenceReasons: cr,
    });
  }

  // 2) curated allowlist
  if (ALLOWLIST[base]) {
    const m = ALLOWLIST[base];
    cr.push('curated_allowlist');
    return result(base, {
      ...base_fields, chain: m.chain, contractAddress: m.contractAddress, name: m.name, verified: true, allowlisted: true,
      reason: METADATA_REASONS.ALLOWLISTED, source: 'curated-allowlist', sourceName: 'curated allowlist',
      confidence: 95, confidenceReasons: cr,
    });
  }

  // 3) known-ambiguous base asset
  if (AMBIGUOUS.has(base)) {
    cr.push('known_multichain_symbol');
    return result(base, { ...base_fields, ambiguous: true, source: 'none', sourceName: 'ambiguity rule', reason: METADATA_REASONS.AMBIGUOUS_CONTRACT_MAPPING, confidence: listing.listed ? 75 : 60, confidenceReasons: cr });
  }

  // 4) provider cache (populated out-of-band by warmChainMetadata; never guesses)
  const cached = opts.providerCache instanceof Map ? opts.providerCache.get(base) : (cache.get(base) ? cache.get(base).value : null);
  if (cached) {
    if (cached.reason === METADATA_REASONS.AMBIGUOUS_CONTRACT_MAPPING) {
      cr.push('coingecko_ambiguous_symbol');
      return result(base, { ...base_fields, ambiguous: true, chainCandidates: cached.candidates || [], source: cached.source || 'coingecko', sourceName: cached.sourceName || 'CoinGecko', reason: METADATA_REASONS.AMBIGUOUS_CONTRACT_MAPPING, confidence: 60, confidenceReasons: cr });
    }
    if (cached.chain && isAddress(cached.contractAddress)) {
      cr.push('provider_unique_mapping');
      if (listing.listed) cr.push('binance_active_listing_plus_provider');
      return result(base, { ...base_fields, chain: cached.chain, contractAddress: cached.contractAddress, name: cached.name || null, verified: cached.verified, chainCandidates: cached.candidates || [], reason: METADATA_REASONS.RESOLVED, source: cached.source || 'coingecko', sourceName: cached.sourceName || 'CoinGecko', confidence: listing.listed ? 85 : 80, confidenceReasons: cr });
    }
  }

  // 5) no chain context. If Binance-listed, that is still a real CEX listing.
  if (listing.listed) {
    cr.push('binance_listed_no_contract');
    return result(base, { ...base_fields, cexOnly: true, source: listing.source || 'binance', sourceName: listing.sourceName || 'Binance listing', reason: METADATA_REASONS.CEX_ONLY_NO_CONTRACT_CONTEXT, confidence: listing.listingSafetyStatus === LISTING_STATUS.LISTING_SAFE ? 75 : 50, confidenceReasons: cr });
  }
  if (cexContext) {
    return result(base, { ...base_fields, cexOnly: true, source: 'cex-only', sourceName: 'CEX context', reason: METADATA_REASONS.CEX_ONLY_NO_CONTRACT_CONTEXT, confidence: 40, confidenceReasons: cr });
  }
  return result(base, { ...base_fields, source: 'none', sourceName: 'none', reason: METADATA_REASONS.MISSING_CONTRACT_METADATA, confidence: 0, confidenceReasons: cr });
}

export async function warmBinanceAlphaListings(opts = {}) {
  const now = opts.now || Date.now();
  const cached = alphaCache.get('binance-alpha-list');
  if (cached && now - cached.at < META_TTL_MS) { counters.metadataCacheHits += 1; return cached.value; }
  counters.metadataCacheMisses += 1;
  counters.binanceAlphaProviderCalls += 1;
  const res = await fetchBinanceAlphaExchangeInfo(opts);
  if (!res.ok) {
    counters.binanceAlphaProviderFailures += 1;
    const value = { ok: false, listings: [], error: res.error || 'Binance Alpha provider failed' };
    alphaCache.set('binance-alpha-list', { at: now, value });
    return value;
  }
  const listings = Array.isArray(res.listings) ? res.listings : [];
  const safeCount = listings.filter((x) => x.active === true).length;
  counters.binanceAlphaResolvedCount += listings.length;
  counters.binanceAlphaListingSafeCount += safeCount;
  counters.alphaListingUnknownCount += Math.max(0, listings.length - safeCount);
  counters.alphaSymbolsSample = listings.slice(0, 12).map((x) => x.pair || x.symbol).filter(Boolean);
  const value = { ok: true, listings, error: null };
  alphaCache.set('binance-alpha-list', { at: now, value });
  return value;
}

// ---- optional async CoinGecko provider (only with injected fetchImpl) ----
async function fetchCoinGeckoList(opts, now) {
  const cached = listCache.get('coingecko-list');
  if (cached && now - cached.at < META_TTL_MS) { counters.metadataCacheHits += 1; return cached.value; }
  counters.metadataCacheMisses += 1;
  if (Array.isArray(opts.coinList)) { listCache.set('coingecko-list', { at: now, value: opts.coinList }); return opts.coinList; }
  counters.metadataProviderCalls += 1;
  const res = await opts.fetchImpl('https://api.coingecko.com/api/v3/coins/list?include_platform=true');
  if (res && res.status === 429) { counters.providerRateLimitedCount += 1; throw new Error('rate_limited'); }
  if (!res || !res.ok) throw new Error('coingecko_list_failed');
  const list = await res.json();
  listCache.set('coingecko-list', { at: now, value: list });
  return list;
}

export async function resolveCoinGeckoMetadata(base, opts = {}) {
  const now = opts.now || Date.now();
  const key = String(base || '').toUpperCase();
  if (!key) return null;
  const cached = cache.get(key);
  if (cached && now - cached.at < META_TTL_MS) { counters.metadataCacheHits += 1; return cached.value; }
  counters.metadataCacheMisses += 1;
  if (typeof opts.fetchImpl !== 'function') return null;
  try {
    const list = await fetchCoinGeckoList(opts, now);
    const matches = (Array.isArray(list) ? list : []).filter((c) => String(c.symbol || '').toUpperCase() === key);
    if (matches.length === 0) {
      const v = { reason: METADATA_REASONS.MISSING_CONTRACT_METADATA, source: 'coingecko', sourceName: 'CoinGecko' };
      cache.set(key, { at: now, value: v });
      return v;
    }
    if (matches.length > 1) {
      counters.ambiguousMetadataCount += 1;
      const candidates = matches.slice(0, 6).map((m) => ({ id: m.id, platforms: m.platforms || null }));
      const v = { reason: METADATA_REASONS.AMBIGUOUS_CONTRACT_MAPPING, candidates, source: 'coingecko', sourceName: 'CoinGecko' };
      cache.set(key, { at: now, value: v });
      return v;
    }
    const only = matches[0];
    const platforms = only.platforms && typeof only.platforms === 'object' ? Object.entries(only.platforms).filter(([k, v]) => k && v) : [];
    if (platforms.length === 1) {
      counters.coingeckoResolvedCount += 1;
      const [chain, contractAddress] = platforms[0];
      const v = { chain: String(chain).toLowerCase(), contractAddress: String(contractAddress), name: only.name, verified: null, source: 'coingecko', sourceName: 'CoinGecko' };
      cache.set(key, { at: now, value: v });
      return v;
    }
    if (platforms.length > 1) {
      counters.ambiguousMetadataCount += 1;
      const candidates = platforms.slice(0, 6).map(([chain, contractAddress]) => ({ chain, contractAddress }));
      const v = { reason: METADATA_REASONS.AMBIGUOUS_CONTRACT_MAPPING, candidates, source: 'coingecko', sourceName: 'CoinGecko' };
      cache.set(key, { at: now, value: v });
      return v;
    }
    const v = { reason: METADATA_REASONS.MISSING_CONTRACT_METADATA, source: 'coingecko', sourceName: 'CoinGecko' };
    cache.set(key, { at: now, value: v });
    return v;
  } catch (err) {
    counters.metadataProviderFailures += 1;
    return { reason: /rate/i.test(String(err && err.message)) ? METADATA_REASONS.PROVIDER_RATE_LIMITED : METADATA_REASONS.METADATA_FETCH_FAILED, source: 'coingecko', sourceName: 'CoinGecko' };
  }
}

// ---- optional async GeckoTerminal provider (only with injected fetchImpl) ----
export async function resolveGeckoTerminalMetadata(base, opts = {}) {
  if (typeof opts.geckoTerminalFetch !== 'function') return null;
  const now = opts.now || Date.now();
  try {
    counters.metadataProviderCalls += 1;
    const res = await opts.geckoTerminalFetch(base);
    if (res && res.status === 429) { counters.providerRateLimitedCount += 1; return { reason: METADATA_REASONS.PROVIDER_RATE_LIMITED, source: 'geckoterminal', sourceName: 'GeckoTerminal' }; }
    if (!res || !res.ok) throw new Error('gt_failed');
    const j = await res.json();
    const tok = j && j.data && j.data.attributes ? j.data.attributes : null;
    if (tok && tok.address && (tok.network || tok.chain)) {
      counters.geckoTerminalResolvedCount += 1;
      return { chain: String(tok.network || tok.chain).toLowerCase(), contractAddress: String(tok.address), name: tok.name || null, verified: null, source: 'geckoterminal', sourceName: 'GeckoTerminal' };
    }
    return { reason: METADATA_REASONS.MISSING_CONTRACT_METADATA, source: 'geckoterminal', sourceName: 'GeckoTerminal' };
  } catch (err) {
    counters.metadataProviderFailures += 1;
    return { reason: METADATA_REASONS.METADATA_FETCH_FAILED, source: 'geckoterminal', sourceName: 'GeckoTerminal' };
  }
}

// ---- batch warmer: populate provider cache for uncovered bases (rate-capped) ----
export async function warmChainMetadata(bases = [], opts = {}) {
  const maxCalls = Number.isFinite(opts.maxCalls) ? opts.maxCalls : DEFAULT_MAX_PROVIDER_CALLS;
  const now = opts.now || Date.now();
  let used = 0;
  const seen = new Set();
  for (const raw of bases) {
    const base = String(raw || '').toUpperCase();
    if (!base || seen.has(base) || ALLOWLIST[base] || AMBIGUOUS.has(base)) continue;
    seen.add(base);
    const cached = cache.get(base);
    if (cached && now - cached.at < META_TTL_MS) continue;
    if (used >= maxCalls) break;
    used += 1;
    let meta = await resolveCoinGeckoMetadata(base, opts);
    if ((!meta || (!meta.chain && meta.reason !== METADATA_REASONS.AMBIGUOUS_CONTRACT_MAPPING)) && typeof opts.geckoTerminalFetch === 'function') {
      const gt = await resolveGeckoTerminalMetadata(base, { ...opts, now });
      if (gt && gt.chain) meta = gt;
    }
    if (meta) cache.set(base, { at: now, value: meta });
  }
  return { ...counters, providerCallsThisPass: used };
}
