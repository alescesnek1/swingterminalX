// Pure trigger evaluation for tracked (Personal Watch) coins.
//
// Until now a watched coin only ever produced one kind of notification: a fully
// confirmed RADAR ENTRY_READY. That is the entry signal — it says nothing once
// you are in, and nothing when a coin simply moves hard.
//
// This module adds three more, and deliberately keeps them SEPARATE from the
// entry gate: none of them can create, imply, or loosen an entry signal. They
// are position/awareness notifications about a coin the user already chose to
// track.
//
//   BIG_MOVE     — the coin moved beyond a threshold in a short window
//   TAKE_PROFIT  — price reached a take-profit level the RADAR published
//   STOP_LOSS    — price broke the stop / hard invalidation the RADAR published
//
// A watch record holds only { symbol, addedAt } — there is no stored entry price,
// so TP/SL are read from the canonical RADAR candidate for that symbol. That
// makes the claim precise and honest: "price reached the level RADAR published",
// never "your position hit take profit", which the system cannot know.
//
// Everything here is fail-closed: a missing price or a missing level produces NO
// trigger. A notification that fires on absent data is worse than silence.

export const TRIGGER_TYPES = Object.freeze({ BIG_MOVE: 'BIG_MOVE', TAKE_PROFIT: 'TAKE_PROFIT', STOP_LOSS: 'STOP_LOSS' });

// Defaults chosen to be quiet: a tracked-coin feed that fires constantly gets
// muted by the user, which silently disables the alerts that matter.
export const DEFAULT_BIG_MOVE_PCT = 8;
export const DEFAULT_TRIGGER_COOLDOWN_MS = 60 * 60 * 1000;

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

function levelsOf(candidate) {
  const tps = [];
  const raw = candidate?.takeProfitCheckpoints ?? candidate?.TAKE_PROFIT_LEVELS;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      // A checkpoint may be a bare price or a { price } / { low, high } zone; the
      // first price that can be read is the level, anything else is skipped.
      const price = num(entry) ?? num(entry?.price) ?? num(entry?.target) ?? num(entry?.low) ?? num(entry?.high);
      if (price !== null && price > 0) tps.push(price);
    }
  }
  const stop = num(candidate?.suggestedStop) ?? num(candidate?.STOP_LOSS_LEVEL);
  const invalidation = num(candidate?.invalidationLevel) ?? num(candidate?.HARD_INVALIDATION);
  return { takeProfits: tps.sort((a, b) => a - b), stop, invalidation };
}

function withinCooldown(state, symbol, type, nowMs, cooldownMs) {
  const record = state?.[`${symbol}:${type}`];
  const lastMs = record?.lastSentAt ? new Date(record.lastSentAt).getTime() : 0;
  return Number.isFinite(lastMs) && lastMs > 0 && nowMs - lastMs < cooldownMs;
}

