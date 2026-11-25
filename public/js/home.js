// Home + Profile views (KCEX-style main page) + view switching.
// Home: total asset value, today's realized PnL, trending pairs (tap one
// to open it in the Trade view). Profile: the user's Telegram identity,
// balances and activity. The Trade view's chart is created lazily the
// first time it is shown (TradeApp.ensureChart), so Home can be the
// landing view without a zero-width chart.
(function () {
  function el(id) { return document.getElementById(id); }

  function renderIdentity(account) {
    const u = (account && account.tg_user) || {};
    const letter = ((u.first_name || u.username || 'T') + '').slice(0, 1).toUpperCase();
    const av = el('profile-avatar');
    if (av) av.textContent = letter;
    const big = el('profile-avatar-big');
    if (big) big.textContent = letter;
  }

  async function loadHome() {
    try {
      const [account, pricesData, positions] = await Promise.all([
        api('/api/account'),
        api('/api/prices'),
        api('/api/futures/positions'),
      ]);
      renderIdentity(account);
      const prices = pricesData.prices || {};
      let total = Number((account.balances || {}).USDT || 0);
      for (const [asset, amount] of Object.entries(account.balances || {})) {
        if (asset === 'USDT') continue;
        const p = Number(prices[asset + 'USDT'] || 0);
        if (p) total += Number(amount) * p;
      }
      el('home-total-value').textContent = fmtUsd(total);
      const today = new Date().toDateString();
      let pnl = 0;
      for (const p of positions.closed || []) {
        if (p.closed_at && new Date(p.closed_at).toDateString() === today) pnl += Number(p.realized_pnl || 0);
      }
      const pnlEl = el('home-today-pnl');
      pnlEl.textContent = `${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}`;
      pnlEl.className = pnl >= 0 ? 'up' : 'down';
      const rows = await api(`/api/market/ticker24?symbols=${encodeURIComponent(JSON.stringify(SYMBOLS))}`);
      const bySym = {};
      for (const r of rows) bySym[r.symbol] = r;
      el('home-trending').innerHTML = SYMBOLS.map((sym) => {
        const base = BASE_OF[sym];
        const price = Number(prices[sym] || 0);
        const rawChg = bySym[sym] ? Number(bySym[sym].priceChangePercent) : NaN;
        const chg = Number.isFinite(rawChg) ? rawChg : null;
        return `<button class="trend-row" data-symbol="${sym}">
          <img class="coin-icon" src="/img/${base.toLowerCase()}.svg" alt="${base}">
          <span class="trend-sym">${base}<small>/USDT</small></span>
          <span class="trend-price">${price ? fmtPrice(sym, price) : '—'}</span>
          <span class="trend-chg ${chg != null && chg < 0 ? 'down' : 'up'}">${chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '—'}</span>
        </button>`;
      }).join('');
      el('home-trending').querySelectorAll('.trend-row').forEach((row) => {
        row.addEventListener('click', () => {
          if (window.TradeApp) window.TradeApp.setSymbol(row.dataset.symbol);
          showView('trade');
        });
      });
    } catch (err) {
      const v = el('home-total-value');
      if (v) v.textContent = '—';
    }
  }

  async function loadProfile() {
    try {
      const [account, positions] = await Promise.all([
        api('/api/account'),
        api('/api/futures/positions'),
      ]);
      renderIdentity(account);
      const u = account.tg_user || {};
      el('profile-name').textContent = u.username ? '@' + u.username : (u.first_name || 'Trader');
      el('profile-tgid').textContent = u.id ? String(u.id) : '—';
      el('profile-created').textContent = account.created_at ? new Date(account.created_at).toLocaleDateString() : '—';
      const rows = Object.entries(account.balances || {})
        .map(([asset, amount]) => `<div class="kv"><span>${asset}</span><b>${fmtNum(amount, asset === 'USDT' ? 2 : 6)}</b></div>`)
        .join('');
      el('profile-balances').innerHTML = rows || '<p class="empty">No balances yet.</p>';
      el('profile-stats').innerHTML =
        `<div class="stat-card"><span class="stat-label">Open positions</span><b class="stat-value">${(positions.open || []).length}</b></div>` +
        `<div class="stat-card"><span class="stat-label">Closed positions</span><b class="stat-value">${(positions.closed || []).length}</b></div>`;
    } catch (err) {
      const n = el('profile-name');
      if (n) n.textContent = err.message;
    }
  }

  // Switch between Home / Trade / Profile / Admin. Trade accepts a mode
  // ('spot' | 'futures') from the bottom nav. A mode-less open (trending
  // tap, admin close) keeps the current Trade mode instead of resetting it.
  function showView(name, mode) {
    const adminView = el('admin-view');
    if (adminView && !adminView.classList.contains('hidden') && window.AdminPanel) {
      window.AdminPanel.close();
    }
    ['home-view', 'trade-view', 'profile-view', 'admin-view'].forEach((id) => {
      const n = document.getElementById(id);
      if (n) n.classList.toggle('hidden', id !== name + '-view');
    });
    let navMode = mode;
    if (name === 'trade' && !navMode && window.TradeApp && window.TradeApp.getMode) {
      navMode = window.TradeApp.getMode();
    }
    document.querySelectorAll('.bn-item').forEach((b) => b.classList.remove('active'));
    // The Trade view has TWO nav items (Spot / Futures): highlight the one
    // matching the mode. The old selector always took the first
    // [data-view="trade"] (Spot), so Futures never looked selected.
    const sel = name === 'trade' && navMode
      ? `.bn-item[data-view="trade"][data-mode="${navMode}"]`
      : `.bn-item[data-view="${name}"]`;
    const nav = document.querySelector(sel);
    if (nav) nav.classList.add('active');
    if (name === 'trade') {
      if (window.TradeApp) {
        window.TradeApp.ensureChart();
        if (navMode) window.TradeApp.setMode(navMode);
      }
    }
    if (name === 'home') loadHome();
    if (name === 'profile') loadProfile();
  }
  window.showView = showView;

  function init() {
    document.querySelectorAll('.bn-item[data-view]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        showView(b.dataset.view, b.dataset.mode || undefined);
      });
    });
    const avatar = el('profile-avatar');
    if (avatar) avatar.addEventListener('click', () => showView('profile'));
    const tgid = el('profile-tgid');
    if (tgid) {
      tgid.addEventListener('click', () => {
        const v = tgid.textContent.trim();
        if (v && v !== '—' && navigator.clipboard) {
          navigator.clipboard.writeText(v).then(() => toast('Telegram ID copied')).catch(() => {});
        }
      });
    }
    // ?mode=spot|futures (e.g. from the Wallet page) opens the Trade view.
    const params = new URLSearchParams(location.search);
    const mode = params.get('mode');
    if (mode === 'spot' || mode === 'futures') showView('trade', mode);
    else showView('home');
    // Keep Home fresh while it is visible.
    setInterval(() => {
      const home = el('home-view');
      if (home && !home.classList.contains('hidden')) loadHome();
    }, 15000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
