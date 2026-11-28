// AVENRA Exchange (simulated) — single-service server.
// Serves the static frontend from /public and the JSON API under /api.
// Postgres is the default store (DATABASE_URL). Without DATABASE_URL the
// server boots with an in-memory store for local smoke tests only.
require('dotenv').config(); // Loads DATABASE_URL from a .env file when present (e.g. hosts with no env-var settings).
const path = require('path');
const express = require('express');
const { getStore } = require('./src/db');
const prices = require('./src/prices');
const engine = require('./src/engine');
const { createRouter } = require('./src/routes');
const { startBot } = require('./src/bot');

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);

// Cache-busting version: the git commit the server was deployed from, so a
// phone never runs stale JS after a `git pull` (Telegram's WebView caches
// aggressively). Falls back to the server start time when git is unavailable.
let APP_VERSION = String(Date.now());
try {
  APP_VERSION = require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf8', timeout: 5000 }).trim() || APP_VERSION;
} catch { /* keep the timestamp fallback */ }

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

  // Versioned app assets (?v=<commit>) are immutable: cache them hard.
  app.use((req, res, next) => {
    if (req.query.v && (req.path.startsWith('/js/') || req.path.startsWith('/css/'))) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    next();
  });

  // The HTML shells carry the version token: serve them fresh (revalidate
  // every open) with the current version injected, so the phone always
  // requests the current JS/CSS URLs after a deploy.
  const PUBLIC_DIR = path.join(__dirname, 'public');
  const fs = require('fs');
  app.get(['/', '/index.html', '/wallet.html'], (req, res, next) => {
    const file = req.path === '/wallet.html' ? 'wallet.html' : 'index.html';
    fs.readFile(path.join(PUBLIC_DIR, file), 'utf8', (err, html) => {
      if (err) return next(err);
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(html.split('__APP_VERSION__').join(APP_VERSION));
    });
  });

  app.use(express.static(PUBLIC_DIR));

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
    // Telegram bot: answers /start with the welcome message + mini-app button.
    // Long polling, no webhook needed; runs in the background and can never
    // crash the exchange (its errors are caught inside the loop).
    startBot();
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
