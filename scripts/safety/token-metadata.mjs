// token-metadata.mjs - conservative token metadata resolver for the safety layer.
//
// Honesty contract:
//   - NEVER guess chain/contract from a ticker alone.
//   - A base asset is only auto-resolved if it is in the curated allowlist OR
//     the caller already supplied an unambiguous chain+contract (e.g. scanner
//     row metadata). Otherwise the resolver returns an explicit reason.
//   - No secrets required. External fetch is OPTIONAL and only used if the
//     caller injects a fetcher; failures are reported as METADATA_FETCH_FAILED,
//     never silently treated as "resolved".

export const METADATA_REASONS = Object.freeze({
  ALLOWLISTED: 'ALLOWLISTED',                       // curated canonical asset
  RESOLVED: 'RESOLVED',                             // unambiguous chain+contract from row/provider
  MISSING_CONTRACT_METADATA: 'MISSING_CONTRACT_METADATA',
  AMBIGUOUS_CONTRACT_MAPPING: 'AMBIGUOUS_CONTRACT_MAPPING',
  METADATA_FETCH_FAILED: 'METADATA_FETCH_FAILED',
});

const QUOTES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'BTC', 'ETH', 'BNB'];

// Curated allowlist of top tracked assets. Each entry is an explicit human
// decision: "this canonical asset is recognised". `contractAddress` is the
// canonical mainnet ERC-20 address where one exists, or `native:<chain>` for
// L1 coins that have no token contract. `verified:true` here means "verified by
// curation", and `allowlisted:true` lets the safety layer treat it as SAFE
// (with an explicit ALLOWLISTED reason) rather than UNKNOWN.
//
// Keyed by base asset (uppercase). Conservative on purpose - if in doubt, leave
// a symbol OUT so it resolves to MISSING_CONTRACT_METADATA instead of a guess.
const ALLOWLIST = Object.freeze({
  // L1 / native coins (no token contract; canonical asset)
  BTC:  { chain: 'bitcoin',   contractAddress: 'native:bitcoin',   name: 'Bitcoin' },
  ETH:  { chain: 'ethereum',  contractAddress: 'native:ethereum',  name: 'Ether' },
  BNB:  { chain: 'bsc',       contractAddress: 'native:bsc',       name: 'BNB' },
  SOL:  { chain: 'solana',    contractAddress: 'native:solana',    name: 'Solana' },
  ADA:  { chain: 'cardano',   contractAddress: 'native:cardano',   name: 'Cardano' },
  AVAX: { chain: 'avalanche', contractAddress: 'native:avalanche', name: 'Avalanche' },
  DOT:  { chain: 'polkadot',  contractAddress: 'native:polkadot',  name: 'Polkadot' },
  TRX:  { chain: 'tron',      contractAddress: 'native:tron',      name: 'TRON' },
  XRP:  { chain: 'xrpl',      contractAddress: 'native:xrpl',      name: 'XRP' },
  LTC:  { chain: 'litecoin',  contractAddress: 'native:litecoin',  name: 'Litecoin' },
  ATOM: { chain: 'cosmos',    contractAddress: 'native:cosmos',    name: 'Cosmos' },
  NEAR: { chain: 'near',      contractAddress: 'native:near',      name: 'NEAR' },
  APT:  { chain: 'aptos',     contractAddress: 'native:aptos',     name: 'Aptos' },
  SUI:  { chain: 'sui',       contractAddress: 'native:sui',       name: 'Sui' },
  INJ:  { chain: 'injective', contractAddress: 'native:injective', name: 'Injective' },
  // Canonical Ethereum-mainnet ERC-20s (well-known addresses)
  USDC: { chain: 'ethereum', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', name: 'USD Coin' },
  USDT: { chain: 'ethereum', contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7', name: 'Tether USD' },
  LINK: { chain: 'ethereum', contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca', name: 'Chainlink' },
  UNI:  { chain: 'ethereum', contractAddress: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', name: 'Uniswap' },
  AAVE: { chain: 'ethereum', contractAddress: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', name: 'Aave' },
  MKR:  { chain: 'ethereum', contractAddress: '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', name: 'Maker' },
  LDO:  { chain: 'ethereum', contractAddress: '0x5a98fcbea516cf06857215779fd812ca3bef1b32', name: 'Lido DAO' },
  CRV:  { chain: 'ethereum', contractAddress: '0xd533a949740bb3306d119cc777fa900ba034cd52', name: 'Curve DAO' },
  COMP: { chain: 'ethereum', contractAddress: '0xc00e94cb662c3520282e6f5717214004a7f26888', name: 'Compound' },
  SNX:  { chain: 'ethereum', contractAddress: '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f', name: 'Synthetix' },
  ARB:  { chain: 'arbitrum', contractAddress: '0x912ce59144191c1204e64559fe8253a0e49e6548', name: 'Arbitrum' },
});

// Base assets that legitimately map to MANY chains/contracts with no reliable
// disambiguator from a CEX ticker. These must NEVER be auto-resolved by symbol.
const AMBIGUOUS = new Set(['BTCB', 'WETH', 'WBTC', 'MULTI', 'BRIDGE', 'O3', 'BIT', 'GAS', 'CAT', 'GMT', 'AGI', 'KEY', 'FT']);

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map();

function baseAssetOf(input) {
  if (input && input.baseAsset) return String(input.baseAsset).toUpperCase();
  const s = String((input && (input.symbol || input.pair)) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const q of QUOTES) {
    if (s.length > q.length && s.endsWith(q)) return s.slice(0, -q.length);
  }
  return s;
}

function isAddress(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function result(base, fields) {
  return {
    baseAsset: base,
    chain: fields.chain || null,
    contractAddress: fields.contractAddress || null,
    name: fields.name || null,
    verified: fields.verified === true ? true : (fields.verified === false ? false : null),
    allowlisted: fields.allowlisted === true,
    ambiguous: fields.ambiguous === true,
    source: fields.source || null,
    confidence: fields.confidence || 'none',
    reason: fields.reason,
  };
}

// Resolve metadata for a single market/candidate row. Pure + deterministic
// unless a fetcher is injected via opts.fetchImpl.
export function resolveTokenMetadata(input = {}, opts = {}) {
  const base = baseAssetOf(input);
  if (!base) {
    return result('', { reason: METADATA_REASONS.MISSING_CONTRACT_METADATA, source: 'none' });
  }

  // 1) Caller already supplied unambiguous chain + contract (e.g. scanner row /
  //    DEX pair context). Trust it but record it as row-sourced.
  const rowChain = input.chain || input.network || input.contractChain;
  const rowContract = input.contractAddress || input.contract || input.tokenAddress;
  if (rowChain && isAddress(rowContract)) {
    return result(base, {
      chain: String(rowChain).toLowerCase(),
      contractAddress: String(rowContract),
      name: input.tokenName || input.name || null,
      verified: input.contractVerified,
      source: 'market-row',
      confidence: 'high',
      reason: METADATA_REASONS.RESOLVED,
    });
  }

  // 2) Curated allowlist (explicit human decision).
  if (ALLOWLIST[base]) {
    const m = ALLOWLIST[base];
    return result(base, {
      chain: m.chain,
      contractAddress: m.contractAddress,
      name: m.name,
      verified: true,
      allowlisted: true,
      source: 'curated-allowlist',
      confidence: 'high',
      reason: METADATA_REASONS.ALLOWLISTED,
    });
  }

  // 3) Known-ambiguous base asset: refuse to guess.
  if (AMBIGUOUS.has(base)) {
    return result(base, { ambiguous: true, source: 'none', reason: METADATA_REASONS.AMBIGUOUS_CONTRACT_MAPPING });
  }

  // 4) Optional external provider (only if injected; never required, no secret).
  if (typeof opts.fetchImpl === 'function') {
    const key = `meta:${base}`;
    const now = opts.now || Date.now();
    const cached = cache.get(key);
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;
    try {
      const fetched = opts.fetchImpl(base, input); // may be sync in tests
      if (fetched && fetched.chain && isAddress(fetched.contractAddress)) {
        if (fetched.ambiguous === true) {
          const v = result(base, { ambiguous: true, source: fetched.source || 'provider', reason: METADATA_REASONS.AMBIGUOUS_CONTRACT_MAPPING });
          cache.set(key, { at: now, value: v });
          return v;
        }
        const v = result(base, {
          chain: String(fetched.chain).toLowerCase(),
          contractAddress: String(fetched.contractAddress),
          name: fetched.name || null,
          verified: fetched.verified,
          source: fetched.source || 'provider',
          confidence: fetched.confidence || 'medium',
          reason: METADATA_REASONS.RESOLVED,
        });
        cache.set(key, { at: now, value: v });
        return v;
      }
      const v = result(base, { source: fetched && fetched.source || 'provider', reason: METADATA_REASONS.MISSING_CONTRACT_METADATA });
      cache.set(key, { at: now, value: v });
      return v;
    } catch (err) {
      return result(base, { source: 'provider', reason: METADATA_REASONS.METADATA_FETCH_FAILED });
    }
  }

  // 5) Nothing available.
  return result(base, { source: 'none', reason: METADATA_REASONS.MISSING_CONTRACT_METADATA });
}

export function __clearTokenMetadataCache() { cache.clear(); }
