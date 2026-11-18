# AVENRA Exchange — Simulated Crypto Exchange

A simulated crypto exchange for practice: spot + USDT-margined futures,
live Binance market data, manual admin-credited balances. **No real money,
no deposits, no withdrawals.**

## Features

- **5 pairs:** BTC/USDT, ETH/USDT, BNB/USDT, SOL/USDT, XRP/USDT
- **Live chart** (lightweight-charts via CDN): MA5/MA10/MA30, volume panel,
  toggleable MACD, timeframes 1m / 5m / 15m / 30m / 1h / 4h / 1d
- **Real order book + recent trades** from Binance public streams
- **Spot:** Market & Limit orders, 0.1% fee, open orders with cancel, trade history
- **Futures:** USDT-margined perpetuals, Long/Short, 1x–50x, isolated margin,
  estimated liquidation price, automatic liquidation, live unrealized PnL & ROE
- **Wallet page** with live USDT valuation
- **Hidden admin panel:** tap "Total balance" 5 times, or `Ctrl/Cmd+Shift+A`.
  Look up any account by its 8-digit UID and credit balances manually
- **No logins:** each visitor gets a persistent 8-digit UID in localStorage

## Stack

Node.js 18+ · Express (serves API + static frontend from one service) ·
PostgreSQL (`pg`, `DATABASE_URL`) · Decimal.js (all money math is decimal-safe) ·
Binance public REST + WebSocket (no API keys).

## Run locally

```bash
npm install
cp .env.example .env   # optional; without DATABASE_URL it uses an in-memory
                       # store (smoke tests only — data is lost on restart)
npm start              # http://localhost:3000
```

With a local Postgres:

```bash
createdb exchange
# set DATABASE_URL=postgresql://user:pass@localhost:5432/exchange in .env
npm start              # schema.sql runs automatically on boot
```

## Deploy (free — $0)

**1. Database — Neon (free, permanent)**

1. Create a free project at https://neon.tech
2. Copy the Postgres connection string
   (`postgresql://user:password@ep-....neon.tech/dbname?sslmode=require`)

**2. App — Render (free web service)**

1. Push this folder to a GitHub repo
2. In Render: New → Web Service → connect the repo
3. Build command: `npm install` · Start command: `npm start`
4. Environment → add `DATABASE_URL` = the Neon connection string
5. Deploy. The service URL is `https://<name>.onrender.com`

**3. Keep it awake (free)**

Render's free service sleeps after 15 minutes without traffic. Create a
free https://uptimerobot.com monitor (HTTP, 5-minute interval) pointing at
`https://<name>.onrender.com/health` — the regular pings keep it awake.
One always-on free service uses ~720 of the 750 free hours per month, so it fits.

## API

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/health` | Status, store mode, prices (uptime-monitor target) |
| GET | `/api/prices` | Cached Binance mark prices for the 5 pairs |
| GET | `/api/market/klines?symbol=&interval=&limit=` | Binance klines proxy |
| GET | `/api/account?uid=` | Account + balances (creates the account on first sight) |
| GET | `/api/balances?uid=` | Balances |
| POST | `/api/spot/order` | `{uid, symbol, side: buy\|sell, type: market\|limit, qty, price?}` |
| POST | `/api/spot/cancel` | `{uid, orderId}` (refunds locked funds) |
| GET | `/api/spot/orders?uid=&symbol=` | Open orders |
| GET | `/api/trades?uid=&symbol=&limit=` | Trade history |
| POST | `/api/futures/open` | `{uid, symbol, side: long\|short, leverage 1-50, qty}` |
| POST | `/api/futures/close` | `{uid, positionId}` |
| GET | `/api/futures/positions?uid=` | Open positions (live PnL/ROE) + closed |
| GET | `/api/admin/account?uid=` | Look up an account |
| POST | `/api/admin/credit` | `{uid, asset, amount}` — credit a balance manually |

## How it works (notes for developers)

- **Pricing:** the server polls Binance REST ticker prices every 2s
  (`src/prices.js`). Market orders execute at that mark price; limit orders
  are matched by the engine when the mark reaches the limit price; futures
  PnL and liquidation use the same mark price.
- **Limit orders lock funds at placement** (USDT for buys, base asset for
  sells) and refund on cancel. The exchange is the counterparty — simulated
  infinite liquidity at the Binance price.
- **Liquidation:** `long: entry × (1 − 1/leverage + 0.005)`,
  `short: entry × (1 + 1/leverage − 0.005)`. The engine checks every tick.
- **Money:** all amounts are decimal strings end-to-end (Decimal.js in the
  app, `NUMERIC(36,18)` in Postgres). Never float math on balances.
- **Admin has no auth** by design for this simulation. Before any public
  launch, protect `/api/admin/*` with a secret token (see `TODO` in README
  if you add one — the endpoints are isolated in `src/routes.js`).

## Project structure

```
server.js            entrypoint: static hosting + API + engine loop
src/
  db.js              store selector (Postgres vs in-memory fallback)
  store-pg.js        Postgres implementation (transactions, row locks)
  store-memory.js    in-memory implementation (local smoke tests only)
  prices.js          Binance price poller + cache
  engine.js          limit-order matching + futures liquidation
  money.js           Decimal helpers, fee, liquidation & PnL math
  routes.js          all REST endpoints
public/
  index.html         trading page
  wallet.html        wallet page
  css/style.css      dark trading theme
  js/common.js       UID, API client, formatting
  js/trade.js        chart, book, trades, spot & futures UI
  js/wallet.js       wallet UI
  js/admin.js        hidden admin panel
schema.sql           Postgres DDL (auto-applied on boot)
render.yaml          one free Render web service
Dockerfile           optional container build
```

## بخش فارسی (برای مالک پروژه)

این یک صرافی شبیه‌سازی‌شده است؛ پول واقعی ندارد و واریز/برداشت ندارد.
موجودی هر کاربر فقط از پنل ادمین (۵ بار ضربه روی «Total balance» یا
`Ctrl+Shift+A`) و با UID هشت‌رقمی شارژ می‌شود.

- **اجرای محلی:** `npm install` و بعد `npm start` — بدون دیتابیس هم با
  حافظه موقت بالا می‌آید (فقط برای تست؛ با ری‌استارت اطلاعات پاک می‌شود).
- **انتشار رایگان:** دیتابیس Neon + هاست Render + مانیتور UptimeRobot —
  همه رایگان؛ راهنمای قدم‌به‌قدم در بخش Deploy همین فایل.
- **توسعه تدریجی:** کد به بخش‌های کوچک تقسیم شده (`src/` برای سرور و
  `public/js/` برای فرانت‌اند) تا اضافه کردن ارز، قابلیت یا صفحه جدید
  راحت باشد. قبل از عمومی کردن، حتماً برای `/api/admin/*` احراز هویت
  بگذارید.
