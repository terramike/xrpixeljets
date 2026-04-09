// /jets/js/wallet-modal-fixed.js — Explicit provider buttons
// v=2025-12-18-fixed1
(function(){
  const $ = (id) => document.getElementById(id);
  const root = $('wallet-modal');
  const closeBtn = $('wallet-modal-close');

  function open() {
    if (root) {
      root.classList.add('open');
      root.setAttribute('aria-hidden', 'false');
    }
  }

  function close() {
    if (root) {
      root.classList.remove('open');
      root.setAttribute('aria-hidden', 'true');
    }
  }

  function wire() {
    // Opener buttons
    const openers = ['btn-connect', 'btn-sign', 'btn-login'];
    openers.forEach(id => {
      const btn = $(id);
      if (btn && !btn.__modal_bound) {
        btn.__modal_bound = true;
        btn.addEventListener('click', open);
      }
    });

    // Close button
    if (closeBtn && !closeBtn.__modal_bound) {
      closeBtn.__modal_bound = true;
      closeBtn.addEventListener('click', close);
    }

    // Click outside to close
    if (root && !root.__modal_bound) {
      root.__modal_bound = true;
      root.addEventListener('click', (e) => {
        if (e.target === root) close();
      });
    }

    // Provider buttons
    const btnX = $('wallet-modal-crossmark');
    const btnG = $('wallet-modal-gem');
    const btnW = $('wallet-modal-wc');

    if (btnX && !btnX.__modal_bound) {
      btnX.__modal_bound = true;
      btnX.addEventListener('click', async () => {
        close();
        // Small delay for modal to close
        await new Promise(r => setTimeout(r, 100));
        if (window.JetsAuth?.signIn) {
          await window.JetsAuth.signIn('crossmark');
        }
      });
    }

    if (btnG && !btnG.__modal_bound) {
      btnG.__modal_bound = true;
      btnG.addEventListener('click', async () => {
        close();
        await new Promise(r => setTimeout(r, 100));
        if (window.JetsAuth?.signIn) {
          await window.JetsAuth.signIn('gem');
        }
      });
    }

    if (btnW && !btnW.__modal_bound) {
      btnW.__modal_bound = true;
      btnW.addEventListener('click', () => {
        close();
        // WC needs to show its own modal, so just trigger the button
        const wcBtn = $('btn-wc-connect');
        if (wcBtn) wcBtn.click();
      });
    }
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire, { once: true });
  } else {
    wire();
  }

  // Re-wire if DOM changes (for SPA-like behavior)
  const mo = new MutationObserver(() => {
    if ($('wallet-modal') && !$('wallet-modal').__modal_bound) {
      wire();
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
})();