// chain-safety.mjs - advisory token safety adapter.
//
// Safety contract:
//   - never marks missing chain/API data as SAFE
//   - never crashes on missing keys/contracts
//   - caches chain API reads to reduce rate-limit pressure
//   - every result carries a machine-readable safetyReason explaining WHY

import { resolveTokenMetadata, METADATA_REASONS } from './token-metadata.mjs';

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map();

// Machine-readable reason codes attached to every safety result.
export const SAFETY_REASONS = Object.freeze({
  ALLOWLISTED: 'ALLOWLISTED',
  RESOLVED: 'RESOLVED',
  MISSING_CONTRACT_METADATA: 'MISSING_CONTRACT_METADATA',
  AMBIGUOUS_CONTRACT_MAPPING: 'AMBIGUOUS_CONTRACT_MAPPING',
  METADATA_FETCH_FAILED: 'METADATA_FETCH_FAILED',
  VERIFICATION_UNAVAILABLE: 'VERIFICATION_UNAVAILABLE',
  UNVERIFIED_CONTRACT: 'UNVERIFIED_CONTRACT',
  HOLDER_CONCENTRATION: 'HOLDER_CONCENTRATION',
  OWNER_PRIVILEGE_RISK: 'OWNER_PRIVILEGE_RISK',
  LIQUIDITY_RISK: 'LIQUIDITY_RISK',
  CRITICAL_EVENT_RISK: 'CRITICAL_EVENT_RISK',
});

const META_REASON_SET = new Set(Object.values(METADATA_REASONS));

function nowIso() {
  return new Date().toISOString();
}

function n(v, fallback = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Number(v) || 0));
}

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
    safetyStatus: status,
    safetyScore: clamp(score),
    safetyReason,
    topHolderPercent: null,
    holderConcentrationRisk: 'UNKNOWN',
    contractVerified: null,
    chain: normChain(chain),
    contractAddress: contractAddress || null,
    reasons: reasons.length ? reasons : ['missing chain safety data'],
    checkedAt: nowIso(),
    source,
  };
}

export function classifyHolderConcentration(topHolderPercent) {
  const top = n(topHolderPercent);
  if (top == null) return { status: 'UNKNOWN', score: 45, risk: 'UNKNOWN', reason: 'top holder unavailable' };
  if (top >= 30) return { status: 'DANGER', score: 10, risk: 'HIGH', reason: `top holder ${top.toFixed(1)}%` };
  if (top >= 10) return { status: 'CAUTION', score: 60, risk: 'MEDIUM', reason: `top holder ${top.toFixed(1)}%` };
  return { status: 'SAFE', score: 88, risk: 'LOW', reason: 'no major holder risk detected' };
}

