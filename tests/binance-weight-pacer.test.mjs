import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeightPacer, SYMBOL_REQUEST_WEIGHT, DEFAULT_WEIGHT_BUDGET_PER_MIN } from '../netlify/functions/_binance-market-context-source.mjs';

// Virtual clock: the pacer must be provably correct without sleeping for real.
function fakeClock(startMs = 1_000_000) {
  let now = startMs;
  return { now: () => now, sleep: async (ms) => { now += ms; }, advance: (ms) => { now += ms; }, get value() { return now; } };
}

test('weight inside the budget is admitted without waiting', async () => {
  const clock = fakeClock();
  const pacer = createWeightPacer(100, clock);
  for (let i = 0; i < 10; i += 1) await pacer.take(10);
  assert.equal(pacer.diagnostics.waitedMs, 0);
  assert.equal(pacer.diagnostics.windowWeight, 100);
});

// Concurrency bounds parallelism, not rate. Without this the collector would burn
// a full minute's allowance in seconds and earn a 418 ban on the whole IP.
test('exceeding the budget waits for the rolling window instead of banning the IP', async () => {
  const clock = fakeClock();
  const pacer = createWeightPacer(100, clock);
  for (let i = 0; i < 10; i += 1) await pacer.take(10);
  assert.equal(pacer.diagnostics.waitedMs, 0);
  await pacer.take(10); // 11th call must wait for the oldest entry to age out
  assert.ok(pacer.diagnostics.waitedMs > 0, 'the over-budget call waited');
  assert.ok(pacer.diagnostics.waitedMs <= 60_000);
});

test('spent weight ages out of the window, so a later burst is admitted freely', async () => {
  const clock = fakeClock();
  const pacer = createWeightPacer(100, clock);
  for (let i = 0; i < 10; i += 1) await pacer.take(10);
  clock.advance(60_001);
  await pacer.take(100);
  assert.equal(pacer.diagnostics.waitedMs, 0, 'the previous minute no longer counts');
});

// A single item costing more than the whole budget must still run, or the venue
// would deadlock rather than collect anything.
test('an item larger than the budget is admitted rather than deadlocking', async () => {
  const clock = fakeClock();
  const pacer = createWeightPacer(5, clock);
  await pacer.take(50);
  assert.equal(pacer.diagnostics.windowWeight, 50);
});

test('the documented per-symbol weight and default budget leave real headroom', () => {
  // klines(2) + depth(5) + aggTrades(2)
  assert.equal(SYMBOL_REQUEST_WEIGHT, 9);
  // Binance allows 6000/min per IP; the default must stay meaningfully under it
  // because the ticker and multi-timeframe calls share the same allowance.
  assert.ok(DEFAULT_WEIGHT_BUDGET_PER_MIN < 6000);
  assert.ok(DEFAULT_WEIGHT_BUDGET_PER_MIN >= 1800, 'but not so low that a cycle cannot finish');
});
