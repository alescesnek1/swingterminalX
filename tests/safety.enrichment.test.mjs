// Dual safety model (chain vs Binance listing) + optional public providers +
// cache/rate-limit + explainable UI labels. No fake chain safety; Telegram
// still requires final SAFE + all other gates; providers fail soft.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  resolveTokenMetadata, resolveBinanceListing, resolveBinanceAlphaListing, resolveCoinGeckoMetadata, resolveGeckoTerminalMetadata,
  warmChainMetadata, warmBinanceAlphaListings, getMetadataDiagnostics, __clearTokenMetadataCache, METADATA_REASONS, LISTING_STATUS,
} from '../scripts/safety/token-metadata.mjs';
import { BINANCE_ALPHA_EXCHANGE_INFO_URL, parseBinanceAlphaExchangeInfo } from '../scripts/safety/binance-alpha-provider.mjs';
import { classifyMarketSafety, evaluateKnownSafety, buildSafetyDiagnostics, SAFETY_BASIS, SAFETY_REASONS } from '../scripts/safety/chain-safety.mjs';
import { evaluateTradingRadar } from '../scripts/radar/trading-radar.mjs';
import { evaluateConfirmedRadarEntryReady, TELEGRAM_CODES, isTelegramHardDisabled } from '../netlify/functions/cron-alerts.mjs';

const MID = '·';
const TERMINAL_JS = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
function loadFormatSafetyLabel() {
  const m = TERMINAL_JS.match(/function formatSafetyLabel\(status, reason, source, chain, contract, basis\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'formatSafetyLabel(...basis) must exist');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '\nreturn formatSafetyLabel;')();
}
const fmt = loadFormatSafetyLabel();

const cgResponse = (list) => ({ ok: true, status: 200, json: async () => list });

test('Binance active listing -> listing SAFE, final SAFE, basis CEX_LISTING (chain UNKNOWN)', () => {
  const s = classifyMarketSafety({ symbol: 'HYPEUSDT', status: 'TRADING', quoteVolume24h: 5_000_000 });
  assert.equal(s.listingSafetyStatus, LISTING_STATUS.LISTING_SAFE);
  assert.equal(s.listingSafetyReason, 'BINANCE_LISTED_ACTIVE');
  assert.equal(s.finalSafetyStatus, 'SAFE');
  assert.equal(s.safetyBasis, SAFETY_BASIS.CEX_LISTING);
  assert.equal(s.chainSafetyStatus, 'UNKNOWN');
});

test('Binance Alpha exchange-info fixture resolves OPG/USDC', () => {
  const listings = parseBinanceAlphaExchangeInfo({ data: { symbols: [
    { symbol: 'OPGUSDC', baseAsset: 'OPG', quoteAsset: 'USDC', tokenId: 'alpha-opg', status: 'TRADING', displayName: 'OPG' },
  ] } });
  assert.equal(BINANCE_ALPHA_EXCHANGE_INFO_URL, 'https://www.binance.com/bapi/defi/v1/public/alpha-trade/get-exchange-info');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].pair, 'OPG/USDC');
  assert.equal(listings[0].baseAsset, 'OPG');
  assert.equal(listings[0].quoteAsset, 'USDC');
  assert.equal(listings[0].alphaTokenId, 'alpha-opg');
  assert.equal(listings[0].source, 'binance-alpha');
  assert.equal(listings[0].listingType, 'BINANCE_ALPHA');
});

test('Binance Alpha provider parses live exchange-info bucket shape', () => {
  const listings = parseBinanceAlphaExchangeInfo({ data: [
    { timezone: 'UTC', symbols: [
      { symbol: 'ALPHA_105USDT', status: 'TRADING', baseAsset: 'ALPHA_105', quoteAsset: 'USDT' },
      { symbol: 'ALPHA_106USDC', status: 'TRADING', baseAsset: 'ALPHA_106', quoteAsset: 'USDC' },
    ] },
  ] });
  assert.equal(listings.length, 2);
  assert.equal(listings[0].pair, 'ALPHA_105/USDT');
  assert.equal(listings[0].alphaTokenId, 'ALPHA_105');
  assert.equal(listings[1].quoteAsset, 'USDC');
});

