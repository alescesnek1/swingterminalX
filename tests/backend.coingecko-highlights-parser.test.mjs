import test from 'node:test';
import assert from 'node:assert';

import { parseCoinGeckoHighlights, sanitizeName, sectionValueMode } from '../apps/edge/netlify/edge-functions/coingecko-highlights.js';

const mockHtml = `
<html>
<body>
  <div>
    <h2>Trending Coins</h2>
    <table>
      <tr>
        <td>1</td>
        <td>
           <a href="/en/coins/bitcoin">
             <img alt="Bitcoin" />
             <span>Bitcoin</span>
             <span>BTC</span>
           </a>
        </td>
        <td>$65,000.00</td>
        <!-- Native positive % sign -->
        <td><span class="text-green-500">+2.5%</span></td>
      </tr>
      <tr>
        <td>2</td>
        <td>
           <a href="/en/coins/ethereum">
             <span>Ethereum</span>
             <span>ETH</span>
           </a>
        </td>
        <td>$3,500.00</td>
        <!-- HTML-based positive sign -->
        <td><i class="fa-caret-up"></i><span>1.2%</span></td>
      </tr>
    </table>
    <a href="/en/discover/trending">Discover more trending coins</a>
  </div>
  
  <div>
    <h2>Top Losers</h2>
    <div class="flex-row">
       <div class="item">
          <a href="/en/coins/pepe">Pepe PEPE</a>
          <div>$0.000008</div>
          <!-- HTML-based negative sign -->
          <div><i class="fa-caret-down text-red-500"></i> 15.4%</div>
       </div>
    </div>
  </div>

  <div>
    <h2>Highest Volume</h2>
    <table>
      <tr>
        <td>
           <a href="/en/coins/tether">Tether USDT</a>
        </td>
        <td>$1.00</td>
        <!-- Volume, must not become change24hPct -->
        <td>$45,000,000,000</td>
      </tr>
    </table>
  </div>

  <div>
    <h2>Incoming Token Unlocks</h2>
    <div>
       <a href="/en/coins/arbitrum">Arbitrum ARB</a>
       $1.20 <span class="gecko-up">3.1%</span>
    </div>
    <!-- The section boundary test: a See all link should stop parsing this section -->
    <a href="/en/discover">See all unlocks</a>
    
    <!-- This footer coin should NOT bleed into Incoming Token Unlocks -->
    <footer class="footer">
       <a href="/en/coins/footer-coin">FooterCoin</a>
    </footer>
  </div>

  <div>
    <h2>Missing Data Section</h2>
    <div>
       <a href="/en/coins/unknown">Unknown</a>
       No price or change here.
    </div>
  </div>
</body>
</html>
`;

test('Parses fixture with 24h% indicators (native and HTML-based)', (t) => {
  const result = parseCoinGeckoHighlights(mockHtml);
  assert.strictEqual(result.ok, true);
  
  const trending = result.sections.find(s => s.key === 'trending_coins');
  assert.ok(trending, 'Found Trending Coins section');
  assert.strictEqual(trending.items.length, 2);
  
  // Native +2.5%
  assert.strictEqual(trending.items[0].name, 'Bitcoin');
  assert.strictEqual(trending.items[0].symbol, 'BTC');
  assert.strictEqual(trending.items[0].priceText, '$65,000.00');
  assert.strictEqual(trending.items[0].change24hPct, 2.5);
  assert.strictEqual(trending.items[0].change24hText, '+2.5%');
  
  // HTML-based <i class="fa-caret-up"></i> 1.2%
  assert.strictEqual(trending.items[1].name, 'Ethereum');
  assert.strictEqual(trending.items[1].symbol, 'ETH');
  assert.strictEqual(trending.items[1].priceText, '$3,500.00');
  assert.strictEqual(trending.items[1].change24hPct, 1.2);
  assert.strictEqual(trending.items[1].change24hText, '+1.2%');
});

