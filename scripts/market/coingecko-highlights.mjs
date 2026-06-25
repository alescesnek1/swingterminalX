export function createUnavailableCoinGeckoSnapshot(reason, options = {}) {
  return {
    source: "coingecko",
    kind: "trending",
    fetchedAt: new Date().toISOString(),
    stale: true,
    unavailableReason: String(reason || 'UNAVAILABLE'),
    items: []
  };
}

export function normalizeCoinGeckoTrending(rawResponse, options = {}) {
  if (!rawResponse || !Array.isArray(rawResponse.coins)) {
    return createUnavailableCoinGeckoSnapshot('BAD_SCHEMA', options);
  }

  const items = [];
  for (let i = 0; i < rawResponse.coins.length; i++) {
    const coin = rawResponse.coins[i];
    if (coin && coin.item && typeof coin.item.symbol === 'string') {
      const rawSym = coin.item.symbol.toUpperCase().trim();
      if (rawSym) {
        items.push({
          coingeckoId: coin.item.id || null,
          symbol: rawSym,
          name: coin.item.name || null,
          rank: i + 1,
          score: coin.item.score !== undefined ? coin.item.score : null,
          thumb: coin.item.thumb || null,
          marketSymbolCandidates: [`${rawSym}USDT`, `${rawSym}USDC`]
        });
      }
    }
  }

  if (items.length === 0) {
    return createUnavailableCoinGeckoSnapshot('EMPTY_COINS', options);
  }

  return {
    source: "coingecko",
    kind: "trending",
    fetchedAt: new Date().toISOString(),
    stale: false,
    unavailableReason: null,
    items
  };
}

export function matchCoinGeckoTrendingToMarketSymbol(itemOrSymbol, marketSymbol, options = {}) {
  if (!marketSymbol || typeof marketSymbol !== 'string') {
    return { matched: false, confidence: "none", reason: "INVALID_MARKET_SYMBOL" };
  }
  const mSym = marketSymbol.toUpperCase().trim();
  if (!mSym) {
    return { matched: false, confidence: "none", reason: "EMPTY_MARKET_SYMBOL" };
  }
  
  let cgSym = '';
  if (typeof itemOrSymbol === 'string') {
    cgSym = itemOrSymbol;
  } else if (itemOrSymbol && typeof itemOrSymbol.symbol === 'string') {
    cgSym = itemOrSymbol.symbol;
  }
  
  cgSym = cgSym.toUpperCase().trim();
  if (!cgSym) {
    return { matched: false, confidence: "none", reason: "EMPTY_COINGECKO_SYMBOL" };
  }

  // Exact match (e.g. BEAT == BEAT)
  if (mSym === cgSym) {
    return { matched: true, confidence: "exact", baseSymbol: cgSym, marketSymbol: mSym };
  }
  
  // Standard quote match
  const validQuotes = ['USDT', 'USDC', 'USD', 'BUSD', 'BTC'];
  for (const quote of validQuotes) {
    if (mSym === `${cgSym}${quote}`) {
      return { matched: true, confidence: "symbol", baseSymbol: cgSym, marketSymbol: mSym };
    }
  }

  // Strict prefix check (prevent PEPE matching 1000PEPEUSDT)
  if (mSym.includes(cgSym)) {
    return { matched: false, confidence: "none", reason: "AMBIGUOUS_PREFIX" };
  }

  return { matched: false, confidence: "none", reason: "NO_MATCH" };
}

export async function fetchCoinGeckoTrending(options = {}) {
  try {
    const url = 'https://api.coingecko.com/api/v3/search/trending';
    const res = await fetch(url, { headers: { Accept: 'application/json' }, ...options });
    if (!res.ok) {
      return createUnavailableCoinGeckoSnapshot(`HTTP_${res.status}`, options);
    }
    const data = await res.json();
    return normalizeCoinGeckoTrending(data, options);
  } catch (err) {
    return createUnavailableCoinGeckoSnapshot('FETCH_FAILED', options);
  }
}
