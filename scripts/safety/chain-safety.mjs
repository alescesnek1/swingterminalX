// chain-safety.mjs - advisory token safety adapter (dual model).
//
// Two independent axes, combined into one final status:
//   - CHAIN axis  : on-chain contract safety (chainSafetyStatus). NEVER faked.
//   - LISTING axis: Binance/CEX listing safety (listingSafetyStatus).
// finalSafetyStatus is derived with explicit precedence and carries a
// safetyBasis so the UI can say e.g. "SAFE - Binance listed" without ever
// claiming "verified contract".
//
// Every result ALWAYS includes: safetyStatus(final), safetyReason, safetySource,
// chain, contractAddress, blocksTelegram, plus the dual-model fields.

import { resolveTokenMetadata, getMetadataDiagnostics, METADATA_REASONS, LISTING_STATUS } from './token-metadata.mjs';

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map();

export const SAFETY_REASONS = Object.freeze({
  ALLOWLISTED: 'ALLOWLISTED',
  RESOLVED: 'RESOLVED',
  MISSING_CONTRACT_METADATA: 'MISSING_CONTRACT_METADATA',
  AMBIGUOUS_CONTRACT_MAPPING: 'AMBIGUOUS_CONTRACT_MAPPING',
  METADATA_FETCH_FAILED: 'METADATA_FETCH_FAILED',
  PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  CEX_ONLY_NO_CONTRACT_CONTEXT: 'CEX_ONLY_NO_CONTRACT_CONTEXT',
  VERIFICATION_UNAVAILABLE: 'VERIFICATION_UNAVAILABLE',
  UNVERIFIED_CONTRACT: 'UNVERIFIED_CONTRACT',
  HOLDER_CONCENTRATION: 'HOLDER_CONCENTRATION',
  OWNER_PRIVILEGE_RISK: 'OWNER_PRIVILEGE_RISK',
  LIQUIDITY_RISK: 'LIQUIDITY_RISK',
  CRITICAL_EVENT_RISK: 'CRITICAL_EVENT_RISK',
  BINANCE_LISTED_ACTIVE: 'BINANCE_LISTED_ACTIVE',
  BINANCE_ALPHA_LISTED_ACTIVE: 'BINANCE_ALPHA_LISTED_ACTIVE',
  BINANCE_ALPHA_NOT_CONFIRMED: 'BINANCE_ALPHA_NOT_CONFIRMED',
  ALPHA_SYMBOL_MAPPING_MISSING: 'ALPHA_SYMBOL_MAPPING_MISSING',
  ALPHA_SYMBOL_AMBIGUOUS: 'ALPHA_SYMBOL_AMBIGUOUS',
  LOW_LIQUIDITY_LISTING: 'LOW_LIQUIDITY_LISTING',
});

export const SAFETY_BASIS = Object.freeze({
  CHAIN_VERIFIED: 'CHAIN_VERIFIED',
  CURATED_ASSET: 'CURATED_ASSET',
  CEX_LISTING: 'CEX_LISTING',
  ALPHA_LISTING: 'ALPHA_LISTING',
  CHAIN_RISK: 'CHAIN_RISK',
  CHAIN_CAUTION: 'CHAIN_CAUTION',
  LISTING_CAUTION: 'LISTING_CAUTION',
  NONE: 'NONE',
});

const META_REASON_SET = new Set(Object.values(METADATA_REASONS));

function nowIso() { return new Date().toISOString(); }
function n(v, fallback = null) { const x = Number(v); return Number.isFinite(x) ? x : fallback; }
function clamp(v, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, Number(v) || 0)); }

function normChain(chain) {
  const c = String(chain || '').trim().toLowerCase();
  if (['bsc', 'bnb', 'binance-smart-chain', 'bnb smart chain'].includes(c)) return 'bsc';
  if (['eth', 'ethereum'].includes(c)) return 'ethereum';
  if (['base'].includes(c)) return 'base';
  if (['arb', 'arbitrum'].includes(c)) return 'arbitrum';
  return c || null;
}

function emptyResult({ chain = null, contractAddress = null, status = 'UNKNOWN', score = 35, reasons = [], safetyReason = SAFETY_REASONS.MISSING_CONTRACT_METADATA, source = 'chain-safety' } = {}) {
  return {
    safetyStatus: status, safetyScore: clamp(score), safetyReason, safetySource: source, blocksTelegram: status !== 'SAFE',
    topHolderPercent: null, holderConcentrationRisk: 'UNKNOWN', contractVerified: null,
    chain: normChain(chain), contractAddress: contractAddress || null,
    reasons: reasons.length ? reasons : ['missing chain safety data'], checkedAt: nowIso(), source,
  };
}

