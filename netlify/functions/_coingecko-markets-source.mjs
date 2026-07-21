// Public, unauthenticated CoinGecko /coins/markets fetcher for the
// scheduled price-history collector (price-history-collect-scheduled.mjs).
//
// WHY THIS EXISTS SEPARATELY FROM /api/markets: /api/markets
// (apps/edge/netlify/edge-functions/markets.js) requires a verified Supabase
// user JWT (verifyAuth) plus an allowlisted Origin (checkOrigin) — neither of
// which an unattended scheduler can ever present without storing a user
// credential or a service-role key, both of which are unacceptable (see the
// production-risk review this module implements). CoinGecko's public
// /coins/markets endpoint is the same upstream markets.js itself calls; this
// module hits it directly with no auth, no cookies, no API key.
//
// SAFETY MODEL
//   - Public GET only, no headers beyond Accept. No auth, no secrets, ever.
//   - Never throws — every path resolves to { ok, rows, pagesOk,
//     pagesAttempted, status, reason }.
//   - Only fields normalizePricePoint (_price-history.mjs) actually reads
//     are needed (symbol, name, current_price, price_change_percentage_24h,
//     total_volume, market_cap, market_cap_rank) — sparkline and the
//     multi-window price_change_percentage param are deliberately omitted
//     to keep the payload small; change_1h/7d simply stay null, which is
//     the existing "missing data stays null" contract, not a regression.
//   - Row count is hard-capped at ABSOLUTE_MAX_COINS, which matches
//     _price-history.mjs's own MAX_ROWS_PER_WRITE ceiling, so this module
//     can never hand the writer more than it is willing to insert.
//   - A 429 from any page stops further page attempts immediately (never
//     retried in-loop) — the live terminal (markets.js) shares this same
//     CoinGecko quota, so hammering it further would degrade the product.
//   - Failures log a stable code + page number only — never the raw
//     response body, never a header, never a token.
//   - A non-array JSON body (including CoinGecko's `{status:{error_code,
//     error_message}}` error envelope, which CoinGecko can send with HTTP
//     200 — a 200 status alone never means success) is a FAILED page, never
//     a silent "no more data" signal. An empty ARRAY response is only ever
//     treated as the legitimate end of pagination once at least one prior
//     page already contributed real rows; an empty array on the very first
//     productive page (zero rows collected so far) is instead a failed page
//     (MARKET_EMPTY_ROWS). Net effect: this function can never return
//     `ok:true`/`status:'ok'` with zero total rows.

const COINGECKO_MARKETS_BASE_URL = 'https://api.coingecko.com/api/v3/coins/markets';
const PER_PAGE = 250;
export const DEFAULT_MAX_COINS = 1000;
export const ABSOLUTE_MAX_COINS = 2000;
const MAX_PAGES = Math.ceil(ABSOLUTE_MAX_COINS / PER_PAGE);

function buildPageUrl(page) {
  return `${COINGECKO_MARKETS_BASE_URL}?vs_currency=usd&order=market_cap_desc&per_page=${PER_PAGE}&page=${page}`;
}

function boundMaxCoins(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_COINS;
  return Math.min(Math.trunc(n), ABSOLUTE_MAX_COINS);
}

function logWarn(event, fields) {
  console.warn(`[COINGECKO_MARKETS_SOURCE] ${event}`, fields);
}

/**
 * Fetches up to `maxCoins` rows from CoinGecko's public /coins/markets
 * endpoint across as many 250-row pages as needed. Never throws. See the
 * module header for the full safety/return-shape contract.
 */
