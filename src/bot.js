// Telegram bot: answers /start with a welcome message that opens the mini app.
// Runs on long polling (getUpdates) — no webhook needed. Telegram signs the
// mini-app auth separately; this bot only sends messages, so setWebhook is
// never required for it to work.
//
// The welcome message is the FIRST thing a new user sees after pressing
// Start, and it carries its own button into the mini app — separate from
// the BotFather menu button. The button is a Telegram web_app button, so
// it opens the mini app right inside the chat.
//
// Env: TELEGRAM_BOT_TOKEN (required), TELEGRAM_MINI_APP_URL (the mini-app
// address; defaults to the current tunnel URL — update it in .env whenever
// the public address changes, e.g. a new tunnel or a stable domain).
const DEFAULT_MINI_APP_URL = 'https://obligations-devon-kills-patterns.trycloudflare.com/';

// The welcome text + keyboard. Kept as a pure function so tests can check
// it without touching the network.
function buildStartMessage(miniAppUrl) {
  const url = (miniAppUrl || DEFAULT_MINI_APP_URL).trim();
  const text =
    '👋 به صرافی AVENRA خوش اومدی!\n\n' +
    'اینجا می‌تونی اسپات و فیوچرز معامله کنی، با قیمت‌های زنده‌ی بازار.\n\n' +
    '👇 برای ورود به صرافی، دکمه‌ی زیر رو بزن:';
  const reply_markup = {
    inline_keyboard: [
      [{ text: '🚀 ورود به صرافی', web_app: { url } }],
    ],
  };
  return { text, reply_markup };
}

async function callApi(token, method, body, timeoutMs = 40000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

// Long-polling loop. Never throws: network errors are logged and retried
// with a backoff, so a Telegram outage can never take the exchange down.
async function runBotLoop(token, miniAppUrl) {
  let offset = 0;
  let backoffMs = 1000;
  for (;;) {
    try {
      const updates = await callApi(token, 'getUpdates', { offset, timeout: 30, allowed_updates: ['message'] }, 35000);
      backoffMs = 1000;
      for (const update of updates || []) {
        offset = Math.max(offset, update.update_id + 1);
        const msg = update.message;
        if (!msg || typeof msg.text !== 'string') continue;
        if (!msg.text.trim().startsWith('/start')) continue;
        const { text, reply_markup } = buildStartMessage(miniAppUrl);
        await callApi(token, 'sendMessage', {
          chat_id: msg.chat.id,
          text,
          reply_markup,
        });
        console.log(`[bot] welcomed chat ${msg.chat.id}`);
      }
    } catch (err) {
      console.error(`[bot] poll error (${err.message}); retrying in ${backoffMs}ms`);
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }
}

// Start the bot in the background (fire-and-forget). If there is no bot
// token configured, the bot simply does not start — the exchange works
// exactly as before.
function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[bot] TELEGRAM_BOT_TOKEN not set — /start welcome disabled');
    return;
  }
  const miniAppUrl = process.env.TELEGRAM_MINI_APP_URL || DEFAULT_MINI_APP_URL;
  console.log(`[bot] starting /start welcome (mini app: ${miniAppUrl})`);
  runBotLoop(token, miniAppUrl).catch((err) => {
    console.error('[bot] loop crashed (will not restart automatically):', err.message);
  });
}

// ---- trade alerts to admins ---------------------------------------------
// Every trade any user opens or closes is reported to each admin as a
// Telegram message — NOT inside the mini app. The report carries the full
// details: long/short, entry price, USDT amount, % of balance, liquidation
// point and the pair. Best-effort: a failed send must never break a trade,
// so every error is swallowed silently (the polling loop above is the
// visible signal that the bot token works).

function adminChatIds() {
  return (process.env.TELEGRAM_ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function fmtAlertNum(n, digits = 2) {
  const v = Number(n);
  if (!isFinite(v)) return String(n);
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

// Pure function (no network) so tests can check the message text.
function formatTradeAlert(ev) {
  if (!ev || !ev.type) return null;
  const who = ev.user_name ? `${ev.user} (${ev.user_name})` : (ev.user || '');
  const sym = String(ev.symbol || '').replace('USDT', '/USDT');
  const side = String(ev.side || '').toUpperCase();
  const pct = (ev.balance_pct != null && isFinite(Number(ev.balance_pct)))
    ? ` (${fmtAlertNum(ev.balance_pct, 1)}٪ از موجودی${ev.balance_asset ? ' ' + ev.balance_asset : ''})`
    : '';
  if (ev.type === 'futures_open') {
    return `🔔 معامله‌ی جدید — فیوچرز\n👤 ${who}\n📈 ${sym} · ${side} ${ev.leverage}x\n` +
      `💰 مارجین: ${fmtAlertNum(ev.margin)} USDT${pct}\n` +
      `🎯 ورود: ${fmtAlertNum(ev.entry_price)}\n💥 لیکویید: ${fmtAlertNum(ev.liquidation_price)}`;
  }
  if (ev.type === 'futures_close') {
    const pnl = Number(ev.realized_pnl || 0);
    return `🔔 بسته‌شدن معامله — فیوچرز\n👤 ${who}\n📉 ${sym} · ${side} ${ev.leverage}x\n` +
      `🎯 ورود: ${fmtAlertNum(ev.entry_price)} ← خروج: ${fmtAlertNum(ev.close_price)}\n` +
      `💵 سود/زیان: ${pnl >= 0 ? '+' : ''}$${fmtAlertNum(pnl)}`;
  }
  if (ev.type === 'futures_liquidated') {
    const pnl = Number(ev.realized_pnl || 0);
    return `💥 لیکویید شد — فیوچرز\n👤 ${who}\n📉 ${sym} · ${side} ${ev.leverage}x\n` +
      `🎯 ورود: ${fmtAlertNum(ev.entry_price)} · لیکویید: ${fmtAlertNum(ev.liquidation_price)}\n` +
      `💵 زیان: ${pnl >= 0 ? '+' : ''}$${fmtAlertNum(pnl)}`;
  }
  if (ev.type === 'spot_fill') {
    const base = String(ev.symbol || '').replace('USDT', '');
    const verb = ev.side === 'buy' ? '🟢 خرید' : '🔴 فروش';
    const money = ev.side === 'buy'
      ? `💰 مجموع: ${fmtAlertNum(ev.total)} USDT${pct}`
      : `💰 دریافت: ${fmtAlertNum(ev.total)} USDT${pct}`;
    return `🔔 معامله‌ی جدید — اسپات\n👤 ${who}\n${verb} ${base} (${fmtAlertNum(ev.qty, 6)}) @ ${fmtAlertNum(ev.price)}\n${money}`;
  }
  return null;
}

async function notifyTrade(ev) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chats = adminChatIds();
  if (!token || !chats.length) return;
  const text = formatTradeAlert(ev);
  if (!text) return;
  for (const chat_id of chats) {
    try {
      await callApi(token, 'sendMessage', { chat_id, text });
    } catch {
      // Best-effort: never break a trade over a failed alert.
    }
  }
}

module.exports = { buildStartMessage, startBot, notifyTrade, formatTradeAlert, DEFAULT_MINI_APP_URL };
