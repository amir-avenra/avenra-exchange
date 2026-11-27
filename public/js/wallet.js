// Wallet page: all balances with live USDT value.
// Identity is the numeric Telegram id (from /api/account).
(function () {
  async function refresh() {
    try {
      const [account, prices, positions] = await Promise.all([
        api('/api/account'),
        api('/api/prices'),
        api('/api/futures/positions'),
      ]);
      const balances = account.balances;
      // The Admin nav item must be visible on the Wallet page too, for the
      // admin account: without this the Admin button vanished the moment
      // the admin opened Wallet (this page never had the item at all).
      if (account.is_admin) {
        const nav = document.getElementById('nav-admin');
        if (nav) nav.classList.remove('hidden');
      }
      let total = 0;
      // Open positions count at mark-to-market (margin + unrealized PnL),
      // same as the header total: the margin left the USDT balance at open.
      for (const p of (positions.open || [])) {
        total += Number(p.margin || 0) + Number(p.unrealized_pnl || 0);
      }
      const rows = ASSETS.map((asset) => {
        const amount = Number(balances[asset] || 0);
        const price = asset === 'USDT' ? 1 : Number(prices.prices[asset + 'USDT'] || 0);
        const value = amount * price;
        total += value;
        return `<tr>
          <td><b>${asset}</b></td>
          <td>${fmtNum(amount)}</td>
          <td>${asset === 'USDT' ? '$1.00' : (price ? fmtUsd(price) : '—')}</td>
          <td>${fmtUsd(value)}</td>
        </tr>`;
      }).join('');
      document.getElementById('wallet-body').innerHTML = rows;
      document.getElementById('wallet-total-value').textContent = fmtUsd(total);
      // Header shows the plain number + the "USDT" label next to it.
      document.getElementById('total-balance-value').textContent = fmtNum(total, 2);
      // Show the numeric Telegram id (tap to copy).
      const tgId = account.tg_user ? String(account.tg_user.id) : account.uid;
      document.getElementById('uid-value').textContent = tgId;
    } catch (err) {
      toast(err.message, 'err');
    }
  }
  window.refreshBalances = refresh;

  document.addEventListener('DOMContentLoaded', () => {
    // Telegram Mini App: tell Telegram the app is ready and expand to full height.
    try {
      const tg = window.Telegram && window.Telegram.WebApp;
      if (tg) { tg.ready(); tg.expand(); }
    } catch {}
    document.getElementById('uid-chip').addEventListener('click', () => {
      const id = document.getElementById('uid-value').textContent;
      navigator.clipboard?.writeText(id);
      toast('Telegram ID copied: ' + id);
    });
    refresh();
    setInterval(refresh, 5000);
  });
})();
