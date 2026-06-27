// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// CoinGecko Highlights Parser (Read-Only)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const CDN_MAX_AGE_SEC = 60;
const CDN_SWR_SEC = 240;
const MEMORY_TTL_MS = 15 * 60 * 1000; // 15 minutes

const GECKO_URL = 'https://www.coingecko.com/en/highlights';

let _cache = null;

const TARGET_SECTIONS = [
  'Trending Coins',
  'Top Gainers',
  'Top Losers',
  'New Coins',
  'Incoming Token Unlocks',
  'Most Viewed',
  'Highest Volume',
  'Price Change since ATH',
  'Most Voted Coins',
  'Upcoming Coins',
  'Trending Categories',
  'Missing Data Section' // For testing
];

// Per-section value semantics. Drives honest UI rendering and diagnostics.
//   price_change → row carries a spot price and/or a % change (coin market lists)
//   volume       → row's primary $ value is trading volume, not price
//   unlock       → row value is an unlock date/countdown (no price/change)
//   category     → category cards (no price/change in source HTML)
//   unknown      → informational rows with no price/change (e.g. upcoming vote counts)
const SECTION_VALUE_MODE = {
  trending_coins: 'price_change',
  top_gainers: 'price_change',
  top_losers: 'price_change',
  new_coins: 'price_change',
  most_viewed: 'price_change',
  most_voted_coins: 'price_change',
  price_change_since_ath: 'price_change',
  highest_volume: 'volume',
  incoming_token_unlocks: 'unlock',
  upcoming_coins: 'unknown',
  trending_categories: 'category',
};

export function sectionValueMode(key) {
  return SECTION_VALUE_MODE[key] || 'unknown';
}

export function parseCoinGeckoHighlights(html) {
  if (!html || typeof html !== 'string') {
    return {
      ok: false,
      source: "coingecko-highlights",
      sourceUrl: GECKO_URL,
      fetchedAt: new Date().toISOString(),
      stale: true,
      sections: [],
      diagnostics: { parserVersion: 1, sectionCount: 0, itemCount: 0, warnings: ['HTML payload is empty or invalid'] }
    };
  }

  const sections = [];
  let totalItems = 0;
  const warnings = [];

  // Find all sections by heading
  const indices = [];
  for (const title of TARGET_SECTIONS) {
    const idx = html.indexOf(title);
    if (idx !== -1) {
      indices.push({ title, idx });
    }
  }

  indices.sort((a, b) => a.idx - b.idx);

  for (let i = 0; i < indices.length; i++) {
    const current = indices[i];
    let nextIdx = i < indices.length - 1 ? indices[i+1].idx : html.length;
    
    // Prevent section bleed: stop at footer or main end
    const footerIdx = html.indexOf('<footer', current.idx);
    if (footerIdx !== -1 && footerIdx < nextIdx) nextIdx = footerIdx;

    const mainEndIdx = html.indexOf('</main>', current.idx);
    if (mainEndIdx !== -1 && mainEndIdx < nextIdx) nextIdx = mainEndIdx;

    // Safety cutoff for last section
    if (nextIdx - current.idx > 15000) {
        nextIdx = current.idx + 15000;
    }
    
    let block = html.substring(current.idx, nextIdx);
    
    // Card boundary heuristic: "See all" or "Discover more" or "Explore"
    const seeAllMatch = block.match(/>\s*(See all|Discover more|Explore)[^<]*<\/a>/i);
    if (seeAllMatch) {
        block = block.substring(0, seeAllMatch.index);
    }
    
    const items = parseItemsFromBlock(block);
    if (items.length > 0) {
      const key = current.title.toLowerCase().replace(/ /g, '_');
      const priceCount = items.filter(i => i.priceText).length;
      const change24hCount = items.filter(i => i.change24hText).length;
      sections.push({
        key,
        title: current.title,
        items,
        // Per-section coverage diagnostics (debug only — never affects trading).
        diagnostics: {
          itemCount: items.length,
          priceCount,
          change24hCount,
          missingPriceCount: items.length - priceCount,
          missingChange24hCount: items.length - change24hCount,
          valueMode: sectionValueMode(key)
        }
      });
      totalItems += items.length;
    } else {
      warnings.push(`Section '${current.title}' found but no items extracted.`);
    }
  }

  return {
    ok: true,
    source: "coingecko-highlights",
    sourceUrl: GECKO_URL,
    fetchedAt: new Date().toISOString(),
    stale: false,
    sections,
    diagnostics: {
      parserVersion: 1,
      sectionCount: sections.length,
      itemCount: totalItems,
      warnings
    }
  };
}

