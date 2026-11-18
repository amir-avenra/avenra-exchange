// AVENRA Exchange (simulated) — single-service server.
// Serves the static frontend from /public and the JSON API under /api.
// Postgres is the default store (DATABASE_URL). Without DATABASE_URL the
// server boots with an in-memory store for local smoke tests only.
const path = require('path');
const express = require('express');
const { getStore } = require('./src/db');
const prices = require('./src/prices');
const engine = require('./src/engine');
const { createRouter } = require('./src/routes');

const PORT = Number(process.env.PORT || 3000);

async function main() {
  const store = getStore();
  try {
    await store.init();
    console.log(`[db] store ready (mode: ${store.mode})`);
  } catch (err) {
    // Postgres configured but unreachable: fall back to memory so the
    // server still boots for testing. Loud warning, not silent.
    console.error('[db] Postgres init failed, falling back to in-memory store:', err.message);
    const mem = require('./src/store-memory')();
    await mem.init();
    global.__store = mem;
    startServer(mem);
    return;
  }
  startServer(store);
}

function startServer(store) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // Health endpoint for uptime monitors (UptimeRobot etc.).
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      db: store.mode,
      prices: prices.getAll(),
      uptime_seconds: Math.floor(process.uptime()),
      time: new Date().toISOString(),
    });
  });

  app.use('/api', createRouter(store, prices));

  // JSON error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[api error]', err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  });

  // Price feed + engine loop: refresh Binance prices, then match limit
  // orders and liquidate futures positions. Guarded against overlap.
  prices.start(2000);
  let engineRunning = false;
  setInterval(async () => {
    if (engineRunning) return;
    engineRunning = true;
    try {
      await prices.refresh();
      await engine.run(store, prices);
    } catch (err) {
      console.error('[engine]', err.message);
    } finally {
      engineRunning = false;
    }
  }, 2000);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT} (store: ${store.mode})`);
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
