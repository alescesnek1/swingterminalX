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
    const nextIdx = i < indices.length - 1 ? indices[i+1].idx : html.length;
    // Extract the block of HTML between this heading and the next
    const block = html.substring(current.idx, nextIdx);
    
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
  // CoinGecko highlights items usually have links like `/en/coins/...`
  // We can look for items wrapped in typical list/row tags
  // We'll split the block by `href="/en/coins/` or `<a ` to isolate items
  // An even better way is to find repeating container tags. Since we don't know the exact DOM,
  // we use a regex to capture text near a coin link.
  
  // Try to find table rows
  const rowMatches = block.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi);
  if (rowMatches && rowMatches.length > 1) { // Assuming >1 because of header row
    for (const row of rowMatches) {
      if (row.includes('<th')) continue;
      const item = extractItemFromText(row);
      if (item) items.push(item);
    }
    return items;
  }
  
  // If no <tr>, try looking for generic wrapper divs that contain a link
  // Splitting by `<a ` might work, but multiple <a> per item is common.
  // We'll split by `href="/en/coins/` and try to reconstruct the item.
  // Actually, splitting by `href="/en/` is safer for categories too.
  
  // Let's strip all tags EXCEPT `<a>` to find logical blocks. Or just use a block splitter.
  // A simple heuristic for CoinGecko grid: 
  const links = block.match(/<a[^>]+href="(\/en\/(?:coins|categories)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
  if (links) {
     // A lot of links might point to the same coin (logo, name, etc)
     // We need to group them or find the parent container.
     // Without DOM parsing, it's safer to extract text chunks separated by large spacing.
  }
  
  // Let's just use a very generic text-based extractor over the whole block.
  // We find matches for `/en/coins/([^\"]+)` and extract the surrounding text (up to 200 chars after it).
  const regex = /href="(\/en\/(?:coins|categories)\/[^"]+)"[^>]*>([\s\S]*?)(?:href="\/en\/|$)/gi;
  // This is too fragile.
  
  // Let's stick to a robust fallback: split by `<img` or `flex` classes?
  // Let's extract all <a> tags. If it has text, maybe it's an item name.
  // But we need price and change. 
  // Let's just strip HTML tags and parse line by line.
  const cleanBlock = block.replace(/<\/div>/gi, '\\n').replace(/<\/tr>/gi, '\\n').replace(/<\/li>/gi, '\\n');
  const lines = cleanBlock.split('\\n');
  let currentItemText = '';
  
  for (const line of lines) {
    const text = stripTags(line).trim();
    if (text) {
      currentItemText += ' ' + text;
    }
    // If we have accumulated enough or hit a boundary, parse it.
    // We can just accumulate lines until we see a price and a change %, then flush.
    if (currentItemText.match(/\$[0-9,.]+/) && currentItemText.match(/[+-][0-9,.]+\s*%/)) {
       const item = extractItemFromText(line); // Pass the original line to keep links if needed
       // Actually, we lost the link by stripping tags.
    }
  }

  // Let's go back to the row approach, and add a div-based approach
  // Many divs have classes like 'tw-flex' or similar. 
  // We can look for `<div` that contains `href="/en/` and `$` and `%`
  const itemBlocks = block.match(/<div[^>]*>[\s\S]*?<\/div>/gi);
  // This is recursive and regex will fail on nested divs.

  // Let's use a simpler heuristic. Find all matches of `href="/en/coins/...`
  // and find the text immediately following it until the next `<a ` or `</div>`
  
  // For the sake of this robust script, we will split the block by `href="` and process each segment.
  const segments = block.split('href="');
  let currentItem = null;
  
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const quoteIdx = seg.indexOf('"');
    if (quoteIdx === -1) continue;
    const href = seg.substring(0, quoteIdx);
    
    if (href.startsWith('/en/coins/') || href.startsWith('/en/categories/')) {
       // This is a coin/category link.
       const fullLink = 'https://www.coingecko.com' + href;
       // Find the text after the link until next major boundary
       const textPart = stripTags('<a href="' + seg).trim().replace(/\s+/g, ' ');
       
       if (textPart.length > 0) {
           // If we already have an item with the same link, append text
           if (currentItem && currentItem.href === fullLink) {
               currentItem.rawText += ' ' + textPart;
           } else {
               if (currentItem) items.push(parseRawTextIntoItem(currentItem));
               currentItem = { href: fullLink, rawText: textPart };
           }
       }
    } else if (currentItem) {
       // Append text of non-coin links/content to the current item
       currentItem.rawText += ' ' + stripTags(seg).trim().replace(/\s+/g, ' ');
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
  
  // Try to extract price
  const priceMatch = text.match(/\$[0-9,.]+/);
  const priceText = priceMatch ? priceMatch[0] : '';
  
  // Extract change
  const changeMatch = text.match(/([+-][0-9,.]+)\s*%/);
  let change24hPct = null;
  let change24hText = '';
  if (changeMatch) {
      change24hText = changeMatch[0];
      change24hPct = parseFloat(changeMatch[1].replace(/,/g, ''));
  }
  
  // Extract name/symbol
  const tokens = text.split(' ').filter(Boolean);
  let rank = null;
  if (/^\d+$/.test(tokens[0])) {
      rank = parseInt(tokens[0], 10);
      tokens.shift();
  }
  
  // The first token is usually the name
  let name = tokens[0] || 'Unknown';
  let symbol = '';
  
  // Heuristic: if there's a token that is all caps, it's the symbol
  for (const t of tokens) {
    if (/^[A-Z0-9-]{2,10}$/.test(t) && t !== name) {
      symbol = t;
      break;
    }
  }
  
  // Clean up name if symbol is attached (e.g. "BitcoinBTC")
  if (symbol && name.endsWith(symbol) && name !== symbol) {
      name = name.substring(0, name.length - symbol.length);
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

function extractItemFromText(rowHtml) {
  const text = stripTags(rowHtml).trim().replace(/\s+/g, ' ');
  if (!text) return null;
  
  const hrefMatch = rowHtml.match(/href="(\/en\/(?:coins|categories)\/[^"]+)"/);
  const href = hrefMatch ? 'https://www.coingecko.com' + hrefMatch[1] : '';
  
  return parseRawTextIntoItem({ href, rawText: text });
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

export async function handler(request) {
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
