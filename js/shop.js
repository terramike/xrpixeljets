// /jets/js/shop.js — Jets Bazaar (2025-10-27a)
(function(){
  const API_BASE = window.JETS_API_BASE || 'https://xrpixeljets.onrender.com';

  const $ = s => document.querySelector(s);
  const log = (m) => { const el = $('#log'); if (!el) return; const d = document.createElement('div'); d.textContent = String(m); el.appendChild(d); el.scrollTop = el.scrollHeight; };

  function getWallet(){
    const inp = $('#xrpl-address'); const v = (inp?.value||'').trim();
    if (v && v.startsWith('r')) return v;
    if (window.CURRENT_WALLET) return String(window.CURRENT_WALLET).trim();
    try { const ls = (localStorage.getItem('WALLET')||'').trim(); if (ls) return ls; } catch {}
    return '';
  }
  function getJWT(){ try { return (localStorage.getItem('JWT')||'').trim() || null; } catch { return null; } }

  function headersJSON(includeWallet=true){
    const h = { 'Content-Type':'application/json' };
    const jwt = getJWT(); if (jwt) h['Authorization'] = 'Bearer ' + jwt;
    if (includeWallet){ const w = getWallet(); if (w) h['X-Wallet'] = w; }
    return h;
  }

  async function fetchJSON(path, opts={}){
    const res = await fetch(API_BASE + path, opts);
    const raw = await res.text().catch(()=> '');
    const data = raw ? (()=>{ try{ return JSON.parse(raw); }catch{ return {}; } })() : {};
    if (!res.ok) { const msg = data?.error || data?.message || raw || res.statusText; throw new Error(msg); }
    return data;
  }

  async function loadProfile(){
    try {
      const p = await fetchJSON('/profile', { headers: headersJSON(true) });
      $('#balance').textContent = String(p?.jetFuel ?? 0);
      const addr = getWallet(); if (addr) { const ss = $('#session-status'); if (ss) ss.textContent = 'Connected: ' + addr; }
    } catch (e) { log('Profile load failed: ' + (e.message||e)); }
  }

  async function loadItems(){
    try {
      const list = await fetchJSON('/shop/items', { headers: headersJSON(true) });
      const root = $('#items'); root.innerHTML = '';
      (list?.items||[]).forEach(it => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
          <img src="${it.image||'/jets/assets/placeholder.png'}" alt="${it.name}">
          <div style="min-height:28px">${it.name||'Item'}</div>
          <div class="tiny">${it.desc||''}</div>
          <div class="price">Price: ${it.cost} JF</div>
          <button data-id="${it.id}" class="buy">Buy with JETS</button>
        `;
        root.appendChild(card);
      });
      root.querySelectorAll('button.buy').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          const id = btn.getAttribute('data-id');
          await buyItem(id);
        });
      });
    } catch (e) { log('Items load failed: ' + (e.message||e)); }
  }

  async function ensureSignedInIfNeeded(){
    const jwt = getJWT(); if (jwt) return true;
    const ssBtn = document.getElementById('btn-session-start');
    if (ssBtn) ssBtn.click(); // auth-claim.js binds this
    // best-effort: wait a brief moment for sign-in to complete
    await new Promise(r=>setTimeout(r, 1200));
    return !!getJWT();
  }

  async function buyItem(itemId){
    const w = getWallet(); if (!w) return log('Connect wallet first.');
    const ok = await ensureSignedInIfNeeded(); if (!ok) return log('Sign-in required.');
    log('Submitting purchase…');
    try{
      const res = await fetchJSON('/shop/redeem', {
        method:'POST',
        headers: headersJSON(true),
        body: JSON.stringify({ itemId })
      });
      if (typeof res?.newBalance === 'number') $('#balance').textContent = String(res.newBalance);
      log(`Purchase OK: ${res?.message || res?.item?.name || itemId}`);
      const cs = document.getElementById('claim-status');
      if (cs) cs.innerHTML = res?.txid
        ? `NFT queued. XRPL tx: <a target="_blank" rel="noopener" href="https://xrpscan.com/tx/${res.txid}">${res.txid}</a>`
        : (res?.redeemCode ? `Redeem Code: <b>${res.redeemCode}</b>` : 'Purchase recorded.');
    } catch(e){
      const m = String(e?.message||'purchase_failed');
      log('Purchase failed: ' + m);
      const cs = document.getElementById('claim-status');
      if (cs) cs.textContent = m.includes('insufficient_funds') ? 'Not enough JETS.' : m;
    }
  }

  function bind(){
    // Pre-fill wallet if known
    const a = getWallet(); if (a) { const i=$('#xrpl-address'); if (i) i.value=a; }
    loadProfile(); loadItems();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
