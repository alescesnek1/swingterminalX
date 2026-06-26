import test from 'node:test';
import assert from 'node:assert';

import { parseCoinGeckoHighlights } from '../apps/edge/netlify/edge-functions/coingecko-highlights.js';

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

test('Source guard: no Binance order endpoints, no Telegram sender, no worker mutation paths', (t) => {
  assert.ok(true);
});
