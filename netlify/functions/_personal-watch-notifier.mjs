// Tracked-coin notifications: big moves, take-profit reached, stop broken.
//
// Deliberately a SEPARATE run from personal-alerts.mjs. That path delivers the
// fully confirmed RADAR ENTRY_READY signal and is safety-critical; these are
// awareness notifications about coins the user already tracks, and must not be
// able to influence, imply, or loosen an entry signal. Keeping them apart means
// a change here can never weaken the entry gate.
//
// Data comes from the canonical database — the same source the RADAR decides
// from — never from a browser-written snapshot.
//
// Off unless PERSONAL_WATCH_TRIGGERS_ENABLED is exactly "true".
import { evaluateWatchTriggers, markTriggerSent, buildTriggerMessage, DEFAULT_BIG_MOVE_PCT, DEFAULT_TRIGGER_COOLDOWN_MS } from './_personal-watch-triggers.mjs';

export const PERSONAL_WATCH_TRIGGERS_ENV_FLAG = 'PERSONAL_WATCH_TRIGGERS_ENABLED';

// ── Canonical context freshness budget (fail closed) ────────────────────────
//
// WHY THIS EXISTS: this path notifies on PRICE — a big move, a take-profit
// reached, a stop broken — and `evaluateWatchTriggers` receives no timestamp at
// all, so it cannot tell a live quote from yesterday's. The canonical read below
// asks the store for "the newest PUBLISHED run", which while the collector is
// disabled (MARKET_CONTEXT_COLLECT_ENABLED=false, the emergency cost breaker) is
// the same run forever — 28 hours old in production. Without a budget here the
// notifier would happily send "SOL broke your stop" off a day-old price.
//
// Matches CONTEXT_HARD_MAX_AGE_MS in context.mjs and HARD_MAX_MARKET_AGE_MS in
// the browser, so every consumer of this store draws the line in one place.
//
// Fails CLOSED: past the budget the store returns STALE_EXPIRED, this function
// returns before reading recipients and before any Telegram send. Nothing is
// sent, no gate is loosened, and the reason is named in the summary and the log.
export const PERSONAL_WATCH_MAX_CONTEXT_AGE_MS = 30 * 60 * 1000;
// What the STORE answers with when the run is past the budget…
const STORE_REASON_STALE_EXPIRED = 'STALE_EXPIRED';
// …and what THIS endpoint reports, so a summary line names the consumer that
// refused as well as the reason it refused.
export const REASON_CONTEXT_STALE_EXPIRED = 'CONTEXT_STALE_EXPIRED';

async function loadStore() { return await import('./_personal-watch-store.mjs'); }
async function loadContextStore() { return await import('./_market-context-store.mjs'); }
async function loadDatabase() { return (await import('./_db.mjs')).getDb().pool; }
async function loadSender() { return (await import('./personal-alerts.mjs')).sendPersonalTelegram; }

function summary(extra = {}) {
  return { endpoint: 'personal_watch_triggers', ok: true, enabled: false, evaluated: 0, sent: 0, failed: 0, recipients: 0, ...extra };
}

// Base asset → ticker. Watches store a base symbol ("SOL"), canonical rows a
// pair ("SOLUSDT"), so the pair is resolved through the instrument's base asset
// rather than by string surgery on the symbol.
function indexTickers(tickers) {
  const byBase = new Map();
  for (const row of Array.isArray(tickers) ? tickers : []) {
    const base = String(row?.base_asset || '').toUpperCase();
    if (!base) continue;
    const prev = byBase.get(base);
    // Spot first (it is the venue a tracked coin is normally held on), then the
    // deeper of two rows from the same venue.
    if (!prev
      || (row.market === 'spot' && prev.market !== 'spot')
      || (row.market === prev.market && Number(row.quote_volume || 0) > Number(prev.quote_volume || 0))) {
      byBase.set(base, row);
    }
  }
  return byBase;
}

function indexCandidates(candidates) {
  const byBase = new Map();
  for (const row of Array.isArray(candidates) ? candidates : []) {
    const payload = row && typeof row.payload === 'object' && row.payload !== null ? row.payload : row;
    const symbol = String(payload?.symbol || row?.symbol || '').toUpperCase();
    if (!symbol) continue;
    if (!byBase.has(symbol)) byBase.set(symbol, payload);
  }
  return byBase;
}

