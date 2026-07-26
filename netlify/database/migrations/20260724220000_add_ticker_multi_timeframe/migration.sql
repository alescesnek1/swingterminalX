-- Bounded multi-timeframe change columns on ticker observations. Populated only
-- for the top-N symbols by 24h quote volume (Binance rolling-window ticker is
-- rate-limited); every other symbol leaves these NULL, which the reader surfaces
-- as UNKNOWN — never a fabricated 0.
ALTER TABLE market_ticker_observations
  ADD COLUMN IF NOT EXISTS change_1h_pct numeric NULL,
  ADD COLUMN IF NOT EXISTS change_4h_pct numeric NULL,
  ADD COLUMN IF NOT EXISTS change_12h_pct numeric NULL,
  ADD COLUMN IF NOT EXISTS change_7d_pct numeric NULL;
