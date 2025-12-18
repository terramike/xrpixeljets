/* XRPixel Jets — Bazaar nomodule loader
 * 2025-11-08hot2
 * Purpose: load the server-inventory Bazaar module (no /bazaar/chain/* calls).
 */
(function () {
  try {
    // prevent double-inject
    if (document.querySelector('script[data-bazaar-hot="1"]')) return;

    var s = document.createElement('script');
    s.type = 'module';
    s.dataset.bazaarHot = '1';
    // point at your server-inventory bazaar.js build
    s.src = '/jets/js/bazaar.js?v=2025-11-08hot1';
    document.head.appendChild(s);
  } catch (e) {
    try { console.warn('[Bazaar] nomodule loader error:', e); } catch {}
  }
})();