test('Binance Alpha active listing -> final SAFE label and no chain SAFE', () => {
  const row = { symbol: 'OPGUSDC', baseAsset: 'OPG', quoteAsset: 'USDC', source: 'BINANCE_ALPHA', alphaTokenId: 'alpha-opg', status: 'TRADING' };
  const listing = resolveBinanceAlphaListing(row);
  assert.equal(listing.listingSafetyStatus, LISTING_STATUS.LISTING_SAFE);
  assert.equal(listing.listingSafetyReason, 'BINANCE_ALPHA_LISTED_ACTIVE');
  const s = classifyMarketSafety(row);
  assert.equal(s.finalSafetyStatus, 'SAFE');
  assert.equal(s.safetyBasis, SAFETY_BASIS.ALPHA_LISTING);
  assert.equal(s.safetyReason, 'BINANCE_ALPHA_LISTED_ACTIVE');
  assert.equal(s.chainSafetyStatus, 'UNKNOWN');
  assert.equal(s.chainSafetyReason, 'CEX_ONLY_NO_CONTRACT_CONTEXT');
  assert.equal(s.alphaTokenId, 'alpha-opg');
  assert.equal(fmt('SAFE', s.safetyReason, s.safetySource, s.chain, s.contractAddress, s.safetyBasis).labelShort, `SAFE ${MID} Binance Alpha listed`);
});

test('Binance Alpha inactive/missing -> UNKNOWN / BINANCE_ALPHA_NOT_CONFIRMED', () => {
  const s = classifyMarketSafety({ symbol: 'OPGUSDC', source: 'BINANCE_ALPHA', status: 'HALTED' });
  assert.equal(s.finalSafetyStatus, 'UNKNOWN');
  assert.equal(s.listingSafetyStatus, LISTING_STATUS.LISTING_UNKNOWN);
  assert.equal(s.listingSafetyReason, 'BINANCE_ALPHA_NOT_CONFIRMED');
  assert.equal(s.safetyReason, 'BINANCE_ALPHA_NOT_CONFIRMED');
  assert.equal(fmt('UNKNOWN', s.safetyReason, s.safetySource, null, null, s.safetyBasis).labelShort, `UNKNOWN ${MID} Alpha not confirmed`);
});

test('Binance Alpha provider failure fails soft', async () => {
  __clearTokenMetadataCache();
  const res = await warmBinanceAlphaListings({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), now: Date.now() });
  assert.equal(res.ok, false);
  assert.equal(res.listings.length, 0);
  assert.equal(getMetadataDiagnostics().binanceAlphaProviderFailures, 1);
  assert.equal(classifyMarketSafety({ symbol: 'FAILUSDC', source: 'BINANCE_ALPHA' }).finalSafetyStatus, 'UNKNOWN');
});

test('Binance Alpha listing + dangerous contract -> DANGER overrides listing', () => {
  const s = classifyMarketSafety({ symbol: 'OPGUSDC', source: 'BINANCE_ALPHA', status: 'TRADING', chain: 'bsc', contractAddress: '0xabc', contractVerified: true, topHolderPercent: 42 });
  assert.equal(s.listingSafetyStatus, LISTING_STATUS.LISTING_SAFE);
  assert.equal(s.chainSafetyStatus, 'DANGER');
  assert.equal(s.finalSafetyStatus, 'DANGER');
  assert.equal(s.safetyBasis, SAFETY_BASIS.CHAIN_RISK);
});

test('Binance inactive/missing -> UNKNOWN, no listing context', () => {
  const s = classifyMarketSafety({ symbol: 'BSBUSDT' }); // no status / volume / activeSet
  assert.equal(s.listingSafetyStatus, LISTING_STATUS.LISTING_UNKNOWN);
  assert.equal(s.finalSafetyStatus, 'UNKNOWN');
  assert.equal(s.chainSafetyStatus, 'UNKNOWN');
});

test('curated asset -> SAFE basis CURATED_ASSET; direct verified contract -> SAFE basis CHAIN_VERIFIED', () => {
  const cur = classifyMarketSafety({ symbol: 'XLMUSDT', baseAsset: 'XLM', status: 'TRADING', quoteVolume24h: 5e7 });
  assert.equal(cur.finalSafetyStatus, 'SAFE');
  assert.equal(cur.safetyBasis, SAFETY_BASIS.CURATED_ASSET);
  const ver = classifyMarketSafety({ symbol: 'XYZUSDT', chain: 'ethereum', contractAddress: '0xabc', contractVerified: true, topHolderPercent: 3, status: 'TRADING', quoteVolume24h: 5e7 });
  assert.equal(ver.finalSafetyStatus, 'SAFE');
  assert.equal(ver.safetyBasis, SAFETY_BASIS.CHAIN_VERIFIED);
});