export function classifyHolderConcentration(topHolderPercent) {
  const top = n(topHolderPercent);
  if (top == null) return { status: 'UNKNOWN', score: 45, risk: 'UNKNOWN', reason: 'top holder unavailable' };
  if (top >= 30) return { status: 'DANGER', score: 10, risk: 'HIGH', reason: `top holder ${top.toFixed(1)}%` };
  if (top >= 10) return { status: 'CAUTION', score: 60, risk: 'MEDIUM', reason: `top holder ${top.toFixed(1)}%` };
  return { status: 'SAFE', score: 88, risk: 'LOW', reason: 'no major holder risk detected' };
}

// CHAIN axis only. Returns UNKNOWN when there is no chain/contract - never faked.
export function evaluateKnownSafety(input = {}) {
  const chain = normChain(input.chain || input.network);
  const contractAddress = input.contractAddress || input.contract || input.tokenAddress || null;
  const reasons = [];
  let score = 82;
  let status = 'SAFE';

  if (!chain || !contractAddress) {
    let safetyReason = SAFETY_REASONS.MISSING_CONTRACT_METADATA;
    if (input.ambiguous === true) safetyReason = SAFETY_REASONS.AMBIGUOUS_CONTRACT_MAPPING;
    else if (input.cexOnly === true) safetyReason = SAFETY_REASONS.CEX_ONLY_NO_CONTRACT_CONTEXT;
    else if (input.metadataReason && META_REASON_SET.has(input.metadataReason)) safetyReason = input.metadataReason;
    const cexOnly = safetyReason === SAFETY_REASONS.CEX_ONLY_NO_CONTRACT_CONTEXT;
    if (cexOnly) reasons.push('CEX-listed, no on-chain contract context');
    else { if (!chain) reasons.push('missing chain'); if (!contractAddress) reasons.push('missing contract address'); if (input.ambiguous === true) reasons.push('ambiguous chain/contract mapping'); }
    const source = cexOnly ? 'cex-only' : (input.safetySource || input.source || 'chain-safety');
    return emptyResult({ chain, contractAddress, status: 'UNKNOWN', score: 35, reasons, safetyReason, source });
  }

  const allowlisted = input.allowlisted === true;
  let safetyReason = allowlisted ? SAFETY_REASONS.ALLOWLISTED : SAFETY_REASONS.RESOLVED;
  const holder = classifyHolderConcentration(input.topHolderPercent ?? input.topHolderPct);
  if (holder.status !== 'UNKNOWN') {
    reasons.push(holder.reason); score = Math.min(score, holder.score);
    if (holder.status === 'DANGER') { status = 'DANGER'; safetyReason = SAFETY_REASONS.HOLDER_CONCENTRATION; }
    else if (holder.status === 'CAUTION') { status = 'CAUTION'; safetyReason = SAFETY_REASONS.HOLDER_CONCENTRATION; }
  } else if (!allowlisted) {
    status = 'UNKNOWN'; safetyReason = SAFETY_REASONS.VERIFICATION_UNAVAILABLE; score = Math.min(score, 45); reasons.push('holder concentration unavailable');
  } else { reasons.push('allowlisted canonical asset (curated)'); }

  const verified = input.contractVerified;
  if (verified === false) { if (status !== 'DANGER') { status = 'CAUTION'; safetyReason = SAFETY_REASONS.UNVERIFIED_CONTRACT; } score = Math.min(score, 55); reasons.push('contract not verified'); }
  else if (verified === true) { reasons.push(allowlisted ? 'allowlisted verified asset' : 'contract verified'); }
  else if (!allowlisted) { if (status === 'SAFE') { status = 'UNKNOWN'; safetyReason = SAFETY_REASONS.VERIFICATION_UNAVAILABLE; } score = Math.min(score, 45); reasons.push('contract verification unavailable'); }

  if (input.ownerPrivilegeRisk === true || input.mintRisk === true || input.pauseRisk === true) { status = 'DANGER'; safetyReason = SAFETY_REASONS.OWNER_PRIVILEGE_RISK; score = Math.min(score, 20); reasons.push('owner/privilege risk detected'); }
  if (input.liquidityRisk === true) { if (status !== 'DANGER') { status = 'CAUTION'; safetyReason = SAFETY_REASONS.LIQUIDITY_RISK; } score = Math.min(score, 50); reasons.push('liquidity risk detected'); }
  if (input.exploitRisk === true || input.hackRisk === true || input.delistingRisk === true || input.unlockRisk === true || input.newsRisk === 'high') { status = 'DANGER'; safetyReason = SAFETY_REASONS.CRITICAL_EVENT_RISK; score = Math.min(score, 15); reasons.push('critical exploit/delisting/unlock/news risk'); }

  const source = input.safetySource || input.source || 'known-chain-data';
  return {
    safetyStatus: status, safetyScore: clamp(score), safetyReason, safetySource: source, blocksTelegram: status !== 'SAFE',
    topHolderPercent: n(input.topHolderPercent ?? input.topHolderPct), holderConcentrationRisk: holder.risk,
    contractVerified: verified == null ? null : !!verified, chain, contractAddress,
    reasons: Array.from(new Set(reasons)).slice(0, 8), checkedAt: nowIso(), source,
  };
}