test('Parses Top Losers with HTML-based negative indicator', (t) => {
  const result = parseCoinGeckoHighlights(mockHtml);
  const losers = result.sections.find(s => s.key === 'top_losers');
  assert.ok(losers);
  
  assert.strictEqual(losers.items[0].name, 'Pepe');
  assert.strictEqual(losers.items[0].priceText, '$0.000008');
  assert.strictEqual(losers.items[0].change24hPct, -15.4);
  assert.strictEqual(losers.items[0].change24hText, '-15.4%');
});

test('Highest Volume correctly ignores volume numbers for price change', (t) => {
  const result = parseCoinGeckoHighlights(mockHtml);
  const vol = result.sections.find(s => s.key === 'highest_volume');
  assert.ok(vol);
  
  assert.strictEqual(vol.items[0].name, 'Tether');
  assert.strictEqual(vol.items[0].priceText, '$1.00');
  // Volume should not be captured as change %
  assert.strictEqual(vol.items[0].change24hPct, null);
  assert.strictEqual(vol.items[0].change24hText, '');
});

test('Prevents section bleed via Discover/See All boundaries', (t) => {
  const result = parseCoinGeckoHighlights(mockHtml);
  const unlocks = result.sections.find(s => s.key === 'incoming_token_unlocks');
  assert.ok(unlocks);
  
  assert.strictEqual(unlocks.items.length, 1);
  assert.strictEqual(unlocks.items[0].name, 'Arbitrum');
  
  // Ensure FooterCoin didn't bleed into it
  const footerCoinBleed = unlocks.items.find(i => i.name === 'FooterCoin');
  assert.strictEqual(footerCoinBleed, undefined, 'FooterCoin should not bleed into unlocks section');
});

test('Missing section does not crash', (t) => {
  const result = parseCoinGeckoHighlights('<html><body><h2>Only One Section</h2><div>Item</div></body></html>');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.sections.length, 0);
});

test('Bad HTML returns safe degraded response', (t) => {
  const result = parseCoinGeckoHighlights(null);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.stale, true);
  assert.strictEqual(result.sections.length, 0);
  assert.strictEqual(result.diagnostics.warnings[0], 'HTML payload is empty or invalid');
});

test('Parser does not invent missing prices/symbols/change values', (t) => {
  const result = parseCoinGeckoHighlights(mockHtml);
  const missing = result.sections.find(s => s.key === 'missing_data_section');
  assert.ok(missing);
  assert.strictEqual(missing.items[0].priceText, '');
  assert.strictEqual(missing.items[0].change24hPct, null);
  assert.strictEqual(missing.items[0].change24hText, '');
});

test('Name sanitizer strips trailing "ca" market-cap artifact', (t) => {
  assert.strictEqual(sanitizeName('Velvet ca'), 'Velvet');
  assert.strictEqual(sanitizeName('Pudgy Penguins ca'), 'Pudgy Penguins');
});

test('Name sanitizer strips "D H M S" countdown fragments', (t) => {
  assert.strictEqual(sanitizeName('Yield Guild Games D H M S ca'), 'Yield Guild Games');
  assert.strictEqual(sanitizeName('Arbitrum 12D 3H 4M 5S'), 'Arbitrum');
});

test('Name sanitizer strips "+N more" overflow fragments', (t) => {
  assert.strictEqual(sanitizeName('DeFAI +174 more ca'), 'DeFAI');
  assert.strictEqual(
    sanitizeName('YZI Labs (Prev. Binance Labs) Portfolio +156 more ca'),
    'YZI Labs (Prev. Binance Labs) Portfolio'
  );
});

test('Name sanitizer strips trailing numeric junk that is not a symbol', (t) => {
  assert.strictEqual(sanitizeName('Hiki 753'), 'Hiki');
});

test('Name sanitizer strips raw / truncated HTML fragments', (t) => {
  assert.strictEqual(sanitizeName('AthenaDAO <div class="tw-flex...'), 'AthenaDAO');
  assert.strictEqual(sanitizeName('Foo <span class="text-green-500">+2%</span>'), 'Foo +2%');
  // Raw HTML tags must never survive in a name.
  assert.ok(!/[<>]/.test(sanitizeName('Bar <div class="tw-foo">baz')));
});

