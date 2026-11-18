// Store selector.
// Default (and production) path: Postgres via DATABASE_URL (Neon-compatible).
// If DATABASE_URL is missing, the server boots with an in-memory store so the
// app can be smoke-tested locally without Postgres — data is lost on restart
// and a loud warning is printed. Never rely on the memory store in production.
let store = null;

function getStore() {
  if (store) return store;
  const url = process.env.DATABASE_URL;
  if (url) {
    console.log('[db] Using Postgres store');
    store = require('./store-pg')(url);
  } else {
    console.warn('[db] WARNING: DATABASE_URL is not set — using IN-MEMORY store. Data will be lost on restart. Set DATABASE_URL to use Postgres.');
    store = require('./store-memory')();
  }
  return store;
}

module.exports = { getStore };
