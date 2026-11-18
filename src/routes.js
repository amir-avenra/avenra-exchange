// REST API routes. All amounts in requests/responses are decimal strings.
// No login/auth: the client identifies itself with a persistent 8-digit UID
// stored in localStorage (created on first visit).
const express = require('express');
const { D, FEE_RATE, feeOf, liquidationPrice, unrealizedPnl, roe } = require('./money');
const { SYMBOLS, HOSTS } = require('./prices');
const engine = require('./engine');

const ASSETS = ['USDT', 'BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
const UID_RE = /^\d{8}$/;

function createRouter(store, prices) {
  const router = express.Router();
  const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  function requireUid(req, res) {
    const uid = req.query.uid || req.body.uid;
    if (!UID_RE.test(uid || '')) {
      res.status(400).json({ error: 'uid must be an 8-digit number' });
      return null;
    }
    return uid;
  }

  function parseAmount(value, field = 'amount') {
    let d;
    try {
      d = D(value);
    } catch {
      return null;
    }
    if (!d.isFinite() || d.lte(0)) return null;
    return d;
  }

  function validSymbol(symbol) {
    return SYMBOLS.includes(symbol);
  }

  // ---- market data -------------------------------------------------------
  router.get('/prices', (req, res) => {
    res.json({ prices: prices.getAll() });
  });

  // Proxy Binance klines (avoids browser CORS/region issues for some users).
  router.get('/market/klines', asyncHandler(async (req, res) => {
    const { symbol, interval = '1m', limit = 200 } = req.query;
    if (!validSymbol(symbol)) return res.status(400).json({ error: 'invalid symbol' });
    const params = new URLSearchParams({ symbol, interval, limit: String(Math.min(Number(limit) || 200, 1000)) });
    let lastError = null;
    for (const host of HOSTS) {
      try {
        const r = await fetch(`${host}/api/v3/klines?${params}`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) { lastError = new Error(`Binance HTTP ${r.status}`); continue; }
        return res.json(await r.json());
      } catch (err) {
        lastError = err;
      }
    }
    res.status(502).json({ error: 'Binance unreachable', detail: String(lastError && lastError.message) });
  }));

  // ---- account / balances -------------------------------------------------
  router.get('/account', asyncHandler(async (req, res) => {
    const uid = requireUid(req, res);
    if (!uid) return;
    const account = await store.ensureAccount(uid);
    const balances = await store.getBalances(uid);
    res.json({ uid: account.uid, created_at: account.created_at, balances });
  }));

  router.get('/balances', asyncHandler(async (req, res) => {
    const uid = requireUid(req, res);
    if (!uid) return;
    await store.ensureAccount(uid);
    res.json({ uid, balances: await store.getBalances(uid) });
  }));

  // ---- spot ---------------------------------------------------------------
  router.post('/spot/order', asyncHandler(async (req, res) => {
    const uid = requireUid(req, res);
    if (!uid) return;
    const { symbol, side, type } = req.body;
    if (!validSymbol(symbol)) return res.status(400).json({ error: 'invalid symbol' });
    if (!['buy', 'sell'].includes(side)) return res.status(400).json({ error: 'side must be buy or sell' });
    if (!['market', 'limit'].includes(type)) return res.status(400).json({ error: 'type must be market or limit' });
    const qty = parseAmount(req.body.qty, 'qty');
    if (!qty) return res.status(400).json({ error: 'qty must be a positive number' });

    const base = engine.baseAsset(symbol);
    await store.ensureAccount(uid);

    if (type === 'market') {
      let mark = prices.getPrice(symbol);
      if (!mark) mark = await prices.fetchOnce(symbol);
      if (!mark) return res.status(503).json({ error: 'Price unavailable, try again in a moment' });

      const price = D(mark);
      const notional = qty.mul(price);
      const fee = notional.mul(FEE_RATE);

      if (side === 'buy') {
        const total = notional.plus(fee);
        try {
          await store.adjustBalance(uid, 'USDT', total.neg().toString());
        } catch {
          return res.status(400).json({ error: 'Insufficient USDT balance' });
        }
        await store.adjustBalance(uid, base, qty.toString());
      } else {
        try {
          await store.adjustBalance(uid, base, qty.neg().toString());
        } catch {
          return res.status(400).json({ error: `Insufficient ${base} balance` });
        }
        await store.adjustBalance(uid, 'USDT', notional.minus(fee).toString());
      }
      const trade = await store.recordTrade({
        uid, symbol, side,
        price: price.toString(), qty: qty.toString(),
        fee: fee.toString(), total: notional.toString(),
      });
      return res.json({ filled: true, trade, balances: await store.getBalances(uid) });
    }

    // limit order: lock funds now, fill later when the mark price reaches it
    const limitPrice = parseAmount(req.body.price, 'price');
    if (!limitPrice) return res.status(400).json({ error: 'price must be a positive number for limit orders' });
    const notional = qty.mul(limitPrice);
    const fee = notional.mul(FEE_RATE);

    let order;
    if (side === 'buy') {
      const lock = notional.plus(fee);
      try {
        await store.adjustBalance(uid, 'USDT', lock.neg().toString());
      } catch {
        return res.status(400).json({ error: 'Insufficient USDT balance' });
      }
      order = await store.createSpotOrder({
        uid, symbol, side, type, price: limitPrice.toString(), qty: qty.toString(),
        locked_asset: 'USDT', locked_amount: lock.toString(),
      });
    } else {
      try {
        await store.adjustBalance(uid, base, qty.neg().toString());
      } catch {
        return res.status(400).json({ error: `Insufficient ${base} balance` });
      }
      order = await store.createSpotOrder({
        uid, symbol, side, type, price: limitPrice.toString(), qty: qty.toString(),
        locked_asset: base, locked_amount: qty.toString(),
      });
    }

    // A limit that already crosses the market fills immediately.
    await engine.matchLimitOrders(store, prices);
    const fresh = await store.getSpotOrder(order.id);
    res.json({ filled: fresh.status === 'filled', order: fresh, balances: await store.getBalances(uid) });
  }));

  router.post('/spot/cancel', asyncHandler(async (req, res) => {
    const uid = requireUid(req, res);
    if (!uid) return;
    const order = await store.getSpotOrder(req.body.orderId);
    if (!order || order.uid !== uid) return res.status(404).json({ error: 'order not found' });
    if (order.status !== 'open') return res.status(400).json({ error: `order is ${order.status}` });
    if (order.locked_asset && order.locked_amount) {
      await store.adjustBalance(uid, order.locked_asset, order.locked_amount);
    }
    const updated = await store.updateSpotOrder(order.id, { status: 'cancelled' });
    res.json({ order: updated, balances: await store.getBalances(uid) });
  }));

  router.get('/spot/orders', asyncHandler(async (req, res) => {
    const uid = requireUid(req, res);
    if (!uid) return;
    const orders = await store.getOpenSpotOrders(uid, req.query.symbol || undefined);
    res.json({ orders });
  }));

  router.get('/trades', asyncHandler(async (req, res) => {
    const uid = requireUid(req, res);
    if (!uid) return;
    const trades = await store.getTrades(uid, req.query.symbol || undefined, Math.min(Number(req.query.limit) || 50, 200));
    res.json({ trades });
  }));

  // ---- futures ------------------------------------------------------------
  router.post('/futures/open', asyncHandler(async (req, res) => {
    const uid = requireUid(req, res);
    if (!uid) return;
    const { symbol, side } = req.body;
    if (!validSymbol(symbol)) return res.status(400).json({ error: 'invalid symbol' });
    if (!['long', 'short'].includes(side)) return res.status(400).json({ error: 'side must be long or short' });
    const leverage = Number(req.body.leverage);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 50) {
      return res.status(400).json({ error: 'leverage must be an integer 1-50' });
    }
    const qty = parseAmount(req.body.qty, 'qty');
    if (!qty) return res.status(400).json({ error: 'qty must be a positive number' });

    let mark = prices.getPrice(symbol);
    if (!mark) mark = await prices.fetchOnce(symbol);
    if (!mark) return res.status(503).json({ error: 'Price unavailable, try again in a moment' });

    const entry = D(mark);
    const notional = qty.mul(entry);
    const margin = notional.div(leverage);
    await store.ensureAccount(uid);
    try {
      await store.adjustBalance(uid, 'USDT', margin.neg().toString());
    } catch {
      return res.status(400).json({ error: 'Insufficient USDT balance for margin' });
    }
    const position = await store.createPosition({
      uid, symbol, side, leverage,
      entry_price: entry.toString(), qty: qty.toString(),
      margin: margin.toString(),
      liquidation_price: liquidationPrice(side, entry, leverage),
    });
    res.json({ position, balances: await store.getBalances(uid) });
  }));

  router.post('/futures/close', asyncHandler(async (req, res) => {
    const uid = requireUid(req, res);
    if (!uid) return;
    const position = await store.getPosition(req.body.positionId);
    if (!position || position.uid !== uid) return res.status(404).json({ error: 'position not found' });
    if (position.status !== 'open') return res.status(400).json({ error: `position is ${position.status}` });

    let mark = prices.getPrice(position.symbol);
    if (!mark) mark = await prices.fetchOnce(position.symbol);
    if (!mark) return res.status(503).json({ error: 'Price unavailable, try again in a moment' });

    const pnl = unrealizedPnl(position, mark);
    const fee = D(position.qty).mul(D(mark)).mul(FEE_RATE);
    const realized = pnl.minus(fee);
    const credit = D(position.margin).plus(realized);
    const creditClamped = credit.isNegative() ? D(0) : credit;
    if (creditClamped.gt(0)) {
      await store.adjustBalance(uid, 'USDT', creditClamped.toString());
    }
    const updated = await store.updatePosition(position.id, {
      status: 'closed',
      realized_pnl: realized.toString(),
      closed_at: new Date().toISOString(),
    });
    res.json({ position: updated, realized_pnl: realized.toString(), balances: await store.getBalances(uid) });
  }));

  router.get('/futures/positions', asyncHandler(async (req, res) => {
    const uid = requireUid(req, res);
    if (!uid) return;
    const open = await store.getOpenPositions(uid);
    const closed = await store.getClosedPositions(uid, 20);
    // Attach live mark price, unrealized PnL and ROE to open positions.
    const openLive = open.map((p) => {
      const mark = prices.getPrice(p.symbol);
      if (!mark) return { ...p, mark_price: null, unrealized_pnl: null, roe: null };
      const pnl = unrealizedPnl(p, mark);
      return {
        ...p,
        mark_price: mark,
        unrealized_pnl: pnl.toString(),
        roe: roe(p, mark).toString(),
      };
    });
    res.json({ open: openLive, closed });
  }));

  // ---- admin (no auth by design for this simulation — see README) ----------
  router.get('/admin/account', asyncHandler(async (req, res) => {
    const uid = requireUid(req, res);
    if (!uid) return;
    const account = await store.getAccount(uid);
    if (!account) return res.status(404).json({ error: 'account not found' });
    res.json({ uid: account.uid, created_at: account.created_at, balances: await store.getBalances(uid) });
  }));

  router.post('/admin/credit', asyncHandler(async (req, res) => {
    const uid = requireUid(req, res);
    if (!uid) return;
    const { asset } = req.body;
    if (!ASSETS.includes(asset)) return res.status(400).json({ error: 'invalid asset' });
    const amount = parseAmount(req.body.amount, 'amount');
    if (!amount) return res.status(400).json({ error: 'amount must be a positive number' });
    await store.ensureAccount(uid);
    const balance = await store.adjustBalance(uid, asset, amount.toString());
    res.json({ uid, asset, balance, balances: await store.getBalances(uid) });
  }));

  return router;
}

module.exports = { createRouter, ASSETS };