export function evaluateKnownSafety(input = {}) {
  const chain = normChain(input.chain || input.network);
  const contractAddress = input.contractAddress || input.contract || input.tokenAddress || null;
  const reasons = [];
  let score = 82;
  let status = 'SAFE';

  // No chain/contract => honest UNKNOWN with a specific machine reason.
  if (!chain || !contractAddress) {
    let safetyReason = SAFETY_REASONS.MISSING_CONTRACT_METADATA;
    if (input.ambiguous === true) safetyReason = SAFETY_REASONS.AMBIGUOUS_CONTRACT_MAPPING;
    else if (input.metadataReason && META_REASON_SET.has(input.metadataReason)) safetyReason = input.metadataReason;
    if (!chain) reasons.push('missing chain');
    if (!contractAddress) reasons.push('missing contract address');
    if (input.ambiguous === true) reasons.push('ambiguous chain/contract mapping');
    return emptyResult({ chain, contractAddress, status: 'UNKNOWN', score: 35, reasons, safetyReason, source: input.source || 'chain-safety' });
  }

  const allowlisted = input.allowlisted === true;
  let safetyReason = allowlisted ? SAFETY_REASONS.ALLOWLISTED : SAFETY_REASONS.RESOLVED;

  // Holder concentration: only downgrades when we actually have data; for a
  // non-allowlisted token, unknown holders is NOT provably safe.
  const holder = classifyHolderConcentration(input.topHolderPercent ?? input.topHolderPct);
  if (holder.status !== 'UNKNOWN') {
    reasons.push(holder.reason);
    score = Math.min(score, holder.score);
    if (holder.status === 'DANGER') { status = 'DANGER'; safetyReason = SAFETY_REASONS.HOLDER_CONCENTRATION; }
    else if (holder.status === 'CAUTION') { status = 'CAUTION'; safetyReason = SAFETY_REASONS.HOLDER_CONCENTRATION; }
  } else if (!allowlisted) {
    status = 'UNKNOWN';
    safetyReason = SAFETY_REASONS.VERIFICATION_UNAVAILABLE;
    score = Math.min(score, 45);
    reasons.push('holder concentration unavailable');
  } else {
    reasons.push('allowlisted canonical asset (curated)');
  }

  const verified = input.contractVerified;
  if (verified === false) {
    if (status !== 'DANGER') { status = 'CAUTION'; safetyReason = SAFETY_REASONS.UNVERIFIED_CONTRACT; }
    score = Math.min(score, 55);
    reasons.push('contract not verified');
  } else if (verified === true) {
    reasons.push(allowlisted ? 'allowlisted verified asset' : 'contract verified');
  } else if (!allowlisted) {
    if (status === 'SAFE') { status = 'UNKNOWN'; safetyReason = SAFETY_REASONS.VERIFICATION_UNAVAILABLE; }
    score = Math.min(score, 45);
    reasons.push('contract verification unavailable');
  }

  if (input.ownerPrivilegeRisk === true || input.mintRisk === true || input.pauseRisk === true) {
    status = 'DANGER';
    safetyReason = SAFETY_REASONS.OWNER_PRIVILEGE_RISK;
    score = Math.min(score, 20);
    reasons.push('owner/privilege risk detected');
  }
  if (input.liquidityRisk === true) {
    if (status !== 'DANGER') { status = 'CAUTION'; safetyReason = SAFETY_REASONS.LIQUIDITY_RISK; }
    score = Math.min(score, 50);
    reasons.push('liquidity risk detected');
  }
  if (input.exploitRisk === true || input.hackRisk === true || input.delistingRisk === true || input.unlockRisk === true || input.newsRisk === 'high') {
    status = 'DANGER';
    safetyReason = SAFETY_REASONS.CRITICAL_EVENT_RISK;
    score = Math.min(score, 15);
    reasons.push('critical exploit/delisting/unlock/news risk');
  }

  return {
    safetyStatus: status,
    safetyScore: clamp(score),
    safetyReason,
    topHolderPercent: n(input.topHolderPercent ?? input.topHolderPct),
    holderConcentrationRisk: holder.risk,
    contractVerified: verified == null ? null : !!verified,
    chain,
    contractAddress,
    reasons: Array.from(new Set(reasons)).slice(0, 8),
    checkedAt: nowIso(),
    source: input.source || 'known-chain-data',
  };
}

// One-stop entry point: resolve metadata for a market row, then classify.
// NEVER fakes SAFE - missing/ambiguous metadata stays UNKNOWN with a reason.
export function classifyMarketSafety(market = {}, opts = {}) {
  const meta = resolveTokenMetadata(market, opts);
  const safety = evaluateKnownSafety({
    chain: meta.chain || market.chain || market.network || market.contractChain,
    contractAddress: meta.contractAddress || market.contractAddress || market.contract || market.tokenAddress,
    contractVerified: market.contractVerified != null ? market.contractVerified : meta.verified,
    allowlisted: meta.allowlisted,
    ambiguous: meta.ambiguous,
    metadataReason: meta.reason,
    topHolderPercent: market.topHolderPercent ?? market.topHolderPct,
    ownerPrivilegeRisk: market.ownerPrivilegeRisk,
    mintRisk: market.mintRisk,
    pauseRisk: market.pauseRisk,
    liquidityRisk: market.liquidityRisk,
    exploitRisk: market.exploitRisk,
    hackRisk: market.hackRisk,
    delistingRisk: market.delistingRisk,
    unlockRisk: market.unlockRisk,
    newsRisk: market.newsRisk,
    source: meta.source || market.safetySource || 'chain-safety',
  });
  safety.metadataSource = meta.source;
  safety.metadataConfidence = meta.confidence;
  safety.tokenName = meta.name;
  if (!safety.chain) safety.chain = meta.chain || null;
  if (!safety.contractAddress) safety.contractAddress = meta.contractAddress || null;
  return safety;
}

