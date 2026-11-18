// Wallet page: all balances with live USDT value.
(function () {
  async function refresh() {
    try {
      const [account, prices] = await Promise.all([
        api(`/api/account?uid=${getUid()}`),
        api('/api/prices'),
      ]);
      const balances = account.balances;
      let total = 0;
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
      document.getElementById('total-balance-value').textContent = fmtUsd(total);
    } catch (err) {
      toast(err.message, 'err');
    }
  }
  window.refreshBalances = refresh;

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('uid-value').textContent = getUid();
    document.getElementById('uid-chip').addEventListener('click', () => {
      navigator.clipboard?.writeText(getUid());
      toast('UID copied: ' + getUid());
    });
    refresh();
    setInterval(refresh, 5000);
  });
})();
