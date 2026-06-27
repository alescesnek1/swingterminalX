// Phase 2 — CoinGecko highlights parser robustness fixtures.
//
// The parser scrapes upstream HTML, so these REAL behaviour tests pin its
// contract against adversarial / dirty inputs. Most important: the 24h
// change SIGN must come from CoinGecko's direction markup, never from words
// like "red" / "down" / "fall" that can appear inside a coin name.

import test from 'node:test';
import assert from 'node:assert';

import {
  parseCoinGeckoHighlights,
  sanitizeName,
  sectionValueMode,
  detectChangeDirection,
} from '../apps/edge/netlify/edge-functions/coingecko-highlights.js';

const html = (...sections) => `<html><body>${sections.join('')}</body></html>`;

// ── detectChangeDirection: the name-safety guarantee ──────────────────────

test('detectChangeDirection reads markup, not free-text words', () => {
  // Direction markup → signed.
  assert.strictEqual(detectChangeDirection('<span class="gecko-down">'), -1);
  assert.strictEqual(detectChangeDirection('<span class="text-red">'), -1);
  assert.strictEqual(detectChangeDirection('<span class="change-down">'), -1);
  assert.strictEqual(detectChangeDirection('<i style="color:#ea3943"></i>'), -1);
  assert.strictEqual(detectChangeDirection('▼ 5%'), -1);
  assert.strictEqual(detectChangeDirection('<span class="gecko-up">'), 1);
  assert.strictEqual(detectChangeDirection('<span class="text-green">'), 1);
  assert.strictEqual(detectChangeDirection('▲ 5%'), 1);

  // Plain words inside a name must NEVER imply a direction.
  assert.strictEqual(detectChangeDirection('Red Down Falling RED'), 0);
  assert.strictEqual(detectChangeDirection('Reddit'), 0);
  assert.strictEqual(detectChangeDirection('Falling Knives'), 0);
  assert.strictEqual(detectChangeDirection(''), 0);
  // Conflicting signals → unknown (no guess).
  assert.strictEqual(detectChangeDirection('text-red text-green'), 0);
});

// ── Sign is not flipped by a hostile coin name ────────────────────────────

test('a coin named with "Red/Down/Fall" does NOT become negative', () => {
  const doc = html(
    `<h2>Top Gainers</h2><table>
       <tr><td><a href="/en/coins/redx">Red Down Falling RED</a></td><td>$2.00</td><td><span>5.0%</span></td></tr>
     </table>`,
  );
  const gainers = parseCoinGeckoHighlights(doc).sections.find(s => s.key === 'top_gainers');
  const row = gainers.items[0];
  // No explicit sign + no direction markup → stays positive (never flipped
  // negative by the words in the name).
  assert.ok(row.change24hPct > 0, `expected positive, got ${row.change24hPct}`);
  assert.strictEqual(row.change24hPct, 5.0);
});

test('positive gainers (explicit + and up markup)', () => {
  const doc = html(
    `<h2>Top Gainers</h2><table>
       <tr><td><a href="/en/coins/alpha">Alpha ALP</a></td><td>$1.50</td><td><span class="gecko-up">+12.0%</span></td></tr>
     </table>`,
  );
  const g = parseCoinGeckoHighlights(doc).sections.find(s => s.key === 'top_gainers');
  assert.strictEqual(g.items[0].change24hPct, 12.0);
  assert.strictEqual(g.items[0].change24hText, '+12.0%');
});

test('negative losers (direction class, no explicit minus)', () => {
  const doc = html(
    `<h2>Top Losers</h2><table>
       <tr><td><a href="/en/coins/charlie">Charlie CHL</a></td><td>$3.00</td><td><span class="gecko-down">14.0%</span></td></tr>
     </table>`,
  );
  const l = parseCoinGeckoHighlights(doc).sections.find(s => s.key === 'top_losers');
  assert.strictEqual(l.items[0].change24hPct, -14.0);
  assert.strictEqual(l.items[0].change24hText, '-14.0%');
});

// ── Section value modes stay honest ───────────────────────────────────────

test('volume-only section carries volume, never a 24h change', () => {
  const doc = html(
    `<h2>Highest Volume</h2><table>
       <tr><td><a href="/en/coins/delta">Delta DLT</a></td><td>$45,000,000,000</td></tr>
     </table>`,
  );
  const v = parseCoinGeckoHighlights(doc).sections.find(s => s.key === 'highest_volume');
  assert.strictEqual(v.diagnostics.valueMode, 'volume');
  assert.strictEqual(sectionValueMode('highest_volume'), 'volume');
  assert.strictEqual(v.items[0].change24hText, '');
  assert.strictEqual(v.items[0].change24hPct, null);
});

test('unlock section is valueMode=unlock with no invented price/change', () => {
  const doc = html(
    `<h2>Incoming Token Unlocks</h2>
       <div><a href="/en/coins/echo">Echo ECH</a> 0 D 5 H 3 M</div>
       <a href="/en/discover">See all unlocks</a>`,
  );
  const u = parseCoinGeckoHighlights(doc).sections.find(s => s.key === 'incoming_token_unlocks');
  assert.strictEqual(u.diagnostics.valueMode, 'unlock');
  assert.strictEqual(u.items[0].priceText, '');
  assert.strictEqual(u.items[0].change24hPct, null);
});

test('category section is valueMode=category', () => {
  const doc = html(
    `<h2>Trending Categories</h2>
       <div><a href="/en/categories/defai">DeFAI +174 more</a></div>`,
  );
  const c = parseCoinGeckoHighlights(doc).sections.find(s => s.key === 'trending_categories');
  assert.strictEqual(c.diagnostics.valueMode, 'category');
  assert.strictEqual(c.items[0].name, 'DeFAI');
});

// ── Missing data must not become fake zero ────────────────────────────────

test('missing price / 24h are null, never a fabricated 0', () => {
  const doc = html(
    `<h2>Trending Coins</h2><table>
       <tr><td><a href="/en/coins/nodata">NoData NOD</a></td></tr>
     </table>`,
  );
  const t = parseCoinGeckoHighlights(doc).sections.find(s => s.key === 'trending_coins');
  assert.strictEqual(t.items[0].priceText, '');
  assert.strictEqual(t.items[0].change24hPct, null);
});

// ── Dirty name sanitization ───────────────────────────────────────────────

test('dirty names are sanitized (overflow / countdown / artifacts / tags)', () => {
  assert.strictEqual(sanitizeName('DeFAI +174 more ca'), 'DeFAI');
  assert.strictEqual(sanitizeName('Arbitrum 12D 3H 4M 5S'), 'Arbitrum');
  assert.strictEqual(sanitizeName('Velvet ca'), 'Velvet');
  assert.strictEqual(sanitizeName('Hiki 753'), 'Hiki');
  // Residual/truncated HTML must never survive.
  assert.ok(!/[<>]/.test(sanitizeName('Bar <div class="tw-foo">baz')));
});

test('degraded payload (null html) is honest stale, not a clean empty success', () => {
  const degraded = parseCoinGeckoHighlights(null);
  assert.strictEqual(degraded.ok, false);
  assert.strictEqual(degraded.stale, true);
  assert.deepStrictEqual(degraded.sections, []);
  assert.ok(degraded.diagnostics.warnings.length > 0);
});