test('low liquidity Binance listing -> LISTING_CAUTION / final CAUTION', () => {
  const s = classifyMarketSafety({ symbol: 'BEATUSDT', status: 'TRADING', quoteVolume24h: 500_000 });
  assert.equal(s.listingSafetyStatus, LISTING_STATUS.LISTING_CAUTION);
  assert.equal(s.finalSafetyStatus, 'CAUTION');
});

test('dangerous contract overrides Binance listing SAFE -> final DANGER', () => {
  const s = classifyMarketSafety({ symbol: 'SIRENUSDT', status: 'TRADING', quoteVolume24h: 5e7, chain: 'bsc', contractAddress: '0xabc', contractVerified: true, topHolderPercent: 38 });
  assert.equal(s.listingSafetyStatus, LISTING_STATUS.LISTING_SAFE);
  assert.equal(s.chainSafetyStatus, 'DANGER');
  assert.equal(s.finalSafetyStatus, 'DANGER');
  assert.equal(s.safetyBasis, SAFETY_BASIS.CHAIN_RISK);
});

test('no chain SAFE from ticker-only guessing', () => {
  // active listing makes FINAL safe, but the CHAIN axis must never be SAFE
  // without a real verified contract.
  for (const sym of ['HYPEUSDT', 'BSBUSDT', 'BEATUSDT']) {
    assert.notEqual(classifyMarketSafety({ symbol: sym, status: 'TRADING', quoteVolume24h: 5e6 }).chainSafetyStatus, 'SAFE');
  }
});

test('CoinGecko unique mapping attaches chain candidate; ambiguous symbol -> ambiguous + chain UNKNOWN', async () => {
  __clearTokenMetadataCache();
  const uniqueList = [{ id: 'xyz-token', symbol: 'xyz', platforms: { ethereum: '0xcontractxyz' } }];
  await warmChainMetadata(['XYZ'], { fetchImpl: async () => cgResponse(uniqueList), now: Date.now() });
  const m = resolveTokenMetadata({ symbol: 'XYZUSDT', baseAsset: 'XYZ' });
  assert.equal(m.chain, 'ethereum');
  assert.equal(m.contractAddress, '0xcontractxyz');
  assert.equal(m.source, 'coingecko');

  __clearTokenMetadataCache();
  const ambigList = [
    { id: 'foo-eth', symbol: 'foo', platforms: { ethereum: '0xaaa' } },
    { id: 'foo-bsc', symbol: 'foo', platforms: { 'binance-smart-chain': '0xbbb' } },
  ];
  const meta = await resolveCoinGeckoMetadata('FOO', { fetchImpl: async () => cgResponse(ambigList), now: Date.now() });
  assert.equal(meta.reason, METADATA_REASONS.AMBIGUOUS_CONTRACT_MAPPING);
  assert.ok(Array.isArray(meta.candidates) && meta.candidates.length >= 2);
});

test('CoinGecko can enrich Alpha token while ambiguous mapping remains UNKNOWN chain', async () => {
  __clearTokenMetadataCache();
  const ambigList = [
    { id: 'opg-eth', symbol: 'opg', platforms: { ethereum: '0xaaa' } },
    { id: 'opg-bsc', symbol: 'opg', platforms: { 'binance-smart-chain': '0xbbb' } },
  ];
  await resolveCoinGeckoMetadata('OPG', { fetchImpl: async () => cgResponse(ambigList), now: Date.now() });
  const s = classifyMarketSafety({ symbol: 'OPGUSDC', source: 'BINANCE_ALPHA', status: 'TRADING' });
  assert.equal(s.finalSafetyStatus, 'SAFE');
  assert.equal(s.safetyBasis, SAFETY_BASIS.ALPHA_LISTING);
  assert.equal(s.chainSafetyStatus, 'UNKNOWN');
  assert.equal(s.chainSafetyReason, 'AMBIGUOUS_CONTRACT_MAPPING');
  assert.ok(s.chainCandidates.length >= 2);
});

test('provider rate limit -> PROVIDER_RATE_LIMITED, fails soft', async () => {
  __clearTokenMetadataCache();
  const meta = await resolveCoinGeckoMetadata('RLX', { fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }), now: Date.now() });
  assert.equal(meta.reason, METADATA_REASONS.PROVIDER_RATE_LIMITED);
  assert.ok(getMetadataDiagnostics().providerRateLimitedCount >= 1);
  // classification still works (no throw)
  assert.equal(classifyMarketSafety({ symbol: 'RLXUSDT' }).finalSafetyStatus, 'UNKNOWN');
});

