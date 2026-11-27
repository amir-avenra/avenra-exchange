// REST API routes. All amounts in requests/responses are decimal strings.
// Identity: Telegram initData ONLY. The client sends its initData in the
// X-Telegram-Init-Data header (verified against TELEGRAM_BOT_TOKEN); the
// account uid is "tg:<numeric telegram id>". There is no legacy UID:
// every user (and the admin) is identified by their numeric Telegram id.
// Admin rights exist ONLY via a verified Telegram identity whose id is
// in TELEGRAM_ADMIN_IDS.
const express = require('express');
const { D, SPOT_FEE_RATE, FUTURES_TAKER_FEE_RATE, liquidationPrice, unrealizedPnl, roe } = require('./money');
const { SYMBOLS, HOSTS } = require('./prices');
const engine = require('./engine');
const { verifyInitData, isAdminId } = require('./telegram');
const tradeEvents = require('./events');

const ASSETS = ['USDT', 'BTC', 'ETH', 'BNB', 'SOL', 'XRP'];

function createRouter(store, prices) {
  const router = express.Router();
  const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // Resolve who is calling. Telegram initData is REQUIRED: every user
  // (and the admin) is identified by their numeric Telegram id, as the
  // account uid "tg:<id>". There is no legacy UID anymore.
  // Returns { uid, tgId, tgUser, isAdmin } or { error: { status, message } }.
  function resolveIdentity(req) {
    const initData = req.get('X-Telegram-Init-Data');
    if (!initData) {
      return { error: { status: 401, message: 'Telegram auth required' } };
    }
    const v = verifyInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!v.ok) return { error: { status: 401, message: 'Invalid Telegram auth: ' + v.error } };
    const tgId = String(v.user.id);
    const uid = 'tg:' + tgId;
    tradeEvents.setProfile(uid, v.user);
    return { uid, tgId, tgUser: v.user, isAdmin: isAdminId(tgId) };
  }

  // Normalize an admin-supplied account id: a bare numeric id is a
  // Telegram numeric id -> "tg:<id>" ("tg:<id>" passes through as-is).
  function normalizeTargetUid(raw) {
    const v = String(raw || '').trim();
    if (/^\d+$/.test(v)) return 'tg:' + v;
    return v;
  }

  // Numeric Telegram id for a uid, or null for legacy accounts.
  function tgIdOf(uid) {
    return uid.startsWith('tg:') ? Number(uid.slice(3)) : null;
  }

  // Percentage of a balance an amount represents (for admin trade alerts).
  // Returns a plain number, or null when the balance is zero/unknown.
  function pctOf(part, whole) {
    const w = D(whole || '0');
    if (w.lte(0)) return null;
    return Number(D(part).div(w).mul(100).toString());
  }

  function requireIdentity(req, res) {
    const id = resolveIdentity(req);
    if (id.error) {
      res.status(id.error.status).json({ error: id.error.message });
      return null;
    }
    return id;
  }

  // Admin-only: Telegram auth is mandatory (no legacy-UID admin), and the
  // Telegram id must be listed in TELEGRAM_ADMIN_IDS.
  function requireAdmin(req, res) {
    const initData = req.get('X-Telegram-Init-Data');
    if (!initData) {
      res.status(401).json({ error: 'Telegram auth required for admin' });
      return null;
    }
    const v = verifyInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!v.ok) {
      res.status(401).json({ error: 'Invalid Telegram auth: ' + v.error });
      return null;
    }
    const tgId = String(v.user.id);
    if (!isAdminId(tgId)) {
      res.status(403).json({ error: 'admin only' });
      return null;
    }
    tradeEvents.setProfile('tg:' + tgId, v.user);
    return { uid: 'tg:' + tgId, tgId, tgUser: v.user, isAdmin: true };
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

  // Fetch from Binance, racing both hosts in parallel and taking the first
  // success. The old sequential fallback could take 20s + 20s = 40s, which
  // exceeded the browser's 25s timeout — on a slow VPN the fast host's
  // answer was thrown away because the client had already given up.
  // Parallel: worst case is now the slower host's 20s, inside the 25s.
  async function fetchBinance(pathWithQuery) {
    const attempts = HOSTS.map(async (host) => {
      const r = await fetch(`${host}${pathWithQuery}`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
      return r.json();
    });
    try {
      return await Promise.any(attempts);
    } catch (agg) {
      const first = agg && Array.isArray(agg.errors) && agg.errors[0];
      throw first || agg;
    }
  }

  // Proxy Binance klines (avoids browser CORS/region issues for some users).
  router.get('/market/klines', asyncHandler(async (req, res) => {
    const { symbol, interval = '1m', limit = 200 } = req.query;
    if (!validSymbol(symbol)) return res.status(400).json({ error: 'invalid symbol' });
    const params = new URLSearchParams({ symbol, interval, limit: String(Math.min(Number(limit) || 200, 1000)) });
    try {
      return res.json(await fetchBinance(`/api/v3/klines?${params}`));
    } catch (err) {
      return res.status(502).json({ error: 'Binance unreachable', detail: String(err && err.message) });
    }
  }));

  // Shared helper for the /market/* Binance proxies below: try each Binance
  // host in turn and return the first successful response.
  async function proxyBinance(res, binancePath, params) {
    try {
      return res.json(await fetchBinance(`${binancePath}?${params}`));
    } catch (err) {
      return res.status(502).json({ error: 'Binance unreachable', detail: String(err && err.message) });
    }
  }

  // Proxy Binance order-book snapshot (REST; the page polls this instead of
  // the Binance websocket, which is blocked on some visitor networks).
  router.get('/market/depth', asyncHandler(async (req, res) => {
    const { symbol } = req.query;
    if (!validSymbol(symbol)) return res.status(400).json({ error: 'invalid symbol' });
    // Binance only accepts these depth limits; snap to the nearest allowed one.
    const allowed = [5, 10, 20, 50, 100, 500, 1000];
    const wanted = Number(req.query.limit) || 20;
    const limit = allowed.find((v) => v >= wanted) || 1000;
    const params = new URLSearchParams({ symbol, limit: String(limit) });
    await proxyBinance(res, '/api/v3/depth', params);
  }));

  // Proxy Binance recent aggregated trades.
  router.get('/market/aggTrades', asyncHandler(async (req, res) => {
    const { symbol } = req.query;
    if (!validSymbol(symbol)) return res.status(400).json({ error: 'invalid symbol' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 1000);
    const params = new URLSearchParams({ symbol, limit: String(limit) });
    await proxyBinance(res, '/api/v3/aggTrades', params);
  }));

  // Proxy Binance 24hr ticker(s). Accepts symbols=<JSON array> like the
  // Binance API, or a single symbol=<SYMBOL>.
  router.get('/market/ticker24', asyncHandler(async (req, res) => {
    let symbols;
    if (req.query.symbols) {
      try {
        symbols = JSON.parse(req.query.symbols);
      } catch {
        return res.status(400).json({ error: 'symbols must be a JSON array' });
      }
      if (!Array.isArray(symbols) || !symbols.length || !symbols.every((s) => validSymbol(s))) {
        return res.status(400).json({ error: 'invalid symbol in symbols' });
      }
    } else if (req.query.symbol) {
      if (!validSymbol(req.query.symbol)) return res.status(400).json({ error: 'invalid symbol' });
      symbols = [req.query.symbol];
    } else {
      return res.status(400).json({ error: 'symbols or symbol required' });
    }
    const params = new URLSearchParams({ symbols: JSON.stringify(symbols) });
    await proxyBinance(res, '/api/v3/ticker/24hr', params);
  }));

  // ---- account / balances -------------------------------------------------
  router.get('/account', asyncHandler(async (req, res) => {
    const id = requireIdentity(req, res);
    if (!id) return;
    const account = await store.ensureAccount(id.uid);
    const balances = await store.getBalances(id.uid);
    res.json({
      uid: account.uid,
      created_at: account.created_at,
      balances,
      is_admin: id.isAdmin,
      tg_user: id.tgUser ? { id: id.tgUser.id, username: id.tgUser.username || null, first_name: id.tgUser.first_name || null } : null,
    });
  }));

  router.get('/balances', asyncHandler(async (req, res) => {
    const id = requireIdentity(req, res);
    if (!id) return;
    await store.ensureAccount(id.uid);
    res.json({ uid: id.uid, balances: await store.getBalances(id.uid) });
  }));

  // ---- spot ---------------------------------------------------------------
  router.post('/spot/order', asyncHandler(async (req, res) => {
    const id = requireIdentity(req, res);
    if (!id) return;
    const uid = id.uid;
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
      const fee = notional.mul(SPOT_FEE_RATE); // KCEX spot fee is 0%
      // Balances BEFORE the trade, so the admin alert can say what % of
      // the user's balance this trade used.
      const before = await store.getBalances(uid);
      let balancePct = null;
      let balanceAsset = null;

      if (side === 'buy') {
        const total = notional.plus(fee);
        try {
          await store.adjustBalance(uid, 'USDT', total.neg().toString());
        } catch {
          return res.status(400).json({ error: 'Insufficient USDT balance' });
        }
        await store.adjustBalance(uid, base, qty.toString());
        balancePct = pctOf(total, before.USDT);
        balanceAsset = 'USDT';
      } else {
        try {
          await store.adjustBalance(uid, base, qty.neg().toString());
        } catch {
          return res.status(400).json({ error: `Insufficient ${base} balance` });
        }
        await store.adjustBalance(uid, 'USDT', notional.minus(fee).toString());
        balancePct = pctOf(qty, before[base]);
        balanceAsset = base;
      }
      const trade = await store.recordTrade({
        uid, symbol, side,
        price: price.toString(), qty: qty.toString(),
        fee: fee.toString(), total: notional.toString(),
      });
      tradeEvents.push('spot_fill', {
        uid, symbol, side, qty: qty.toString(),
        price: price.toString(), total: notional.toString(), fee: fee.toString(),
        balance_pct: balancePct, balance_asset: balanceAsset,
      });
      return res.json({ filled: true, trade, balances: await store.getBalances(uid) });
    }

    // limit order: lock funds now, fill later when the mark price reaches it
    const limitPrice = parseAmount(req.body.price, 'price');
    if (!limitPrice) return res.status(400).json({ error: 'price must be a positive number for limit orders' });
    const notional = qty.mul(limitPrice);
    const fee = notional.mul(SPOT_FEE_RATE); // KCEX spot fee is 0%

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
    if (fresh.status === 'filled') {
      tradeEvents.push('spot_fill', {
        uid, symbol, side, qty: qty.toString(),
        price: limitPrice.toString(), total: notional.toString(), fee: fee.toString(),
      });
    }
    res.json({ filled: fresh.status === 'filled', order: fresh, balances: await store.getBalances(uid) });
  }));

  router.post('/spot/cancel', asyncHandler(async (req, res) => {
    const id = requireIdentity(req, res);
    if (!id) return;
    const uid = id.uid;
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
    const id = requireIdentity(req, res);
    if (!id) return;
    const uid = id.uid;
    const orders = await store.getOpenSpotOrders(uid, req.query.symbol || undefined);
    res.json({ orders });
  }));

  router.get('/trades', asyncHandler(async (req, res) => {
    const id = requireIdentity(req, res);
    if (!id) return;
    const uid = id.uid;
    const trades = await store.getTrades(uid, req.query.symbol || undefined, Math.min(Number(req.query.limit) || 50, 200));
    res.json({ trades });
  }));

  // ---- futures ------------------------------------------------------------
  router.post('/futures/open', asyncHandler(async (req, res) => {
    const id = requireIdentity(req, res);
    if (!id) return;
    const uid = id.uid;
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
    // KCEX taker fee (0.01% of notional) on a market open, debited with
    // the margin so the position itself still holds exactly `margin`.
    const fee = notional.mul(FUTURES_TAKER_FEE_RATE);
    await store.ensureAccount(uid);
    // Balance BEFORE the margin is locked, for the admin alert's % figure.
    const before = await store.getBalances(uid);
    try {
      await store.adjustBalance(uid, 'USDT', margin.plus(fee).neg().toString());
    } catch {
      return res.status(400).json({ error: 'Insufficient USDT balance for margin' });
    }
    const position = await store.createPosition({
      uid, symbol, side, leverage,
      entry_price: entry.toString(), qty: qty.toString(),
      margin: margin.toString(),
      liquidation_price: liquidationPrice(side, entry, leverage),
    });
    tradeEvents.push('futures_open', {
      uid, symbol, side, leverage,
      qty: qty.toString(), entry_price: entry.toString(),
      margin: margin.toString(), liquidation_price: position.liquidation_price,
      balance_pct: pctOf(margin, before.USDT), balance_asset: 'USDT',
    });
    res.json({ position, balances: await store.getBalances(uid) });
  }));

  router.post('/futures/close', asyncHandler(async (req, res) => {
    const id = requireIdentity(req, res);
    if (!id) return;
    const uid = id.uid;
    const position = await store.getPosition(req.body.positionId);
    if (!position || position.uid !== uid) return res.status(404).json({ error: 'position not found' });
    if (position.status !== 'open') return res.status(400).json({ error: `position is ${position.status}` });

    let mark = prices.getPrice(position.symbol);
    if (!mark) mark = await prices.fetchOnce(position.symbol);
    if (!mark) return res.status(503).json({ error: 'Price unavailable, try again in a moment' });

    const pnl = unrealizedPnl(position, mark);
    // KCEX taker fee (0.01% of the closing notional) — was 0.1%.
    const fee = D(position.qty).mul(D(mark)).mul(FUTURES_TAKER_FEE_RATE);
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
    tradeEvents.push('futures_close', {
      uid, symbol: position.symbol, side: position.side,
      leverage: position.leverage, qty: position.qty,
      entry_price: position.entry_price, close_price: D(mark).toString(),
      realized_pnl: realized.toString(),
    });
    res.json({ position: updated, realized_pnl: realized.toString(), balances: await store.getBalances(uid) });
  }));

  router.get('/futures/positions', asyncHandler(async (req, res) => {
    const id = requireIdentity(req, res);
    if (!id) return;
    const uid = id.uid;
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

  // ---- admin (Telegram auth required; id must be in TELEGRAM_ADMIN_IDS) --
  // The hidden in-app admin is gone: the admin opens this same mini app
  // from their own Telegram account and gets the separate Admin panel.
  router.get('/admin/account', asyncHandler(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const uid = normalizeTargetUid(req.query.uid);
    if (typeof uid !== 'string' || !uid) return res.status(400).json({ error: 'uid required' });
    const account = await store.getAccount(uid);
    if (!account) return res.status(404).json({ error: 'account not found' });
    const profile = tradeEvents.getProfile(uid);
    res.json({
      uid: account.uid, created_at: account.created_at,
      balances: await store.getBalances(uid),
      open_positions: (await store.getOpenPositions(uid)).length,
      trades: await store.countTrades(uid),
      telegram_id: tgIdOf(uid),
      telegram: profile,
    });
  }));

  router.post('/admin/credit', asyncHandler(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const uid = normalizeTargetUid(req.body.uid);
    if (typeof uid !== 'string' || !uid) return res.status(400).json({ error: 'uid required' });
    const { asset } = req.body;
    if (!ASSETS.includes(asset)) return res.status(400).json({ error: 'invalid asset' });
    const amount = parseAmount(req.body.amount, 'amount');
    if (!amount) return res.status(400).json({ error: 'amount must be a positive number' });
    await store.ensureAccount(uid);
    const balance = await store.adjustBalance(uid, asset, amount.toString());
    res.json({ uid, asset, balance, balances: await store.getBalances(uid) });
  }));

  // All users, with balances and activity counts (newest first).
  router.get('/admin/users', asyncHandler(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const accounts = await store.listAccounts();
    const users = [];
    for (const a of accounts) {
      users.push({
        uid: a.uid,
        created_at: a.created_at,
        telegram_id: tgIdOf(a.uid),
        telegram: tradeEvents.getProfile(a.uid),
        balances: await store.getBalances(a.uid),
        open_positions: (await store.getOpenPositions(a.uid)).length,
        trades: await store.countTrades(a.uid),
      });
    }
    res.json({ users });
  }));

  // Totals for the admin dashboard.
  router.get('/admin/overview', asyncHandler(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const accounts = await store.listAccounts();
    let totalUsdt = D(0);
    for (const a of accounts) {
      const balances = await store.getBalances(a.uid);
      if (balances.USDT) totalUsdt = totalUsdt.plus(D(balances.USDT));
    }
    const openPositions = await store.listOpenPositions();
    let totalTrades = 0;
    for (const a of accounts) totalTrades += await store.countTrades(a.uid);
    res.json({
      users: accounts.length,
      total_usdt_balances: totalUsdt.toString(),
      open_positions: openPositions.length,
      total_trades: totalTrades,
    });
  }));

  // All open positions across users, with live mark price and unrealized
  // PnL — the admin's live view of who holds what. Trade reports
  // themselves go to the admin as Telegram messages (src/bot.js), not here.
  router.get('/admin/positions', asyncHandler(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const open = await store.listOpenPositions();
    const positions = open.map((p) => {
      const mark = prices.getPrice(p.symbol);
      const pnl = mark ? unrealizedPnl(p, mark) : null;
      return {
        ...p,
        user: tradeEvents.userLabel(p.uid),
        user_name: tradeEvents.userDisplayName(p.uid),
        telegram_id: tgIdOf(p.uid),
        mark_price: mark,
        unrealized_pnl: pnl ? pnl.toString() : null,
      };
    });
    res.json({ positions });
  }));

  return router;
}

module.exports = { createRouter, ASSETS };
