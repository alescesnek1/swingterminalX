// chain-safety.mjs - advisory token safety adapter.
//
// Safety contract:
//   - never marks missing chain/API data as SAFE
//   - never crashes on missing keys/contracts
//   - caches chain API reads to reduce rate-limit pressure

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map();

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

function emptyResult({ chain = null, contractAddress = null, status = 'UNKNOWN', score = 35, reasons = [], source = 'chain-safety' } = {}) {
  return {
    safetyStatus: status,
    safetyScore: clamp(score),
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

  if (!chain) reasons.push('missing chain');
  if (!contractAddress) reasons.push('missing contract address');
  if (!chain || !contractAddress) {
    return emptyResult({ chain, contractAddress, status: 'UNKNOWN', score: 35, reasons });
  }

  const holder = classifyHolderConcentration(input.topHolderPercent ?? input.topHolderPct);
  reasons.push(holder.reason);
  score = Math.min(score, holder.score);
  if (holder.status === 'DANGER') status = 'DANGER';
  else if (holder.status === 'CAUTION') status = 'CAUTION';
  else if (holder.status === 'UNKNOWN') status = 'UNKNOWN';

  const verified = input.contractVerified;
  if (verified === false) {
    status = status === 'DANGER' ? status : 'CAUTION';
    score = Math.min(score, 55);
    reasons.push('contract not verified');
  } else if (verified === true) {
    reasons.push('contract verified');
  } else {
    status = status === 'SAFE' ? 'UNKNOWN' : status;
    score = Math.min(score, 45);
    reasons.push('contract verification unavailable');
  }

  if (input.ownerPrivilegeRisk === true || input.mintRisk === true || input.pauseRisk === true) {
    status = 'DANGER';
    score = Math.min(score, 20);
    reasons.push('owner/privilege risk detected');
  }
  if (input.liquidityRisk === true) {
    status = status === 'DANGER' ? status : 'CAUTION';
    score = Math.min(score, 50);
    reasons.push('liquidity risk detected');
  }
  if (input.exploitRisk === true || input.hackRisk === true || input.delistingRisk === true || input.unlockRisk === true || input.newsRisk === 'high') {
    status = 'DANGER';
    score = Math.min(score, 15);
    reasons.push('critical exploit/delisting/unlock/news risk');
  }

  return {
    safetyStatus: status,
    safetyScore: clamp(score),
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

function parseBscScanSource(source) {
  if (!source || typeof source !== 'object') return null;
  const result = Array.isArray(source.result) ? source.result[0] : null;
  if (!result || typeof result !== 'object') return null;
  const verified = !!String(result.SourceCode || '').trim() || String(result.ABI || '').trim() !== 'Contract source code not verified';
  const ownerPrivilegeRisk = /owner|onlyOwner|pause|mint|blacklist|whitelist|excludeFromFee/i.test(
    [result.SourceCode, result.Proxy, result.Implementation].filter(Boolean).join('\n')
  );
  return { contractVerified: verified, ownerPrivilegeRisk };
}

export async function checkBscScanTokenSafety({ contractAddress, chain = 'bsc', apiKey = process.env.BSCSCAN_API_KEY, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const normalizedChain = normChain(chain);
  if (normalizedChain !== 'bsc') {
    return emptyResult({ chain, contractAddress, status: 'UNKNOWN', score: 35, reasons: ['BscScan adapter supports BSC only'], source: 'bscscan' });
  }
  if (!contractAddress) {
    return emptyResult({ chain: 'bsc', contractAddress: null, status: 'UNKNOWN', score: 30, reasons: ['missing contract address'], source: 'bscscan' });
  }
  if (!apiKey) {
    return emptyResult({ chain: 'bsc', contractAddress, status: 'UNKNOWN', score: 35, reasons: ['BscScan API key unavailable'], source: 'bscscan' });
  }
  if (typeof fetchImpl !== 'function') {
    return emptyResult({ chain: 'bsc', contractAddress, status: 'UNKNOWN', score: 35, reasons: ['fetch unavailable'], source: 'bscscan' });
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
      return emptyResult({ chain: 'bsc', contractAddress, status: 'UNKNOWN', score: 35, reasons: ['BscScan source unavailable'], source: 'bscscan' });
    }
    const value = evaluateKnownSafety({ chain: 'bsc', contractAddress, ...parsed, source: 'bscscan' });
    cache.set(key, { at: now, value });
    return value;
  } catch (err) {
    return emptyResult({ chain: 'bsc', contractAddress, status: 'UNKNOWN', score: 35, reasons: [`BscScan API unavailable: ${err && err.message ? err.message : String(err)}`], source: 'bscscan' });
  }
}

export function buildSafetyDiagnostics(results = []) {
  const rows = Array.isArray(results) ? results.filter(Boolean) : [];
  const count = (status) => rows.filter((r) => r.safetyStatus === status).length;
  return {
    safetyRowsChecked: rows.length,
    safetyRowsUnknown: count('UNKNOWN'),
    safetyRowsCaution: count('CAUTION'),
    safetyRowsDanger: count('DANGER'),
    chainApiAvailable: rows.some((r) => r.source && !String(r.source).includes('unavailable') && r.safetyStatus !== 'UNKNOWN'),
    lastSafetyCheckAt: rows.map((r) => r.checkedAt).filter(Boolean).sort().at(-1) || null,
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

