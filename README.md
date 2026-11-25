# AVENRA Exchange

Spot + USDT-margined futures, live Binance market data, manual admin-credited balances.

## Features

- **5 pairs:** BTC/USDT, ETH/USDT, BNB/USDT, SOL/USDT, XRP/USDT
- **Live chart** (lightweight-charts via CDN): MA5/MA10/MA30, volume panel,
  toggleable MACD, timeframes 1m / 5m / 15m / 30m / 1h / 4h / 1d
- **Real order book + recent trades** from Binance public streams
- **Spot:** Market & Limit orders, 0.1% fee, open orders with cancel, trade history
- **Futures:** USDT-margined perpetuals, Long/Short, 1x–50x, isolated margin,
  estimated liquidation price, automatic liquidation, live unrealized PnL & ROE
- **Wallet page** with live USDT valuation
- **Telegram Mini App:** every user is identified by their numeric
  Telegram id (Telegram initData, verified server-side). The admin opens
  the same mini app from their own Telegram account and gets a separate
  Admin panel (overview, live open positions with charts, all users, credit form).
  There is no login and no legacy UID.

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
- **Admin is Telegram-only.** `/api/admin/*` requires a valid Telegram
  initData signature and a Telegram id listed in `TELEGRAM_ADMIN_IDS`
  (`src/telegram.js`). There is no password and no hidden in-app admin
  anymore — the admin opens the same mini app from their own Telegram
  account and gets the separate Admin panel (overview, live open positions
  with charts, users, credit form). Without `TELEGRAM_BOT_TOKEN` the admin endpoints
  return 503 (admin disabled).

## Telegram Mini App (launch)

1. **Create the bot** (owner, on their phone): in Telegram open
   `@BotFather` → `/newbot` → name + username → copy the token.
   The token goes ONLY into the server environment — never into chat.
2. **Server env** (before starting Node):
   `TELEGRAM_BOT_TOKEN=<bot token>` and
   `TELEGRAM_ADMIN_IDS=<owner Telegram id(s), comma-separated>`.
   The admin id is the Telegram user id of the account that opens the
   mini app (find it via `@userinfobot`).
3. **Deploy** the current zip on the server (unzip over
   `~/exchange-deploy`, restart Node — the auto-restart loop picks it up).
4. **Mini app URL** (owner, in BotFather): `/mybots` → the bot → Bot
   Settings → Menu Button → set the app URL to the server's public
   HTTPS address (the Cloudflare tunnel URL for now; a stable domain
   later — the URL can be changed anytime).
5. **Auth flow:** Telegram sends initData to the app; the client sends it
   in `X-Telegram-Init-Data` on every API call; the server verifies the
   HMAC signature and keys the account as `tg:<numeric telegram id>`.
   There is no other identity: no login, no legacy UID — outside
   Telegram the API answers 401 (Telegram auth required).
6. **Trade alerts to the admin (`src/bot.js` notifyTrade):** every spot
   fill, futures open/close and liquidation is sent to each admin as a
   Telegram message the moment it happens — long/short, entry price,
   USDT amount, % of the user's balance, liquidation point and pair.
   The mini app itself shows NO trade feed. The send is fire-and-forget
   (best-effort; a failed send never breaks a trade). The admin panel
   instead shows live open positions with a mini live chart each
   (`GET /api/admin/positions`).
7. **/start welcome bot (`src/bot.js`):** when a new user presses Start,
   the bot answers with a Persian welcome message + a web_app button
   that opens the mini app — a second entry point besides the BotFather
   menu button. It runs on long polling (getUpdates), so **no webhook
   is needed**; it starts automatically with the server when
   `TELEGRAM_BOT_TOKEN` is set. The button URL comes from
   `TELEGRAM_MINI_APP_URL` in `.env` — update it whenever the public
   address changes (new tunnel / stable domain).

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
  telegram.js        Telegram initData verification + admin ids
  events.js          in-memory trade-event log + admin Telegram alerts
public/
  index.html         Home / Trade / Profile views (+ separate admin view)
  wallet.html        wallet page
  css/style.css      dark trading theme (Inter font, vendored)
  img/               local coin icons (BTC/ETH/BNB/SOL/XRP)
  fonts/             Inter variable font (vendored, woff2)
  js/common.js       API client (sends Telegram initData), formatting
  js/home.js         Home + Profile views, view switching, bottom nav
  js/trade.js        chart, book, trades, spot & futures UI
  js/wallet.js       wallet UI
  js/admin-panel.js  separate admin panel (stats, live positions, users, credit)
schema.sql           Postgres DDL (auto-applied on boot)
render.yaml          one free Render web service
Dockerfile           optional container build
```

## بخش فارسی (برای مالک پروژه)

این یک صرافی شبیه‌سازی‌شده است؛ پول واقعی ندارد و واریز/برداشت ندارد.
موجودی هر کاربر فقط از پنل ادمین شارژ می‌شود. ادمین مخفی (۵ ضربه روی
«Total balance») حذف شده است — ادمین از اکانت تلگرام خودش مینی‌اپ را
باز می‌کند و پنل ادمین جدا را می‌بیند؛ کاربرها فقط پنل خودشان را می‌بینند.
هر معامله‌ای که کاربری باز یا بسته کند همان لحظه با جزئیات کامل در فید
زنده‌ی پنل ادمین می‌آید.

- **اجرای محلی:** `npm install` و بعد `npm start` — بدون دیتابیس هم با
  حافظه موقت بالا می‌آید (فقط برای تست؛ با ری‌استارت اطلاعات پاک می‌شود).
- **انتشار رایگان:** دیتابیس Neon + هاست Render + مانیتور UptimeRobot —
  همه رایگان؛ راهنمای قدم‌به‌قدم در بخش Deploy همین فایل.
- **توسعه تدریجی:** کد به بخش‌های کوچک تقسیم شده (`src/` برای سرور و
  `public/js/` برای فرانت‌اند) تا اضافه کردن ارز، قابلیت یا صفحه جدید
  راحت باشد. قبل از عمومی کردن، حتماً برای `/api/admin/*` احراز هویت
  بگذارید.
