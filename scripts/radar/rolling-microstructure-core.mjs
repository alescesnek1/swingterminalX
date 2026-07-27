/** Pure rolling microstructure calculations; no network or runtime side effects. */
const DEFAULT_WINDOW_MS = 300_000;
const DEFAULT_MIN_TRADE_SAMPLES = 10;
const MIN_KLINE_SAMPLES = 30;

export function classifyMakerFlag(m) {
  if (m === true) return 'sell'; // Binance m=true means buyer was maker: taker sold.
  if (m === false) return 'buy';
  return null;
}

const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const finite = (value) => Number.isFinite(Number(value));

// MALFORMED, not merely out of window: a bad timestamp/price/quantity/maker flag
// is a data-integrity problem. Falling outside the measurement window is not —
// it is the expected result of asking an exchange for the last N trades, since N
// is a COUNT and the window is a DURATION. Conflating the two made a symbol whose
// last 500 trades happen to span more than the window look corrupt, and STRICT
// then refused a perfectly good measurement.
function malformedTrade(trade) {
  if (!trade || typeof trade !== 'object') return true;
  return !Number.isFinite(Number(trade.T)) || !positive(trade.p) || !positive(trade.q) || !classifyMakerFlag(trade.m);
}

function normalizeTrade(trade, now, windowMs) {
  if (malformedTrade(trade)) return null;
  const timestamp = Number(trade.T); const price = Number(trade.p); const quantity = Number(trade.q);
  const side = classifyMakerFlag(trade.m);
  if (timestamp > now || now - timestamp > windowMs) return null;
  return { timestamp, price, quantity, side };
}

export function validateRollingTrades(rawTrades, now = Date.now(), windowMs = DEFAULT_WINDOW_MS) {
  if (!Array.isArray(rawTrades) || !Number.isFinite(now) || !positive(windowMs)) return { trades: [], invalid: 1, malformed: 1, outOfWindow: 0, invalidMakerFlags: 0 };
  const trades = []; let malformed = 0; let outOfWindow = 0; let invalidMakerFlags = 0;
  for (const raw of rawTrades) {
    if (malformedTrade(raw)) {
      malformed += 1;
      if (!classifyMakerFlag(raw?.m)) invalidMakerFlags += 1;
      continue;
    }
    const normalized = normalizeTrade(raw, now, windowMs);
    if (!normalized) { outOfWindow += 1; continue; }
    trades.push(normalized);
  }
  trades.sort((a, b) => a.timestamp - b.timestamp);
  // `invalid` stays the total reject count for existing callers/diagnostics.
  return { trades, invalid: malformed + outOfWindow, malformed, outOfWindow, invalidMakerFlags };
}

function supportRetestFromKlines(rawKlines, endPrice) {
  if (!Array.isArray(rawKlines) || !(endPrice > 0)) return undefined;
  const candles = rawKlines.map((raw) => {
    const timestamp = Number(raw?.[0]); const low = Number(raw?.[3]); const close = Number(raw?.[4]);
    return Number.isFinite(timestamp) && positive(low) && positive(close) ? { timestamp, low, close } : null;
  }).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);
  if (candles.length < MIN_KLINE_SAMPLES) return undefined;
  const recent = candles.slice(-10); const reference = candles.slice(0, -10);
  if (!reference.length) return undefined;
  const support = Math.min(...reference.map((candle) => candle.low));
  const recentLow = Math.min(...recent.map((candle) => candle.low));
  if (!(support > 0 && recentLow > 0)) return undefined;
  const nearSupport = recentLow >= support && recentLow <= support * 1.0075;
  return nearSupport && endPrice > support && recent[recent.length - 1].close > support;
}

export function computeRollingAbsorption(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || !Number.isFinite(now)) return {};
  const windowMs = positive(input.config?.windowMs) ? Number(input.config.windowMs) : DEFAULT_WINDOW_MS;
  const minSamples = Number.isInteger(Number(input.config?.minSamples)) && Number(input.config.minSamples) > 0 ? Number(input.config.minSamples) : DEFAULT_MIN_TRADE_SAMPLES;
  const validation = validateRollingTrades(input.trades, now, windowMs);
  // Any MALFORMED row makes a measurement set untrustworthy; never silently use a
  // subset of corrupt data. Trades outside the window are a different matter: the
  // caller asks for the last N trades and N is a count, so an out-of-window tail
  // is expected. Treating it as corruption returned {} — no absorptionScore, no
  // bidDepthRebuildPct — for every symbol whose recent trades happened to span
  // longer than the window, which is exactly the quieter symbols.
  if (validation.malformed || validation.trades.length < minSamples) return {};
  const trades = validation.trades;
  let takerBuyVolume = 0; let takerSellVolume = 0;
  for (const trade of trades) {
    const volume = trade.price * trade.quantity;
    if (trade.side === 'buy') takerBuyVolume += volume; else takerSellVolume += volume;
  }
  const totalVolume = takerBuyVolume + takerSellVolume;
  if (!(totalVolume > 0)) return {};
  const startPrice = trades[0].price; const endPrice = trades.at(-1).price;
  const priceChangePct = ((endPrice - startPrice) / startPrice) * 100;
  const midpoint = Math.floor(trades.length / 2);
  if (!midpoint || midpoint === trades.length) return {};
  const deltaFor = (part) => part.reduce((sum, trade) => sum + (trade.side === 'buy' ? 1 : -1) * trade.price * trade.quantity, 0);
  const deltaImprovementPct = ((deltaFor(trades.slice(midpoint)) - deltaFor(trades.slice(0, midpoint))) / totalVolume) * 100;
  const marketBuyVolumeDominance = takerBuyVolume / totalVolume;
  const fields = { marketBuyVolumeDominance, deltaImprovementPct };
  if (takerSellVolume > 0) {
    fields.aggressiveSellsFailed = takerSellVolume > takerBuyVolume * 1.2 && priceChangePct >= -0.1;
    fields.absorptionScore = Math.max(0, Math.min(100, marketBuyVolumeDominance * 150 + (priceChangePct > 0 ? 20 : 0)));
  }
  const beforeDepth = Number(input.snapshots?.before?.bidDepth); const afterDepth = Number(input.snapshots?.after?.bidDepth);
  if (positive(beforeDepth) && finite(afterDepth) && afterDepth >= 0) fields.bidDepthRebuildPct = ((afterDepth - beforeDepth) / beforeDepth) * 100;
  const supportRetestHeld = supportRetestFromKlines(input.klines, endPrice);
  if (supportRetestHeld !== undefined) fields.supportRetestHeld = supportRetestHeld;
  const spreadPct = Number(input.context?.spreadPct);
  if (finite(spreadPct) && spreadPct >= 0) fields.spreadAndSlippageHealthy = spreadPct < 0.2;
  return fields;
}