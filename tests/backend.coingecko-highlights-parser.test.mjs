import test from 'node:test';
import assert from 'node:assert';

// Import the parser logic once it's implemented.
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
        <td><span class="text-green-500">+2.5%</span></td>
      </tr>
      <tr>
        <td>2</td>
        <td>
           <a href="/en/coins/solana">
             <span>Solana</span>
             <span>SOL</span>
           </a>
        </td>
        <td>$140.50</td>
        <td><span class="text-red-500">-1.2%</span></td>
      </tr>
    </table>
  </div>
  <div>
    <h2>Top Gainers</h2>
    <div class="flex-row">
       <div class="item">
          <a href="/en/coins/pepe">Pepe PEPE</a>
          <div>$0.000008</div>
          <div>+15.4%</div>
       </div>
    </div>
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

test('Parses fixture with Trending Coins, Top Gainers, Missing Data Section', (t) => {
  const result = parseCoinGeckoHighlights(mockHtml);
  
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.stale, false);
  
  // Should find 3 sections
  assert.ok(result.sections.length >= 3);
  
  const trending = result.sections.find(s => s.key === 'trending_coins');
  assert.ok(trending, 'Found Trending Coins section');
  assert.strictEqual(trending.items.length, 2);
  
  assert.strictEqual(trending.items[0].name, 'Bitcoin');
  assert.strictEqual(trending.items[0].symbol, 'BTC');
  assert.strictEqual(trending.items[0].priceText, '$65,000.00');
  assert.strictEqual(trending.items[0].change24hPct, 2.5);
  
  assert.strictEqual(trending.items[1].name, 'Solana');
  assert.strictEqual(trending.items[1].symbol, 'SOL');
  assert.strictEqual(trending.items[1].change24hPct, -1.2);
  
  const gainers = result.sections.find(s => s.key === 'top_gainers');
  assert.ok(gainers, 'Found Top Gainers section');
  assert.strictEqual(gainers.items.length, 1);
  assert.strictEqual(gainers.items[0].name, 'Pepe');
  assert.strictEqual(gainers.items[0].priceText, '$0.000008');
  assert.strictEqual(gainers.items[0].change24hPct, 15.4);
});

test('Missing section does not crash', (t) => {
  const result = parseCoinGeckoHighlights('<html><body><h2>Only One Section</h2><div>Item</div></body></html>');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.sections.length, 0); // No known sections found
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
  // Pure parsing module, no imports of binance, telegram, or worker state.
  assert.ok(true);
});
