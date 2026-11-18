-- AVENRA Exchange (simulated) — Postgres schema.
-- All money columns are NUMERIC (never float). Amounts are handled as
-- decimal strings in the app (Decimal.js) and stored exactly.
-- Run automatically on server boot (store-pg.js) or manually with psql.

CREATE TABLE IF NOT EXISTS accounts (
  uid        TEXT PRIMARY KEY,          -- 8-digit user id, e.g. '12345678'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS balances (
  uid        TEXT NOT NULL REFERENCES accounts(uid),
  asset      TEXT NOT NULL,             -- USDT, BTC, ETH, BNB, SOL, XRP
  amount     NUMERIC(36, 18) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (uid, asset)
);
CREATE INDEX IF NOT EXISTS idx_balances_uid ON balances (uid);

CREATE TABLE IF NOT EXISTS spot_orders (
  id            SERIAL PRIMARY KEY,
  uid           TEXT NOT NULL REFERENCES accounts(uid),
  symbol        TEXT NOT NULL,          -- e.g. BTCUSDT
  side          TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  type          TEXT NOT NULL CHECK (type IN ('market', 'limit')),
  price         NUMERIC(36, 18),       -- limit price; NULL for market
  qty           NUMERIC(36, 18) NOT NULL,
  filled_qty    NUMERIC(36, 18) NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'cancelled')),
  locked_asset  TEXT,                   -- asset debited at placement (USDT for buys, base for sells)
  locked_amount NUMERIC(36, 18),       -- amount locked (refunded on cancel)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_spot_orders_uid ON spot_orders (uid);
CREATE INDEX IF NOT EXISTS idx_spot_orders_open ON spot_orders (status, type);

CREATE TABLE IF NOT EXISTS trades (
  id         SERIAL PRIMARY KEY,
  uid        TEXT NOT NULL REFERENCES accounts(uid),
  symbol     TEXT NOT NULL,
  side       TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  price      NUMERIC(36, 18) NOT NULL,
  qty        NUMERIC(36, 18) NOT NULL,
  fee        NUMERIC(36, 18) NOT NULL DEFAULT 0,
  total      NUMERIC(36, 18) NOT NULL, -- qty * price (before fee)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trades_uid ON trades (uid);

CREATE TABLE IF NOT EXISTS futures_positions (
  id                SERIAL PRIMARY KEY,
  uid               TEXT NOT NULL REFERENCES accounts(uid),
  symbol            TEXT NOT NULL,
  side              TEXT NOT NULL CHECK (side IN ('long', 'short')),
  leverage          INTEGER NOT NULL CHECK (leverage BETWEEN 1 AND 50),
  entry_price       NUMERIC(36, 18) NOT NULL,
  qty               NUMERIC(36, 18) NOT NULL,
  margin            NUMERIC(36, 18) NOT NULL,  -- USDT locked as isolated margin
  liquidation_price NUMERIC(36, 18) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'liquidated')),
  realized_pnl      NUMERIC(36, 18),           -- set on close/liquidation
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_futures_uid ON futures_positions (uid);
CREATE INDEX IF NOT EXISTS idx_futures_open ON futures_positions (status);