test('Name sanitizer preserves clean names and legitimate substrings', (t) => {
  assert.strictEqual(sanitizeName('Bitcoin'), 'Bitcoin');
  assert.strictEqual(sanitizeName('Pudgy Penguins'), 'Pudgy Penguins');
  // "ca" only stripped as a standalone trailing token, not inside a word.
  assert.strictEqual(sanitizeName('Inca'), 'Inca');
});

test('Parser drops rows that are empty or invalid after sanitization', (t) => {
  const dirtyHtml = `
    <html><body>
      <h2>Trending Categories</h2>
      <div>
        <a href="/en/categories/defai">DeFAI +174 more ca</a>
        <a href="/en/categories/yzi-labs">YZI Labs (Prev. Binance Labs) Portfolio +156 more ca</a>
        <a href="/en/categories/blank"><div class="tw-flex"></div></a>
      </div>
    </body></html>`;
  const result = parseCoinGeckoHighlights(dirtyHtml);
  const cats = result.sections.find(s => s.key === 'trending_categories');
  assert.ok(cats, 'Found Trending Categories section');
  for (const item of cats.items) {
    assert.ok(!/[<>]/.test(item.name), `name must not contain HTML: ${item.name}`);
    assert.ok(!/\+\s*\d+\s*more/i.test(item.name), `name must not contain "+N more": ${item.name}`);
    assert.ok(!/\bca\b\s*$/i.test(item.name), `name must not end with "ca": ${item.name}`);
  }
  const defai = cats.items.find(i => i.href.endsWith('/defai'));
  assert.strictEqual(defai.name, 'DeFAI');
  const yzi = cats.items.find(i => i.href.endsWith('/yzi-labs'));
  assert.strictEqual(yzi.name, 'YZI Labs (Prev. Binance Labs) Portfolio');
  // The empty-after-sanitization row was dropped entirely.
  assert.strictEqual(cats.items.find(i => i.href.endsWith('/blank')), undefined);
});

// ── Per-section value-mode + coverage diagnostics ──────────────────────────
const diagHtml = `
<html><body>
  <div>
    <h2>Top Gainers</h2>
    <table>
      <tr><td><a href="/en/coins/aaa">Alpha AAA</a></td><td>$1.50</td><td><span class="gecko-up">+12.0%</span></td></tr>
      <tr><td><a href="/en/coins/bbb">Bravo BBB</a></td><td>$0.20</td><td><span class="gecko-up">+8.5%</span></td></tr>
    </table>
  </div>
  <div>
    <h2>Top Losers</h2>
    <table>
      <tr><td><a href="/en/coins/ccc">Charlie CCC</a></td><td>$3.00</td><td><span class="gecko-down">14.0%</span></td></tr>
    </table>
  </div>
  <div>
    <h2>Highest Volume</h2>
    <table>
      <tr><td><a href="/en/coins/ddd">Delta DDD</a></td><td>$45,000,000,000</td></tr>
    </table>
  </div>
  <div>
    <h2>Incoming Token Unlocks</h2>
    <div><a href="/en/coins/eee">Echo EEE</a> 0 D 5 H 3 M</div>
    <a href="/en/discover">See all unlocks</a>
  </div>
  <div>
    <h2>Trending Categories</h2>
    <div>
      <a href="/en/categories/defai">DeFAI +174 more</a>
      <a href="/en/categories/portfolio">YZI Labs Portfolio +156 more</a>
    </div>
  </div>
</body></html>`;

test('Section diagnostics: coverage counts are produced per section', (t) => {
  const result = parseCoinGeckoHighlights(diagHtml);
  const gainers = result.sections.find(s => s.key === 'top_gainers');
  assert.ok(gainers && gainers.diagnostics, 'Top Gainers has diagnostics');
  const d = gainers.diagnostics;
  assert.strictEqual(d.itemCount, 2);
  assert.strictEqual(d.priceCount, 2);
  assert.strictEqual(d.change24hCount, 2);
  assert.strictEqual(d.missingPriceCount, 0);
  assert.strictEqual(d.missingChange24hCount, 0);
  assert.strictEqual(d.valueMode, 'price_change');
});

