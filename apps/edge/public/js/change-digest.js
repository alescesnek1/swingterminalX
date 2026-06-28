// ─────────────────────────────────────────────────────────────
// Swing Terminal — "WHAT CHANGED?" digest (pure, no DOM)
//
// OBSERVATION ONLY. This module diffs the previous markets/GECKO snapshot
// against the current one and returns a plain digest object describing what
// moved since the last refresh. It is a read-only convenience for the
// operator's eyes — it produces NO trading signal:
//   • it never emits ENTRY_READY, never touches Trading RADAR gates,
//     Telegram alerts, or Auto Trader intent;
//   • it carries no buy/sell labels, confidence scores, or execution CTAs;
//   • every consumer must render the "not a trade signal" disclaimer.
//
// Pure + importable so the diff logic is unit-tested in isolation
// (frontend.change-digest.test.mjs); terminal.js calls it via
// window.__changeDigest and renders the result into a small left-rail card.
// ─────────────────────────────────────────────────────────────

const DISCLAIMER = 'Observation only · not a trade signal';

function _key(d) {
  return String((d && (d.id != null ? d.id : d.symbol)) || '').toLowerCase();
}
// Raw (non-lowercased) coin id — this is what the rest of the app uses as
// data-coin-id / pickCoin(id), so chips must navigate with this exact value,
// not the lowercased match key.
function _rawId(d) {
  return String((d && (d.id != null ? d.id : d.symbol)) || '');
}
function _sym(d) {
  return String((d && d.symbol) || _key(d) || '').toUpperCase();
}
function _score(d) {
  const v = d && (d.score != null ? d.score : d._sig_score);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function _c24(d) {
  const v = d && (d.price_change_percentage_24h != null ? d.price_change_percentage_24h : d._c24);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Diff the top-N (by score) visible scanner set plus per-coin 24h-change
// movement since the previous refresh. Returns plain arrays — no ranking
// that implies an action, just "what entered/left view and what moved most".
export function marketsDigest(prevMarkets, currMarkets, opts = {}) {
  const topN = Number.isFinite(opts.topN) ? opts.topN : 50;
  const maxItems = Number.isFinite(opts.maxItems) ? opts.maxItems : 6;
  const curr = Array.isArray(currMarkets) ? currMarkets : [];
  const prev = Array.isArray(prevMarkets) ? prevMarkets : null;

  if (!prev || !prev.length || !curr.length) {
    return { firstSnapshot: true, entered: [], left: [], movers: [] };
  }

  const topSet = (arr) => arr.slice().sort((a, b) => _score(b) - _score(a)).slice(0, topN);
  const currTop = topSet(curr);
  const prevTop = topSet(prev);
  const currKeys = new Set(currTop.map(_key).filter(Boolean));
  const prevKeys = new Set(prevTop.map(_key).filter(Boolean));

  const entered = currTop.filter((d) => _key(d) && !prevKeys.has(_key(d)))
    .map((d) => ({ id: _rawId(d), symbol: _sym(d) })).slice(0, maxItems);
  const left = prevTop.filter((d) => _key(d) && !currKeys.has(_key(d)))
    .map((d) => ({ id: _rawId(d), symbol: _sym(d) })).slice(0, maxItems);

  // 24h-change delta for coins present in BOTH snapshots, sorted by the size
  // of the move (largest absolute change first). Observation, not a call.
  const prevByKey = new Map(prev.map((d) => [_key(d), d]));
  const movers = [];
  for (const d of curr) {
    const k = _key(d);
    if (!k) continue;
    const p = prevByKey.get(k);
    if (!p) continue;
    const from = _c24(p);
    const to = _c24(d);
    if (from == null || to == null) continue;
    const delta = to - from;
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.01) continue;
    movers.push({ id: _rawId(d), symbol: _sym(d), from, to, delta });
  }
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return { firstSnapshot: false, entered, left, movers: movers.slice(0, maxItems) };
}

// Diff per-section coin NAMES newly appearing in the GECKO highlights since
// the previous GECKO snapshot. Category cards are not coins, so they are
// skipped (only sections whose valueMode is not 'category' are compared).
export function geckoDigest(prevSections, currSections, opts = {}) {
  const maxNames = Number.isFinite(opts.maxNames) ? opts.maxNames : 6;
  const maxSections = Number.isFinite(opts.maxSections) ? opts.maxSections : 4;
  const curr = Array.isArray(currSections) ? currSections : null;
  const prev = Array.isArray(prevSections) ? prevSections : null;

  if (!curr || !prev) return { firstSnapshot: true, newBySection: [] };

  const isCoinSection = (s) => (s && s.diagnostics && s.diagnostics.valueMode) !== 'category';
  const namesOf = (s) => new Set(
    (Array.isArray(s && s.items) ? s.items : [])
      .map((i) => String((i && i.name) || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const prevByKey = new Map(prev.map((s) => [s && s.key, s]));

  const newBySection = [];
  for (const s of curr) {
    if (!isCoinSection(s)) continue;
    const p = prevByKey.get(s && s.key);
    if (!p) continue; // section wasn't present before → don't report it as "new"
    const prevNames = namesOf(p);
    const fresh = [];
    const seen = new Set();
    for (const it of (Array.isArray(s.items) ? s.items : [])) {
      const nm = String((it && it.name) || '').trim();
      const low = nm.toLowerCase();
      if (!nm || seen.has(low)) continue;
      if (!prevNames.has(low)) { fresh.push(nm); seen.add(low); }
      if (fresh.length >= maxNames) break;
    }
    if (fresh.length) newBySection.push({ section: String((s.title || s.key) || ''), key: s.key, names: fresh });
    if (newBySection.length >= maxSections) break;
  }
  return { firstSnapshot: false, newBySection };
}

// Top-level digest the renderer consumes. Combines the markets + GECKO diffs
// and resolves an honest freshness note for the comparison.
export function buildChangeDigest(input = {}) {
  const { prevMarkets, currMarkets, prevGecko, currGecko, freshness, prevAtMs, nowMs, topN } = input;
  const markets = marketsDigest(prevMarkets, currMarkets, { topN });
  const gecko = geckoDigest(prevGecko, currGecko);
  const fresh = freshness || {};

  let freshnessNote;
  let comparisonLevel;
  if (markets.firstSnapshot) {
    freshnessNote = 'First snapshot — no comparison yet.';
    comparisonLevel = 'none';
  } else if (fresh.ok === false || fresh.stale === true) {
    freshnessNote = 'Previous snapshot stale — comparison may be limited.';
    comparisonLevel = 'limited';
  } else {
    const ageSec = (Number.isFinite(prevAtMs) && Number.isFinite(nowMs))
      ? Math.max(0, Math.round((nowMs - prevAtMs) / 1000))
      : null;
    freshnessNote = ageSec != null
      ? `Comparing with the previous snapshot from ${ageSec}s ago.`
      : 'Comparing with the previous snapshot.';
    comparisonLevel = 'ok';
  }

  const hasChanges = !markets.firstSnapshot && !!(
    markets.entered.length || markets.left.length || markets.movers.length ||
    (gecko.newBySection && gecko.newBySection.length)
  );

  return {
    disclaimer: DISCLAIMER,
    freshnessNote,
    comparisonLevel,
    firstSnapshot: markets.firstSnapshot,
    hasChanges,
    markets,
    gecko,
  };
}

if (typeof window !== 'undefined') {
  window.__changeDigest = { buildChangeDigest, marketsDigest, geckoDigest };
}
