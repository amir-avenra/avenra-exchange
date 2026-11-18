// Server-side price feed: polls Binance public REST ticker for the 5 pairs.
// No API keys. Used for market-order execution, limit-order matching,
// futures PnL and automatic liquidation. Falls back to Binance's public
// data mirror if the main host is unreachable.
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];
const HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];

const cache = {}; // symbol -> { price: string, ts: number }

function getPrice(symbol) {
  return cache[symbol] ? cache[symbol].price : null;
}

function getAll() {
  const out = {};
  for (const s of SYMBOLS) out[s] = cache[s] ? cache[s].price : null;
  return out;
}

async function fetchOnce(symbol) {
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}/api/v3/ticker/price?symbol=${symbol}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data.price) {
        cache[symbol] = { price: String(data.price), ts: Date.now() };
        return cache[symbol].price;
      }
    } catch (err) {
      // try next host
    }
  }
  return getPrice(symbol);
}

async function refresh() {
  const query = `symbols=${encodeURIComponent(JSON.stringify(SYMBOLS))}`;
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}/api/v3/ticker/price?${query}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data)) {
        for (const row of data) {
          if (row.symbol && row.price) cache[row.symbol] = { price: String(row.price), ts: Date.now() };
        }
        return true;
      }
    } catch (err) {
      // try next host
    }
  }
  return false;
}

function start(intervalMs = 2000) {
  refresh();
  setInterval(refresh, intervalMs);
}

module.exports = { SYMBOLS, HOSTS, getPrice, getAll, fetchOnce, refresh, start };