function parseBscScanSource(source) {
  if (!source || typeof source !== 'object') return null;
  const result = Array.isArray(source.result) ? source.result[0] : null;
  if (!result || typeof result !== 'object') return null;
  // A contract is "verified" only if BscScan returns actual source code, or an
  // ABI that is both non-empty AND not the explicit "not verified" sentinel.
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
  if (normalizedChain !== 'bsc') {
    return emptyResult({ chain, contractAddress, status: 'UNKNOWN', score: 35, reasons: ['BscScan adapter supports BSC only'], safetyReason: SAFETY_REASONS.METADATA_FETCH_FAILED, source: 'bscscan' });
  }
  if (!contractAddress) {
    return emptyResult({ chain: 'bsc', contractAddress: null, status: 'UNKNOWN', score: 30, reasons: ['missing contract address'], safetyReason: SAFETY_REASONS.MISSING_CONTRACT_METADATA, source: 'bscscan' });
  }
  if (!apiKey) {
    return emptyResult({ chain: 'bsc', contractAddress, status: 'UNKNOWN', score: 35, reasons: ['BscScan API key unavailable'], safetyReason: SAFETY_REASONS.METADATA_FETCH_FAILED, source: 'bscscan' });
  }
  if (typeof fetchImpl !== 'function') {
    return emptyResult({ chain: 'bsc', contractAddress, status: 'UNKNOWN', score: 35, reasons: ['fetch unavailable'], safetyReason: SAFETY_REASONS.METADATA_FETCH_FAILED, source: 'bscscan' });
  }

  const key = `bsc:${String(contractAddress).toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) return { ...cached.value, source: 'bscscan-cache' };

  try {
    const url = new URL('https://api.bscscan.com/api');
    url.searchParams.set('module', 'contract');
    url.searchParams.set('action', 'getsourcecode');
    url.searchParams.set('address', contractAddress);
    url.searchParams.set('apikey', apiKey);
    const res = await fetchImpl(url);
    if (!res || !res.ok) throw new Error(`BscScan HTTP ${res ? res.status : 'unknown'}`);
    const json = await res.json();
    const parsed = parseBscScanSource(json);
    if (!parsed) {
      return emptyResult({ chain: 'bsc', contractAddress, status: 'UNKNOWN', score: 35, reasons: ['BscScan source unavailable'], safetyReason: SAFETY_REASONS.METADATA_FETCH_FAILED, source: 'bscscan' });
    }
    const value = evaluateKnownSafety({ chain: 'bsc', contractAddress, ...parsed, source: 'bscscan' });
    cache.set(key, { at: now, value });
    return value;
  } catch (err) {
    return emptyResult({ chain: 'bsc', contractAddress, status: 'UNKNOWN', score: 35, reasons: [`BscScan API unavailable: ${err && err.message ? err.message : String(err)}`], safetyReason: SAFETY_REASONS.METADATA_FETCH_FAILED, source: 'bscscan' });
  }
}

export function buildSafetyDiagnostics(results = []) {
  const rows = Array.isArray(results) ? results.filter(Boolean) : [];
  const countStatus = (status) => rows.filter((r) => r.safetyStatus === status).length;
  const countReason = (reason) => rows.filter((r) => r.safetyReason === reason).length;
  return {
    safetyRowsChecked: rows.length,
    safetySafeCount: countStatus('SAFE'),
    safetyCautionCount: countStatus('CAUTION'),
    safetyDangerCount: countStatus('DANGER'),
    safetyUnknownCount: countStatus('UNKNOWN'),
    // legacy field names kept for back-compat with existing consumers
    safetyRowsUnknown: countStatus('UNKNOWN'),
    safetyRowsCaution: countStatus('CAUTION'),
    safetyRowsDanger: countStatus('DANGER'),
    missingContractMetadataCount: countReason(SAFETY_REASONS.MISSING_CONTRACT_METADATA),
    ambiguousContractMappingCount: countReason(SAFETY_REASONS.AMBIGUOUS_CONTRACT_MAPPING),
    safetyProviderFailedCount: countReason(SAFETY_REASONS.METADATA_FETCH_FAILED),
    chainApiAvailable: rows.some((r) => r.source && !String(r.source).includes('unavailable') && r.safetyStatus !== 'UNKNOWN'),
    lastSafetyCheckAt: rows.map((r) => r.checkedAt).filter(Boolean).sort().at(-1) || null,
    sampleSafetyReasons: rows.slice(0, 12).map((r) => ({
      symbol: r.symbol || null,
      status: r.safetyStatus,
      reason: r.safetyReason || (Array.isArray(r.reasons) ? r.reasons[0] : null),
    })),
    topSafetyRisks: rows
      .filter((r) => ['DANGER', 'CAUTION', 'UNKNOWN'].includes(r.safetyStatus))
      .slice(0, 10)
      .map((r) => ({
        symbol: r.symbol || null,
        status: r.safetyStatus,
        reason: Array.isArray(r.reasons) ? r.reasons[0] : 'risk',
      })),
  };
}
