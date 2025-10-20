import { GameState } from './state.js';
import { getE, getFuel } from './utils.js';

// Try several likely containers to place the cards into; fall back to #ui-root or body.
const CARD_PARENT_CANDIDATES = [
  'squad-cards','squad-panel','cards-row','pick-row','controls-left','controls','ui-left','ui-root'
];

function firstExistingId(ids){
  for (const id of ids){
    const el = document.getElementById(id);
    if (el) return id;
  }
  return null;
}

function ensureEl(id, tag, parentId, attrs={}){
  let el = document.getElementById(id);
  if (!el){
    let parent = null;
    if (parentId) parent = document.getElementById(parentId);
    if (!parent){
      const chosen = firstExistingId(CARD_PARENT_CANDIDATES);
      parent = chosen ? document.getElementById(chosen) : null;
    }
    el = document.createElement(tag);
    el.id = id;
    Object.entries(attrs).forEach(([k,v])=> el.setAttribute(k, v));
    (parent || document.body).appendChild(el);
  }
  return el;
}

export const ui = {
  energyFill: document.querySelector('.energyfill'),
  energyText: document.getElementById('energy-text'),
  youFill:    document.querySelector('.youfill'),
  enemyFill:  document.querySelector('.enemyfill'),

  msHit:   document.getElementById('ms-hit'),
  msCrit:  document.getElementById('ms-crit'),
  msDodge: document.getElementById('ms-dodge'),

  squadAtk: document.getElementById('sq-atk'),
  squadSpd: document.getElementById('sq-spd'),
  squadDef: document.getElementById('sq-def'),
  squadSyn: document.getElementById('sq-syn'),

  youHPLabel:   document.getElementById('you-hp-text'),
  enemyHPLabel: document.getElementById('enemy-hp-text'),

  jetFuelText: document.getElementById('jetfuel'),
};

// Safe setters for squad cards (will mount into a proper UI container)
export function setMainCard(name, image){
  const parentId = firstExistingId(CARD_PARENT_CANDIDATES);
  const cardId = 'main-card';
  ensureEl(cardId, 'div', parentId, { class: 'card tiny' });

  const img = ensureEl('main-img', 'img', cardId, { style: 'width:72px;height:72px;object-fit:contain;image-rendering:pixelated;' });
  const label = ensureEl('main-name', 'div', cardId, { class: 'tiny' });

  img.src = image || '';
  img.alt = name || 'Main Jet';
  label.textContent = name || '—';
}

export function setWingCard(name, image){
  const parentId = firstExistingId(CARD_PARENT_CANDIDATES);
  const cardId = 'wing-card';
  ensureEl(cardId, 'div', parentId, { class: 'card tiny' });

  const img = ensureEl('wing-img', 'img', cardId, { style: 'width:72px;height:72px;object-fit:contain;image-rendering:pixelated;' });
  const label = ensureEl('wing-name', 'div', cardId, { class: 'tiny' });

  img.src = image || '';
  img.alt = name || 'Wingman';
  label.textContent = name || 'None';
}

export function updateEnergyUI(){
  const cap = GameState.ms.current.energyCap;
  const e = Math.min(parseInt(localStorage.getItem('energy')||'0',10), cap);
  if (ui.energyFill) ui.energyFill.style.width = `${Math.floor(100*e/cap)}%`;
  if (ui.energyText) ui.energyText.textContent = `Energy: ${e}/${cap}`;
}

export function updateMSUI(){
  const ms = GameState.ms.current;
  const jf = getFuel();
  const hEl=document.getElementById('ms-health');
  const cEl=document.getElementById('ms-cap');
  const rEl=document.getElementById('ms-regen');
  if(hEl) hEl.textContent = String(ms.health);
  if(cEl) cEl.textContent = String(ms.energyCap);
  if(rEl) rEl.textContent = `${ms.regenPerMin.toFixed(1)}/min`;

  if (ui.msHit)   ui.msHit.textContent   = `${ms.hit??0}%`;
  if (ui.msCrit)  ui.msCrit.textContent  = `${ms.crit??10}%`;
  if (ui.msDodge) ui.msDodge.textContent = `${ms.dodge??0}%`;

  if (ui.jetFuelText) ui.jetFuelText.textContent = `${jf}`;
}

export function updateHPBars(){
  const you = Math.max(0, GameState.battle.playerHP);
  const en  = Math.max(0, GameState.battle.enemyHP);
  const youMax = GameState.ms.current.health;
  const enMax  = GameState.battle.enemyMaxHP || Math.max(en, 1); // lock from scene.resetBattle()

  if (ui.youFill)   ui.youFill.style.width   = `${Math.floor(100*you/youMax)}%`;
  if (ui.enemyFill) ui.enemyFill.style.width = `${Math.floor(100*en/enMax)}%`;

  if (ui.youHPLabel)   ui.youHPLabel.textContent   = `${you}/${youMax}`;
  if (ui.enemyHPLabel) ui.enemyHPLabel.textContent = `${en}/${enMax}`;
}

export function renderSquadStats(){
  if (ui.squadAtk)  ui.squadAtk.textContent = String(GameState.squad.attack);
  if (ui.squadSpd)  ui.squadSpd.textContent = String(GameState.squad.speed);
  if (ui.squadDef)  ui.squadDef.textContent = String(GameState.squad.defense);
  if (ui.squadSyn)  ui.squadSyn.textContent = GameState.squad.solo ? 'Solo +50% ATK / +20% SPD' : (GameState.squad.synergy>1 ? '+10% ATK (synergy)' : '—');
}
