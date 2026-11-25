// Telegram Mini App authentication (initData validation).
// When the exchange runs inside Telegram, the client sends the initData
// string Telegram provides (window.Telegram.WebApp.initData) in the
// X-Telegram-Init-Data header. The server verifies Telegram's signature
// per the official Mini App recipe (core.telegram.org/bots/webapps):
//   secret = HMAC-SHA256(key="WebAppData", message=bot token)  (raw bytes)
//   hmac   = HMAC-SHA256(secret, data_check_string)             (hex)
//   data_check_string = sorted "key=<value>" pairs (excluding hash),
//                       joined with "\n"
// NOTE: the secret is the HMAC of "WebAppData", NOT SHA256(bot token) —
// SHA256(token) is the *Login Widget* scheme and fails every real Mini
// App signature with "bad signature".
// The bot token lives ONLY in the server environment (TELEGRAM_BOT_TOKEN)
// and is never sent to, or stored by, any client.
// Admins are Telegram user ids, comma-separated in TELEGRAM_ADMIN_IDS
// (e.g. the owner's personal accounts). No admin rights exist without
// a valid Telegram signature.
const crypto = require('crypto');

const MAX_AGE_SECONDS = 86400; // initData older than 24h is rejected

function verifyInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') {
    return { ok: false, error: 'missing initData' };
  }
  if (!botToken) {
    return { ok: false, error: 'Telegram auth not configured on this server' };
  }
  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, error: 'bad initData' };
  }
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'missing hash' };
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) {
    return { ok: false, error: 'initData expired' };
  }
  const pairs = [];
  for (const [key, value] of params) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, error: 'bad signature' };
  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return { ok: false, error: 'bad user payload' };
  }
  if (!user || !user.id) return { ok: false, error: 'missing user' };
  return { ok: true, user };
}

function adminIds() {
  return (process.env.TELEGRAM_ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAdminId(tgId) {
  return adminIds().includes(String(tgId));
}

module.exports = { verifyInitData, adminIds, isAdminId };
