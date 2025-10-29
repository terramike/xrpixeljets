// /jets/js/ipfs-img-fallback.js — 2025-10-28-ghost1
// Global image fallback for Jet thumbnails/cards.
// If an image fails to load, swap to the ghost placeholder.

const PLACEHOLDER = 'https://mykeygo.io/jets/assets/ghost.png';

// Attach a one-time error handler to an <img>
function attachFallback(img) {
  if (!img || img.dataset.fallbackAttached === '1') return;
  img.dataset.fallbackAttached = '1';

  img.addEventListener('error', () => {
    // Prevent loops if the placeholder 404s (shouldn't, but guard anyway)
    if (img.src !== PLACEHOLDER) img.src = PLACEHOLDER;
  }, { passive: true });

  // If src is empty or already failed before we attached, force placeholder
  if (!img.getAttribute('src') || (img.complete && img.naturalWidth === 0)) {
    img.src = PLACEHOLDER;
  }
}

// Scan current DOM for Jet images
function scanNow() {
  // All Jet thumbnails in the grid + main/wing card images
  document.querySelectorAll('.jet-grid img, #main-img, #wing-img').forEach(attachFallback);
}

// Observe future DOM changes so newly added images also get the fallback
const mo = new MutationObserver((records) => {
  for (const r of records) {
    for (const node of r.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches?.('.jet-grid img, #main-img, #wing-img')) {
        attachFallback(node);
      }
      // If a whole subtree was added, scan inside it
      node.querySelectorAll?.('.jet-grid img, #main-img, #wing-img').forEach(attachFallback);
    }
  }
});

// Boot
window.addEventListener('DOMContentLoaded', () => {
  scanNow();
  try { mo.observe(document.body, { childList: true, subtree: true }); } catch {}
});

// Optional helper if other modules want to set src with guaranteed fallback
export function setNFTImg(imgEl, url) {
  attachFallback(imgEl);
  try { imgEl.src = url || PLACEHOLDER; } catch { imgEl.src = PLACEHOLDER; }
}
