// Smoke test: exercises the API end-to-end against a running server.
// Usage:  npm run test:smoke   (server must be running on PORT or 3000)
// Uses the in-memory store when the server has no DATABASE_URL.
const BASE = process.env.SMOKE_BASE || `http://localhost:${process.env.PORT || 3000}`;

const UID = '12345678';
let failures = 0;

function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name} ${extra}`);
  }
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${data.error || JSON.stringify(data)}`);
  return data;
}

(async () => {
  console.log('Smoke test against', BASE);

  const health = await api('/health');
  check('health ok', health.status === 'ok', JSON.stringify(health));
  console.log(`  (store mode: ${health.db})`);

  // Account + admin credit
  const credit = await api('/api/admin/credit', {
    method: 'POST',
    body: JSON.stringify({ uid: UID, asset: 'USDT', amount: '10000' }),
  });
  check('admin credit 10000 USDT', Number(credit.balance) === 10000, JSON.stringify(credit));

  const account = await api(`/api/account?uid=${UID}`);
  check('account balances', Number(account.balances.USDT) === 10000);

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
      method: 'POST',
      body: JSON.stringify({ uid: UID, symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '0.01' }),
    });
    check('market buy filled', buy.filled === true && buy.trade);
    const balAfterBuy = await api(`/api/balances?uid=${UID}`);
    check('BTC balance after buy', Math.abs(Number(balAfterBuy.balances.BTC) - 0.01) < 1e-9, JSON.stringify(balAfterBuy.balances));
    const expectedUsdt = 10000 - 0.01 * btcPrice * 1.001;
    check(
      'USDT debited with 0.1% fee',
      Math.abs(Number(balAfterBuy.balances.USDT) - expectedUsdt) < 0.05,
      `expected ~${expectedUsdt.toFixed(2)} got ${balAfterBuy.balances.USDT}`
    );

    // Limit buy far below market -> stays open; then cancel -> refund
    const limit = await api('/api/spot/order', {
      method: 'POST',
      body: JSON.stringify({ uid: UID, symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: '0.01', price: '1000' }),
    });
    check('limit order placed (open)', limit.filled === false && limit.order.status === 'open');
    const orders = await api(`/api/spot/orders?uid=${UID}&symbol=BTCUSDT`);
    check('open orders list', orders.orders.length >= 1);
    const cancelled = await api('/api/spot/cancel', {
      method: 'POST',
      body: JSON.stringify({ uid: UID, orderId: limit.order.id }),
    });
    check('limit order cancelled + refunded', cancelled.order.status === 'cancelled');

    // Limit buy ABOVE market -> fills immediately (engine runs on placement)
    const limitFill = await api('/api/spot/order', {
      method: 'POST',
      body: JSON.stringify({ uid: UID, symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: '0.005', price: String(Math.ceil(btcPrice * 2)) }),
    });
    check('crossing limit order fills immediately', limitFill.filled === true, JSON.stringify(limitFill.order));

    // Futures: open long 10x, check liq price math, then close
    const fut = await api('/api/futures/open', {
      method: 'POST',
      body: JSON.stringify({ uid: UID, symbol: 'BTCUSDT', side: 'long', leverage: 10, qty: '0.01' }),
    });
    check('futures long opened', fut.position && fut.position.status === 'open');
    const expectedLiq = btcPrice * (1 - 1 / 10 + 0.005);
    check(
      'liquidation price ≈ entry*(1-1/10+0.005)',
      Math.abs(Number(fut.position.liquidation_price) - expectedLiq) / expectedLiq < 0.01,
      `expected ~${expectedLiq.toFixed(2)} got ${fut.position.liquidation_price}`
    );
    const positions = await api(`/api/futures/positions?uid=${UID}`);
    check('open positions list', positions.open.length === 1 && positions.open[0].unrealized_pnl !== undefined);
    const closed = await api('/api/futures/close', {
      method: 'POST',
      body: JSON.stringify({ uid: UID, positionId: fut.position.id }),
    });
    check('futures position closed', closed.position.status === 'closed' && closed.realized_pnl !== undefined);

    // Trade history
    const trades = await api(`/api/trades?uid=${UID}&symbol=BTCUSDT`);
    check('trade history has entries', trades.trades.length >= 2, `got ${trades.trades.length}`);

    // Validation: bad UID rejected
    try {
      await api('/api/account?uid=123');
      check('bad UID rejected', false);
    } catch {
      check('bad UID rejected', true);
    }
    // Validation: insufficient balance
    try {
      await api('/api/spot/order', {
        method: 'POST',
        body: JSON.stringify({ uid: UID, symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: '1000000' }),
      });
      check('insufficient balance rejected', false);
    } catch {
      check('insufficient balance rejected', true);
    }
  }

  console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} SMOKE TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
