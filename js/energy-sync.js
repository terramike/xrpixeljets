// jets/js/energy-sync.js — event-driven HUD sync (2025-10-25d)
import { GameState } from '/jets/js/state.js';

function updateHUD(detail) {
  const energy = Number(detail?.energy ?? GameState.energy ?? 0);
  const cap    = Number(detail?.energyCap ?? GameState.ms?.current?.energyCap ?? 100);
  const regen  = Number(detail?.ms?.current?.regenPerMin ?? GameState.ms?.current?.regenPerMin ?? 0);
  const pct = Math.max(0, Math.min(100, Math.round((energy / (cap || 1)) * 100)));

  const bar = document.querySelector('#hud-top .energyfill');
  if (bar) bar.style.width = pct + '%';

  const txt = document.getElementById('energy-text');
  if (txt) txt.textContent = `${energy}/${cap} (+${regen}/min)`;
}

function onProfile(e){ updateHUD(e?.detail || null); }

function bind() {
  window.addEventListener('jets:profile', onProfile);
  // first paint
  setTimeout(() => updateHUD(null), 0);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
