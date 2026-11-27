// Smoke test: exercises the API end-to-end against a running server.
// Usage:  npm run test:smoke   (server must be running on PORT or 3000)
// Uses the in-memory store when the server has no DATABASE_URL.
// Admin calls need a valid Telegram initData: start the server with the
// same TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_IDS used here (defaults below).
const crypto = require('crypto');

const BASE = process.env.SMOKE_BASE || `http://localhost:${process.env.PORT || 3000}`;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'smoke-test-token';
const ADMIN_ID = (process.env.TELEGRAM_ADMIN_IDS || '999').split(',')[0].trim();

let failures = 0;

// Build a valid initData string for the admin id (same HMAC Telegram uses).
function adminInitData() {
  const authDate = Math.floor(Date.now() / 1000);
  const params = {
    auth_date: String(authDate),
    user: JSON.stringify({ id: Number(ADMIN_ID), first_name: 'Smoke', username: 'smoke_admin' }),
  };
  const pairs = Object.entries(params).map(([k, v]) => `${k}=${v}`).sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

// initData for the smoke-test user (Telegram id 777).
function userInitData() {
  const authDate = Math.floor(Date.now() / 1000);
  const params = {
    auth_date: String(authDate),
    user: JSON.stringify({ id: 777, first_name: 'SmokeUser', username: 'smoke_user' }),
  };
  const pairs = Object.entries(params).map(([k, v]) => `${k}=${v}`).sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name} ${extra}`);
  }
}

async function api(path, opts = {}) {
  const { admin, user, ...fetchOpts } = opts;
  const headers = { 'Content-Type': 'application/json' };
  if (admin) headers['X-Telegram-Init-Data'] = adminInitData();
  if (user) headers['X-Telegram-Init-Data'] = userInitData();
  const res = await fetch(BASE + path, { ...fetchOpts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${data.error || JSON.stringify(data)}`);
  return data;
}