export async function fetchCoinGeckoMarketRows({ maxCoins, fetchImpl } = {}) {
  try {
    const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
    if (typeof fetchFn !== 'function') {
      return { ok: false, rows: [], pagesOk: 0, pagesAttempted: 0, status: 'failed', reason: 'MARKET_FETCH_FAILED' };
    }

    const cap = boundMaxCoins(maxCoins);
    const pagesNeeded = Math.min(Math.ceil(cap / PER_PAGE), MAX_PAGES);

    const rows = [];
    let pagesOk = 0;
    let pagesAttempted = 0;
    let lastFailureReason = null;
    let rateLimited = false;

    for (let page = 1; page <= pagesNeeded; page += 1) {
      pagesAttempted += 1;

      let res;
      try {
        res = await fetchFn(buildPageUrl(page), { headers: { Accept: 'application/json' } });
      } catch (err) {
        lastFailureReason = 'MARKET_FETCH_FAILED';
        logWarn('page_fetch_error', { page, name: err?.name || 'Error' });
        continue;
      }

      if (res && res.status === 429) {
        rateLimited = true;
        lastFailureReason = 'UPSTREAM_RATE_LIMITED';
        logWarn('page_rate_limited', { page });
        break; // never retry a rate-limited upstream in-loop
      }

      if (!res || !res.ok) {
        lastFailureReason = 'MARKET_FETCH_FAILED';
        logWarn('page_fetch_failed', { page, status: res ? res.status : null });
        continue;
      }

      let json;
      try {
        json = await res.json();
      } catch (err) {
        lastFailureReason = 'MARKET_FETCH_FAILED';
        logWarn('page_parse_failed', { page, name: err?.name || 'Error' });
        continue;
      }

      // A 200 status never means success by itself — CoinGecko can (and
      // does) send an error envelope, e.g. { status: { error_code: 429,
      // error_message: '...' } }, with an HTTP 200. Any non-array body is
      // therefore a FAILED page, never a "no more data" signal — this is
      // the fix for the case a naive `Array.isArray(json) ? json : []`
      // silently turned an error envelope into an empty-but-"ok" page.
      if (!Array.isArray(json)) {
        lastFailureReason = 'MARKET_INVALID_PAYLOAD';
        const errorCode = json && typeof json === 'object' && json.status && typeof json.status === 'object'
          ? json.status.error_code
          : undefined;
        logWarn('page_invalid_payload', {
          page,
          errorCode: (typeof errorCode === 'number' || typeof errorCode === 'string') ? errorCode : null,
        });
        continue;
      }

      const pageRows = json;

      if (!pageRows.length) {
        if (rows.length > 0) {
          // Legitimate end of pagination: we already have real rows from an
          // earlier page, and this page is a genuinely empty (but
          // array-typed) response — CoinGecko has no more data to give us.
          pagesOk += 1;
          break;
        }
        // Zero rows collected so far AND this page came back as an empty
        // array — do not treat this as a successful, complete fetch. A
        // page failure, not a data-exhaustion signal.
        lastFailureReason = 'MARKET_EMPTY_ROWS';
        logWarn('page_empty_rows', { page });
        continue;
      }

      pagesOk += 1;
      rows.push(...pageRows);
      if (pageRows.length < PER_PAGE || rows.length >= cap) break;
    }

    const boundedRows = rows.slice(0, cap);

    // Zero total rows must never be reported as ok:true/status:'ok', even
    // as a defense-in-depth check against the loop logic above — a caller
    // must never write an empty snapshot believing the fetch succeeded.
    if (pagesOk === 0 || boundedRows.length === 0) {
      return {
        ok: false,
        rows: [],
        pagesOk,
        pagesAttempted,
        status: 'failed',
        reason: rateLimited ? 'UPSTREAM_RATE_LIMITED' : (lastFailureReason || 'MARKET_FETCH_FAILED'),
      };
    }

    const status = pagesOk < pagesAttempted ? 'partial' : 'ok';
    return {
      ok: true,
      rows: boundedRows,
      pagesOk,
      pagesAttempted,
      status,
      reason: status === 'partial' ? (rateLimited ? 'UPSTREAM_RATE_LIMITED' : lastFailureReason) : null,
    };
  } catch (err) {
    logWarn('unexpected_failure', { name: err?.name || 'Error' });
    return { ok: false, rows: [], pagesOk: 0, pagesAttempted: 0, status: 'failed', reason: 'MARKET_FETCH_FAILED' };
  }
}
