// Trading page: live chart (Binance), order book, recent trades,
// spot market/limit, futures with leverage, open orders, history.
// KCEX-style mobile layout: pair cards, Spot/Futures switch, book/trades tabs.
(function () {
  // All Binance market data goes through the server's /api/market/* proxy:
  // api.binance.com and the Binance websocket are blocked on some visitor
  // networks (e.g. Iranian IPs), while the server reaches Binance fine.
  // Live updates use REST polling as the primary path; the websocket below
  // is only a best-effort enhancement and must never break the page.
  const BINANCE_WS = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision'];

  const state = {
    symbol: 'BTCUSDT',
    interval: '15m',
    mode: 'spot',
    klines: [], // {time, open, high, low, close, volume}
    lastPrice: null,
    ticker24: {}, // symbol -> 24h change %
    balances: {},
    serverPrices: {},
    openPositions: [], // open futures positions for the current uid
    openValue: 0, // mark-to-market value of open positions: margin + uPnL
    recentTrades: [], // own filled trades (for B/S chart markers)
    spotSide: 'buy',
    spotType: 'market',
    futSide: 'long',
    leverage: 10,
    showMA: true,
    showVol: true,
    showMacd: true,
    psMode: 'linear', // price-scale mode: 'linear' (manual) or 'log'
    autoScale: true, // KCEX default: price axis refits to visible candles on zoom
    ws: null,
    wsHostIdx: 0,
    wsBackoff: 3000,
    wsReconnectTimer: null,
  };

  // ---------- market data (same-origin server proxy) ----------
  async function marketRest(path) {
    // 25s (must exceed the server's 20s proxy timeout): slow VPNs need
    // more than 8s for the bigger payloads (ticker24, 300 candles).
    const res = await fetch(path, { signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
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
  let markPriceLine = null; // dashed "Mark" line at the live price
  let macdChart, macdHist, macdDif, macdDea;

  function initChart() {
    // Never build the chart twice on the same element: the ?mode= startup
    // path calls this once via showView('trade') and once directly below,
    // and a second createChart on the same container leaves a blank chart
    // stacked over the live one (fullscreen's resize used to "fix" it by
    // repainting the top, empty canvas).
    if (chart) return;
    const el = document.getElementById('chart');
    if (typeof LightweightCharts === 'undefined') {
      // Chart library missing (e.g. CDN blocked): trading still works,
      // only the chart stays empty. Never let this kill the whole app.
      if (el) el.textContent = 'Chart unavailable';
      return;
    }
    try {
      initChartInner(el);
    } catch (err) {
      // A half-built chart (chart object exists, series missing) would
      // stay blank forever: ensureChart() would see `chart` set and never
      // retry, and loadKlines() would skip setData without a series.
      // Tear it all down so the next Trade open builds it fresh.
      console.error('chart init failed, will retry on next Trade open:', err);
      try { if (chart) chart.remove(); } catch {}
      try { if (macdChart) macdChart.remove(); } catch {}
      chart = null; candleSeries = null; volumeSeries = null;
      ma5Series = null; ma10Series = null; ma30Series = null;
      macdChart = null; macdHist = null; macdDif = null; macdDea = null;
    }
  }

  function initChartInner(el) {
    chart = LightweightCharts.createChart(el, {
      width: el.clientWidth,
      height: el.clientHeight || 320,
      layout: { background: { color: '#12161c' }, textColor: '#d1d4dc', fontSize: 12 },
      grid: { vertLines: { color: 'rgba(42,46,57,0.5)' }, horzLines: { color: 'rgba(42,46,57,0.5)' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#2a2e39', rightOffset: 5 },
      // Chart settings exactly like KCEX (TradingView chart): auto-scale ON
      // by default — zooming refits the price axis to the visible candles.
      // The Auto toggle freezes the axis (manual mode); Log/% switch the
      // scale mode. Vertical drag moves the whole chart up/down, pinch zooms.
      rightPriceScale: {
        borderColor: '#2a2e39',
        mode: state.psMode === 'log' ? LightweightCharts.PriceScaleMode.Logarithmic : state.psMode === 'percent' ? LightweightCharts.PriceScaleMode.Percentage : LightweightCharts.PriceScaleMode.Normal,
        autoScale: state.autoScale,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });
    window.__chart = chart; // debug handle (price-scale mode, overlays)
    candleSeries = chart.addCandlestickSeries({
      upColor: '#0ecb81', downColor: '#f6465d',
      wickUpColor: '#0ecb81', wickDownColor: '#f6465d', borderVisible: false,
      // No built-in last-price line/label: the Mark line below replaces it.
      priceLineVisible: false, lastValueVisible: false,
    });
    window.__candleSeries = candleSeries;
    // TradingView-style current-price line: a dashed line at the live mark
    // with a "Mark" axis label, always visible (even with no position open).
    // Grabbing the price axis turns auto-scale off (TradingView behaviour)
    // so the manual scale the user drags stays put.
    el.addEventListener('pointerdown', (e) => {
      if (!chart) return;
      const rect = el.getBoundingClientRect();
      const axisW = chart.priceScale('right').width() || 0;
      if (e.clientX >= rect.right - axisW) setAutoScale(false);
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
      width: macdEl.clientWidth || el.clientWidth,
      height: macdEl.clientHeight || 110,
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
      updatePositionBadge(); // entry line moved on screen: re-pin the badge
    });

    new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      if (!macdEl.classList.contains('hidden')) {
        macdChart.applyOptions({ width: macdEl.clientWidth, height: macdEl.clientHeight });
      }
    }).observe(el);
  }

  // Create the chart on first use. Home is the landing view, so the chart
  // container is hidden at startup and would init at zero width; when the
  // Trade view opens, build it (or re-fit it) and paint any data already
  // loaded by the background polling.
  function ensureChart() {
    if (!chart) {
      initChart();
      if (chart && candleSeries && state.klines.length) {
        paintKlines();
      }
    } else {
      const el = document.getElementById('chart');
      if (el) chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      // Self-heal: the chart exists but its series never got data (slow
      // connection raced the first paint, or an earlier init failed
      // partway). Repaint now instead of leaving a blank chart.
      if (candleSeries && state.klines.length && !seriesHasData()) {
        paintKlines();
        chart.timeScale().fitContent();
      }
    }
    // Deferred re-fit: in the Telegram WebView the layout can still be
    // settling when the view opens (fonts, viewport resize), so a chart
    // created at a stale size stays blank until something resizes it —
    // fullscreen used to be the only thing that did. Re-measure on the
    // next frame and repaint if the series is still empty.
    requestAnimationFrame(() => {
      const el = document.getElementById('chart');
      if (!chart || !el) return;
      if (document.getElementById('trade-view').classList.contains('hidden')) return;
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      if (candleSeries && state.klines.length && !seriesHasData()) {
        paintKlines();
        chart.timeScale().fitContent();
      }
    });
  }

  // While the Trade view is visible, keep the chart honest: if the series
  // ever ends up empty while candles are loaded (a failed first paint, a
  // stalled resize), repaint it here instead of waiting for the user to
  // notice a blank chart. Also re-apply the container size every tick so
  // a stale-size canvas can never stick.
  function chartWatchdog() {
    const view = document.getElementById('trade-view');
    if (!view || view.classList.contains('hidden')) return;
    const el = document.getElementById('chart');
    if (!chart || !el) return;
    chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    if (candleSeries && state.klines.length && !seriesHasData()) {
      paintKlines();
      chart.timeScale().fitContent();
    }
  }

  function seriesHasData() {
    try { return !!candleSeries.dataByIndex(0); } catch { return false; }
  }

  function paintKlines() {
    candleSeries.setData(state.klines);
    refreshIndicators();
    updateOhlc();
    refreshPositionOverlay();
    refreshTradeMarkers();
    fitPriceScale();
  }

  function setMaSeries(series, closes, period) {
    const values = sma(closes, period);
    const data = values.map((v, i) => ({ time: state.klines[i + period - 1].time, value: v }));
    series.setData(data);
  }

  function refreshIndicators() {
    if (!state.klines.length) return;
    if (!candleSeries) return;
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

  // OHLC legend under the indicator chips. Flex-wrap with nowrap items:
  // it wraps onto extra lines on narrow screens instead of overlapping.
  function updateOhlc() {
    const el = document.getElementById('ohlc');
    if (!el || !state.klines.length) return;
    const last = state.klines[state.klines.length - 1];
    const closes = state.klines.map((k) => k.close);
    const maVal = (period) => {
      const v = sma(closes, period);
      return v.length ? v[v.length - 1] : null;
    };
    const chg = last.open ? ((last.close - last.open) / last.open) * 100 : 0;
    const dateStr = new Date(last.time * 1000).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const ma5 = maVal(5), ma10 = maVal(10), ma30 = maVal(30);
    const chgCls = chg >= 0 ? 'num-up' : 'num-down';
    el.innerHTML =
      `<span class="oh-date">${dateStr}</span>` +
      `<span>O <b>${fmtPrice(state.symbol, last.open)}</b></span>` +
      `<span>H <b>${fmtPrice(state.symbol, last.high)}</b></span>` +
      `<span>L <b>${fmtPrice(state.symbol, last.low)}</b></span>` +
      `<span>C <b>${fmtPrice(state.symbol, last.close)}</b></span>` +
      `<span class="${chgCls}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>` +
      `<span>Vol <b>${fmtNum(last.volume, 2)}</b></span>` +
      (ma5 !== null ? `<span class="ma5">MA5 <b>${fmtPrice(state.symbol, ma5)}</b></span>` : '') +
      (ma10 !== null ? `<span class="ma10">MA10 <b>${fmtPrice(state.symbol, ma10)}</b></span>` : '') +
      (ma30 !== null ? `<span class="ma30">MA30 <b>${fmtPrice(state.symbol, ma30)}</b></span>` : '');
  }

  // ---------- price scale: KCEX-style settings ----------
  // KCEX default is auto-scale ON: zooming refits the price axis to the
  // visible candles. Turning Auto off freezes the axis (manual mode) — the
  // user then moves it by dragging the price axis. Lightweight-charts v4
  // has no public setVisibleRange on the price scale, so fitting is done
  // by briefly re-enabling autoScale (one frame recalculates the range
  // from the new data) and locking it again.
  function fitPriceScale() {
    if (!chart || state.autoScale) return; // auto-scale on: library fits by itself
    const ps = chart.priceScale('right');
    ps.applyOptions({ autoScale: true });
    setTimeout(() => { if (!state.autoScale) ps.applyOptions({ autoScale: false }); }, 50);
  }
  function keepPriceInRange(candle) {
    if (!chart || !state.klines.length || state.autoScale) return;
    const hi = Number(candle.high), lo = Number(candle.low);
    let dataLo = Infinity, dataHi = -Infinity;
    for (const k of state.klines) {
      dataLo = Math.min(dataLo, Number(k.low));
      dataHi = Math.max(dataHi, Number(k.high));
    }
    // New extreme beyond the fitted data range: re-fit so the price stays visible.
    if (hi > dataHi || lo < dataLo) fitPriceScale();
  }
  function setAutoScale(on) {
    state.autoScale = on;
    try { localStorage.setItem('ex_autoscale', on ? '1' : '0'); } catch {}
    if (chart) chart.priceScale('right').applyOptions({ autoScale: on });
    document.getElementById('ps-auto').classList.toggle('active', on);
  }
  function setPriceScaleMode(mode) {
    state.psMode = mode;
    try { localStorage.setItem('ex_psmode', mode); } catch {}
    if (chart) {
      const m = mode === 'log' ? LightweightCharts.PriceScaleMode.Logarithmic
        : mode === 'percent' ? LightweightCharts.PriceScaleMode.Percentage
        : LightweightCharts.PriceScaleMode.Normal;
      chart.priceScale('right').applyOptions({ mode: m });
      // Percentage mode forces autoScale on in the library.
      if (mode === 'percent' && !state.autoScale) setAutoScale(true);
    }
    document.getElementById('ps-lin').classList.toggle('active', mode === 'linear');
    document.getElementById('ps-log').classList.toggle('active', mode === 'log');
    document.getElementById('ps-pct').classList.toggle('active', mode === 'percent');
  }
  function resetChart() {
    if (!chart) return;
    if (candleSeries && state.klines.length && !seriesHasData()) paintKlines();
    chart.timeScale().resetTimeScale();
    fitPriceScale();
  }

  // ---------- position overlay on the chart (KCEX-style) ----------
  // Open futures position for the current pair, drawn on the chart:
  // dashed entry line (green long / red short) + dashed orange liquidation
  // line, a floating badge with live PnL + distance to entry pinned to the
  // entry line, and B/S markers on the candles where own trades filled.
  const INTERVAL_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
  let posEntryLine = null, posLiqLine = null, posKey = null;
  let lastMarkerKey = '';

  function currentPosition() {
    return (state.openPositions || []).find((p) => p.symbol === state.symbol) || null;
  }

  function clearPositionLines() {
    if (!candleSeries) return;
    if (posEntryLine) { try { candleSeries.removePriceLine(posEntryLine); } catch { /* ignore */ } posEntryLine = null; }
    if (posLiqLine) { try { candleSeries.removePriceLine(posLiqLine); } catch { /* ignore */ } posLiqLine = null; }
    posKey = null;
  }

  function refreshPositionOverlay() {
    const el = document.getElementById('pos-overlay');
    if (!candleSeries) return;
    const pos = currentPosition();
    if (!pos) {
      clearPositionLines();
      if (el) el.classList.add('hidden');
      return;
    }
    const key = `${pos.id}:${pos.symbol}:${pos.entry_price}:${pos.liquidation_price}`;
    if (key !== posKey) {
      clearPositionLines();
      const sideColor = pos.side === 'long' ? '#0ecb81' : '#f6465d';
      posEntryLine = candleSeries.createPriceLine({
        price: Number(pos.entry_price),
        color: sideColor,
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Entry',
        crosshairMarkerVisible: false,
      });
      posLiqLine = candleSeries.createPriceLine({
        price: Number(pos.liquidation_price),
        color: '#f0b90b',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Liq',
        crosshairMarkerVisible: false,
      });
      posKey = key;
    }
    updatePositionBadge();
  }

  // Mark line: dashed horizontal line at the live price with a "Mark"
  // axis label (TradingView's last-price line). Recreated on every tick
  // because price lines cannot change their price in place.
  function updateMarkLine() {
    if (!candleSeries || !state.lastPrice) return;
    if (markPriceLine) candleSeries.removePriceLine(markPriceLine);
    markPriceLine = candleSeries.createPriceLine({
      price: state.lastPrice,
      color: '#2962ff',
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Mark',
    });
  }

  // Liquidation edge label: when the liq price is outside the visible
  // range, its line and axis label are off-screen — pin a small pill to
  // the nearest chart edge (bottom if liq is below, top if above) so the
  // number is always visible next to where the line would be.
  function updateLiqEdge(pos, mark) {
    const pill = document.getElementById('liq-edge');
    if (!pill || !candleSeries) return;
    if (!pos || !mark) { pill.classList.add('hidden'); return; }
    const liq = Number(pos.liquidation_price);
    const y = candleSeries.priceToCoordinate(liq);
    const h = document.getElementById('chart').clientHeight || 320;
    // Treat the outer 12px as "off-screen": a line buried at the extreme
    // edge (behind the volume bars / cut-off axis label) is not visible.
    if (y !== null && y >= 12 && y <= h - 12) { pill.classList.add('hidden'); return; }
    pill.classList.remove('hidden');
    pill.textContent = `${liq < mark ? '▼' : '▲'} Liq ${fmtPrice(pos.symbol, liq)}`;
    // Pinned to the bottom/top edge of the MAIN chart (the panel also holds
    // the MACD pane below, so bottom is computed from the chart height).
    pill.style.top = liq < mark ? Math.max(0, h - 26) + 'px' : '4px';
  }

  // Live badge: PnL (USDT + ROE%) and distance from mark to entry.
  // Repositioned on every price tick and on chart scroll/zoom.
  function updatePositionBadge() {
    const el = document.getElementById('pos-overlay');
    if (!el || !candleSeries) return;
    const pos = currentPosition();
    const mark = state.lastPrice;
    updateLiqEdge(pos, mark);
    if (!pos || !mark) { el.classList.add('hidden'); return; }
    const entry = Number(pos.entry_price);
    const qty = Number(pos.qty);
    const margin = Number(pos.margin);
    const pnl = pos.side === 'long' ? (mark - entry) * qty : (entry - mark) * qty;
    const y = candleSeries.priceToCoordinate(entry);
    if (y === null) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.classList.toggle('down', pnl < 0);
    el.style.top = Math.max(0, y - 28) + 'px';
    // One compact line only: direction · USDT PnL. No ROE% and no Liq —
    // the liq price lives on the liq line / edge pill below.
    el.innerHTML =
      `<div class="po-pnl">${pos.side === 'long' ? 'LONG' : 'SHORT'} · ${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}</div>`;
  }

  // B/S markers: own filled trades, floored onto the current interval's
  // candle (buy = B below the bar, sell = S above the bar).
  function refreshTradeMarkers() {
    if (!candleSeries || !state.klines.length) return;
    const ivSec = INTERVAL_SECONDS[state.interval] || 900;
    const byCandle = new Map();
    for (const t of state.recentTrades || []) {
      const ts = Math.floor(new Date(t.created_at).getTime() / 1000);
      if (!Number.isFinite(ts)) continue;
      byCandle.set(Math.floor(ts / ivSec) * ivSec, t.side);
    }
    const markers = [...byCandle.entries()].sort((a, b) => a[0] - b[0]).map(([time, side]) => ({
      time,
      position: side === 'buy' ? 'belowBar' : 'aboveBar',
      color: side === 'buy' ? '#0ecb81' : '#f6465d',
      shape: side === 'buy' ? 'arrowUp' : 'arrowDown',
      text: side === 'buy' ? 'B' : 'S',
    }));
    const key = JSON.stringify(markers);
    if (key !== lastMarkerKey) {
      lastMarkerKey = key;
      candleSeries.setMarkers(markers);
    }
  }

  async function loadKlines() {
    // Retry: on a slow VPN one timeout must not leave the chart empty
    // until the next symbol/interval change. Guard against applying a
    // stale response after the user switched symbol/interval mid-retry.
    const sym = state.symbol, iv = state.interval;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await marketRest(`/api/market/klines?symbol=${sym}&interval=${iv}&limit=300`);
        if (state.symbol !== sym || state.interval !== iv) return;
        state.klines = raw.map((k) => ({
          time: Math.floor(k[0] / 1000),
          open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
          volume: Number(k[5]),
        }));
        if (candleSeries) {
          candleSeries.setData(state.klines);
          volumeSeries.setData(state.klines.map((k) => ({
            time: k.time, value: k.volume, color: k.close >= k.open ? 'rgba(14,203,129,0.5)' : 'rgba(246,70,93,0.5)',
          })));
        }
        refreshIndicators();
        updateOhlc();
        const last = state.klines[state.klines.length - 1];
        if (last) updateLastPrice(last.close);
        updateMarkLine();
        refreshPositionOverlay();
        refreshTradeMarkers();
        fitPriceScale(); // lock the price range for this symbol/interval
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    toast('Chart data unavailable: ' + lastErr.message, 'err');
  }

  // ---------- websocket (best-effort only; polling is the primary path) ----------
  function connectWs() {
    if (state.ws) { try { state.ws.close(); } catch { /* ignore */ } state.ws = null; }
    clearTimeout(state.wsReconnectTimer);
    const sym = state.symbol.toLowerCase();
    const streams = `${sym}@kline_${state.interval}/${sym}@depth20@100ms/${sym}@trade`;
    const host = BINANCE_WS[state.wsHostIdx % BINANCE_WS.length];
    let ws;
    try {
      ws = new WebSocket(`${host}/stream?streams=${streams}`);
    } catch {
      scheduleWsReconnect();
      return;
    }
    state.ws = ws;

    ws.onopen = () => { state.wsBackoff = 3000; };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const { stream, data } = msg;
      if (!stream || !data) return;
      if (stream.endsWith('@trade')) onTrade(data);
      else if (stream.includes('@depth')) onDepth(data);
      else if (stream.includes('@kline')) onKline(data.k);
    };
    ws.onclose = () => { scheduleWsReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  // Reconnect with backoff (3s -> 30s cap) so a blocked websocket fails
  // quietly in the background instead of hammering reconnects.
  function scheduleWsReconnect() {
    clearTimeout(state.wsReconnectTimer);
    const delay = Math.min(state.wsBackoff || 3000, 30000);
    state.wsBackoff = delay * 2;
    state.wsReconnectTimer = setTimeout(() => {
      state.wsHostIdx += 1; // try the other host next time
      connectWs();
    }, delay);
  }

  function onKline(k) {
    updateCandle({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });
  }

  // Apply one candle (from the websocket or from the polling fallback).
  function updateCandle(k) {
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
    if (candleSeries) {
      candleSeries.update(candle);
      volumeSeries.update({ time: candle.time, value: candle.volume, color: candle.close >= candle.open ? 'rgba(14,203,129,0.5)' : 'rgba(246,70,93,0.5)' });
      keepPriceInRange(candle); // live price left the locked range: expand just enough
    }
    refreshIndicators();
    updateOhlc();
    updateLastPrice(candle.close);
    updateMarkLine(); // after updateLastPrice: the mark line uses the fresh price
  }

  function updateLastPrice(price) {
    state.lastPrice = price;
    renderPairHeader();
    updateSpotPreview();
    updateFuturesPreview();
    updatePositionBadge();
  }

  // ---------- order book ----------
  // The book used to rewrite its whole DOM on every poll (2s) and every
  // live depth tick: rows vanished and reappeared under the user's scroll,
  // and a thin book (fewer than 12 levels) shrank the panel so the page
  // jumped. Now each side always renders exactly BOOK_ROWS rows (missing
  // levels are padded with empty rows, so the panel height never changes)
  // and the DOM is only touched when the built HTML actually changed.
  // A failed poll never clears the book either: pollMarket's catch skips
  // the render, so the last good levels stay on screen until the next
  // successful poll (the server answers 502 while Binance is unreachable,
  // so a bad payload can never reach renderBook as an empty book).
  const BOOK_ROWS = 12;
  let lastBookRender = 0;
  function onDepth(data) {
    // Websocket depth payload: { b: [[price, qty], ...], a: [...] }.
    renderBook(data.b || [], data.a || []);
  }
  // Cumulative totals from the spread outward (KCEX-style): the row
  // nearest the mid sums only itself; each row further out adds every row
  // between it and the spread. `nearestFirst` says whether rows[0] is the
  // row nearest the spread.
  function cumulativeTotals(rows, nearestFirst) {
    const totals = new Array(rows.length);
    let sum = 0;
    if (nearestFirst) {
      for (let i = 0; i < rows.length; i++) { sum += Number(rows[i][0]) * Number(rows[i][1]); totals[i] = sum; }
    } else {
      for (let i = rows.length - 1; i >= 0; i--) { sum += Number(rows[i][0]) * Number(rows[i][1]); totals[i] = sum; }
    }
    return totals;
  }
  function bookRowsHtml(rows, totals) {
    let html = rows.map(([p, q], i) => bookRow(p, q, totals ? totals[i] : undefined)).join('');
    for (let i = rows.length; i < BOOK_ROWS; i++) {
      html += '<div class="book-row"><span></span><span></span><span></span></div>';
    }
    return html;
  }
  // Shared renderer for both shapes: websocket {b, a} and REST {bids, asks}.
  function renderBook(bids, asks) {
    const now = Date.now();
    if (now - lastBookRender < 250) return; // throttle DOM updates
    lastBookRender = now;
    // Explicit sort — never trust the feed's order: asks ascending, bids
    // descending, so the best price on each side sits next to the mid line.
    const asksSorted = [...(asks || [])].sort((a, b) => Number(a[0]) - Number(b[0]));
    const bidsSorted = [...(bids || [])].sort((a, b) => Number(b[0]) - Number(a[0]));
    const asksTop = asksSorted.slice(0, BOOK_ROWS).reverse(); // display: farthest -> nearest
    const bidsTop = bidsSorted.slice(0, BOOK_ROWS); // display: nearest -> farthest
    const asksEl = document.getElementById('asks');
    const bidsEl = document.getElementById('bids');
    const asksHtml = bookRowsHtml(asksTop, cumulativeTotals(asksTop, false));
    const bidsHtml = bookRowsHtml(bidsTop, cumulativeTotals(bidsTop, true));
    if (asksEl.innerHTML !== asksHtml) asksEl.innerHTML = asksHtml;
    if (bidsEl.innerHTML !== bidsHtml) bidsEl.innerHTML = bidsHtml;
    const bestAsk = Number((asksSorted || [])[0]?.[0] || 0);
    const bestBid = Number((bidsSorted || [])[0]?.[0] || 0);
    const mid = document.getElementById('book-mid');
    if (bestAsk && bestBid) {
      // No spread is charged anywhere (orders execute at the mark price);
      // the mid price is shown alone so it never reads as a cost.
      const midPrice = (bestAsk + bestBid) / 2;
      mid.textContent = fmtPrice(state.symbol, midPrice);
      mid.className = 'book-mid ' + (midPrice >= (state.lastPrice || midPrice) ? 'num-up' : 'num-down');
    }
  }
  function bookRow(price, qty, total) {
    const t = total == null ? Number(price) * Number(qty) : total;
    return `<div class="book-row"><span>${fmtPrice(state.symbol, price)}</span><span>${fmtNum(qty, 4)}</span><span>${fmtUsd(t)}</span></div>`;
  }

  // ---------- recent trades ----------
  // Same stability rule as the book: the feed used to rewrite its whole
  // DOM on every live trade (several times a second), so rows flickered
  // under a scroll. It now renders a fixed FEED_ROWS rows (padded), only
  // touches the DOM when the content changed, and live-trade renders are
  // throttled to 500ms (the 2s poll still refreshes it).
  const FEED_ROWS = 30;
  const feed = [];
  let lastFeedRender = 0;
  async function loadRecentTrades() {
    try {
      const raw = await marketRest(`/api/market/aggTrades?symbol=${state.symbol}&limit=30`);
      feed.length = 0;
      for (const t of raw.reverse()) {
        feed.push({ price: Number(t.p), qty: Number(t.q), time: t.T, sell: t.m });
      }
      renderFeed();
    } catch { /* feed is non-critical */ }
  }
  function onTrade(t) {
    feed.unshift({ price: Number(t.p), qty: Number(t.q), time: t.T, sell: t.m });
    if (feed.length > FEED_ROWS) feed.pop();
    const now = Date.now();
    if (now - lastFeedRender >= 500) {
      lastFeedRender = now;
      renderFeed();
    }
  }
  function renderFeed() {
    const el = document.getElementById('trade-feed');
    if (!el) return;
    let html = feed.map((t) => {
      const cls = t.sell ? 'num-down' : 'num-up';
      const time = new Date(t.time).toLocaleTimeString('en-GB');
      return `<div class="book-row"><span class="${cls}">${fmtPrice(state.symbol, t.price)}</span><span>${fmtNum(t.qty, 4)}</span><span>${time}</span></div>`;
    }).join('');
    for (let i = feed.length; i < FEED_ROWS; i++) {
      html += '<div class="book-row"><span></span><span></span><span></span></div>';
    }
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  // ---------- live updates via REST polling (primary path) ----------
  // The Binance websocket is blocked on some visitor networks, so the page
  // polls the server proxy every 2s for the book, the latest candle and
  // recent trades. The websocket (when it connects) only adds finer updates.
  async function pollMarket() {
    const sym = state.symbol;
    try {
      const depth = await marketRest(`/api/market/depth?symbol=${sym}&limit=20`);
      renderBook(depth.bids || [], depth.asks || []);
    } catch { /* non-critical: retried next tick */ }
    try {
      const kl = await marketRest(`/api/market/klines?symbol=${sym}&interval=${state.interval}&limit=2`);
      if (Array.isArray(kl) && kl.length) {
        const k = kl[kl.length - 1];
        updateCandle({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] });
      }
    } catch { /* non-critical */ }
    try {
      await loadRecentTrades();
    } catch { /* non-critical */ }
  }

  // ---------- balances / account ----------
  async function refreshBalances() {
    try {
      const data = await api('/api/account');
      state.balances = data.balances;
      renderBalances();
      // Admins get the separate Admin panel (Telegram mini app).
      if (data.is_admin && window.AdminPanel) window.AdminPanel.enable();
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
    // Total balance = wallet balances at mark + the mark-to-market value
    // of open positions (locked margin + unrealized PnL). The margin was
    // debited from USDT when the position opened, so without this the
    // total understates the account while a trade is open.
    let total = state.openValue || 0;
    for (const [asset, amount] of Object.entries(state.balances)) total += assetValue(asset, amount);
    const totalEl = document.getElementById('total-balance-value');
    if (totalEl) totalEl.textContent = fmtNum(total, 2);
    updateSpotPreview();
    updateFuturesPreview();
  }

  // ---------- pair cards / pair header ----------
  function renderPairHeader() {
    const sym = state.symbol;
    const symEl = document.getElementById('pair-symbol');
    if (symEl) symEl.textContent = sym.replace('USDT', '/USDT');
    const iconEl = document.getElementById('pair-icon');
    if (iconEl) iconEl.src = '/img/' + BASE_OF[sym].toLowerCase() + '.svg';
    const priceEl = document.getElementById('pair-price');
    if (priceEl) priceEl.textContent = state.lastPrice ? fmtPrice(sym, state.lastPrice) : '—';
    const chEl = document.getElementById('pair-change');
    const chg = state.ticker24[sym];
    if (chEl) {
      if (chg === undefined || chg === null) {
        chEl.textContent = '—';
        chEl.className = 'ph-change';
      } else {
        chEl.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% (24h)`;
        chEl.className = 'ph-change ' + (chg >= 0 ? 'num-up' : 'num-down');
      }
    }
  }

  async function refreshTabPrices() {
    try {
      const rows = await marketRest(`/api/market/ticker24?symbols=${encodeURIComponent(JSON.stringify(SYMBOLS))}`);
      for (const row of rows) {
        const change = Number(row.priceChangePercent);
        state.ticker24[row.symbol] = change;
        const card = document.querySelector(`.pair-card[data-symbol="${row.symbol}"]`);
        if (!card) continue;
        const priceEl = card.querySelector('.pc-price');
        const chEl = card.querySelector('.pc-change');
        if (priceEl) priceEl.textContent = fmtPrice(row.symbol, row.lastPrice);
        if (chEl) {
          chEl.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
          chEl.className = 'pc-change ' + (change >= 0 ? 'up' : 'down');
        }
      }
      renderPairHeader();
    } catch { /* non-critical */ }
  }

  function setSymbol(symbol) {
    if (state.symbol === symbol) return;
    state.symbol = symbol;
    document.querySelectorAll('.pair-card').forEach((el) => el.classList.toggle('active', el.dataset.symbol === symbol));
    document.getElementById('spot-base').textContent = BASE_OF[symbol];
    document.getElementById('fut-base').textContent = BASE_OF[symbol];
    renderPairHeader();
    loadKlines();
    loadRecentTrades();
    connectWs();
    pollMarket();
    refreshOrders();
    refreshTrades();
  }

  function setIntervalTf(interval) {
    if (state.interval === interval) return;
    state.interval = interval;
    document.querySelectorAll('.tf-btn').forEach((el) => el.classList.toggle('active', el.dataset.tf === interval));
    loadKlines();
    connectWs();
    pollMarket();
  }

  // ---------- Spot / Futures switch + book tabs + indicator chips ----------
  function setMode(mode) {
    state.mode = mode;
    document.getElementById('spot-panel').classList.toggle('hidden', mode !== 'spot');
    document.getElementById('futures-panel').classList.toggle('hidden', mode !== 'futures');
    // Keep the bottom nav in sync: the bottom keys are now the ONLY
    // Spot/Futures switch (the in-view tabs were removed — two switches
    // controlling one mode kept confusing the nav highlight).
    document.querySelectorAll('.bn-item[data-view="trade"]').forEach((el) => el.classList.toggle('active', el.dataset.mode === mode));
  }

  function setBookTab(tab) {
    document.querySelectorAll('.tab-btn').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
    document.getElementById('tab-book').classList.toggle('hidden', tab !== 'book');
    document.getElementById('tab-trades').classList.toggle('hidden', tab !== 'trades');
  }

  function setMaVisible(v) {
    state.showMA = v;
    [ma5Series, ma10Series, ma30Series].forEach((s) => { if (s) s.applyOptions({ visible: v }); });
    document.getElementById('ma-chip').classList.toggle('active', v);
  }
  function setVolVisible(v) {
    state.showVol = v;
    if (volumeSeries) volumeSeries.applyOptions({ visible: v });
    document.getElementById('vol-chip').classList.toggle('active', v);
  }
  function setMacdVisible(v) {
    state.showMacd = v;
    const el = document.getElementById('macd-chart');
    el.classList.toggle('hidden', !v);
    document.getElementById('macd-chip').classList.toggle('active', v);
    if (v && macdChart) requestAnimationFrame(() => macdChart.applyOptions({ width: el.clientWidth, height: el.clientHeight }));
  }

  // ---------- chart fullscreen ----------
  function toggleFullscreen() {
    const panel = document.querySelector('.chart-panel');
    if (!panel) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    if (panel.classList.contains('fs-fallback')) {
      panel.classList.remove('fs-fallback');
      return;
    }
    if (panel.requestFullscreen) {
      panel.requestFullscreen().catch(() => panel.classList.add('fs-fallback'));
    } else {
      panel.classList.add('fs-fallback');
    }
  }
  function exitFullscreen() {
    const panel = document.querySelector('.chart-panel');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (panel) panel.classList.remove('fs-fallback');
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
    const fee = 0; // KCEX spot fee is 0%
    const totalEl = document.getElementById('spot-total');
    if (totalEl) totalEl.textContent = price ? `${fmtUsd(total)}  ·  Fee ${fmtUsd(fee)}` : '—';
    const btn = document.getElementById('spot-submit');
    if (btn) {
      btn.textContent = state.spotSide === 'buy' ? `Buy ${base}` : `Sell ${base}`;
      btn.className = 'submit ' + state.spotSide;
    }
  }

  // USDT amount <-> quantity, two-way sync (spot): qty = amount / price.
  let spotSyncing = false;
  function spotPriceNow() {
    return state.spotType === 'limit'
      ? Number(document.getElementById('spot-price').value || 0)
      : (state.lastPrice || 0);
  }
  function syncSpotFromUsdt() {
    if (spotSyncing) return; spotSyncing = true;
    const amount = Number(document.getElementById('spot-usdt').value || 0);
    const price = spotPriceNow();
    const qtyEl = document.getElementById('spot-qty');
    if (price && amount > 0) qtyEl.value = (amount / price).toFixed(6);
    else if (!amount) qtyEl.value = '';
    updateSpotPreview();
    spotSyncing = false;
  }
  function syncSpotFromQty() {
    if (spotSyncing) return; spotSyncing = true;
    const qty = Number(document.getElementById('spot-qty').value || 0);
    const price = spotPriceNow();
    const usdtEl = document.getElementById('spot-usdt');
    if (price && qty > 0) usdtEl.value = (qty * price).toFixed(2);
    else if (!qty) usdtEl.value = '';
    updateSpotPreview();
    spotSyncing = false;
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
    syncSpotFromQty(); // price basis changed: USDT amount follows the qty
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
        body: JSON.stringify({ symbol: state.symbol, side: state.spotSide, type: state.spotType, qty, price: state.spotType === 'limit' ? price : undefined }),
      });
      toast(data.filled ? `Order filled @ ${fmtPrice(state.symbol, data.trade.price)}` : 'Limit order placed');
      document.getElementById('spot-qty').value = '';
      document.getElementById('spot-usdt').value = '';
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
    const feeEl = document.getElementById('fut-fee');
    if (feeEl) feeEl.textContent = (mark && qty) ? fmtUsd(qty * mark * 0.0001) : '—'; // KCEX taker 0.01%
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

  // USDT amount (margin) <-> quantity, two-way sync (futures):
  // qty = amount * leverage / mark; amount = qty * mark / leverage.
  let futSyncing = false;
  function syncFutFromUsdt() {
    if (futSyncing) return; futSyncing = true;
    const amount = Number(document.getElementById('fut-usdt').value || 0);
    const mark = state.lastPrice || 0;
    const qtyEl = document.getElementById('fut-qty');
    if (mark && amount > 0) qtyEl.value = ((amount * state.leverage) / mark).toFixed(6);
    else if (!amount) qtyEl.value = '';
    updateFuturesPreview();
    futSyncing = false;
  }
  function syncFutFromQty() {
    if (futSyncing) return; futSyncing = true;
    const qty = Number(document.getElementById('fut-qty').value || 0);
    const mark = state.lastPrice || 0;
    const usdtEl = document.getElementById('fut-usdt');
    if (mark && qty > 0) usdtEl.value = ((qty * mark) / state.leverage).toFixed(2);
    else if (!qty) usdtEl.value = '';
    updateFuturesPreview();
    futSyncing = false;
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
    syncFutFromUsdt(); // leverage changed: qty follows the entered USDT amount
  }

  async function submitFutures() {
    const qty = document.getElementById('fut-qty').value.trim();
    if (!qty || Number(qty) <= 0) return toast('Enter a quantity', 'err');
    const btn = document.getElementById('fut-submit');
    btn.disabled = true;
    try {
      const data = await api('/api/futures/open', {
        method: 'POST',
        body: JSON.stringify({ symbol: state.symbol, side: state.futSide, leverage: state.leverage, qty }),
      });
      toast(`Position opened @ ${fmtPrice(state.symbol, data.position.entry_price)}`);
      document.getElementById('fut-qty').value = '';
      document.getElementById('fut-usdt').value = '';
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
      const data = await api(`/api/spot/orders?symbol=${state.symbol}`);
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
          await api('/api/spot/cancel', { method: 'POST', body: JSON.stringify({ orderId: Number(btn.dataset.cancel) }) });
          toast('Order cancelled');
          await refreshBalances();
          await refreshOrders();
        } catch (err) { toast(err.message, 'err'); }
      }));
    } catch (err) { /* ignore transient */ }
  }

  async function refreshPositions() {
    try {
      const data = await api('/api/futures/positions');
      state.openPositions = data.open || [];
      // Mark-to-market value of the open positions, for the Total balance
      // (header + Home): locked margin + unrealized PnL at the live mark.
      state.openValue = (data.open || []).reduce(
        (s, p) => s + Number(p.margin || 0) + Number(p.unrealized_pnl || 0), 0);
      renderBalances();
      refreshPositionOverlay();
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
          const data2 = await api('/api/futures/close', { method: 'POST', body: JSON.stringify({ positionId: Number(btn.dataset.closePos) }) });
          toast(`Closed. Realized PnL ${fmtUsd(data2.realized_pnl)}`);
          await refreshBalances();
          await refreshPositions();
        } catch (err) { toast(err.message, 'err'); }
      }));
    } catch { /* ignore transient */ }
  }

  async function refreshTrades() {
    try {
      const data = await api(`/api/trades?symbol=${state.symbol}&limit=20`);
      state.recentTrades = data.trades || [];
      refreshTradeMarkers();
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
    // Telegram Mini App: tell Telegram the app is ready and expand to full height.
    try {
      const tg = window.Telegram && window.Telegram.WebApp;
      if (tg) { tg.ready(); tg.expand(); }
    } catch {}
    // Home is the landing view: only build the chart when the Trade view
    // is actually visible (a hidden container measures zero width).
    // ensureChart() builds it the first time Trade opens.
    if (!document.getElementById('trade-view').classList.contains('hidden')) initChart();
    document.getElementById('spot-base').textContent = BASE_OF[state.symbol];
    document.getElementById('fut-base').textContent = BASE_OF[state.symbol];

    document.querySelectorAll('.pair-card').forEach((el) => el.addEventListener('click', () => setSymbol(el.dataset.symbol)));
    document.querySelectorAll('.tf-btn').forEach((el) => el.addEventListener('click', () => setIntervalTf(el.dataset.tf)));
    document.querySelectorAll('.tab-btn').forEach((el) => el.addEventListener('click', () => setBookTab(el.dataset.tab)));
    document.getElementById('ma-chip').addEventListener('click', () => setMaVisible(!state.showMA));
    document.getElementById('vol-chip').addEventListener('click', () => setVolVisible(!state.showVol));
    document.getElementById('macd-chip').addEventListener('click', () => setMacdVisible(!state.showMacd));

    document.getElementById('spot-buy-btn').addEventListener('click', () => setSpotSide('buy'));
    document.getElementById('spot-sell-btn').addEventListener('click', () => setSpotSide('sell'));
    document.getElementById('spot-market-btn').addEventListener('click', () => setSpotType('market'));
    document.getElementById('spot-limit-btn').addEventListener('click', () => setSpotType('limit'));
    document.getElementById('spot-qty').addEventListener('input', syncSpotFromQty);
    document.getElementById('spot-usdt').addEventListener('input', syncSpotFromUsdt);
    document.getElementById('spot-price').addEventListener('input', syncSpotFromQty);
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
      syncSpotFromQty();
    }));

    document.getElementById('fut-long-btn').addEventListener('click', () => setFutSide('long'));
    document.getElementById('fut-short-btn').addEventListener('click', () => setFutSide('short'));
    document.querySelectorAll('.lev-btn').forEach((el) => el.addEventListener('click', () => setLeverage(Number(el.dataset.lev))));
    document.getElementById('fut-lev-range').addEventListener('input', (e) => setLeverage(Number(e.target.value)));
    document.getElementById('fut-qty').addEventListener('input', syncFutFromQty);
    document.getElementById('fut-usdt').addEventListener('input', syncFutFromUsdt);
    document.getElementById('fut-submit').addEventListener('click', submitFutures);
    document.getElementById('fs-btn').addEventListener('click', toggleFullscreen);
    document.getElementById('fs-exit').addEventListener('click', exitFullscreen);
    document.getElementById('ps-lin').addEventListener('click', () => setPriceScaleMode('linear'));
    document.getElementById('ps-log').addEventListener('click', () => setPriceScaleMode('log'));
    document.getElementById('ps-pct').addEventListener('click', () => setPriceScaleMode('percent'));
    document.getElementById('ps-auto').addEventListener('click', () => setAutoScale(!state.autoScale));
    document.getElementById('ps-reset').addEventListener('click', resetChart);
    try {
      if (localStorage.getItem('ex_autoscale') === '0') setAutoScale(false);
      const savedMode = localStorage.getItem('ex_psmode');
      if (savedMode === 'log' || savedMode === 'percent') setPriceScaleMode(savedMode);
    } catch {}

    loadKlines();
    loadRecentTrades();
    connectWs();
    pollMarket();
    refreshBalances();
    refreshServerPrices();
    refreshTabPrices();
    refreshOrders();
    refreshPositions();
    refreshTrades();

    setInterval(pollMarket, 2000);
    setInterval(refreshServerPrices, 2000);
    setInterval(refreshPositions, 2000);
    setInterval(refreshTabPrices, 10000);
    setInterval(() => { refreshOrders(); refreshTrades(); }, 5000);
    setInterval(chartWatchdog, 3000);
    // Entering/exiting fullscreen resizes #chart: re-fit the chart to the
    // new size (the ResizeObserver covers it too; this is the belt to its
    // braces, and it also repaints a series that ended up empty).
    document.addEventListener('fullscreenchange', () => {
      chartWatchdog();
      if (chart && candleSeries && state.klines.length && !seriesHasData()) {
        paintKlines();
        chart.timeScale().fitContent();
      }
    });
  }

  // Public handle for the Home/Profile views: open Trade, switch the
  // pair, and build the chart on first use.
  window.TradeApp = { setMode, setSymbol, ensureChart, getMode: () => state.mode };

  document.addEventListener('DOMContentLoaded', init);
})();