// Returns the triggers due for ONE watched symbol. `state` is the per-user
// trigger bookkeeping ({ "SYM:TYPE": { lastSentAt, level } }), used only for
// cooldown and for not repeating the same level.
export function evaluateWatchTriggers(input = {}) {
  const symbol = String(input.symbol || '').trim().toUpperCase();
  if (!symbol) return [];
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  const cooldownMs = Number.isFinite(Number(input.cooldownMs)) && Number(input.cooldownMs) > 0 ? Number(input.cooldownMs) : DEFAULT_TRIGGER_COOLDOWN_MS;
  const bigMovePct = Number.isFinite(Number(input.bigMovePct)) && Number(input.bigMovePct) > 0 ? Number(input.bigMovePct) : DEFAULT_BIG_MOVE_PCT;
  const state = input.state && typeof input.state === 'object' ? input.state : {};
  const ticker = input.ticker || {};
  const candidate = input.candidate || null;

  const price = num(ticker.lastPrice) ?? num(ticker.last_price) ?? num(ticker.price);
  const triggers = [];

  // ── BIG_MOVE ── prefers the shortest window actually available, so a sharp
  // 1h move is not diluted by a flat 24h. An absent window is skipped, never
  // treated as 0% — that would make a quiet coin look like a moving one.
  const windows = [
    { key: '1h', pct: num(ticker.change1hPct) ?? num(ticker.change_1h_pct) },
    { key: '4h', pct: num(ticker.change4hPct) ?? num(ticker.change_4h_pct) },
    { key: '24h', pct: num(ticker.priceChangePercent) ?? num(ticker.price_change_percent) },
  ].filter((w) => w.pct !== null);
  const biggest = windows.reduce((best, w) => (best === null || Math.abs(w.pct) > Math.abs(best.pct) ? w : best), null);
  if (biggest && Math.abs(biggest.pct) >= bigMovePct && !withinCooldown(state, symbol, TRIGGER_TYPES.BIG_MOVE, nowMs, cooldownMs)) {
    triggers.push({ type: TRIGGER_TYPES.BIG_MOVE, symbol, window: biggest.key, changePct: biggest.pct, price, direction: biggest.pct >= 0 ? 'UP' : 'DOWN' });
  }

  // ── TAKE_PROFIT / STOP_LOSS ── need both a live price and a published level.
  if (price === null || price <= 0 || !candidate) return triggers;
  const { takeProfits, stop, invalidation } = levelsOf(candidate);

  // Highest take-profit level the price has actually reached. Reporting the
  // highest rather than the first avoids a burst of one message per level when
  // price gaps through several at once.
  const reached = takeProfits.filter((level) => price >= level);
  if (reached.length) {
    const level = reached[reached.length - 1];
    const previous = num(state[`${symbol}:${TRIGGER_TYPES.TAKE_PROFIT}`]?.level);
    // Re-notify only for a HIGHER level than last time; the same level crossing
    // back and forth must not resend.
    if ((previous === null || level > previous) && !withinCooldown(state, symbol, TRIGGER_TYPES.TAKE_PROFIT, nowMs, cooldownMs)) {
      triggers.push({ type: TRIGGER_TYPES.TAKE_PROFIT, symbol, level, price, index: takeProfits.indexOf(level) + 1, total: takeProfits.length });
    }
  }

  // The stop is whichever protective level is defined; when both exist the hard
  // invalidation is the lower, more decisive one and wins.
  const protective = invalidation !== null && stop !== null ? Math.min(invalidation, stop) : (invalidation ?? stop);
  if (protective !== null && protective > 0 && price <= protective && !withinCooldown(state, symbol, TRIGGER_TYPES.STOP_LOSS, nowMs, cooldownMs)) {
    triggers.push({ type: TRIGGER_TYPES.STOP_LOSS, symbol, level: protective, price, isInvalidation: protective === invalidation });
  }

  return triggers;
}

export function markTriggerSent(state, trigger, nowIso) {
  const next = { ...(state && typeof state === 'object' ? state : {}) };
  next[`${trigger.symbol}:${trigger.type}`] = { lastSentAt: nowIso, level: trigger.level ?? null };
  return next;
}

const fmt = (value) => (Number.isFinite(Number(value)) ? String(Number(value)) : '--');

// Message text states what is actually known. It never says "your position",
// because the watch record holds no entry price — only that price reached a
// level the RADAR published.
export function buildTriggerMessage(trigger) {
  const symbol = trigger.symbol;
  if (trigger.type === TRIGGER_TYPES.BIG_MOVE) {
    const arrow = trigger.direction === 'UP' ? '▲' : '▼';
    return `${arrow} <b>${symbol}</b> moved ${fmt(trigger.changePct)}% (${trigger.window})\nPrice: ${fmt(trigger.price)}\nTracked coin — this is a movement notice, not an entry signal.`;
  }
  if (trigger.type === TRIGGER_TYPES.TAKE_PROFIT) {
    return `[TP] <b>${symbol}</b> reached take-profit ${trigger.index}/${trigger.total}\nLevel: ${fmt(trigger.level)} | Price: ${fmt(trigger.price)}\nLevel published by RADAR for this setup.`;
  }
  return `[SL] <b>${symbol}</b> broke its ${trigger.isInvalidation ? 'hard invalidation' : 'stop'} level\nLevel: ${fmt(trigger.level)} | Price: ${fmt(trigger.price)}\nLevel published by RADAR for this setup.`;
}