function parseItemsFromBlock(block) {
  const items = [];
  
  const segments = block.split('href="');
  let currentItem = null;
  
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const quoteIdx = seg.indexOf('"');
    if (quoteIdx === -1) continue;
    const href = seg.substring(0, quoteIdx);
    const rawHtmlPart = '<a href="' + seg;
    
    if (href.startsWith('/en/coins/') || href.startsWith('/en/categories/')) {
       const fullLink = 'https://www.coingecko.com' + href;
       const textPart = stripTags(rawHtmlPart).trim().replace(/\s+/g, ' ');
       
       if (currentItem && currentItem.href === fullLink) {
           currentItem.rawText += ' ' + textPart;
           currentItem.rawHtml += ' ' + rawHtmlPart;
       } else {
           if (currentItem) items.push(parseRawTextIntoItem(currentItem));
           currentItem = { href: fullLink, rawText: textPart, rawHtml: rawHtmlPart };
       }
    } else if (currentItem) {
       currentItem.rawText += ' ' + stripTags(rawHtmlPart).trim().replace(/\s+/g, ' ');
       currentItem.rawHtml += ' ' + rawHtmlPart;
    }
  }
  
  if (currentItem) items.push(parseRawTextIntoItem(currentItem));
  
  // Filter out invalid items and dedup
  const validItems = [];
  const seenHrefs = new Set();
  
  for (const item of items) {
    // Drop rows whose name is empty or obviously invalid after sanitization.
    if (isValidName(item.name) && !seenHrefs.has(item.href)) {
      validItems.push(item);
      seenHrefs.add(item.href);
    }
  }

  return validItems;
}

