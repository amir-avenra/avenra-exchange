// Hidden admin panel.
// Opens by tapping "Total balance" 5 times quickly, or Ctrl/Cmd+Shift+A.
// The admin can look up any account by its 8-digit UID and credit balances.
(function () {
  let taps = [];
  let modal = null;

  function open() {
    if (!modal) return;
    modal.classList.remove('hidden');
    const input = modal.querySelector('#admin-uid');
    if (input) input.focus();
  }
  function close() {
    if (modal) modal.classList.add('hidden');
  }

  function bindTapTarget() {
    const target = document.getElementById('total-balance');
    if (!target) return;
    target.addEventListener('click', () => {
      const now = Date.now();
      taps = taps.filter((t) => now - t < 1500);
      taps.push(now);
      if (taps.length >= 5) {
        taps = [];
        open();
      }
    });
  }

  async function lookup() {
    const uid = document.getElementById('admin-uid').value.trim();
    if (!/^\d{8}$/.test(uid)) return toast('Enter an 8-digit UID', 'err');
    try {
      const data = await api(`/api/admin/account?uid=${uid}`);
      const box = document.getElementById('admin-account');
      box.innerHTML =
        `<div class="kv"><span>UID</span><b>${data.uid}</b></div>` +
        `<div class="kv"><span>Created</span><span>${new Date(data.created_at).toLocaleString()}</span></div>` +
        ASSETS.map((a) => `<div class="kv"><span>${a}</span><b>${fmtNum(data.balances[a] || '0')}</b></div>`).join('');
      document.getElementById('admin-credit-box').classList.remove('hidden');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function credit() {
    const uid = document.getElementById('admin-uid').value.trim();
    const asset = document.getElementById('admin-asset').value;
    const amount = document.getElementById('admin-amount').value.trim();
    if (!amount || Number(amount) <= 0) return toast('Enter a positive amount', 'err');
    try {
      const data = await api('/api/admin/credit', {
        method: 'POST',
        body: JSON.stringify({ uid, asset, amount }),
      });
      toast(`Credited ${fmtNum(amount)} ${asset} to ${uid}`);
      document.getElementById('admin-amount').value = '';
      // Refresh the lookup view
      await lookup();
      // Refresh the page balances if a hook exists
      if (window.refreshBalances) window.refreshBalances();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function init() {
    modal = document.getElementById('admin-modal');
    if (!modal) return;
    bindTapTarget();
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault();
        open();
      }
      if (e.key === 'Escape') close();
    });
    modal.querySelector('.close-x').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.getElementById('admin-lookup').addEventListener('click', lookup);
    document.getElementById('admin-credit').addEventListener('click', credit);
    document.getElementById('admin-uid').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') lookup();
    });
  }

  window.Admin = { open, close, init };
  document.addEventListener('DOMContentLoaded', init);
})();
