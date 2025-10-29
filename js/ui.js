// jets/js/ui.js — XRPixel Jets MKG (2025-10-24 bars-solid)
// Fixes: selects bar fills by class per your current index.html.
// Energy:  #hud-top .energyfill
// Player:  #hud-top .playerfill
// Enemy:   #hud-top .enemyfill

import { GameState } from './state.js';

// -------- small DOM helpers --------
const $ = (s) => document.querySelector(s);
function setText(el, val) { if (el) el.textContent = (val ?? '—'); }
function byIds(ids) { for (const id of ids) { const el = document.getElementById(id); if (el) return el; } return null; }
function setBarFill(el, value, max) {
  if (!el) return;
  const pct = (!max || max <= 0) ? 0 : Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  el.style.width = pct + '%';
  el.setAttribute?.('data-pct', String(pct));
}

// -------- Squad Stats --------
export function renderSquadStats() {
  const s = GameState?.squad || { attack: 0, speed: 0, defense: 0, synergy: 1, synergyText: '—' };

  const atkEl = byIds(['s-atk', 'squad-atk', 'squad_attack', 'squadAtk']);
  const spdEl = byIds(['s-spd', 'squad-spd', 'squad_speed', 'squadSpd']);
  const defEl = byIds(['s-def', 'squad-def', 'squad_defense', 'squadDef']);
  const synEl = byIds(['s-syn', 'squad-syn', 'squad_synergy', 'squadSyn']);

  setText(atkEl, s.attack|0);
  setText(spdEl, s.speed|0);
  setText(defEl, s.defense|0);
  setText(synEl, s.synergyText || `${(s.synergy||1).toFixed(1)}×`);
}

// -------- Main/Wing cards --------
export function setMainCard(jetOrNull) {
  const nameEl = byIds(['main-name','main_name','mainName']);
  const gunsEl = byIds(['main-guns','main_guns','mainGuns']);
  const imgEl  = byIds(['main-img','main_img','mainImg']);

  if (!jetOrNull) {
    setText(nameEl, '—');
    setText(gunsEl, '— | —');
    if (imgEl) imgEl.src = '/jets/assets/placeholder.png';
    return;
  }
  const j = jetOrNull;
  setText(nameEl, j.name || 'XRPixel Jet');
  setText(gunsEl, `${j.top_gun || '—'} | ${j.bottom_gun || '—'}`);
  if (imgEl && j.image) imgEl.src = j.image;
}

export function setWingCard(jetOrNull) {
  const nameEl = byIds(['wing-name','wing_name','wingName']);
  const gunsEl = byIds(['wing-guns','wing_guns','wingGuns']);
  const imgEl  = byIds(['wing-img','wing_img','wingImg']);

  if (!jetOrNull) {
    setText(nameEl, '—');
    setText(gunsEl, '— | —');
    if (imgEl) imgEl.src = '/jets/assets/placeholder.png';
    return;
  }
  const j = jetOrNull;
  setText(nameEl, j.name || 'XRPixel Jet');
  setText(gunsEl, `${j.top_gun || '—'} | ${j.bottom_gun || '—'}`);
  if (imgEl && j.image) imgEl.src = j.image;
}

// -------- Energy / JF / HP --------
export function updateEnergyUI() {
  const cap = Number(GameState?.ms?.current?.energyCap ?? GameState?.ms?.base?.energyCap ?? 100);
  const val = Number(GameState?.energy ?? 0);

  // text
  const textEl = byIds(['energy-text','energyText','energy_value']);
  setText(textEl, `${val}/${cap}`);

  // fill (match your current HTML structure)
  const fillEl = $('#hud-top .energyfill');
  setBarFill(fillEl, val, cap);
}

export function updateJetFuelUI() {
  const jfEl = byIds(['jetfuel','jet_fuel','jf-value','jfValue','jetfuel-ms']);
  setText(jfEl, GameState?.jetFuel ?? 0);
}

export function updateHPBars() {
  // Text IDs in your HTML:
  const pNowText = byIds(['player-hp-text','hp-player','hp_player','hpPlayer']);
  const eNowText = byIds(['enemy-hp-text','hp-enemy','hp_enemy','hpEnemy']);

  // Prefer live SCENE values, fallback to GameState.scene if present.
  const pNow = Number(window?.SCENE?.playerHP ?? GameState?.scene?.playerHP ?? 0);
  const pMax = Number(window?.SCENE?.playerMaxHP ?? GameState?.scene?.playerMaxHP ?? 0);
  const eNow = Number(window?.SCENE?.enemyHP  ?? GameState?.scene?.enemyHP  ?? 0);
  const eMax = Number(window?.SCENE?.enemyMaxHP ?? GameState?.scene?.enemyMaxHP ?? 0);

  setText(pNowText, `${pNow}/${pMax || 0}`);
  setText(eNowText, `${eNow}/${eMax || 0}`);

  // fills by class (per your index.html)
  const pFill = $('#hud-top .playerfill');
  const eFill = $('#hud-top .enemyfill');
  setBarFill(pFill, pNow, pMax);
  setBarFill(eFill, eNow, eMax);
}

// Paint mothership basics and percent pills
export function paintMSBasics() {
  const hp = Number(GameState?.ms?.current?.health ?? GameState?.ms?.base?.health ?? 20);
  const cap = Number(GameState?.ms?.current?.energyCap ?? GameState?.ms?.base?.energyCap ?? 100);
  const reg = Number(GameState?.ms?.current?.regenPerMin ?? GameState?.ms?.base?.regenPerMin ?? 1);

  setText(byIds(['ms-hp','ms_hp','msHp','ms-health']), hp);
  setText(byIds(['ms-cap','ms_cap','msCap']), cap);
  setText(byIds(['ms-reg','ms_reg','msReg','ms-regen']), reg);
}

export function paintMSPct() {
  const pct = GameState?.pct || { hit:0, crit:0, dodge:0 };
  setText(byIds(['ms-hit','ms_hit','msHit']),  pct.hit|0);
  setText(byIds(['ms-crit','ms_crit','msCrit']), pct.crit|0);
  setText(byIds(['ms-dodge','ms_dodge','msDodge']), pct.dodge|0);
}

// Bulk repaint
export function syncHUDAll() {
  paintMSBasics();
  paintMSPct();
  updateEnergyUI();
  renderSquadStats();
  updateHPBars();
}
