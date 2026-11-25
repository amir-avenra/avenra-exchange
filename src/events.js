// In-memory trade-event log for the admin live feed.
// Every trade a user opens or closes (spot fill, futures open/close,
// liquidation) is appended here the moment it happens; the admin panel
// polls /api/admin/events?since=<seq> and shows new events immediately.
// Capped at the newest 200 events. In-memory by design for now (the
// container runs in memory mode); the underlying trades/positions are
// still in the store (Postgres when DATABASE_URL is set).
//
// The event is also reported to every admin as a Telegram message the
// moment it happens (src/bot.js notifyTrade) — that message, not this
// log, is the admin's trade report. The send is fire-and-forget and can
// never break the trade.
const bot = require('./bot');
const events = [];
let seq = 0;
const MAX_EVENTS = 200;

// Telegram display names seen in this process (uid -> { username, first_name }).
// In-memory only: repopulated whenever a Telegram user authenticates.
const tgProfiles = new Map();

function setProfile(uid, profile) {
  if (profile && (profile.username || profile.first_name)) {
    tgProfiles.set(uid, { username: profile.username || null, first_name: profile.first_name || null });
  }
}

function getProfile(uid) {
  return tgProfiles.get(uid) || null;
}

// The numeric Telegram id is the primary identifier: not every user has
// a @username, but every user has a numeric id. The display name, when
// known, rides along as a secondary detail.
function userLabel(uid) {
  return uid.startsWith('tg:') ? uid.slice(3) : uid;
}

function userDisplayName(uid) {
  const p = tgProfiles.get(uid);
  if (p && p.username) return '@' + p.username;
  if (p && p.first_name) return p.first_name;
  return null;
}

function push(type, data) {
  const ev = { seq: ++seq, ts: new Date().toISOString(), type, ...data };
  if (data.uid) {
    ev.user = userLabel(data.uid);
    const name = userDisplayName(data.uid);
    if (name) ev.user_name = name;
  }
  events.push(ev);
  if (events.length > MAX_EVENTS) events.shift();
  // Report to admins as a Telegram message (fire-and-forget; never throws).
  try {
    const p = bot.notifyTrade(ev);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* best-effort only */ }
  return ev;
}

function since(afterSeq) {
  const n = Number(afterSeq) || 0;
  return events.filter((e) => e.seq > n);
}

function latestSeq() {
  return seq;
}

module.exports = { push, since, latestSeq, setProfile, getProfile, userLabel, userDisplayName };