test('GeckoTerminal provider failure fails soft', async () => {
  __clearTokenMetadataCache();
  const meta = await resolveGeckoTerminalMetadata('GTX', { geckoTerminalFetch: async () => { throw new Error('network'); }, now: Date.now() });
  assert.equal(meta.reason, METADATA_REASONS.METADATA_FETCH_FAILED);
});

test('cache prevents repeated provider calls', async () => {
  __clearTokenMetadataCache();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return cgResponse([{ id: 'cac', symbol: 'cac', platforms: { ethereum: '0xcac' } }]); };
  await resolveCoinGeckoMetadata('CAC', { fetchImpl, now: 1000 });
  await resolveCoinGeckoMetadata('CAC', { fetchImpl, now: 2000 });
  assert.equal(calls, 1, 'second lookup must hit cache');
});

test('provider failure does not break scanner/RADAR', () => {
  const mk = (s, b, v) => ({ symbol: s, baseAsset: b, quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: v, bidPrice: 1, askPrice: 1.001, spreadPct: 0.02, change24hPct: -5 });
  const r = evaluateTradingRadar({ markets: [mk('BTCUSDT', 'BTC', 9e8), mk('HYPEUSDT', 'HYPE', 5e6)], now: Date.now() });
  assert.ok(r.candidates.length >= 1);
  for (const c of r.candidates) { assert.ok(c.safetyStatus && c.safetyReason && c.safetyBasis); }
  assert.equal(r.universeDiagnostics.plainUnknownCount, 0);
  assert.ok('finalSafetyBasisBreakdown' in r.universeDiagnostics);
  assert.ok('chainUnknownButListingSafeCount' in r.universeDiagnostics);
});

test('Scanner UI/RADAR renders Alpha source and token id', () => {
  const mk = (s, b, v) => ({ symbol: s, baseAsset: b, quoteAsset: 'USDC', status: 'TRADING', quoteVolume24h: v, bidPrice: 1, askPrice: 1.001, spreadPct: 0.02, change24hPct: -5, depthUsdWithin1Pct: 300_000 });
  const r = evaluateTradingRadar({
    markets: [mk('BTCUSDC', 'BTC', 9e8)],
    scannerCandidates: [{ symbol: 'OPGUSDC', source: 'BINANCE_ALPHA', listingType: 'BINANCE_ALPHA', alphaTokenId: 'alpha-opg', score: 8, c24: -7, volume: 20_000_000, price: 0.2 }],
    scannerContext: { binanceAlphaListings: [{ symbol: 'OPGUSDC', baseAsset: 'OPG', quoteAsset: 'USDC', active: true, status: 'TRADING', alphaTokenId: 'alpha-opg' }] },
    now: Date.now(),
  });
  const opg = r.candidates.find((c) => c.symbol === 'OPGUSDC');
  assert.ok(opg);
  assert.equal(opg.safetyBasis, SAFETY_BASIS.ALPHA_LISTING);
  assert.equal(opg.alphaTokenId, 'alpha-opg');
  assert.equal(opg.listingSource, 'Binance Alpha');
  assert.equal(fmt(opg.safetyStatus, opg.safetyReason, opg.safetySource, opg.chain, opg.contractAddress, opg.safetyBasis).labelShort, `SAFE ${MID} Binance Alpha listed`);
  assert.ok(r.universeDiagnostics.binanceAlphaListingSafeCount >= 1);
});

test('Telegram: scanner/forbidden stages blocked; final SAFE passes safety gate; microstructure still required', () => {
  const base = {
    symbol: 'SOLUSDT', actionability: 'ENTRY_READY', telegramEligible: true, allRadarConditionsPassed: true,
    entryZone: { low: 1, high: 1.1 }, invalidationLevel: 0.9, suggestedStop: 0.9,
    TAKE_PROFIT_LEVELS: [{ level: 1.2 }, { level: 1.3 }, { level: 1.4 }], tpZonesExist: true,
    EXECUTION_SCORE: 70, SETUP_SCORE: 74, RISK_REWARD_SCORE: 64, MARKET_REGIME_SCORE: 61, confidence: 82, stale: false,
    safetyStatus: 'SAFE', safetyBasis: 'ALPHA_LISTING',
  };
  for (const st of ['BUY', 'FLUSH+BUY', 'WATCH']) {
    assert.equal(evaluateConfirmedRadarEntryReady({ ...base, STATUS: st }).code, TELEGRAM_CODES.LEGACY_BLOCKED);
  }
  // missing microstructure still blocks even when final SAFE
  assert.equal(evaluateConfirmedRadarEntryReady({ ...base, STATUS: 'STANDARD_ENTRY_READY', executionDataMissing: ['orderBook'] }).code, TELEGRAM_CODES.SKIPPED_MISSING_MICROSTRUCTURE);
  // UNKNOWN safety blocked
  assert.equal(evaluateConfirmedRadarEntryReady({ ...base, STATUS: 'STANDARD_ENTRY_READY', executionDataMissing: [], safetyStatus: 'UNKNOWN' }).code, TELEGRAM_CODES.SKIPPED_SAFETY_NOT_SAFE);
  // final SAFE (CEX_LISTING) + all gates -> passes safety gate
  assert.equal(evaluateConfirmedRadarEntryReady({ ...base, STATUS: 'STANDARD_ENTRY_READY', executionDataMissing: [] }).ok, true);
});

