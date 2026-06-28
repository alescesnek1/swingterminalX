// ─────────────────────────────────────────────────────────────
// Swing Terminal — GECKO section column layout (pure, no DOM)
//
// Canonical implementation of terminal.js `_geckoSectionLayout`. Decides
// which columns a CoinGecko highlights section honestly renders, from its
// backend `valueMode` plus the ACTUAL coverage of the rows being shown.
// It never invents a column: price/24h only appear where values exist,
// volume sections show VOLUME, and unlock/category/upcoming sections fall
// back to a compact name-only list. Sections with missing-but-expected
// values are flagged `partial` so the card can say so instead of faking
// completeness.
//
// Extracted so this honesty logic is importable and unit-testable
// (frontend.gecko-layout.test.mjs) instead of only grep-guarded — it is
// the core of "render the real state, never a fake success".
// ─────────────────────────────────────────────────────────────

export function geckoSectionLayout(sec, validItems) {
  const s = sec || {};
  const items = Array.isArray(validItems) ? validItems : [];
  const diag = s.diagnostics || {};
  const mode = diag.valueMode || 'unknown';
  const n = items.length;
  const vPrice = items.filter((i) => i && i.priceText).length;
  const vChange = items.filter((i) => i && i.change24hText).length;

  let showPrice = false, showChange = false, showVolume = false, partial = false;
  let priceLabel = 'PRICE', changeLabel = '24H';

  if (mode === 'volume') {
    showVolume = true; // primary $ value is trading volume, not price
  } else if (mode === 'price_change') {
    showChange = true;            // coin-market lists always carry a change column
    showPrice = vPrice > 0;       // ATH-style sections have no spot price → hide it
    if (s.key === 'price_change_since_ath') changeLabel = 'FROM ATH';
    // Expected-but-missing data → flag the section honestly.
    if (n > 0 && vChange < n) partial = true;
    if (showPrice && vPrice < n) partial = true;
  } else {
    // unlock / category / unknown: informational. Only surface values that exist.
    showPrice = vPrice > 0;
    showChange = vChange > 0;
  }

  let gridCols = '36px 1fr';
  if (showPrice || showVolume) gridCols += ' auto';
  if (showChange) gridCols += ' auto';

  return { mode, showPrice, showChange, showVolume, partial, priceLabel, changeLabel, gridCols };
}

if (typeof window !== 'undefined') window.__geckoLayout = { sectionLayout: geckoSectionLayout };
