/* XRPixel Jets — login-extras.js (2025-10-26relB)
   - Xumm/Xaman QR connect (browser SDK)
   - xrp.cafe iframe bridge
   - Zero changes to existing game loop
*/
(function(){
  const WALLET_KEY = 'WALLET';
  const isR = (s)=> typeof s==='string' && /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(s);
  const log = (...a)=>console.log('[JetsLoginExtras]', ...a);

  function setWallet(addr, opts={}){
    if(!isR(addr)) return false;
    try{ localStorage.setItem(WALLET_KEY, addr); }catch{}
    try{ window.dispatchEvent(new CustomEvent('jets:auth', { detail: { address: addr } })); }catch{}
    if (opts.statusId){
      const el=document.getElementById(opts.statusId);
      if(el) el.textContent = `Connected: ${addr}`;
    }
    if (opts.redirect){ location.assign(opts.redirect); }
    log('Connected wallet:', addr);
    return true;
  }

  async function loadScript(src){
    if ([...document.scripts].some(s => (s.src||'')===src)) return;
    await new Promise((res, rej)=>{
      const s=document.createElement('script');
      s.src=src; s.async=false; s.crossOrigin='anonymous';
      s.onload=res; s.onerror=()=>rej(new Error('Failed to load '+src));
      document.head.appendChild(s);
    });
  }

  // ---------- Xumm / Xaman QR connect ----------
  async function connectWithXumm({ apiKey, onReadyQR, onPushed, statusId, redirect }){
    if (!apiKey) throw new Error('Missing Xumm apiKey');
    await loadScript('https://xaman.app/assets/cdn/xumm.min.js');
    // global Xumm from SDK
    // eslint-disable-next-line no-undef
    const xumm = new Xumm(apiKey);

    const { created, resolved } = await xumm.payload.createAndSubscribe(
      { txjson: { TransactionType: 'SignIn' } },
      (evt)=>{
        try{
          if (evt && evt.data && 'opened' in evt.data){ onPushed && onPushed(!!evt.data.opened); }
          if (evt && evt.data && 'signed' in evt.data){ return evt; }
        }catch{}
      }
    );

    onReadyQR && onReadyQR(created?.refs?.qr_png || null, created?.next?.always || null);

    const payload = await resolved;
    if (!payload || payload.signed !== true) throw new Error('SignIn rejected or timed out');

    const addr = payload?.response?.account || payload?.account || null;
    if (!isR(addr)) throw new Error('No XRPL account returned by Xumm');

    setWallet(addr, { statusId, redirect });
    return addr;
  }

  // ---------- xrp.cafe iframe bridge ----------
  function attachXrpcafeBridge({ originAllow = ['https://xrp.cafe','https://www.xrp.cafe'], extractor, statusId, redirect } = {}){
    const guessAddr = (data)=>{
      const cand = data?.account || data?.address || data?.wallet?.address || data?.payload?.account || null;
      if (isR(cand)) return cand;
      try{
        const s = JSON.stringify(data);
        const m = s.match(/r[1-9A-HJ-NP-Za-km-z]{25,35}/);
        return m ? m[0] : null;
      }catch{ return null; }
    };
    const onMsg = (ev)=>{
      if (originAllow.length && !originAllow.includes(ev.origin)) return;
      const addr = (extractor ? extractor(ev.data, ev) : guessAddr(ev.data));
      if (isR(addr)) setWallet(addr, { statusId, redirect });
    };
    window.addEventListener('message', onMsg, false);
    log('xrpcafe bridge attached. Allowed origins:', originAllow);
    return ()=>window.removeEventListener('message', onMsg, false);
  }

  // ---------- Convenience wiring ----------
  function wireButtons({ xummButton='#btn-login-xaman', xummKey=null, statusId='session-status', redirect=null, cafeBridge=true } = {}){
    // Xumm connect button
    const b = document.querySelector(xummButton);
    if (b && !b.__jetsLoginBound){
      b.__jetsLoginBound = true;
      b.addEventListener('click', async ()=>{
        b.disabled = true;
        try {
          let shown = false;
          const showQR = (png, link)=>{
            const img = document.getElementById('xumm-qr');
            if (img && png){ img.src = png; img.style.display='block'; shown = true; }
            if (!shown && link){ window.open(link, '_blank'); }
          };
          await connectWithXumm({ apiKey: xummKey || b.dataset.xummKey, onReadyQR: showQR, statusId, redirect });
        } catch(e){
          alert('Xaman connect failed: '+(e?.message||e));
        } finally { b.disabled = false; }
      }, { passive:true });
    }
    if (cafeBridge) attachXrpcafeBridge({ statusId, redirect });
  }

  window.JetsLoginExtras = { setWallet, connectWithXumm, attachXrpcafeBridge, wireButtons };
})();
