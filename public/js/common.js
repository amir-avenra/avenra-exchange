// Shared helpers: API client, formatting, toast.
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];
const ASSETS = ['USDT', 'BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
const BASE_OF = { BTCUSDT: 'BTC', ETHUSDT: 'ETH', BNBUSDT: 'BNB', SOLUSDT: 'SOL', XRPUSDT: 'XRP' };

// Telegram Mini App identity: when the page runs inside Telegram,
// window.Telegram.WebApp.initData holds the signed user payload.
// It is sent on every API call so the server can verify the user.
function tgInitData() {
  try {
    const tg = window.Telegram && window.Telegram.WebApp;
    return (tg && tg.initData) || '';
  } catch {
    return '';
  }
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const initData = tgInitData();
  if (initData) headers['X-Telegram-Init-Data'] = initData;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Number formatting: trims trailing zeros, keeps it readable.
function fmtNum(value, maxDecimals = 8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: maxDecimals, minimumFractionDigits: 0 });
}
function fmtPrice(symbol, price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return '—';
  const decimals = symbol === 'XRPUSDT' ? 4 : 2;
  return p.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtQty(symbol, qty) {
  return fmtNum(qty, symbol === 'XRPUSDT' ? 2 : 6);
}

let toastTimer = null;
function toast(msg, kind = 'ok') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = kind;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
}
