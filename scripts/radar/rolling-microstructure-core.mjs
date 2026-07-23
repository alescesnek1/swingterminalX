/** Pure rolling microstructure calculations. This module is intentionally not runtime-wired. */
const DEFAULT_WINDOW_MS = 300_000;
const DEFAULT_MIN_TRADE_SAMPLES = 10;

export function classifyMakerFlag(m) {
  if (m === true) return 'sell';
  if (m === false) return 'buy';
  return null;
}

const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const finiteNumber = (value) => Number.isFinite(Number(value));

function normalizeTrade(trade, now, windowMs) {
  if (!trade || typeof trade !== 'object') return null;
  const timestamp = Number(trade.T);
  const price = Number(trade.p);
  const quantity = Number(trade.q);
  const side = classifyMakerFlag(trade.m);
  if (!Number.isFinite(timestamp) || !finitePositive(price) || !finitePositive(quantity) || !side) return null;
  if (timestamp > now || now - timestamp > windowMs) return null;
  return { timestamp, price, quantity, side };
}

export function computeRollingAbsorption(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.trades) || !Number.isFinite(now)) return {};
  const configuredWindow = Number(input.config?.windowMs);
  const configuredMinSamples = Number(input.config?.minSamples);
  const windowMs = finitePositive(configuredWindow) ? configuredWindow : DEFAULT_WINDOW_MS;
  const minSamples = Number.isInteger(configuredMinSamples) && configuredMinSamples > 0 ? configuredMinSamples : DEFAULT_MIN_TRADE_SAMPLES;
  const trades = input.trades.map((trade) => normalizeTrade(trade, now, windowMs)).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);
  if (trades.length < minSamples) return {};
  let takerBuyVolume = 0;
  let takerSellVolume = 0;
  for (const trade of trades) {
    const volume = trade.price * trade.quantity;
    if (trade.side === 'buy') takerBuyVolume += volume;
    else takerSellVolume += volume;
  }
  const totalVolume = takerBuyVolume + takerSellVolume;
  if (!(totalVolume > 0)) return {};
  const startPrice = trades[0].price;
  const endPrice = trades[trades.length - 1].price;
  const priceChangePct = ((endPrice - startPrice) / startPrice) * 100;
  const marketBuyVolumeDominance = takerBuyVolume / totalVolume;
  const fields = {
    marketBuyVolumeDominance,
    deltaImprovementPct: ((takerBuyVolume - takerSellVolume) / totalVolume) * 100,
  };
  if (takerSellVolume > 0) {
    fields.aggressiveSellsFailed = takerSellVolume > takerBuyVolume * 1.2 && priceChangePct >= -0.1;
    fields.absorptionScore = Math.max(0, Math.min(100, (marketBuyVolumeDominance * 100 * 1.5) + (priceChangePct > 0 ? 20 : 0)));
  }
  const beforeDepth = Number(input.snapshots?.before?.bidDepth);
  const afterDepth = Number(input.snapshots?.after?.bidDepth);
  if (finitePositive(beforeDepth) && finiteNumber(afterDepth) && afterDepth >= 0) fields.bidDepthRebuildPct = (afterDepth / beforeDepth) * 100;
  const low = Number(input.context?.supportZone?.low);
  const high = Number(input.context?.supportZone?.high);
  if (finiteNumber(low) && finiteNumber(high) && low <= high) {
    const minPrice = Math.min(...trades.map((trade) => trade.price));
    if (minPrice >= low && minPrice <= high && endPrice > minPrice) fields.supportRetestHeld = true;
    else if (minPrice < low) fields.supportRetestHeld = false;
  }
  const spreadPct = Number(input.context?.spreadPct);
  if (finiteNumber(spreadPct) && spreadPct >= 0) fields.spreadAndSlippageHealthy = spreadPct < 0.2;
  return fields;
}
