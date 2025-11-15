// jets/js/ui.js — XRPixel Jets MKG (2025-10-24 bars-solid)
// Minimal upgrade (2025-11-01revert1): resolve Main/Wing image to HTTP sprite xrpixeljet_<N>.png

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

// -------- NEW: map selected jet image to HTTP sprite by hull index --------
function resolveSelectedImg(jet) {
  // Try the XRPixelJet trait (e.g., "jet42")
  let raw = null;

  // 1) From normalized traits map if present
  if (jet?.traits && typeof jet.traits === 'object') {
    raw = jet.traits.XRPixelJet || jet.traits['XRPixelJet'];
  }

  // 2) From attributes array (common in XRPL JSON)
  if (!raw && Array.isArray(jet?.attributes)) {
    const t = jet.attributes.find(a => String(a?.trait_type).toLowerCase() === 'xrpixeljet');
    if (t?.value) raw = t.value;
  }

  // 3) From any field that looks like "jetNN"
  if (!raw && typeof jet?.XRPixelJet === 'string') raw = jet.XRPixelJet;
  if (!raw && typeof jet?.hull === 'string') raw = jet.hull;

  // Parse number from "jet42" or "…_42"
  let idx = 1;
  const m = String(raw || '').match(/(\d{1,3})/);
  if (m) {
    idx = Math.max(1, Math.min(111, parseInt(m[1], 10)));
  } else {
    // fallback: try to infer from image filename
    const im = String(jet?.image || '');
    const m2 = im.match(/(?:jet|xrpixeljet)[^\d]*?(\d{1,3})/i);
    if (m2) idx = Math.max(1, Math.min(111, parseInt(m2[1], 10)));
  }

  return `https://mykeygo.io/jets/assets/xrpixeljet_${idx}.png`;
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

// -------- Main/Wing cards (reverted behavior; only image src logic tweaked) --------
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
  if (imgEl) {
    // Use local HTTP sprite by hull index for selected view
    imgEl.src = resolveSelectedImg(j);
  }
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
  if (imgEl) {
    // Use local HTTP sprite by hull index for selected view
    imgEl.src = resolveSelectedImg(j);
  }
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
