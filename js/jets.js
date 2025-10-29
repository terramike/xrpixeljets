// jets/js/jets.js — XRPixel Jets MKG (2025-10-24 squad-fix)
// - Mirror Main -> Wing when Wing empty (immediate, not just at Start)
// - Recompute + repaint squad pills on every selection/unselection
// - Button badges reflect current role(s)
// - Allows same jet to be both Main and Wing; clicking again unselects.

import { GameState } from './state.js';
import { renderSquadStats, setMainCard, setWingCard } from './ui.js';

function gridEl() {
  return document.getElementById('jet-grid')
      || document.getElementById('jets')
      || document.getElementById('jets-grid'); // legacy fallbacks
}

export function recalcSquad() {
  const m = GameState.mainJet || null;
  const w = GameState.wingJet || null;

  if (!m && !w) {
    GameState.squad = { attack: 0, speed: 0, defense: 0, synergy: 1, synergyText: '—' };
    return GameState.squad;
  }

  const atk = (m?.attack || 0) + (w?.attack || 0);
  const spd = (m?.speed  || 0) + (w?.speed  || 0);
  const def = (m?.defense|| 0) + (w?.defense|| 0);

  let syn = 1.0, synText = '1×';
  if (m && w) {
    const top  = String(m.top_gun ?? '').toLowerCase();
    const bot  = String(w.bottom_gun ?? '').toLowerCase();
    if (top && bot) {
      syn = (top !== bot) ? 1.2 : 1.1;
      synText = (top !== bot) ? '1.2×' : '1.1×';
    }
  }

  GameState.squad = {
    attack: Math.round(atk),
    speed:  Math.round(spd),
    defense:Math.round(def),
    synergy: syn,
    synergyText: synText
  };
  return GameState.squad;
}

function ensureTwoRolesAfterSelect() {
  // If only one role is set, mirror it into the other so squad stats are never zero
  if (GameState.mainJet && !GameState.wingJet) {
    GameState.wingJet = GameState.mainJet;
    setWingCard(GameState.wingJet);
  } else if (!GameState.mainJet && GameState.wingJet) {
    GameState.mainJet = GameState.wingJet;
    setMainCard(GameState.mainJet);
  }
}

export function renderJets(onSetMain, onSetWing, jets) {
  const grid = gridEl();
  if (!grid) return;

  const mainId = GameState.mainJet?.id ?? null;
  const wingId = GameState.wingJet?.id ?? null;

  const html = (jets || []).map(j => {
    const isMain = (j.id === mainId);
    const isWing = (j.id === wingId);
    return `
      <div class="jet-card" data-id="${j.id}">
        <img src="${j.image}" alt="${j.name || 'Jet'}" />
        <div class="nm tiny">${j.name || 'XRPixel Jet'}</div>
        <div class="stats tiny">ATK ${j.attack ?? '—'} • SPD ${j.speed ?? '—'} • DEF ${j.defense ?? '—'}</div>
        <div class="guns tiny">${j.top_gun || '—'} | ${j.bottom_gun || '—'}</div>
        <div class="row tight">
          <button class="btn-main">${isMain ? 'Main ✓' : 'Set Main'}</button>
          <button class="btn-wing">${isWing ? 'Wing ✓' : 'Set Wing'}</button>
        </div>
      </div>
    `;
  }).join('');

  grid.innerHTML = html || '<div class="tiny">No Jets found.</div>';

  // Wire click handlers
  grid.querySelectorAll('.jet-card').forEach(card => {
    const id = card.getAttribute('data-id');
    const btnMain = card.querySelector('.btn-main');
    const btnWing = card.querySelector('.btn-wing');

    const findJet = () => (jets || []).find(j => String(j.id) === String(id));

    if (btnMain) btnMain.onclick = () => {
      const jet = findJet(); if (!jet) return;

      // Toggle main selection
      if (GameState.mainJet && GameState.mainJet.id === jet.id) {
        GameState.mainJet = null;
        setMainCard(null);
      } else {
        GameState.mainJet = jet;
        setMainCard(jet);
      }

      ensureTwoRolesAfterSelect();
      recalcSquad(); renderSquadStats();
      renderJets(onSetMain, onSetWing, jets);
      onSetMain && onSetMain(GameState.mainJet || null);
    };

    if (btnWing) btnWing.onclick = () => {
      const jet = findJet(); if (!jet) return;

      // Toggle wing selection
      if (GameState.wingJet && GameState.wingJet.id === jet.id) {
        GameState.wingJet = null;
        setWingCard(null);
      } else {
        GameState.wingJet = jet;
        setWingCard(jet);
      }

      ensureTwoRolesAfterSelect();
      recalcSquad(); renderSquadStats();
      renderJets(onSetMain, onSetWing, jets);
      onSetWing && onSetWing(GameState.wingJet || null);
    };
  });

  // If we loaded fresh and only one role is set, mirror now (e.g., single NFT case)
  ensureTwoRolesAfterSelect();
  recalcSquad(); renderSquadStats();
}
