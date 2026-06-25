/**
 * Phase E2b: Structural Reclaim Computation
 * Pure math helper to identify breakdown levels from klines.
 */

function normalizeKlines(klines) {
  if (!Array.isArray(klines)) return [];
  
  const out = [];
  for (const k of klines) {
    if (!k) continue;
    let open, high, low, close, volume;
    
    // Check if it's a Binance array format: [openTime, open, high, low, close, volume]
    if (Array.isArray(k)) {
      open = parseFloat(k[1]);
      high = parseFloat(k[2]);
      low = parseFloat(k[3]);
      close = parseFloat(k[4]);
      volume = parseFloat(k[5]);
    } else {
      // Assume normalized object
      open = parseFloat(k.open);
      high = parseFloat(k.high);
      low = parseFloat(k.low);
      close = parseFloat(k.close);
      volume = parseFloat(k.volume);
    }
    
    if (Number.isFinite(open) && Number.isFinite(high) && 
        Number.isFinite(low) && Number.isFinite(close)) {
      out.push({
        open, high, low, close, volume: Number.isFinite(volume) ? volume : 0,
      });
    }
  }
  return out;
}

export function computeStructuralReclaimLevels(rawKlines, opts = {}) {
  const includeLastCandle = opts.includeLastCandle === true;
  const minCandles = opts.minCandles || 30;
  const swingWindow = opts.swingWindow || 3;
  const timeframe = opts.timeframe || '1h';
  
  let klines = normalizeKlines(rawKlines);
  if (!includeLastCandle && klines.length > 0) {
    klines.pop(); // Remove forming candle
  }
  
  if (klines.length < minCandles) {
    return null;
  }
  
  // Calculate some median metrics for confidence checks
  const bodies = klines.map(k => Math.abs(k.open - k.close) / k.open).sort((a, b) => a - b);
  const medianBodyPct = bodies[Math.floor(bodies.length / 2)];
  
  const volumes = klines.map(k => k.volume).sort((a, b) => a - b);
  const medianVol = volumes[Math.floor(volumes.length / 2)];

  // Identify confirmed swing lows (lower than N preceding and N succeeding)
  const swingLows = [];
  for (let i = swingWindow; i < klines.length - swingWindow; i++) {
    const currentLow = klines[i].low;
    let isSwingLow = true;
    for (let j = 1; j <= swingWindow; j++) {
      if (klines[i - j].low <= currentLow || klines[i + j].low <= currentLow) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      swingLows.push({ index: i, price: currentLow });
    }
  }

  // Find the most recent swing low that was subsequently broken by a closed candle
  let bestSwing = null;
  let breakdownCandleIndex = -1;
  let breakdownCandle = null;
  
  // Search from most recent swing backwards
  for (let i = swingLows.length - 1; i >= 0; i--) {
    const swing = swingLows[i];
    
    // Find the first candle AFTER the swing formation that breaks it
    // The swing is confirmed at swing.index + swingWindow, so we start checking after that.
    for (let j = swing.index + swingWindow + 1; j < klines.length; j++) {
      if (klines[j].close < swing.price) {
        bestSwing = swing;
        breakdownCandleIndex = j;
        breakdownCandle = klines[j];
        break;
      }
    }
    if (bestSwing) break;
  }

  if (!bestSwing || !breakdownCandle) {
    return null;
  }

  // Displacement checks for flush high
  const bodySize = (breakdownCandle.open - breakdownCandle.close) / breakdownCandle.open;
  const isDisplacement = bodySize > medianBodyPct && breakdownCandle.close < breakdownCandle.open;
  let flushHigh = null;
  if (isDisplacement) {
    flushHigh = breakdownCandle.high;
  }

  // Calculate confidence score (0-100)
  let confidence = 70; // Base confidence for finding a valid structural break
  if (breakdownCandle.volume > medianVol) confidence += 10;
  if (breakdownCandle.volume > medianVol * 2) confidence += 10;
  if (isDisplacement && bodySize > medianBodyPct * 2) confidence += 10;
  confidence = Math.min(confidence, 100);

  return {
    computedBreakdownLevel: bestSwing.price,
    computedReclaimLevel: bestSwing.price,
    computedLostSupportLevel: bestSwing.price,
    computedFlushHigh: flushHigh,
    computedStructuralSource: "closed-candle-swing-low",
    computedStructuralTimeframe: timeframe,
    computedStructuralConfidence: confidence,
    computedStructuralReason: `Swing low at index ${bestSwing.index} broken by close at index ${breakdownCandleIndex}`,
    sourceCandleIndex: bestSwing.index,
    breakdownCandleIndex,
  };
}