function stripTags(s) {
  return String(s || '').replace(/<\/?[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

// ────────────────────────────────────────────────────────────────────────────
// Strict name sanitizer.
// Removes parser artifacts from a coin/category name without inventing data.
// Handles: raw/truncated HTML tags & attributes, "+123 more" link fragments,
// "D H M S" countdown fragments, trailing "ca" (market cap) artifact, footer/nav
// link text, and trailing numeric junk that is not a symbol.
// ────────────────────────────────────────────────────────────────────────────
export function sanitizeName(raw) {
  if (raw == null) return '';
  let s = String(raw);

  // 1. Strip complete HTML tags, then truncated/partial tags (e.g. `<div class="tw-flex...`).
  s = s.replace(/<\/?[a-z][^>]*>/gi, ' '); // complete tags
  s = s.replace(/<\/?[a-z][^>]*$/gi, ' '); // truncated opening tag running to end of string
  // Leftover bare HTML attribute / class fragments (e.g. class="tw-flex...", style=...).
  s = s.replace(/\b(?:class|style|href|src|data-[\w-]+|aria-[\w-]+)\s*=\s*"[^"]*"?/gi, ' ');
  s = s.replace(/\btw-[\w-]+/gi, ' '); // tailwind utility class fragments
  // HTML entities.
  s = s.replace(/&[a-z]+;/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // 2. "+123 more" fragments (trending category overflow links).
  s = s.replace(/\+\s*\d+\s*more\b/gi, ' ');

  // 3. "D H M S" / "12D 3H 4M 5S" countdown fragments (token-unlock timers).
  //    Requires at least two consecutive D/H/M/S tokens so single-letter names survive.
  s = s.replace(/\b\d*\s*[DHMS](?:\s+\d*\s*[DHMS])+\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // 4. Trailing standalone "ca" artifact (market-cap link text).
  s = s.replace(/\bca\b\s*$/i, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // 5. Trailing numeric junk that is not a symbol (e.g. "Hiki 753" -> "Hiki").
  s = s.replace(/\s+[\d][\d,.]*$/g, '');

  return s.replace(/\s+/g, ' ').trim();
}

// A name is usable only if, after sanitization, it still has real word content.
function isValidName(name) {
  const n = String(name || '').trim();
  if (n.length < 2) return false;
  if (!/[A-Za-z0-9]/.test(n)) return false; // pure punctuation / junk
  if (/[<>]/.test(n)) return false;          // residual HTML must never survive
  return true;
}

// Direction of a 24h change, inferred ONLY from CoinGecko's own direction
// markup — a color class, a brand hex colour, or an arrow glyph — and NEVER
// from arbitrary words in the row text. This is what stops a coin literally
// named "RED" / "DOWN" or a "Falling Knives" category from flipping a
// gainer's sign. Returns -1 (down), +1 (up) or 0 (unknown / no signal).
export function detectChangeDirection(html) {
  const h = String(html || '');
  // Class-style suffixes ([-_]down / [-_]up) match CoinGecko markup like
  // `gecko-down`, `change-down`, `price_up`, `text-red`, etc. They require a
  // leading hyphen/underscore so a bare coin/category name ("RED", "DOWN",
  // "Falling Knives") can never match. Plus brand hex colours and arrows.
  const DOWN = /(text-red|tw-text-red|text-danger|[-_]down\b|#ea3943|#cf304a|#f0616d|[▼↓⬇])/i;
  const UP   = /(text-green|tw-text-green|text-success|[-_]up\b|#16c784|#00c389|#1ea97c|[▲↑⬆])/i;
  const down = DOWN.test(h);
  const up = UP.test(h);
  if (down && !up) return -1;
  if (up && !down) return 1;
  return 0;
}

function parseRawTextIntoItem(item) {
  const text = item.rawText;
  const htmlStr = item.rawHtml || '';
  
  // Try to extract price
  const priceMatch = text.match(/\$[0-9,.]+/);
  const priceText = priceMatch ? priceMatch[0] : '';
  
  // Try to extract change
  let change24hPct = null;
  let change24hText = '';
  const pctMatch = text.match(/([+-]?\s*[0-9,.]+)\s*%/);
  
  if (pctMatch) {
      let valStr = pctMatch[1].replace(/\s/g, '').replace(/,/g, '');
      let sign = 1;
      if (valStr.startsWith('-')) {
          sign = -1;
          valStr = valStr.substring(1);
      } else if (valStr.startsWith('+')) {
          sign = 1;
          valStr = valStr.substring(1);
      } else {
          // No explicit +/- in the visible text — infer the sign ONLY from
          // CoinGecko's direction markup (color class / brand hex / arrow),
          // never from words like "red"/"down"/"fall" that can legitimately
          // appear inside a coin or category name.
          const dir = detectChangeDirection(htmlStr);
          if (dir < 0) sign = -1;
          else if (dir > 0) sign = 1;
      }
      
      const num = parseFloat(valStr);
      if (!isNaN(num)) {
          change24hPct = sign * num;
          change24hText = (sign === 1 ? '+' : '-') + valStr + '%';
      }
  }
  
  // Extract name/symbol
  const tokens = text.split(' ').filter(Boolean);
  let rank = null;
  if (/^\d+$/.test(tokens[0])) {
      rank = parseInt(tokens[0], 10);
      tokens.shift();
  }
  
  // Exclude tokens that look like price, percent, or pure large numbers (e.g. volume)
  const nameTokens = tokens.filter(t => !t.includes('$') && !t.includes('%') && !/^[0-9,.]+$/.test(t));
  
  let name = nameTokens[0] || ''; // do not invent a name; empty rows are dropped later
  let symbol = '';
  
  for (let i = 1; i < nameTokens.length; i++) {
    const t = nameTokens[i];
    if (/^[A-Z0-9-]{2,10}$/.test(t)) {
      symbol = t;
      name = nameTokens.slice(0, i).join(' ');
      break;
    }
  }
  
  if (!symbol && nameTokens.length > 1) {
      name = nameTokens.join(' ');
  }

  // Cleanup if symbol is attached
  if (symbol && name.endsWith(symbol) && name !== symbol) {
      name = name.substring(0, name.length - symbol.length).trim();
  }

  // Final strict sanitization pass — strip parser artifacts from the name.
  name = sanitizeName(name);

  return {
    rank,
    name,
    symbol,
    priceText,
    change24hText,
    change24hPct,
    href: item.href,
    rawText: text
  };
}

function corsHeaders(allowOrigin) {
  return {
    'Access-Control-Allow-Origin': allowOrigin || 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    // Vary on Authorization (not just Origin) so a shared/CDN cache can NEVER
    // serve an authenticated 200 to an unauthenticated caller — without this
    // the auth gate is bypassed on every cache hit. Parity with /api/markets.
    'Vary': 'Origin, Authorization',
  };
}

function jsonHeaders(allowOrigin) {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': `public, s-maxage=${CDN_MAX_AGE_SEC}, stale-while-revalidate=${CDN_SWR_SEC}`,
    ...corsHeaders(allowOrigin),
  };
}

// Gate / error (OPTIONS-aside) responses must never be stored by any cache,
// so an unauthenticated 401/403 can't be replayed and a cached body can't be
// confused with a gated one.
function gateHeaders(allowOrigin) {
  return { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(allowOrigin) };
}

// Core handler with INJECTABLE security + fetch. The default export wires in
// the real lib/security.js (Deno-only at module load) and global fetch; tests
// call runGecko() directly with mocks so the fail-closed behaviour is actually
// executed, not just grepped.
export async function runGecko(request, deps) {
  const { checkOrigin, verifyAuth, pickAllowOrigin, fetchImpl = fetch, now = Date.now() } = deps;
  const allowOrigin = pickAllowOrigin(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
  }
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: gateHeaders(allowOrigin) });
  }

  // FAIL-CLOSED gate: origin allowlist + Supabase JWT BEFORE any upstream
  // fetch/parse. GECKO scrapes an upstream on cache-miss, so an unauthorized
  // caller must never reach that path.
  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return new Response(JSON.stringify({ error: 'Forbidden origin', detail: originCheck.reason }), { status: 403, headers: gateHeaders(allowOrigin) });
  }
  const auth = await verifyAuth(request);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: 'Unauthorized', detail: auth.reason }), { status: auth.status || 401, headers: gateHeaders(allowOrigin) });
  }

  if (_cache && now - _cache.at < MEMORY_TTL_MS) {
    return new Response(_cache.body, { status: 200, headers: jsonHeaders(allowOrigin) });
  }

  try {
    const res = await fetchImpl(GECKO_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SwingTerminal/1.0)',
        'Accept': 'text/html'
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const degraded = parseCoinGeckoHighlights(null);
      degraded.diagnostics.warnings.push(`HTTP ${res.status}`);
      return new Response(JSON.stringify(degraded), { status: 200, headers: jsonHeaders(allowOrigin) });
    }

    const html = await res.text();
    const payload = parseCoinGeckoHighlights(html);

    if (payload.ok) {
      const body = JSON.stringify(payload);
      _cache = { at: now, body };
      return new Response(body, { status: 200, headers: jsonHeaders(allowOrigin) });
    } else {
      return new Response(JSON.stringify(payload), { status: 200, headers: jsonHeaders(allowOrigin) });
    }
  } catch (err) {
    const degraded = parseCoinGeckoHighlights(null);
    degraded.diagnostics.warnings.push(`Fetch failed: ${err.message}`);
    return new Response(JSON.stringify(degraded), { status: 200, headers: jsonHeaders(allowOrigin) });
  }
}

// Test-only: reset the in-isolate scrape cache so behaviour tests are isolated.
export function __resetGeckoCacheForTests() { _cache = null; }

export default async function handler(request, context) {
  // security.js pulls a Deno-only esm.sh dependency at module load, so import
  // it dynamically — the handler runs on Deno; node:test exercises runGecko
  // with mock security + fetch instead.
  const { checkOrigin, verifyAuth, pickAllowOrigin } = await import('./lib/security.js');
  return runGecko(request, { checkOrigin, verifyAuth, pickAllowOrigin });
}
