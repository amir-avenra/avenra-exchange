// In-memory store implementing the same async interface as the Postgres store.
// Used ONLY when DATABASE_URL is not set (local smoke tests). It is NOT a
// production store: all data is lost on restart.
const { D } = require('./money');

function createMemoryStore() {
  const accounts = new Map(); // uid -> { uid, created_at }
  const balances = new Map(); // uid -> Map(asset -> Decimal-string)
  const orders = new Map(); // id -> order
  const trades = []; // array, newest last
  const positions = new Map(); // id -> position
  let orderSeq = 1;
  let tradeSeq = 1;
  let positionSeq = 1;

  const now = () => new Date().toISOString();

  function balMap(uid) {
    if (!balances.has(uid)) balances.set(uid, new Map());
    return balances.get(uid);
  }

  return {
    mode: 'memory',
    async init() { /* nothing to do */ },

    async ensureAccount(uid) {
      if (!accounts.has(uid)) accounts.set(uid, { uid, created_at: now() });
      return accounts.get(uid);
    },

    async getAccount(uid) {
      return accounts.get(uid) || null;
    },

    async getBalances(uid) {
      const out = {};
      for (const [asset, amount] of balMap(uid)) out[asset] = amount;
      return out;
    },

    // delta is a decimal string, may be negative. Throws if result < 0.
    async adjustBalance(uid, asset, delta) {
      const m = balMap(uid);
      const cur = D(m.get(asset) || '0');
      const next = cur.plus(D(delta));
      if (next.isNegative()) {
        throw new Error(`Insufficient ${asset} balance`);
      }
      m.set(asset, next.toString());
      return next.toString();
    },

    async setBalance(uid, asset, amount) {
      balMap(uid).set(asset, D(amount).toString());
      return D(amount).toString();
    },

    async createSpotOrder(o) {
      const id = orderSeq++;
      const order = {
        id,
        uid: o.uid,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        price: o.price ?? null,
        qty: o.qty,
        filled_qty: '0',
        status: 'open',
        locked_asset: o.locked_asset ?? null,
        locked_amount: o.locked_amount ?? null,
        created_at: now(),
        updated_at: now(),
      };
      orders.set(id, order);
      return { ...order };
    },

    async getSpotOrder(id) {
      const o = orders.get(Number(id));
      return o ? { ...o } : null;
    },

    async getOpenSpotOrders(uid, symbol) {
      return [...orders.values()]
        .filter((o) => o.status === 'open' && (!uid || o.uid === uid) && (!symbol || o.symbol === symbol))
        .sort((a, b) => b.id - a.id)
        .map((o) => ({ ...o }));
    },

    async listOpenLimitOrders() {
      return [...orders.values()]
        .filter((o) => o.status === 'open' && o.type === 'limit')
        .sort((a, b) => a.id - b.id)
        .map((o) => ({ ...o }));
    },

    async updateSpotOrder(id, patch) {
      const o = orders.get(Number(id));
      if (!o) return null;
      Object.assign(o, patch, { updated_at: now() });
      return { ...o };
    },

    async recordTrade(t) {
      const id = tradeSeq++;
      const trade = { id, ...t, created_at: now() };
      trades.push(trade);
      return { ...trade };
    },

    async getTrades(uid, symbol, limit = 50) {
      return trades
        .filter((t) => (!uid || t.uid === uid) && (!symbol || t.symbol === symbol))
        .slice(-limit)
        .reverse()
        .map((t) => ({ ...t }));
    },

    async createPosition(p) {
      const id = positionSeq++;
      const pos = {
        id,
        uid: p.uid,
        symbol: p.symbol,
        side: p.side,
        leverage: p.leverage,
        entry_price: p.entry_price,
        qty: p.qty,
        margin: p.margin,
        liquidation_price: p.liquidation_price,
        status: 'open',
        realized_pnl: null,
        created_at: now(),
        closed_at: null,
      };
      positions.set(id, pos);
      return { ...pos };
    },

    async getPosition(id) {
      const p = positions.get(Number(id));
      return p ? { ...p } : null;
    },

    async getOpenPositions(uid) {
      return [...positions.values()]
        .filter((p) => p.status === 'open' && (!uid || p.uid === uid))
        .sort((a, b) => b.id - a.id)
        .map((p) => ({ ...p }));
    },

    async getClosedPositions(uid, limit = 20) {
      return [...positions.values()]
        .filter((p) => p.status !== 'open' && (!uid || p.uid === uid))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
        .map((p) => ({ ...p }));
    },

    async listOpenPositions() {
      return [...positions.values()]
        .filter((p) => p.status === 'open')
        .map((p) => ({ ...p }));
    },

    async updatePosition(id, patch) {
      const p = positions.get(Number(id));
      if (!p) return null;
      Object.assign(p, patch);
      return { ...p };
    },
  };
}

module.exports = createMemoryStore;
