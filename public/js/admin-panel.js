// Separate admin panel (Telegram mini app). Enabled only when the server
// says the current user is an admin (is_admin in /api/account).
//
// Shows aligned overview stats, all users, the credit form, and the live
// open positions — each with its own live chart (candles + entry / liq /
// mark lines) so the admin sees exactly what each trader's position
// looks like right now.
//
// Trade reports are NOT shown here: every trade a user opens or closes
// is sent to the admin as a Telegram message the moment it happens
// (src/bot.js notifyTrade). The old in-app live trade feed is gone.
(function () {
  let posTimer = null;
  let usersTimer = null;
  let enabled = false;
  let pollCount = 0;
  const charts = new Map(); // position id -> { chart, series, entryLine, liqLine, markLine, symbol, klines }

  function el(id) { return document.getElementById(id); }

  function statCard(label, value) {
    return `<div class="stat-card"><span class="stat-label">${label}</span><b class="stat-value">${value}</b></div>`;
  }

  async function loadOverview() {
    try {
      const d = await api('/api/admin/overview');
      el('admin-stats').innerHTML =
        statCard('Users', d.users) +
        statCard('Total USDT balances', fmtUsd(Number(d.total_usdt_balances))) +
        statCard('Open positions', d.open_positions) +
        statCard('Total trades', d.total_trades);
    } catch (err) {
      el('admin-stats').innerHTML = `<p class="empty">${err.message}</p>`;
    }
  }

  async function loadUsers() {
    try {
      const d = await api('/api/admin/users');
      const body = el('admin-users-body');
      if (!d.users.length) {
        body.innerHTML = '<tr><td colspan="5" class="empty">No users yet.</td></tr>';
        return;
      }
      body.innerHTML = d.users.map((u) => {
        // Numeric Telegram id is the primary identifier; the name, when
        // known, is secondary. Legacy browser accounts show their UID.
        const idLabel = u.telegram_id ? String(u.telegram_id) : u.uid;
        const name = (u.telegram && u.telegram.username) ? '@' + u.telegram.username
          : (u.telegram && u.telegram.first_name) ? u.telegram.first_name : null;
        const usdt = fmtNum(Number(u.balances.USDT || '0'), 2);
        return `<tr><td><b>${idLabel}</b>${name ? `<br><span class="muted">${name}</span>` : ''}</td><td>${usdt}</td><td>${u.open_positions}</td><td>${u.trades}</td>` +
          `<td><button class="mini-btn neutral" data-credit-uid="${u.uid}">Credit</button></td></tr>`;
      }).join('');
      body.querySelectorAll('[data-credit-uid]').forEach((btn) => {
        btn.addEventListener('click', () => {
          el('admin-credit-uid').value = btn.getAttribute('data-credit-uid');
          el('admin-credit-amount').focus();
        });
      });
    } catch (err) {
      el('admin-users-body').innerHTML = `<tr><td colspan="5" class="empty">${err.message}</td></tr>`;
    }
  }

  async function credit() {
    let uid = el('admin-credit-uid').value.trim();
    // A bare numeric id is a Telegram id.
    if (/^\d+$/.test(uid)) uid = 'tg:' + uid;
    const asset = el('admin-credit-asset').value;
    const amount = el('admin-credit-amount').value.trim();
    const result = el('admin-credit-result');
    if (!uid) return toast('Enter an account UID', 'err');
    if (!amount || Number(amount) <= 0) return toast('Enter a positive amount', 'err');
    try {
      const data = await api('/api/admin/credit', {
        method: 'POST',
        body: JSON.stringify({ uid, asset, amount }),
      });
      result.textContent = `Credited ${fmtNum(amount)} ${asset} to ${uid}. New ${asset} balance: ${fmtNum(data.balance)}`;
      toast(`Credited ${fmtNum(amount)} ${asset} to ${uid}`);
      el('admin-credit-amount').value = '';
      await loadUsers();
      await loadOverview();
    } catch (err) {
      result.textContent = '';
      toast(err.message, 'err');
    }
  }

  // ---- live open positions (with a mini live chart each) ------------------
  function posCardHtml(p) {
    const pnl = Number(p.unrealized_pnl || 0);
    const sideCls = p.side === 'long' ? 'long' : 'short';
    const who = p.user_name ? `${p.user} <span class="muted">(${p.user_name})</span>` : p.user;
    return `<div class="pos-card" data-pos-id="${p.id}">
      <div class="pos-head">
        <div class="pos-who"><b>${who}</b></div>
        <span class="side-badge ${sideCls}">${p.side.toUpperCase()} ${p.leverage}x</span>
      </div>
      <div class="pos-sym">${p.symbol.replace('USDT', '/USDT')}</div>
      <div class="pos-nums">
        <div class="pos-num"><span>Entry</span><b>${fmtPrice(p.symbol, p.entry_price)}</b></div>
        <div class="pos-num"><span>Mark</span><b data-mark>${p.mark_price ? fmtPrice(p.symbol, p.mark_price) : '—'}</b></div>
        <div class="pos-num"><span>Liq. price</span><b class="liq">${fmtPrice(p.symbol, p.liquidation_price)}</b></div>
        <div class="pos-num"><span>Margin</span><b>${fmtUsd(Number(p.margin))}</b></div>
        <div class="pos-num"><span>Qty</span><b>${fmtQty(p.symbol, p.qty)}</b></div>
        <div class="pos-num"><span>uPnL</span><b data-pnl class="${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}</b></div>
      </div>
      <div class="mini-chart" id="pos-chart-${p.id}"></div>
    </div>`;
  }

  function priceLine(series, price, color, title) {
    return series.createPriceLine({
      price,
      color,
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title,
      crosshairMarkerVisible: false,
    });
  }

  async function loadKlinesFor(id, pos) {
    const host = el('pos-chart-' + id);
    if (!host || typeof LightweightCharts === 'undefined') return;
    let rec = charts.get(String(id));
    if (!rec) {
      const chart = LightweightCharts.createChart(host, {
        width: host.clientWidth || 320,
        height: 140,
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#848e9c', fontSize: 10 },
        grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
        timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: false },
      });
      const series = chart.addCandlestickSeries({
        upColor: '#0ecb81', downColor: '#f6465d',
        wickUpColor: '#0ecb81', wickDownColor: '#f6465d', borderVisible: false,
      });
      rec = { chart, series, entryLine: null, liqLine: null, markLine: null, symbol: pos.symbol, klines: [] };
      charts.set(String(id), rec);
    }
    try {
      const raw = await api(`/api/market/klines?symbol=${pos.symbol}&interval=15m&limit=100`);
      rec.klines = raw.map((k) => ({
        time: Math.floor(k[0] / 1000),
        open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
        volume: Number(k[5]),
      }));
      rec.series.setData(rec.klines);
      if (!rec.entryLine) {
        const sideColor = pos.side === 'long' ? '#0ecb81' : '#f6465d';
        rec.entryLine = priceLine(rec.series, Number(pos.entry_price), sideColor, 'Entry');
        rec.liqLine = priceLine(rec.series, Number(pos.liquidation_price), '#f0b90b', 'Liq');
      }
      updateMiniChart(String(id), pos);
    } catch (err) {
      console.warn('[admin chart]', pos.symbol, err.message);
    }
  }

  // Refresh the live mark line + last candle from the position poll data.
  function updateMiniChart(id, pos) {
    const rec = charts.get(String(id));
    if (!rec || !rec.klines.length) return;
    const mark = Number(pos.mark_price);
    if (!isFinite(mark) || mark <= 0) return;
    if (rec.markLine) rec.series.removePriceLine(rec.markLine);
    rec.markLine = priceLine(rec.series, mark, '#2962ff', 'Mark');
    const last = rec.klines[rec.klines.length - 1];
    last.close = mark;
    if (mark > last.high) last.high = mark;
    if (mark < last.low) last.low = mark;
    rec.series.update(last);
  }

  function destroyChart(id) {
    const rec = charts.get(String(id));
    if (rec) {
      try { rec.chart.remove(); } catch { /* already gone */ }
      charts.delete(String(id));
    }
  }

  async function loadPositions() {
    try {
      const d = await api('/api/admin/positions');
      pollCount++;
      const wrap = el('admin-positions');
      if (!d.positions.length) {
        wrap.innerHTML = '<p class="empty">No open positions.</p>';
        wrap.dataset.ids = '';
        for (const id of [...charts.keys()]) destroyChart(id);
        return;
      }
      const liveIds = new Set(d.positions.map((p) => String(p.id)));
      const ids = [...liveIds].sort().join(',');
      if (wrap.dataset.ids !== ids) {
        // The set of positions changed: rebuild the cards + charts.
        wrap.innerHTML = d.positions.map(posCardHtml).join('');
        wrap.dataset.ids = ids;
        for (const id of [...charts.keys()]) {
          if (!liveIds.has(id)) destroyChart(id);
        }
        for (const p of d.positions) await loadKlinesFor(p.id, p);
      } else {
        // Same positions: update the live numbers + mark lines in place.
        for (const p of d.positions) {
          const card = wrap.querySelector(`[data-pos-id="${p.id}"]`);
          if (card) {
            const markEl = card.querySelector('[data-mark]');
            if (markEl) markEl.textContent = p.mark_price ? fmtPrice(p.symbol, p.mark_price) : '—';
            const pnlEl = card.querySelector('[data-pnl]');
            if (pnlEl) {
              const pnl = Number(p.unrealized_pnl || 0);
              pnlEl.textContent = `${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}`;
              pnlEl.className = pnl >= 0 ? 'up' : 'down';
            }
          }
          updateMiniChart(String(p.id), p);
        }
        // Fresh candles every 12th poll (~60s).
        if (pollCount % 12 === 0) {
          for (const p of d.positions) await loadKlinesFor(p.id, p);
        }
      }
      for (const id of [...charts.keys()]) {
        if (!liveIds.has(id)) destroyChart(id);
      }
    } catch (err) {
      const wrap = el('admin-positions');
      if (wrap && !wrap.querySelector('.pos-card')) {
        wrap.innerHTML = `<p class="empty">${err.message}</p>`;
      }
    }
  }

  function open() {
    loadOverview();
    loadUsers();
    loadPositions();
    if (!posTimer) posTimer = setInterval(loadPositions, 5000);
    if (!usersTimer) usersTimer = setInterval(() => { loadUsers(); loadOverview(); }, 15000);
    // Views are owned by home.js: show the admin view through it so the
    // other views (and their timers) are handled in one place.
    if (window.showView) window.showView('admin');
    else {
      const main = document.querySelector('main');
      if (main) main.classList.add('show-admin');
      el('admin-view').classList.remove('hidden');
    }
    document.querySelectorAll('.bn-item').forEach((b) => b.classList.remove('active'));
    const nav = el('nav-admin');
    if (nav) nav.classList.add('active');
  }

  function close() {
    if (posTimer) { clearInterval(posTimer); posTimer = null; }
    if (usersTimer) { clearInterval(usersTimer); usersTimer = null; }
    // Hide first: showView('trade') calls close() again while the admin
    // view is still visible, so hiding here breaks that loop.
    el('admin-view').classList.add('hidden');
    const main = document.querySelector('main');
    if (main) main.classList.remove('show-admin');
    if (window.showView) window.showView('trade');
    else {
      document.querySelectorAll('.bn-item').forEach((b) => b.classList.remove('active'));
      const tradeNav = document.querySelector('.bn-item[data-view="trade"]');
      if (tradeNav) tradeNav.classList.add('active');
    }
  }

  function enable() {
    if (enabled) return;
    enabled = true;
    const nav = el('nav-admin');
    if (nav) nav.classList.remove('hidden');
    if (nav) nav.addEventListener('click', (e) => { e.preventDefault(); open(); });
    el('admin-credit-btn').addEventListener('click', credit);
    window.addEventListener('resize', () => {
      for (const [id, rec] of charts) {
        const host = el('pos-chart-' + id);
        if (host && host.clientWidth) rec.chart.applyOptions({ width: host.clientWidth });
      }
    });
  }

  window.AdminPanel = { enable, open, close };
})();
