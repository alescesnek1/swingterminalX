-- Derived rolling-absorption result, computed at COLLECTION time from the raw
-- trades/candles while they are still in memory, and stored as one row per
-- measured symbol.
--
-- Why derived rather than recomputed on read: the publisher previously rebuilt
-- absorption by re-reading every symbol's raw agg trades and candles back out of
-- the database, which costs two round trips PER SYMBOL. That is affordable for 5
-- symbols and impossible for the full tradable universe. Storing the derived
-- result makes the read a single query and removes the need to retain raw trades
-- for every symbol at all.
--
-- NULL means "not computed for this row" (e.g. no depth baseline inside the
-- honest window) and must read as UNKNOWN — never as an absent/failed absorb.
ALTER TABLE market_microstructure_measurements
  ADD COLUMN IF NOT EXISTS absorb jsonb NULL;
