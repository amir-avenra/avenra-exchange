// Postgres store (primary store). Amounts are NUMERIC in the DB and come back
// from `pg` as strings — never converted to JS floats.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { D } = require('./money');

function createPgStore(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });

  async function init() {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    await pool.query(schema);
  }

  // Runs fn(client) inside a transaction.
  async function withTx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    mode: 'postgres',
    init,

    async ensureAccount(uid) {
      const { rows } = await pool.query(
        'INSERT INTO accounts (uid) VALUES ($1) ON CONFLICT (uid) DO NOTHING RETURNING uid, created_at',
        [uid]
      );
      if (rows.length) return rows[0];
      const existing = await pool.query('SELECT uid, created_at FROM accounts WHERE uid = $1', [uid]);
      return existing.rows[0];
    },

    async getAccount(uid) {
      const { rows } = await pool.query('SELECT uid, created_at FROM accounts WHERE uid = $1', [uid]);
      return rows[0] || null;
    },

    async getBalances(uid) {
      const { rows } = await pool.query('SELECT asset, amount FROM balances WHERE uid = $1', [uid]);
      const out = {};
      for (const r of rows) out[r.asset] = r.amount;
      return out;
    },

    // delta is a decimal string, may be negative. Throws if result < 0.
    // Uses SELECT ... FOR UPDATE so concurrent adjustments can't overdraw.
    async adjustBalance(uid, asset, delta) {
      return withTx(async (client) => {
        const { rows } = await client.query(
          'SELECT amount FROM balances WHERE uid = $1 AND asset = $2 FOR UPDATE',
          [uid, asset]
        );
        const cur = D(rows.length ? rows[0].amount : '0');
        const next = cur.plus(D(delta));
        if (next.isNegative()) throw new Error(`Insufficient ${asset} balance`);
        if (rows.length) {
          await client.query('UPDATE balances SET amount = $3, updated_at = now() WHERE uid = $1 AND asset = $2', [
            uid, asset, next.toString(),
          ]);
        } else {
          await client.query('INSERT INTO balances (uid, asset, amount) VALUES ($1, $2, $3)', [
            uid, asset, next.toString(),
          ]);
        }
        return next.toString();
      });
    },

    async setBalance(uid, asset, amount) {
      await pool.query(
        `INSERT INTO balances (uid, asset, amount) VALUES ($1, $2, $3)
         ON CONFLICT (uid, asset) DO UPDATE SET amount = EXCLUDED.amount, updated_at = now()`,
        [uid, asset, D(amount).toString()]
      );
      return D(amount).toString();
    },

    async createSpotOrder(o) {
      const { rows } = await pool.query(
        `INSERT INTO spot_orders (uid, symbol, side, type, price, qty, locked_asset, locked_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [o.uid, o.symbol, o.side, o.type, o.price ?? null, o.qty, o.locked_asset ?? null, o.locked_amount ?? null]
      );
      return rows[0];
    },

    async getSpotOrder(id) {
      const { rows } = await pool.query('SELECT * FROM spot_orders WHERE id = $1', [id]);
      return rows[0] || null;
    },

    async getOpenSpotOrders(uid, symbol) {
      const params = [];
      let sql = "SELECT * FROM spot_orders WHERE status = 'open'";
      if (uid) { params.push(uid); sql += ` AND uid = $${params.length}`; }
      if (symbol) { params.push(symbol); sql += ` AND symbol = $${params.length}`; }
      sql += ' ORDER BY id DESC';
      const { rows } = await pool.query(sql, params);
      return rows;
    },

    async listOpenLimitOrders() {
      const { rows } = await pool.query(
        "SELECT * FROM spot_orders WHERE status = 'open' AND type = 'limit' ORDER BY id ASC"
      );
      return rows;
    },

    async updateSpotOrder(id, patch) {
      const sets = [];
      const params = [id];
      for (const [key, value] of Object.entries(patch)) {
        params.push(value);
        sets.push(`${key} = $${params.length}`);
      }
      sets.push('updated_at = now()');
      const { rows } = await pool.query(
        `UPDATE spot_orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        params
      );
      return rows[0] || null;
    },

    async recordTrade(t) {
      const { rows } = await pool.query(
        `INSERT INTO trades (uid, symbol, side, price, qty, fee, total)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [t.uid, t.symbol, t.side, t.price, t.qty, t.fee, t.total]
      );
      return rows[0];
    },

    async getTrades(uid, symbol, limit = 50) {
      const params = [];
      let sql = 'SELECT * FROM trades WHERE 1=1';
      if (uid) { params.push(uid); sql += ` AND uid = $${params.length}`; }
      if (symbol) { params.push(symbol); sql += ` AND symbol = $${params.length}`; }
      params.push(limit);
      sql += ` ORDER BY id DESC LIMIT $${params.length}`;
      const { rows } = await pool.query(sql, params);
      return rows;
    },

    async createPosition(p) {
      const { rows } = await pool.query(
        `INSERT INTO futures_positions (uid, symbol, side, leverage, entry_price, qty, margin, liquidation_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [p.uid, p.symbol, p.side, p.leverage, p.entry_price, p.qty, p.margin, p.liquidation_price]
      );
      return rows[0];
    },

    async getPosition(id) {
      const { rows } = await pool.query('SELECT * FROM futures_positions WHERE id = $1', [id]);
      return rows[0] || null;
    },

    async getOpenPositions(uid) {
      const params = [];
      let sql = "SELECT * FROM futures_positions WHERE status = 'open'";
      if (uid) { params.push(uid); sql += ` AND uid = $${params.length}`; }
      sql += ' ORDER BY id DESC';
      const { rows } = await pool.query(sql, params);
      return rows;
    },

    async getClosedPositions(uid, limit = 20) {
      const params = [];
      let sql = "SELECT * FROM futures_positions WHERE status <> 'open'";
      if (uid) { params.push(uid); sql += ` AND uid = $${params.length}`; }
      params.push(limit);
      sql += ` ORDER BY id DESC LIMIT $${params.length}`;
      const { rows } = await pool.query(sql, params);
      return rows;
    },

    async listOpenPositions() {
      const { rows } = await pool.query("SELECT * FROM futures_positions WHERE status = 'open'");
      return rows;
    },

    async updatePosition(id, patch) {
      const sets = [];
      const params = [id];
      for (const [key, value] of Object.entries(patch)) {
        params.push(value);
        sets.push(`${key} = $${params.length}`);
      }
      const { rows } = await pool.query(
        `UPDATE futures_positions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        params
      );
      return rows[0] || null;
    },
  };
}

module.exports = createPgStore;
