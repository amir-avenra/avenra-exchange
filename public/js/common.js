// Shared helpers: UID identity, API client, formatting, toast.
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];
const ASSETS = ['USDT', 'BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
const BASE_OF = { BTCUSDT: 'BTC', ETHUSDT: 'ETH', BNBUSDT: 'BNB', SOLUSDT: 'SOL', XRPUSDT: 'XRP' };

function getUid() {
  let uid = localStorage.getItem('ex_uid');
  if (!/^\d{8}$/.test(uid || '')) {
    uid = String(Math.floor(10000000 + Math.random() * 90000000));
    localStorage.setItem('ex_uid', uid);
  }
  return uid;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
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