// DUAL MODEL entry point. Combines chain axis + listing axis into a final.
export function classifyMarketSafety(market = {}, opts = {}) {
  const meta = resolveTokenMetadata(market, opts);

  // chain axis
  const chainEval = evaluateKnownSafety({
    chain: meta.chain || market.chain || market.network || market.contractChain,
    contractAddress: meta.contractAddress || market.contractAddress || market.contract || market.tokenAddress,
    contractVerified: market.contractVerified != null ? market.contractVerified : meta.verified,
    allowlisted: meta.allowlisted, ambiguous: meta.ambiguous, cexOnly: meta.cexOnly, metadataReason: meta.reason,
    topHolderPercent: market.topHolderPercent ?? market.topHolderPct,
    ownerPrivilegeRisk: market.ownerPrivilegeRisk, mintRisk: market.mintRisk, pauseRisk: market.pauseRisk,
    liquidityRisk: market.liquidityRisk, exploitRisk: market.exploitRisk, hackRisk: market.hackRisk,
    delistingRisk: market.delistingRisk, unlockRisk: market.unlockRisk, newsRisk: market.newsRisk,
    source: meta.reason === METADATA_REASONS.CEX_ONLY_NO_CONTRACT_CONTEXT ? 'cex-only' : (meta.source || market.safetySource),
  });
  const chainSafetyStatus = chainEval.safetyStatus;
  const chainSafetyReason = chainEval.safetyReason;

  // listing axis
  const listingSafetyStatus = meta.listingSafetyStatus;
  const listingSafetyReason = meta.listingSafetyReason;

  // final precedence
  let finalSafetyStatus = 'UNKNOWN';
  let safetyBasis = SAFETY_BASIS.NONE;
  let safetyReason;
  if (chainSafetyStatus === 'DANGER') { finalSafetyStatus = 'DANGER'; safetyBasis = SAFETY_BASIS.CHAIN_RISK; safetyReason = chainSafetyReason; }
  else if (chainSafetyStatus === 'CAUTION') { finalSafetyStatus = 'CAUTION'; safetyBasis = SAFETY_BASIS.CHAIN_CAUTION; safetyReason = chainSafetyReason; }
  else if (listingSafetyStatus === LISTING_STATUS.LISTING_CAUTION) { finalSafetyStatus = 'CAUTION'; safetyBasis = SAFETY_BASIS.LISTING_CAUTION; safetyReason = SAFETY_REASONS.LOW_LIQUIDITY_LISTING; }
  else if (chainSafetyStatus === 'SAFE') { finalSafetyStatus = 'SAFE'; safetyBasis = meta.allowlisted ? SAFETY_BASIS.CURATED_ASSET : SAFETY_BASIS.CHAIN_VERIFIED; safetyReason = meta.allowlisted ? SAFETY_REASONS.ALLOWLISTED : SAFETY_REASONS.RESOLVED; }
  else if (listingSafetyStatus === LISTING_STATUS.LISTING_SAFE) {
    finalSafetyStatus = 'SAFE';
    safetyBasis = meta.listingType === 'BINANCE_ALPHA' || meta.exchange === 'binance-alpha' ? SAFETY_BASIS.ALPHA_LISTING : SAFETY_BASIS.CEX_LISTING;
    safetyReason = safetyBasis === SAFETY_BASIS.ALPHA_LISTING ? SAFETY_REASONS.BINANCE_ALPHA_LISTED_ACTIVE : SAFETY_REASONS.BINANCE_LISTED_ACTIVE;
  }
  else {
    finalSafetyStatus = 'UNKNOWN';
    safetyBasis = SAFETY_BASIS.NONE;
    safetyReason = meta.listingType === 'BINANCE_ALPHA' && [
      SAFETY_REASONS.BINANCE_ALPHA_NOT_CONFIRMED,
      SAFETY_REASONS.ALPHA_SYMBOL_MAPPING_MISSING,
      SAFETY_REASONS.ALPHA_SYMBOL_AMBIGUOUS,
    ].includes(listingSafetyReason)
      ? listingSafetyReason
      : chainSafetyReason;
  }

  return {
    // legacy/compat (RADAR + Telegram gate read safetyStatus)
    safetyStatus: finalSafetyStatus,
    safetyScore: chainEval.safetyScore,
    safetyReason,
    safetySource: meta.source || chainEval.safetySource || 'chain-safety',
    blocksTelegram: finalSafetyStatus !== 'SAFE',
    reasons: chainEval.reasons,
    contractVerified: chainEval.contractVerified,
    checkedAt: nowIso(),
    source: meta.source || 'chain-safety',
    // dual model
    finalSafetyStatus, safetyBasis,
    chainSafetyStatus, chainSafetyReason,
    listingSafetyStatus, listingSafetyReason,
    exchange: meta.exchange, listed: meta.listed, baseAsset: meta.baseAsset, quoteAsset: meta.quoteAsset,
    listingType: meta.listingType || null,
    alphaTokenId: meta.alphaTokenId || null,
    alphaPair: meta.alphaPair || null,
    // Link-only Alpha chain/contract for direct Binance Alpha deep links.
    // Deliberately NOT fed into the chain safety axis above, so the
    // safety verdict/labels are unchanged.
    alphaChain: meta.alphaChain || null,
    alphaContractAddress: meta.alphaContractAddress || null,
    humanSymbol: meta.humanSymbol || null,
    alphaCandidates: meta.alphaCandidates || [],
    listingSource: meta.exchange === 'binance-alpha' ? 'Binance Alpha' : (meta.exchange === 'binance' ? 'Binance' : null),
    chain: meta.chain || chainEval.chain || null,
    contractAddress: meta.contractAddress || chainEval.contractAddress || null,
    chainCandidates: meta.chainCandidates || [],
    ambiguous: meta.ambiguous === true,
    confidence: meta.confidence, confidenceReasons: meta.confidenceReasons,
    metadataSource: meta.source, sourceName: meta.sourceName,
    tokenName: meta.name,
  };
}