test('Telegram disabled by default (fail-closed)', () => {
  assert.equal(isTelegramHardDisabled({}), true);
});

// ---- UI label helper ----
test('formatSafetyLabel: basis-aware SAFE labels + chain note for CEX listing', () => {
  assert.equal(fmt('SAFE', 'BINANCE_LISTED_ACTIVE', 'binance', null, null, 'CEX_LISTING').labelShort, `SAFE ${MID} Binance listed`);
  assert.equal(fmt('SAFE', 'BINANCE_ALPHA_LISTED_ACTIVE', 'binance-alpha', null, null, 'ALPHA_LISTING').labelShort, `SAFE ${MID} Binance Alpha listed`);
  assert.equal(fmt('SAFE', 'ALLOWLISTED', 'curated-allowlist', 'near', 'native:near', 'CURATED_ASSET').labelShort, `SAFE ${MID} curated asset`);
  assert.equal(fmt('SAFE', 'RESOLVED', 'market-row', 'ethereum', '0xabc', 'CHAIN_VERIFIED').labelShort, `SAFE ${MID} verified contract`);
  assert.equal(fmt('CAUTION', 'LOW_LIQUIDITY_LISTING', 'binance', null, null, 'LISTING_CAUTION').labelShort, `CAUTION ${MID} low liquidity`);
  assert.equal(fmt('UNKNOWN', '', 'none', null, null, '').labelShort, `UNKNOWN ${MID} missing metadata`);
  assert.equal(fmt('UNKNOWN', 'BINANCE_ALPHA_NOT_CONFIRMED', 'binance-alpha', null, null, '').labelShort, `UNKNOWN ${MID} Alpha not confirmed`);
  const cex = fmt('SAFE', 'BINANCE_LISTED_ACTIVE', 'binance', null, null, 'CEX_LISTING');
  assert.match(cex.tooltip, /Chain safety: UNKNOWN - no contract context/);
  assert.match(cex.tooltip, /Basis: CEX_LISTING/);
  assert.equal(cex.blocksTelegram, false);
  // never a plain reasonless UNKNOWN
  assert.notEqual(fmt(null, null, null, null, null, null).labelShort, 'UNKNOWN');
});

test('shipped JS wires dual-model into scanner / RADAR / detail / cockpit', () => {
  assert.match(TERMINAL_JS, /function formatSafetyLabel\(status, reason, source, chain, contract, basis\)/);
  assert.match(TERMINAL_JS, /formatSafetyLabel\(s\.status, s\.code, s\.source, s\.chain, s\.contract, s\.basis\)/);
  assert.match(TERMINAL_JS, /formatSafetyLabel\(c\.safetyStatus, c\.safetyReason, c\.safetySource, c\.chain, c\.contractAddress, c\.safetyBasis\)/);
  assert.match(TERMINAL_JS, /<span>Safety basis<\/span>/);
  assert.match(TERMINAL_JS, /<span>Chain safety<\/span>/);
  assert.match(TERMINAL_JS, /<span>Listing safety<\/span>/);
  assert.match(TERMINAL_JS, /<span>Listing source<\/span>/);
  assert.match(TERMINAL_JS, /<span>Alpha token id<\/span>/);
  assert.match(TERMINAL_JS, /Binance listed/);
  assert.match(TERMINAL_JS, /Binance Alpha listed/);
});

test('cron telegram message includes safetyBasis', () => {
  const cron = fs.readFileSync(new URL('../netlify/functions/cron-alerts.mjs', import.meta.url), 'utf8');
  assert.match(cron, /Safety basis: \$\{escHtml\(candidate\.safetyBasis/);
});
