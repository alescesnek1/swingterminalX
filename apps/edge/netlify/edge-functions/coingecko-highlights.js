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
      sections.push({
        key: current.title.toLowerCase().replace(/ /g, '_'),
        title: current.title,
        items
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
    if (item.name && !seenHrefs.has(item.href)) {
      validItems.push(item);
      seenHrefs.add(item.href);
    }
  }

  return validItems;
}

function stripTags(s) {
  return String(s || '').replace(/<\/?[^>]+>/g, ' ').replace(/\s+/g, ' ');
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
          // No explicit sign in text. Look at HTML.
          const lowerHtml = htmlStr.toLowerCase();
          if (lowerHtml.includes('down') || lowerHtml.includes('red') || lowerHtml.includes('fall')) {
              sign = -1;
          }
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
  
  let name = nameTokens[0] || 'Unknown';
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

function corsHeaders(req) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function jsonHeaders(req) {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': `public, s-maxage=${CDN_MAX_AGE_SEC}, stale-while-revalidate=${CDN_SWR_SEC}`,
    ...corsHeaders(req),
  };
}

export default async function handler(request, context) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }

  const now = Date.now();
  if (_cache && now - _cache.at < MEMORY_TTL_MS) {
    return new Response(_cache.body, { status: 200, headers: jsonHeaders(request) });
  }

  try {
    const res = await fetch(GECKO_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SwingTerminal/1.0)',
        'Accept': 'text/html'
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const degraded = parseCoinGeckoHighlights(null);
      degraded.diagnostics.warnings.push(`HTTP ${res.status}`);
      return new Response(JSON.stringify(degraded), { status: 200, headers: jsonHeaders(request) });
    }

    const html = await res.text();
    const payload = parseCoinGeckoHighlights(html);

    if (payload.ok) {
      const body = JSON.stringify(payload);
      _cache = { at: now, body };
      return new Response(body, { status: 200, headers: jsonHeaders(request) });
    } else {
      return new Response(JSON.stringify(payload), { status: 200, headers: jsonHeaders(request) });
    }
  } catch (err) {
    const degraded = parseCoinGeckoHighlights(null);
    degraded.diagnostics.warnings.push(`Fetch failed: ${err.message}`);
    return new Response(JSON.stringify(degraded), { status: 200, headers: jsonHeaders(request) });
  }
}
