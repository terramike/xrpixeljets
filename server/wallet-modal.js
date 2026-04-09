// /jets/js/wallet-modal.js — v2025-12-20-modal4
(function(){
  const $ = (id)=>document.getElementById(id);
  const backdrop = $('wallet-modal');
  const closeBtn = $('wallet-modal-close');

  function open(){ backdrop?.classList?.add('open'); backdrop?.setAttribute('aria-hidden','false'); }
  function close(){ backdrop?.classList?.remove('open'); backdrop?.setAttribute('aria-hidden','true'); }

  function wire(){
    const connect = $('btn-connect') || $('btn-sign');
    if (connect && !connect.__b){ connect.__b=1; connect.addEventListener('click', open); }
    if (closeBtn && !closeBtn.__b){ closeBtn.__b=1; closeBtn.addEventListener('click', close); }
    if (backdrop && !backdrop.__b){
      backdrop.__b=1;
      backdrop.addEventListener('click', (e)=>{ if (e.target === backdrop) close(); });
    }

    const btnXMK = $('wallet-modal-crossmark');
    const btnGEM = $('wallet-modal-gem');
    const btnWC  = $('wallet-modal-wc');

    // FORCE Crossmark flow (no detection)
    if (btnXMK && !btnXMK.__b){
      btnXMK.__b=1;
      btnXMK.addEventListener('click', async ()=>{
        try{
          const ok = await window.JetsAuth?.signIn('crossmark'); // force that provider
          if (ok) close();
        }catch(e){ console.warn('[modal] crossmark failed', e); }
      });
    }
    // FORCE Gem flow (no detection)
    if (btnGEM && !btnGEM.__b){
      btnGEM.__b=1;
      btnGEM.addEventListener('click', async ()=>{
        try{
          const ok = await window.JetsAuth?.signIn('gem'); // force that provider
          if (ok) close();
        }catch(e){ console.warn('[modal] gem failed', e); }
      });
    }
    if (btnWC && !btnWC.__b){
      btnWC.__b=1;
      btnWC.addEventListener('click', ()=>{
        (document.getElementById('btn-wc-connect')||{}).click?.();
        close();
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once:true });
  else wire();
})();