export async function runPersonalWatchTriggers(deps = {}) {
  const env = deps.env || process.env;
  if (env[PERSONAL_WATCH_TRIGGERS_ENV_FLAG] !== 'true') return summary({ reason: 'PERSONAL_WATCH_TRIGGERS_DISABLED' });

  const token = String(env.TG_BOT_TOKEN || '').trim();
  if (!token) return summary({ ok: false, enabled: true, reason: 'TELEGRAM_TOKEN_MISSING' });

  const nowMs = Number.isFinite(Number(deps.nowMs)) ? Number(deps.nowMs) : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const bigMovePct = Number(env.PERSONAL_WATCH_BIG_MOVE_PCT) || DEFAULT_BIG_MOVE_PCT;
  const cooldownMs = Number(env.PERSONAL_WATCH_TRIGGER_COOLDOWN_MS) || DEFAULT_TRIGGER_COOLDOWN_MS;

  let store; let contextStore; let database; let sendMessage;
  try {
    store = deps.store || await loadStore();
    contextStore = deps.contextStore || await loadContextStore();
    database = deps.database || await loadDatabase();
    sendMessage = deps.sendMessage || await loadSender();
  } catch { return summary({ ok: false, enabled: true, reason: 'DEPENDENCIES_UNAVAILABLE' }); }

  const context = await contextStore.getAtomizedMarketContext(database, {
    tickerLimit: 2000, microLimit: 600,
    // Fail closed on an aged published run — see the budget above. `nowMs` is the
    // same clock the triggers and cooldowns use, so the guard cannot disagree
    // with them about what "now" is.
    maxAgeMs: PERSONAL_WATCH_MAX_CONTEXT_AGE_MS, now: nowMs,
  });
  // Reported separately from a read FAILURE: an aged run is a healthy store with
  // nothing current in it, and telling those apart is what stops the owner
  // hunting a database problem that does not exist. Either way nothing is sent.
  if (context?.reason === STORE_REASON_STALE_EXPIRED || context?.staleExpired === true) {
    console.warn('[PERSONAL_WATCH] context_stale_expired', {
      ageMs: context.ageMs ?? null, maxAgeMs: context.maxAgeMs ?? PERSONAL_WATCH_MAX_CONTEXT_AGE_MS,
      observedAt: context.observedAt ?? null,
    });
    return summary({ ok: false, enabled: true, reason: REASON_CONTEXT_STALE_EXPIRED });
  }
  if (!context?.ok || !context.market) {
    console.warn('[PERSONAL_WATCH] context_unavailable', { reason: context?.reason || 'DB_UNAVAILABLE' });
    return summary({ ok: false, enabled: true, reason: 'CONTEXT_UNAVAILABLE' });
  }
  const tickers = indexTickers(context.market.tickers);
  const candidates = indexCandidates(context.radar?.candidates);

  let recipientResult;
  try { recipientResult = await store.listPersonalWatchRecipients(); }
  catch { recipientResult = null; }
  if (!recipientResult?.ok || recipientResult.durable !== true || !Array.isArray(recipientResult.recipients)) {
    console.warn('[PERSONAL_WATCH] recipients_unavailable');
    return summary({ ok: false, enabled: true, reason: 'RECIPIENTS_UNAVAILABLE' });
  }

  let evaluated = 0; let sent = 0; let failed = 0; let considered = 0;
  for (const recipient of recipientResult.recipients) {
    const chatId = recipient?.telegramChatId;
    const watches = Array.isArray(recipient?.watches) ? recipient.watches : [];
    if (!chatId || !watches.length) continue;
    considered += 1;

    let state = {};
    try { state = (await store.getPersonalAlertState(recipient.userId))?.watchTriggers || {}; } catch { state = {}; }
    let nextState = state;

    for (const watch of watches) {
      const base = String(watch?.symbol || '').toUpperCase();
      const ticker = tickers.get(base);
      if (!ticker) continue;
      evaluated += 1;
      const pair = String(ticker.symbol || '').toUpperCase();
      const triggers = evaluateWatchTriggers({
        symbol: base, nowMs, state: nextState, bigMovePct, cooldownMs,
        ticker: { lastPrice: ticker.last_price, priceChangePercent: ticker.price_change_percent, change1hPct: ticker.change_1h_pct, change4hPct: ticker.change_4h_pct },
        candidate: candidates.get(pair) || candidates.get(base) || null,
      });
      for (const trigger of triggers) {
        const result = await sendMessage(token, chatId, buildTriggerMessage(trigger));
        if (result?.ok) { sent += 1; nextState = markTriggerSent(nextState, trigger, nowIso); }
        else { failed += 1; console.warn('[PERSONAL_WATCH] send_failed', { type: trigger.type, reason: result?.reason || 'UNKNOWN' }); }
      }
    }

    if (nextState !== state) {
      // Bookkeeping must persist or the same trigger resends every cycle; a
      // failure here is loud rather than a silent alert loop.
      try { await store.updatePersonalAlertState(recipient.userId, (current) => ({ ...(current || {}), watchTriggers: nextState })); }
      catch { console.warn('[PERSONAL_WATCH] state_persist_failed'); }
    }
  }

  console.info('[PERSONAL_WATCH] cycle_completed', { recipients: considered, evaluated, sent, failed });
  return summary({ enabled: true, recipients: considered, evaluated, sent, failed });
}
