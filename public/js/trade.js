// Trading page: live chart (Binance), order book, recent trades,
// spot market/limit, futures with leverage, open orders, history.
(function () {
  const BINANCE_REST = ['https://api.binance.com', 'https://data-api.binance.vision'];
  const BINANCE_WS = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision'];

  const state = {
    symbol: 'BTCUSDT',
    interval: '1m',
    klines: [], // {time, open, high, low, close, volume}
    lastPrice: null,
    balances: {},
    serverPrices: {},
    spotSide: 'buy',
    spotType: 'market',
    futSide: 'long',
    leverage: 10,
    ws: null,
    wsHostIdx: 0,
    wsReconnectTimer: null,
  };

  // ---------- Binance helpers (REST with host fallback) ----------
  async function binanceRest(path) {
    let lastErr = null;
    for (const host of BINANCE_REST) {
      try {
        const res = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        return await res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Binance unreachable');
  }

  // ---------- indicators ----------
  function sma(values, period) {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      if (i < period - 1) continue;
      let sum = 0;
      for (let j = 0; j < period; j++) sum += values[i - j];
      out.push(sum / period);
    }
    return out;
  }
  function ema(values, period) {
    const k = 2 / (period + 1);
    const out = [];
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      prev = prev === null ? values[i] : values[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }
  function macd(values) {
    const e12 = ema(values, 12);
    const e26 = ema(values, 26);
    const dif = values.map((_, i) => e12[i] - e26[i]);
    const dea = ema(dif, 9);
    const hist = dif.map((v, i) => (v - dea[i]) * 2);
    return { dif, dea, hist };
  }

  // ---------- chart ----------
  let chart, candleSeries, volumeSeries, ma5Series, ma10Series, ma30Series;
  let macdChart, macdHist, macdDif, macdDea;

  function initChart() {
    const el = document.getElementById('chart');
    chart = LightweightCharts.createChart(el, {
      width: el.clientWidth,
      height: 420,
      layout: { background: { color: '#12161c' }, textColor: '#d1d4dc', fontSize: 12 },
      grid: { vertLines: { color: 'rgba(42,46,57,0.5)' }, horzLines: { color: 'rgba(42,46,57,0.5)' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#2a2e39' },
      rightPriceScale: { borderColor: '#2a2e39' },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });
    candleSeries = chart.addCandlestickSeries({
      upColor: '#0ecb81', downColor: '#f6465d',
      wickUpColor: '#0ecb81', wickDownColor: '#f6465d', borderVisible: false,
    });
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.18 } });
    volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    ma5Series = chart.addLineSeries({ color: '#f0b90b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    ma10Series = chart.addLineSeries({ color: '#2962ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    ma30Series = chart.addLineSeries({ color: '#e040fb', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

    const macdEl = document.getElementById('macd-chart');
    macdChart = LightweightCharts.createChart(macdEl, {
      width: macdEl.clientWidth,
      height: 130,
      layout: { background: { color: '#12161c' }, textColor: '#d1d4dc', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(42,46,57,0.5)' }, horzLines: { color: 'rgba(42,46,57,0.5)' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#2a2e39' },
      rightPriceScale: { borderColor: '#2a2e39' },
    });
    macdHist = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    macdDif = macdChart.addLineSeries({ color: '#2962ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    macdDea = macdChart.addLineSeries({ color: '#f0b90b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

    // Keep both charts in sync when scrolling/zooming the main one.
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) macdChart.timeScale().setVisibleLogicalRange(range);
    });

    new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth });
      macdChart.applyOptions({ width: macdEl.clientWidth });
    }).observe(el);
  }

  function setMaSeries(series, closes, period) {
    const values = sma(closes, period);
    const data = values.map((v, i) => ({ time: state.klines[i + period - 1].time, value: v }));
    series.setData(data);
  }

  function refreshIndicators() {
    if (!state.klines.length) return;
    const closes = state.klines.map((k) => k.close);
    setMaSeries(ma5Series, closes, 5);
    setMaSeries(ma10Series, closes, 10);
    setMaSeries(ma30Series, closes, 30);
    const { dif, dea, hist } = macd(closes);
    const times = state.klines.map((k) => k.time);
    macdHist.setData(hist.map((v, i) => ({ time: times[i], value: v, color: v >= 0 ? '#0ecb81' : '#f6465d' })));
    macdDif.setData(dif.map((v, i) => ({ time: times[i], value: v })));
    macdDea.setData(dea.map((v, i) => ({ time: times[i], value: v })));
  }

  async function loadKlines() {
    try {
      const raw = await binanceRest(`/api/v3/klines?symbol=${state.symbol}&interval=${state.interval}&limit=300`);
      state.klines = raw.map((k) => ({
        time: Math.floor(k[0] / 1000),
        open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
        volume: Number(k[5]),
      }));
      candleSeries.setData(state.klines);
      volumeSeries.setData(state.klines.map((k) => ({
        time: k.time, value: k.volume, color: k.close >= k.open ? 'rgba(14,203,129,0.5)' : 'rgba(246,70,93,0.5)',
      })));
      refreshIndicators();
      const last = state.klines[state.klines.length - 1];
      if (last) updateLastPrice(last.close);
    } catch (err) {
      toast('Chart data unavailable: ' + err.message, 'err');
    }
  }

  // ---------- websocket (combined stream, with host fallback) ----------
  function connectWs() {
    if (state.ws) { state.ws.close(); state.ws = null; }
    clearTimeout(state.wsReconnectTimer);
    const sym = state.symbol.toLowerCase();
    const streams = `${sym}@kline_${state.interval}/${sym}@depth20@100ms/${sym}@trade`;
    const host = BINANCE_WS[state.wsHostIdx % BINANCE_WS.length];
    const ws = new WebSocket(`${host}/stream?streams=${streams}`);
    state.ws = ws;

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const { stream, data } = msg;
      if (!stream || !data) return;
      if (stream.endsWith('@trade')) onTrade(data);
      else if (stream.includes('@depth')) onDepth(data);
      else if (stream.includes('@kline')) onKline(data.k);
    };
    ws.onclose = () => {
      state.wsReconnectTimer = setTimeout(() => {
        state.wsHostIdx += 1; // try the other host next time
        connectWs();
      }, 3000);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  function onKline(k) {
    const candle = {
      time: Math.floor(k.t / 1000),
      open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c),
      volume: Number(k.v),
    };
    const last = state.klines[state.klines.length - 1];
    if (last && last.time === candle.time) {
      state.klines[state.klines.length - 1] = candle;
    } else if (!last || candle.time > last.time) {
      state.klines.push(candle);
      if (state.klines.length > 400) state.klines.shift();
    } else {
      return;
    }
    candleSeries.update(candle);
    volumeSeries.update({ time: candle.time, value: candle.volume, color: candle.close >= candle.open ? 'rgba(14,203,129,0.5)' : 'rgba(246,70,93,0.5)' });
    refreshIndicators();
    updateLastPrice(candle.close);
  }

  function updateLastPrice(price) {
    state.lastPrice = price;
    const el = document.getElementById('last-price');
    if (el) el.textContent = fmtPrice(state.symbol, price);
    updateSpotPreview();
    updateFuturesPreview();
  }

  // ---------- order book ----------
  let lastBookRender = 0;
  function onDepth(data) {
    const now = Date.now();
    if (now - lastBookRender < 250) return; // throttle DOM updates
    lastBookRender = now;
    const asks = (data.a || []).slice(0, 12).reverse();
    const bids = (data.b || []).slice(0, 12);
    const asksEl = document.getElementById('asks');
    const bidsEl = document.getElementById('bids');
    asksEl.innerHTML = asks.map(([p, q]) => bookRow(p, q)).join('');
    bidsEl.innerHTML = bids.map(([p, q]) => bookRow(p, q)).join('');
    const bestAsk = Number((data.a || [])[0]?.[0] || 0);
    const bestBid = Number((data.b || [])[0]?.[0] || 0);
    const mid = document.getElementById('book-mid');
    if (bestAsk && bestBid) {
      const midPrice = (bestAsk + bestBid) / 2;
      mid.textContent = `${fmtPrice(state.symbol, midPrice)}  ·  Spread ${fmtPrice(state.symbol, bestAsk - bestBid)}`;
      mid.className = 'book-mid ' + (midPrice >= (state.lastPrice || midPrice) ? 'num-up' : 'num-down');
    }
  }
  function bookRow(price, qty) {
    return `<div class="book-row"><span>${fmtPrice(state.symbol, price)}</span><span>${fmtNum(qty, 4)}</span><span>${fmtUsd(Number(price) * Number(qty))}</span></div>`;
  }

  // ---------- recent trades ----------
  const feed = [];
  async function loadRecentTrades() {
    try {
      const raw = await binanceRest(`/api/v3/aggTrades?symbol=${state.symbol}&limit=30`);
      feed.length = 0;
      for (const t of raw.reverse()) {
        feed.push({ price: Number(t.p), qty: Number(t.q), time: t.T, sell: t.m });
      }
      renderFeed();
    } catch { /* feed is non-critical */ }
  }
  function onTrade(t) {
    feed.unshift({ price: Number(t.p), qty: Number(t.q), time: t.T, sell: t.m });
    if (feed.length > 30) feed.pop();
    renderFeed();
  }
  function renderFeed() {
    const el = document.getElementById('trade-feed');
    if (!el) return;
    el.innerHTML = feed.map((t) => {
      const cls = t.sell ? 'num-down' : 'num-up';
      const time = new Date(t.time).toLocaleTimeString('en-GB');
      return `<div class="book-row"><span class="${cls}">${fmtPrice(state.symbol, t.price)}</span><span>${fmtNum(t.qty, 4)}</span><span>${time}</span></div>`;
    }).join('');
  }

  // ---------- balances / account ----------
  async function refreshBalances() {
    try {
      const data = await api(`/api/account?uid=${getUid()}`);
      state.balances = data.balances;
      renderBalances();
    } catch (err) {
      toast(err.message, 'err');
    }
  }
  window.refreshBalances = refreshBalances;

  async function refreshServerPrices() {
    try {
      const data = await api('/api/prices');
      state.serverPrices = data.prices;
      renderBalances();
    } catch { /* ignore */ }
  }

  function assetValue(asset, amount) {
    if (asset === 'USDT') return Number(amount);
    const price = Number(state.serverPrices[asset + 'USDT'] || 0);
    return Number(amount) * price;
  }

  function renderBalances() {
    let total = 0;
    for (const [asset, amount] of Object.entries(state.balances)) total += assetValue(asset, amount);
    const totalEl = document.getElementById('total-balance-value');
    if (totalEl) totalEl.textContent = fmtUsd(total);
    const uidEl = document.getElementById('uid-value');
    if (uidEl) uidEl.textContent = getUid();
    updateSpotPreview();
    updateFuturesPreview();
  }

  // ---------- symbol tabs / timeframe ----------
  async function refreshTabPrices() {
    try {
      const rows = await binanceRest(`/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(SYMBOLS))}`);
      for (const row of rows) {
        const tab = document.querySelector(`.symbol-tab[data-symbol="${row.symbol}"] .p`);
        if (!tab) continue;
        const change = Number(row.priceChangePercent);
        tab.textContent = `${fmtPrice(row.symbol, row.lastPrice)} (${change >= 0 ? '+' : ''}${change.toFixed(2)}%)`;
        tab.className = 'p ' + (change >= 0 ? 'up' : 'down');
      }
    } catch { /* non-critical */ }
  }

  function setSymbol(symbol) {
    if (state.symbol === symbol) return;
    state.symbol = symbol;
    document.querySelectorAll('.symbol-tab').forEach((el) => el.classList.toggle('active', el.dataset.symbol === symbol));
    document.getElementById('spot-base').textContent = BASE_OF[symbol];
    document.getElementById('fut-base').textContent = BASE_OF[symbol];
    loadKlines();
    loadRecentTrades();
    connectWs();
    refreshOrders();
    refreshTrades();
  }

  function setIntervalTf(interval) {
    if (state.interval === interval) return;
    state.interval = interval;
    document.querySelectorAll('.tf-btn').forEach((el) => el.classList.toggle('active', el.dataset.tf === interval));
    loadKlines();
    connectWs();
  }

  // ---------- spot form ----------
  function updateSpotPreview() {
    const base = BASE_OF[state.symbol];
    const availUsdt = Number(state.balances.USDT || 0);
    const availBase = Number(state.balances[base] || 0);
    const availEl = document.getElementById('spot-available');
    if (availEl) {
      availEl.textContent = state.spotSide === 'buy'
        ? `Available: ${fmtNum(availUsdt, 2)} USDT`
        : `Available: ${fmtNum(availBase)} ${base}`;
    }
    const qty = Number(document.getElementById('spot-qty').value || 0);
    const limitPrice = Number(document.getElementById('spot-price').value || 0);
    const price = state.spotType === 'limit' ? limitPrice : (state.lastPrice || 0);
    const total = qty * price;
    const fee = total * 0.001;
    const totalEl = document.getElementById('spot-total');
    if (totalEl) totalEl.textContent = price ? `${fmtUsd(total)}  ·  Fee ${fmtUsd(fee)}` : '—';
    const btn = document.getElementById('spot-submit');
    if (btn) {
      btn.textContent = state.spotSide === 'buy' ? `Buy ${base}` : `Sell ${base}`;
      btn.className = 'submit ' + state.spotSide;
    }
  }

  function setSpotSide(side) {
    state.spotSide = side;
    document.getElementById('spot-buy-btn').classList.toggle('buy-on', side === 'buy');
    document.getElementById('spot-sell-btn').classList.toggle('sell-on', side === 'sell');
    updateSpotPreview();
  }
  function setSpotType(type) {
    state.spotType = type;
    document.getElementById('spot-market-btn').classList.toggle('type-on', type === 'market');
    document.getElementById('spot-limit-btn').classList.toggle('type-on', type === 'limit');
    document.getElementById('spot-price').disabled = type === 'market';
    updateSpotPreview();
  }

  async function submitSpot() {
    const qty = document.getElementById('spot-qty').value.trim();
    const price = document.getElementById('spot-price').value.trim();
    if (!qty || Number(qty) <= 0) return toast('Enter a quantity', 'err');
    if (state.spotType === 'limit' && (!price || Number(price) <= 0)) return toast('Enter a limit price', 'err');
    const btn = document.getElementById('spot-submit');
    btn.disabled = true;
    try {
      const data = await api('/api/spot/order', {
        method: 'POST',
        body: JSON.stringify({ uid: getUid(), symbol: state.symbol, side: state.spotSide, type: state.spotType, qty, price: state.spotType === 'limit' ? price : undefined }),
      });
      toast(data.filled ? `Order filled @ ${fmtPrice(state.symbol, data.trade.price)}` : 'Limit order placed');
      document.getElementById('spot-qty').value = '';
      await refreshBalances();
      await refreshOrders();
      await refreshTrades();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- futures form ----------
  function liqPreview(side, entry, leverage) {
    const e = Number(entry);
    if (!e || !leverage) return null;
    return side === 'long' ? e * (1 - 1 / leverage + 0.005) : e * (1 + 1 / leverage - 0.005);
  }

  function updateFuturesPreview() {
    const base = BASE_OF[state.symbol];
    const qty = Number(document.getElementById('fut-qty').value || 0);
    const mark = state.lastPrice || 0;
    const margin = mark && qty ? (qty * mark) / state.leverage : 0;
    const liq = liqPreview(state.futSide, mark, state.leverage);
    const availEl = document.getElementById('fut-available');
    if (availEl) availEl.textContent = `Available: ${fmtNum(Number(state.balances.USDT || 0), 2)} USDT`;
    const marginEl = document.getElementById('fut-margin');
    if (marginEl) marginEl.textContent = margin ? fmtUsd(margin) : '—';
    const liqEl = document.getElementById('fut-liq');
    if (liqEl) liqEl.textContent = liq ? fmtPrice(state.symbol, liq) : '—';
    const entryEl = document.getElementById('fut-entry');
    if (entryEl) entryEl.textContent = mark ? fmtPrice(state.symbol, mark) : '—';
    const btn = document.getElementById('fut-submit');
    if (btn) {
      btn.textContent = state.futSide === 'long' ? `Open Long ${base}` : `Open Short ${base}`;
      btn.className = 'submit ' + state.futSide;
    }
  }

  function setFutSide(side) {
    state.futSide = side;
    document.getElementById('fut-long-btn').classList.toggle('long-on', side === 'long');
    document.getElementById('fut-short-btn').classList.toggle('short-on', side === 'short');
    updateFuturesPreview();
  }
  function setLeverage(lev) {
    state.leverage = lev;
    document.querySelectorAll('.lev-btn').forEach((el) => el.classList.toggle('type-on', Number(el.dataset.lev) === lev));
    document.getElementById('fut-lev-range').value = lev;
    document.getElementById('fut-lev-label').textContent = lev + 'x';
    updateFuturesPreview();
  }

  async function submitFutures() {
    const qty = document.getElementById('fut-qty').value.trim();
    if (!qty || Number(qty) <= 0) return toast('Enter a quantity', 'err');
    const btn = document.getElementById('fut-submit');
    btn.disabled = true;
    try {
      const data = await api('/api/futures/open', {
        method: 'POST',
        body: JSON.stringify({ uid: getUid(), symbol: state.symbol, side: state.futSide, leverage: state.leverage, qty }),
      });
      toast(`Position opened @ ${fmtPrice(state.symbol, data.position.entry_price)}`);
      document.getElementById('fut-qty').value = '';
      await refreshBalances();
      await refreshPositions();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- tables ----------
  async function refreshOrders() {
    try {
      const data = await api(`/api/spot/orders?uid=${getUid()}&symbol=${state.symbol}`);
      const el = document.getElementById('open-orders-body');
      if (!data.orders.length) {
        el.innerHTML = `<tr><td colspan="6" class="empty">No open orders</td></tr>`;
        return;
      }
      el.innerHTML = data.orders.map((o) => `<tr>
        <td>${o.symbol}</td>
        <td class="${o.side === 'buy' ? 'num-up' : 'num-down'}">${o.side.toUpperCase()}</td>
        <td>${o.type}</td>
        <td>${o.price ? fmtPrice(o.symbol, o.price) : 'Market'}</td>
        <td>${fmtQty(o.symbol, o.qty)}</td>
        <td><button class="mini-btn" data-cancel="${o.id}">Cancel</button></td>
      </tr>`).join('');
      el.querySelectorAll('[data-cancel]').forEach((btn) => btn.addEventListener('click', async () => {
        try {
          await api('/api/spot/cancel', { method: 'POST', body: JSON.stringify({ uid: getUid(), orderId: Number(btn.dataset.cancel) }) });
          toast('Order cancelled');
          await refreshBalances();
          await refreshOrders();
        } catch (err) { toast(err.message, 'err'); }
      }));
    } catch (err) { /* ignore transient */ }
  }

  async function refreshPositions() {
    try {
      const data = await api(`/api/futures/positions?uid=${getUid()}`);
      const el = document.getElementById('positions-body');
      const rows = [];
      for (const p of data.open) {
        const pnl = Number(p.unrealized_pnl || 0);
        const roe = Number(p.roe || 0);
        rows.push(`<tr>
          <td>${p.symbol}</td>
          <td class="${p.side === 'long' ? 'num-up' : 'num-down'}">${p.side.toUpperCase()} ${p.leverage}x</td>
          <td>${fmtPrice(p.symbol, p.entry_price)}</td>
          <td>${p.mark_price ? fmtPrice(p.symbol, p.mark_price) : '—'}</td>
          <td>${fmtPrice(p.symbol, p.liquidation_price)}</td>
          <td>${fmtQty(p.symbol, p.qty)}</td>
          <td class="${pnl >= 0 ? 'num-up' : 'num-down'}">${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)} (${roe >= 0 ? '+' : ''}${roe.toFixed(2)}%)</td>
          <td><button class="mini-btn" data-close-pos="${p.id}">Close</button></td>
        </tr>`);
      }
      for (const p of data.closed) {
        const pnl = Number(p.realized_pnl || 0);
        rows.push(`<tr>
          <td>${p.symbol}</td>
          <td>${p.side.toUpperCase()} ${p.leverage}x</td>
          <td>${fmtPrice(p.symbol, p.entry_price)}</td>
          <td>—</td>
          <td>${fmtPrice(p.symbol, p.liquidation_price)}</td>
          <td>${fmtQty(p.symbol, p.qty)}</td>
          <td class="${pnl >= 0 ? 'num-up' : 'num-down'}">${p.status === 'liquidated' ? 'LIQ ' : ''}${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}</td>
          <td>${p.status}</td>
        </tr>`);
      }
      el.innerHTML = rows.length ? rows.join('') : `<tr><td colspan="8" class="empty">No positions yet</td></tr>`;
      el.querySelectorAll('[data-close-pos]').forEach((btn) => btn.addEventListener('click', async () => {
        try {
          const data2 = await api('/api/futures/close', { method: 'POST', body: JSON.stringify({ uid: getUid(), positionId: Number(btn.dataset.closePos) }) });
          toast(`Closed. Realized PnL ${fmtUsd(data2.realized_pnl)}`);
          await refreshBalances();
          await refreshPositions();
        } catch (err) { toast(err.message, 'err'); }
      }));
    } catch { /* ignore transient */ }
  }

  async function refreshTrades() {
    try {
      const data = await api(`/api/trades?uid=${getUid()}&symbol=${state.symbol}&limit=20`);
      const el = document.getElementById('trade-history-body');
      if (!data.trades.length) {
        el.innerHTML = `<tr><td colspan="5" class="empty">No trades yet</td></tr>`;
        return;
      }
      el.innerHTML = data.trades.map((t) => `<tr>
        <td>${new Date(t.created_at).toLocaleTimeString('en-GB')}</td>
        <td class="${t.side === 'buy' ? 'num-up' : 'num-down'}">${t.side.toUpperCase()}</td>
        <td>${fmtPrice(t.symbol, t.price)}</td>
        <td>${fmtQty(t.symbol, t.qty)}</td>
        <td>${fmtUsd(t.fee)}</td>
      </tr>`).join('');
    } catch { /* ignore transient */ }
  }

  // ---------- init ----------
  function init() {
    initChart();
    document.getElementById('spot-base').textContent = BASE_OF[state.symbol];
    document.getElementById('fut-base').textContent = BASE_OF[state.symbol];

    document.querySelectorAll('.symbol-tab').forEach((el) => el.addEventListener('click', () => setSymbol(el.dataset.symbol)));
    document.querySelectorAll('.tf-btn').forEach((el) => el.addEventListener('click', () => setIntervalTf(el.dataset.tf)));
    document.getElementById('macd-toggle').addEventListener('change', (e) => {
      document.getElementById('macd-chart').classList.toggle('hidden', !e.target.checked);
    });

    document.getElementById('spot-buy-btn').addEventListener('click', () => setSpotSide('buy'));
    document.getElementById('spot-sell-btn').addEventListener('click', () => setSpotSide('sell'));
    document.getElementById('spot-market-btn').addEventListener('click', () => setSpotType('market'));
    document.getElementById('spot-limit-btn').addEventListener('click', () => setSpotType('limit'));
    document.getElementById('spot-qty').addEventListener('input', updateSpotPreview);
    document.getElementById('spot-price').addEventListener('input', updateSpotPreview);
    document.getElementById('spot-submit').addEventListener('click', submitSpot);
    document.querySelectorAll('[data-pct]').forEach((btn) => btn.addEventListener('click', () => {
      const pct = Number(btn.dataset.pct) / 100;
      const base = BASE_OF[state.symbol];
      const price = state.spotType === 'limit'
        ? Number(document.getElementById('spot-price').value || 0)
        : (state.lastPrice || 0);
      if (!price) return;
      const qty = state.spotSide === 'buy'
        ? (Number(state.balances.USDT || 0) * pct) / price
        : Number(state.balances[base] || 0) * pct;
      document.getElementById('spot-qty').value = qty > 0 ? qty.toFixed(6) : '';
      updateSpotPreview();
    }));

    document.getElementById('fut-long-btn').addEventListener('click', () => setFutSide('long'));
    document.getElementById('fut-short-btn').addEventListener('click', () => setFutSide('short'));
    document.querySelectorAll('.lev-btn').forEach((el) => el.addEventListener('click', () => setLeverage(Number(el.dataset.lev))));
    document.getElementById('fut-lev-range').addEventListener('input', (e) => setLeverage(Number(e.target.value)));
    document.getElementById('fut-qty').addEventListener('input', updateFuturesPreview);
    document.getElementById('fut-submit').addEventListener('click', submitFutures);

    document.getElementById('uid-value').textContent = getUid();
    document.getElementById('uid-chip').addEventListener('click', () => {
      navigator.clipboard?.writeText(getUid());
      toast('UID copied: ' + getUid());
    });

    loadKlines();
    loadRecentTrades();
    connectWs();
    refreshBalances();
    refreshServerPrices();
    refreshTabPrices();
    refreshOrders();
    refreshPositions();
    refreshTrades();

    setInterval(refreshServerPrices, 2000);
    setInterval(refreshPositions, 2000);
    setInterval(refreshTabPrices, 10000);
    setInterval(() => { refreshOrders(); refreshTrades(); }, 5000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