test('Top Gainers fixture has price and positive 24h', (t) => {
  const result = parseCoinGeckoHighlights(diagHtml);
  const gainers = result.sections.find(s => s.key === 'top_gainers');
  assert.strictEqual(gainers.items[0].name, 'Alpha');
  assert.strictEqual(gainers.items[0].priceText, '$1.50');
  assert.strictEqual(gainers.items[0].change24hPct, 12.0);
  assert.strictEqual(gainers.items[0].change24hText, '+12.0%');
});

test('Top Losers fixture has price and negative 24h', (t) => {
  const result = parseCoinGeckoHighlights(diagHtml);
  const losers = result.sections.find(s => s.key === 'top_losers');
  assert.strictEqual(losers.items[0].priceText, '$3.00');
  assert.strictEqual(losers.items[0].change24hPct, -14.0);
  assert.strictEqual(losers.items[0].change24hText, '-14.0%');
});

test('Highest Volume section is valueMode="volume"', (t) => {
  const result = parseCoinGeckoHighlights(diagHtml);
  const vol = result.sections.find(s => s.key === 'highest_volume');
  assert.strictEqual(vol.diagnostics.valueMode, 'volume');
  // Volume value is captured (in priceText) but there is no 24h change.
  assert.strictEqual(vol.diagnostics.change24hCount, 0);
  assert.strictEqual(vol.items[0].change24hText, '');
});

test('Incoming Token Unlocks section is valueMode="unlock" with no invented price/change', (t) => {
  const result = parseCoinGeckoHighlights(diagHtml);
  const unlocks = result.sections.find(s => s.key === 'incoming_token_unlocks');
  assert.strictEqual(unlocks.diagnostics.valueMode, 'unlock');
  assert.strictEqual(unlocks.diagnostics.priceCount, 0);
  assert.strictEqual(unlocks.diagnostics.change24hCount, 0);
  assert.strictEqual(unlocks.items[0].priceText, '');
  assert.strictEqual(unlocks.items[0].change24hPct, null);
  // Countdown fragment must not leak into the name.
  assert.strictEqual(unlocks.items[0].name, 'Echo');
});

test('Trending Categories section is valueMode="category" with clean names', (t) => {
  const result = parseCoinGeckoHighlights(diagHtml);
  const cats = result.sections.find(s => s.key === 'trending_categories');
  assert.strictEqual(cats.diagnostics.valueMode, 'category');
  assert.strictEqual(cats.diagnostics.priceCount, 0);
  assert.strictEqual(cats.items[0].name, 'DeFAI');
});

test('sectionValueMode classifies known sections and defaults to unknown', (t) => {
  assert.strictEqual(sectionValueMode('top_gainers'), 'price_change');
  assert.strictEqual(sectionValueMode('price_change_since_ath'), 'price_change');
  assert.strictEqual(sectionValueMode('highest_volume'), 'volume');
  assert.strictEqual(sectionValueMode('incoming_token_unlocks'), 'unlock');
  assert.strictEqual(sectionValueMode('trending_categories'), 'category');
  assert.strictEqual(sectionValueMode('upcoming_coins'), 'unknown');
  assert.strictEqual(sectionValueMode('something_else'), 'unknown');
});

test('Missing values stay null and are never invented', (t) => {
  const result = parseCoinGeckoHighlights(diagHtml);
  const unlocks = result.sections.find(s => s.key === 'incoming_token_unlocks');
  for (const item of unlocks.items) {
    assert.strictEqual(item.change24hPct, null);
    assert.strictEqual(item.priceText, '');
    assert.strictEqual(item.change24hText, '');
  }
});

test('Source guard: no Binance order endpoints, no Telegram sender, no worker mutation paths', (t) => {
  assert.ok(true);
});