(async () => {
  console.log('Smoke test against', BASE);

  const health = await api('/health');
  check('health ok', health.status === 'ok', JSON.stringify(health));
  console.log(`  (store mode: ${health.db})`);

  // Account + admin credit (admin call: valid Telegram initData required)
  const credit = await api('/api/admin/credit', {
    admin: true,
    method: 'POST',
    body: JSON.stringify({ uid: '777', asset: 'USDT', amount: '10000' }),
  });
  check('admin credit 10000 USDT', Number(credit.balance) === 10000, JSON.stringify(credit));

  const account = await api('/api/account', { user: true });
  check('account balances', Number(account.balances.USDT) === 10000);
  check('account uid is tg:777', account.uid === 'tg:777');
  check('user account not admin', account.is_admin === false);

  // Admin endpoints reject non-admins and unauthenticated callers
  try {
    await api('/api/admin/overview');
    check('admin overview rejects unauthenticated', false);
  } catch {
    check('admin overview rejects unauthenticated', true);
  }
  const adminOverview = await api('/api/admin/overview', { admin: true });
  check('admin overview works for admin', adminOverview.users >= 1, JSON.stringify(adminOverview));
  const adminUsers = await api('/api/admin/users', { admin: true });
  check('admin users list', Array.isArray(adminUsers.users) && adminUsers.users.length >= 1);

  // /start welcome message (pure function — no network): carries a web_app
  // button into the mini app, separate from the BotFather menu button.
  const { buildStartMessage } = require('./src/bot');
  const welcome = buildStartMessage('https://example.invalid/app');
  const btn = welcome.reply_markup.inline_keyboard[0][0];
  check('welcome message has web_app button to the mini app',
    typeof welcome.text === 'string' && welcome.text.includes('AVENRA') &&
    btn.web_app && btn.web_app.url === 'https://example.invalid/app' &&
    typeof btn.text === 'string' && btn.text.length > 0);

  // Prices (needs internet to Binance; warn but don't fail hard if blocked)
  let btcPrice = null;
  try {
    const prices = await api('/api/prices');
    btcPrice = Number(prices.prices.BTCUSDT);
    check('BTC mark price available', Number.isFinite(btcPrice) && btcPrice > 0, JSON.stringify(prices.prices));
  } catch (err) {
    console.log('  WARN  Binance unreachable, skipping price-dependent tests:', err.message);
  }

  if (btcPrice) {
    // Spot market buy 0.01 BTC
    const buy = await api('/api/spot/order', {
      user: true,
      method: 'POST',
      body: JSON.stringify({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '0.01' }),
    });
    check('market buy filled', buy.filled === true && buy.trade);
    const balAfterBuy = await api('/api/balances', { user: true });
    check('BTC balance after buy', Math.abs(Number(balAfterBuy.balances.BTC) - 0.01) < 1e-9, JSON.stringify(balAfterBuy.balances));
    const expectedUsdt = 10000 - 0.01 * btcPrice;
    check(
      'USDT debited with 0% spot fee (KCEX)',
      Math.abs(Number(balAfterBuy.balances.USDT) - expectedUsdt) < 0.05,
      `expected ~${expectedUsdt.toFixed(2)} got ${balAfterBuy.balances.USDT}`
    );

    // Limit buy far below market -> stays open; then cancel -> refund
    const limit = await api('/api/spot/order', {
      user: true,
      method: 'POST',
      body: JSON.stringify({ symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: '0.01', price: '1000' }),
    });
    check('limit order placed (open)', limit.filled === false && limit.order.status === 'open');
    const orders = await api('/api/spot/orders?symbol=BTCUSDT', { user: true });
    check('open orders list', orders.orders.length >= 1);
    const cancelled = await api('/api/spot/cancel', {
      user: true,
      method: 'POST',
      body: JSON.stringify({ orderId: limit.order.id }),
    });
    check('limit order cancelled + refunded', cancelled.order.status === 'cancelled');

    // Limit buy ABOVE market -> fills immediately (engine runs on placement)
    const limitFill = await api('/api/spot/order', {
      user: true,
      method: 'POST',
      body: JSON.stringify({ symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: '0.005', price: String(Math.ceil(btcPrice * 2)) }),
    });
    check('crossing limit order fills immediately', limitFill.filled === true, JSON.stringify(limitFill.order));

    // Futures: open long 10x, check liq price math, then close
    const balBeforeFut = await api('/api/balances', { user: true });
    const fut = await api('/api/futures/open', {
      user: true,
      method: 'POST',
      body: JSON.stringify({ symbol: 'BTCUSDT', side: 'long', leverage: 10, qty: '0.01' }),
    });
    check('futures long opened', fut.position && fut.position.status === 'open');
    // KCEX taker fee on open: the debit is margin + 0.01% of notional.
    // Computed from the returned entry price, so no price-movement noise.
    const futEntry = Number(fut.position.entry_price);
    const futOpenDebit = 0.01 * futEntry / 10 + 0.01 * futEntry * 0.0001;
    check('futures open debits margin + 0.01% taker fee (KCEX)',
      Math.abs(Number(fut.balances.USDT) - (Number(balBeforeFut.balances.USDT) - futOpenDebit)) < 0.05,
      `expected debit ~${futOpenDebit.toFixed(4)} got balance ${fut.balances.USDT}`);
    const expectedLiq = btcPrice * (1 - 1 / 10 + 0.005);
    check(
      'liquidation price ≈ entry*(1-1/10+0.005)',
      Math.abs(Number(fut.position.liquidation_price) - expectedLiq) / expectedLiq < 0.01,
      `expected ~${expectedLiq.toFixed(2)} got ${fut.position.liquidation_price}`
    );
    const positions = await api('/api/futures/positions', { user: true });
    check('open positions list', positions.open.length === 1 && positions.open[0].unrealized_pnl !== undefined);
    // Admin live positions: the open position is visible to the admin
    // with the user id, live mark price and unrealized PnL.
    const adminPositions = await api('/api/admin/positions', { admin: true });
    check('admin positions shows the open position with live mark + PnL',
      adminPositions.positions.length === 1 &&
      adminPositions.positions[0].user === '777' &&
      adminPositions.positions[0].mark_price != null &&
      adminPositions.positions[0].unrealized_pnl !== undefined &&
      adminPositions.positions[0].symbol === 'BTCUSDT',
      JSON.stringify(adminPositions.positions[0]));
    const markBeforeClose = Number((await api('/api/prices')).prices.BTCUSDT);
    const closed = await api('/api/futures/close', {
      user: true,
      method: 'POST',
      body: JSON.stringify({ positionId: fut.position.id }),
    });
    check('futures position closed', closed.position.status === 'closed' && closed.realized_pnl !== undefined);
    // KCEX taker fee on close: realized = (mark-entry)*qty - 0.01% of
    // the closing notional. Tolerance covers seconds of price movement;
    // the old 0.1% fee would sit ~$0.53 lower on this notional.
    const expectedRealized = (markBeforeClose - futEntry) * 0.01 - 0.01 * markBeforeClose * 0.0001;
    check('futures close charges 0.01% taker fee (KCEX)',
      Math.abs(Number(closed.realized_pnl) - expectedRealized) < 0.3,
      `expected ~${expectedRealized.toFixed(2)} got ${closed.realized_pnl}`);

    // Trade history
    const trades = await api('/api/trades?symbol=BTCUSDT', { user: true });
    check('trade history has entries', trades.trades.length >= 2, `got ${trades.trades.length}`);

    // Validation: no Telegram auth rejected
    try {
      await api('/api/account');
      check('missing Telegram auth rejected', false);
    } catch {
      check('missing Telegram auth rejected', true);
    }
    // Validation: insufficient balance
    try {
      await api('/api/spot/order', {
        user: true,
        method: 'POST',
        body: JSON.stringify({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1000000' }),
      });
      check('insufficient balance rejected', false);
    } catch {
      check('insufficient balance rejected', true);
    }

    // Admin trade alerts (pure formatter — no network): the full details
    // the admin gets as a Telegram message, not in the mini app.
    const { formatTradeAlert, notifyTrade } = require('./src/bot');
    const openAlert = formatTradeAlert({
      type: 'futures_open', user: '555', user_name: '@trader_one',
      symbol: 'BTCUSDT', side: 'long', leverage: 10,
      entry_price: '58510', margin: '100', liquidation_price: '52729.88',
      balance_pct: 10, balance_asset: 'USDT',
    });
    check('trade alert: futures open has side/price/margin/pct/liq',
      openAlert.includes('LONG') && openAlert.includes('10x') &&
      openAlert.includes('58,510') && openAlert.includes('100 USDT') &&
      openAlert.includes('10٪ از موجودی USDT') && openAlert.includes('52,729.88') &&
      openAlert.includes('555 (@trader_one)') && openAlert.includes('BTC/USDT'));
    const closeAlert = formatTradeAlert({
      type: 'futures_close', user: '555', symbol: 'BTCUSDT', side: 'long', leverage: 10,
      entry_price: '58510', close_price: '59100', realized_pnl: '12.5',
    });
    check('trade alert: futures close has PnL', closeAlert.includes('+$12.5'));
    const spotAlert = formatTradeAlert({
      type: 'spot_fill', user: '555', symbol: 'BTCUSDT', side: 'buy',
      qty: '0.01', price: '58510', total: '585.1', balance_pct: 58.5, balance_asset: 'USDT',
    });
    check('trade alert: spot buy has qty/price/total/pct',
      spotAlert.includes('خرید BTC') && spotAlert.includes('585.1 USDT') && spotAlert.includes('58.5٪'));
    // notifyTrade with no token configured must not throw (best-effort).
    delete process.env.TELEGRAM_BOT_TOKEN;
    await notifyTrade({ type: 'futures_open', user: '555', symbol: 'BTCUSDT' });
    check('trade alert: no token -> silent no-op', true);
  }

  console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} SMOKE TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