function parseBscScanSource(source) {
  if (!source || typeof source !== 'object') return null;
  const result = Array.isArray(source.result) ? source.result[0] : null;
  if (!result || typeof result !== 'object') return null;
  const sourceCode = String(result.SourceCode || '').trim();
  const abi = String(result.ABI || '').trim();
  const hasSourceCode = sourceCode.length > 0;
  const hasRealAbi = abi.length > 0 && abi !== 'Contract source code not verified';
  const verified = hasSourceCode || hasRealAbi;
  const ownerPrivilegeRisk = /owner|onlyOwner|pause|mint|blacklist|whitelist|excludeFromFee/i.test(
    [result.SourceCode, result.Proxy, result.Implementation].filter(Boolean).join('\n')
  );
  return { contractVerified: verified, ownerPrivilegeRisk };
}

export async function checkBscScanTokenSafety({ contractAddress, chain = 'bsc', apiKey = process.env.BSCSCAN_API_KEY, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const normalizedChain = normChain(chain);
  if (normalizedChain !== 'bsc') return emptyResult({ chain, contractAddress, status: 'UNKNOWN', score: 35, reasons: ['BscScan adapter supports BSC only'], safetyReason: SAFETY_REASONS.METADATA_FETCH_FAILED, source: 'bscscan' });
  if (!contractAddress) return emptyResult({ chain: 'bsc', contractAddress: null, status: 'UNKNOWN', score: 30, reasons: ['missing contract address'], safetyReason: SAFETY_REASONS.MISSING_CONTRACT_METADATA, source: 'bscscan' });
  if (!apiKey) return emptyResult({ chain: 'bsc', contractAddress, status: 'UNKNOWN', score: 35, reasons: ['BscScan API key unavailable'], safetyReason: SAFETY_REASONS.METADATA_FETCH_FAILED, source: 'bscscan' });
  if (typeof fetchImpl !== 'function') return emptyResult({ chain: 'bsc', contractAddress, status: 'UNKNOWN', score: 35, reasons: ['fetch unavailable'], safetyReason: SAFETY_REASONS.METADATA_FETCH_FAILED, source: 'bscscan' });

  const key = `bsc:${String(contractAddress).toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) return { ...cached.value, source: 'bscscan-cache' };
  try {
    const url = new URL('https://api.bscscan.com/api');
    url.searchParams.set('module', 'contract'); url.searchParams.set('action', 'getsourcecode');
    url.searchParams.set('address', contractAddress); url.searchParams.set('apikey', apiKey);
    const res = await fetchImpl(url);
    if (!res || !res.ok) throw new Error(`BscScan HTTP ${res ? res.status : 'unknown'}`);
    const json = await res.json();
    const parsed = parseBscScanSource(json);
    if (!parsed) return emptyResult({ chain: 'bsc', contractAddress, status: 'UNKNOWN', score: 35, reasons: ['BscScan source unavailable'], safetyReason: SAFETY_REASONS.METADATA_FETCH_FAILED, source: 'bscscan' });
    const value = evaluateKnownSafety({ chain: 'bsc', contractAddress, ...parsed, source: 'bscscan' });
    cache.set(key, { at: now, value });
    return value;
  } catch (err) {
    return emptyResult({ chain: 'bsc', contractAddress, status: 'UNKNOWN', score: 35, reasons: [`BscScan API unavailable: ${err && err.message ? err.message : String(err)}`], safetyReason: SAFETY_REASONS.METADATA_FETCH_FAILED, source: 'bscscan' });
  }
}

export function buildSafetyDiagnostics(results = []) {
  const rows = Array.isArray(results) ? results.filter(Boolean) : [];
  const total = rows.length;
  const countStatus = (status) => rows.filter((r) => (r.finalSafetyStatus || r.safetyStatus) === status).length;
  const countReason = (reason) => rows.filter((r) => r.safetyReason === reason).length;
  const classified = rows.filter((r) => { const s = r.finalSafetyStatus || r.safetyStatus; return s && s !== 'UNKNOWN'; }).length;

  const basisBreakdown = {};
  for (const r of rows) { const b = r.safetyBasis || 'NONE'; basisBreakdown[b] = (basisBreakdown[b] || 0) + 1; }

  const unknownRows = rows.filter((r) => (r.finalSafetyStatus || r.safetyStatus) === 'UNKNOWN');
  const plainUnknownCount = unknownRows.filter((r) => !r.safetyReason).length;
  const reasonCounts = {};
  for (const r of unknownRows) { const k = r.safetyReason || 'EMPTY'; reasonCounts[k] = (reasonCounts[k] || 0) + 1; }
  const topUnknownReasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, count]) => ({ reason, count }));

  const chainUnknownButListingSafeCount = rows.filter((r) => r.chainSafetyStatus === 'UNKNOWN' && r.listingSafetyStatus === LISTING_STATUS.LISTING_SAFE && (r.finalSafetyStatus || r.safetyStatus) === 'SAFE').length;
  const cexListingSafe = rows.filter((r) => r.safetyBasis === SAFETY_BASIS.CEX_LISTING || r.safetyBasis === SAFETY_BASIS.ALPHA_LISTING).map((r) => r.symbol || r.baseAsset).filter(Boolean).slice(0, 12);
  const alphaRows = rows.filter((r) => r.listingType === 'BINANCE_ALPHA' || r.exchange === 'binance-alpha' || r.safetyBasis === SAFETY_BASIS.ALPHA_LISTING);
  const stillUnknown = unknownRows.map((r) => ({ symbol: r.symbol || r.baseAsset || null, reason: r.safetyReason || 'EMPTY' })).slice(0, 12);
  const ambiguousSamples = rows.filter((r) => r.ambiguous).map((r) => ({ symbol: r.symbol || r.baseAsset || null, candidates: (r.chainCandidates || []).slice(0, 4) })).slice(0, 12);

  const prov = getMetadataDiagnostics();
  return {
    safetyRowsChecked: total,
    safetyCoveragePct: total ? Math.round((classified / total) * 100) : 0,
    safetySafeCount: countStatus('SAFE'), safetyCautionCount: countStatus('CAUTION'), safetyDangerCount: countStatus('DANGER'), safetyUnknownCount: countStatus('UNKNOWN'),
    plainUnknownCount, unknownWithReasonCount: unknownRows.length - plainUnknownCount, topUnknownReasons,
    topUnknownSymbols: unknownRows.map((r) => r.symbol || r.baseAsset).filter(Boolean).slice(0, 12),
    finalSafetyBasisBreakdown: basisBreakdown,
    chainUnknownButListingSafeCount,
    binanceListingResolvedCount: rows.filter((r) => r.listingSafetyStatus === LISTING_STATUS.LISTING_SAFE).length,
    binanceAlphaProviderCalls: prov.binanceAlphaProviderCalls,
    binanceAlphaProviderFailures: prov.binanceAlphaProviderFailures,
    binanceAlphaResolvedCount: Math.max(prov.binanceAlphaResolvedCount, alphaRows.length),
    binanceAlphaListingSafeCount: alphaRows.filter((r) => r.listingSafetyStatus === LISTING_STATUS.LISTING_SAFE).length,
    alphaListingUnknownCount: alphaRows.filter((r) => r.listingSafetyStatus !== LISTING_STATUS.LISTING_SAFE).length,
    alphaSymbolsSample: (prov.alphaSymbolsSample && prov.alphaSymbolsSample.length ? prov.alphaSymbolsSample : alphaRows.map((r) => r.symbol || r.baseAsset).filter(Boolean)).slice(0, 12),
    alphaTokenIdMappedCount: prov.alphaTokenIdMappedCount,
    alphaSymbolMappingMissingCount: prov.alphaSymbolMappingMissingCount,
    alphaSymbolAmbiguousCount: prov.alphaSymbolAmbiguousCount,
    alphaMappingProviderCalls: prov.alphaMappingProviderCalls,
    alphaMappingProviderFailures: prov.alphaMappingProviderFailures,
    alphaMappedExamples: prov.alphaMappedExamples,
    alphaUnmappedExamples: prov.alphaUnmappedExamples,
    coingeckoResolvedCount: prov.coingeckoResolvedCount,
    geckoTerminalResolvedCount: prov.geckoTerminalResolvedCount,
    ambiguousMetadataCount: prov.ambiguousMetadataCount,
    providerRateLimitedCount: prov.providerRateLimitedCount,
    metadataProviderCalls: prov.metadataProviderCalls, metadataProviderFailures: prov.metadataProviderFailures,
    metadataCacheHits: prov.metadataCacheHits, metadataCacheMisses: prov.metadataCacheMisses,
    missingContractMetadataCount: countReason(SAFETY_REASONS.MISSING_CONTRACT_METADATA),
    ambiguousContractMappingCount: countReason(SAFETY_REASONS.AMBIGUOUS_CONTRACT_MAPPING),
    cexOnlyNoContextCount: countReason(SAFETY_REASONS.CEX_ONLY_NO_CONTRACT_CONTEXT),
    safetyProviderFailedCount: countReason(SAFETY_REASONS.METADATA_FETCH_FAILED),
    topCexListingSafeSymbols: cexListingSafe,
    topStillUnknown: stillUnknown,
    ambiguousSamples,
    chainApiAvailable: rows.some((r) => r.source && !String(r.source).includes('unavailable') && (r.finalSafetyStatus || r.safetyStatus) !== 'UNKNOWN'),
    lastSafetyCheckAt: rows.map((r) => r.checkedAt).filter(Boolean).sort().at(-1) || null,
    sampleSafetyReasons: rows.slice(0, 12).map((r) => ({ symbol: r.symbol || null, status: r.finalSafetyStatus || r.safetyStatus, reason: r.safetyReason, basis: r.safetyBasis })),
    topSafetyRisks: rows.filter((r) => ['DANGER', 'CAUTION', 'UNKNOWN'].includes(r.finalSafetyStatus || r.safetyStatus)).slice(0, 10).map((r) => ({ symbol: r.symbol || null, status: r.finalSafetyStatus || r.safetyStatus, reason: Array.isArray(r.reasons) ? r.reasons[0] : 'risk' })),
  };
}
