// jets/js/ui.js — XRPixel Jets MKG (2025-11-19 mothership-level2)
// Rebuilt HUD/UI module with Mothership Level + squad, HP, energy and cards.

import { GameState } from './state.js';
import { DEFAULT_MS } from './constants.js';

// -------- small DOM helpers --------
const $ = (s) => document.querySelector(s);

function setText(el, val) {
  if (!el) return;
  el.textContent = (val ?? '—');
}

function byIds(ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) return el;
  }
  return null;
}

function setBarFill(el, value, max) {
  if (!el) return;
  const v = Number(value || 0);
  const m = Number(max || 0);
  const pct = (!m || m <= 0)
    ? 0
    : Math.max(0, Math.min(100, Math.round((v / m) * 100)));
  el.style.width = pct + '%';
  if (typeof el.setAttribute === 'function') {
    el.setAttribute('data-pct', String(pct));
  }
}

// -------- Jet sprite resolver (for selected Main/Wing cards) --------
function resolveSelectedImg(jet) {
  if (!jet) {
    return '/jets/assets/placeholder.png';
  }

  // Try XRPixelJet trait name: "jet42", "XRPixeljet_72", etc.
  let raw = null;

  // Traits map style
  if (jet.traits && typeof jet.traits === 'object') {
    raw = jet.traits.XRPixelJet || jet.traits['XRPixelJet'];
  }

  // Attributes array style
  if (!raw && Array.isArray(jet.attributes)) {
    const t = jet.attributes.find(
      (a) => String(a?.trait_type).toLowerCase() === 'xrpixeljet'
    );
    if (t && t.value) raw = t.value;
  }

  // Direct props
  if (!raw && typeof jet.XRPixelJet === 'string') raw = jet.XRPixelJet;
  if (!raw && typeof jet.hull === 'string') raw = jet.hull;

  // Fallback to image filename
  if (!raw && typeof jet.image === 'string') {
    const mImg = jet.image.match(/(?:jet|xrpixeljet)[^\d]*?(\d{1,3})/i);
    if (mImg) raw = mImg[1];
  }

  // Extract numeric index
  let idx = 1;
  const m = String(raw || '').match(/(\d{1,3})/);
  if (m) {
    idx = Math.max(1, Math.min(111, parseInt(m[1], 10)));
  }

  return `https://mykeygo.io/jets/assets/xrpixeljet_${idx}.png`;
}

// -------- Squad Stats --------
export function renderSquadStats() {
  const s = GameState?.squad || {
    attack: 0,
    speed: 0,
    defense: 0,
    synergy: 1,
    synergyText: '—'
  };

  const atkEl = byIds(['squad-atk', 's-atk', 'squad_attack', 'squadAtk']);
  const spdEl = byIds(['squad-spd', 's-spd', 'squad_speed', 'squadSpd']);
  const defEl = byIds(['squad-def', 's-def', 'squad_defense', 'squadDef']);
  const synEl = byIds(['squad-syn', 's-syn', 'squad_synergy', 'squadSyn']);
  const detailEl = document.getElementById('squad-detail');

  setText(atkEl, s.attack | 0);
  setText(spdEl, s.speed | 0);
  setText(defEl, s.defense | 0);

  if (synEl) {
    const syn = Number(s.synergy || 1);
    const label = s.synergyText || `${syn.toFixed(1)}×`;
    synEl.textContent = label;
  }

  // Simple squad detail: show pattern of main/wing guns
  if (detailEl) {
    const m = GameState.mainJet || null;
    const w = GameState.wingJet || null;
    if (!m && !w) {
      detailEl.textContent = 'No squad selected';
    } else if (m && !w) {
      const tg = m.top_gun || '—';
      const bg = m.bottom_gun || '—';
      detailEl.textContent = `Main only: ${tg}/${bg}`;
    } else if (!m && w) {
      const tg = w.top_gun || '—';
      const bg = w.bottom_gun || '—';
      detailEl.textContent = `Wing only: ${tg}/${bg}`;
    } else {
      const mTop  = m.top_gun || '—';
      const mBot  = m.bottom_gun || '—';
      const wTop  = w.top_gun || '—';
      const wBot  = w.bottom_gun || '—';
      detailEl.textContent = `Main: ${mTop}/${mBot} · Wing: ${wTop}/${wBot}`;
    }
  }
}

// -------- Main/Wing cards --------
export function setMainCard(jetOrNull) {
  const imgEl  = document.getElementById('main-img');
  const cardEl = document.getElementById('main-card');

  if (!jetOrNull) {
    if (imgEl) imgEl.src = '/jets/assets/placeholder.png';
    if (cardEl) cardEl.textContent = 'Select a Main Jet';
    return;
  }

  const j = jetOrNull;
  if (imgEl) {
    imgEl.src = resolveSelectedImg(j);
  }

  if (cardEl) {
    const atk = j.attack ?? '—';
    const spd = j.speed ?? '—';
    const def = j.defense ?? '—';
    const top = j.top_gun || '—';
    const bot = j.bottom_gun || '—';
    const lines = [
      j.name || 'XRPixel Jet',
      `ATK ${atk} · SPD ${spd} · DEF ${def}`,
      `Guns: ${top} / ${bot}`
    ];
    cardEl.textContent = lines.join(' · ');
  }
}

export function setWingCard(jetOrNull) {
  const imgEl  = document.getElementById('wing-img');
  const cardEl = document.getElementById('wing-card');

  if (!jetOrNull) {
    if (imgEl) imgEl.src = '/jets/assets/placeholder.png';
    if (cardEl) cardEl.textContent = 'Select a Wing Jet';
    return;
  }

  const j = jetOrNull;
  if (imgEl) {
    imgEl.src = resolveSelectedImg(j);
  }

  if (cardEl) {
    const atk = j.attack ?? '—';
    const spd = j.speed ?? '—';
    const def = j.defense ?? '—';
    const top = j.top_gun || '—';
    const bot = j.bottom_gun || '—';
    const lines = [
      j.name || 'XRPixel Jet',
      `ATK ${atk} · SPD ${spd} · DEF ${def}`,
      `Guns: ${top} / ${bot}`
    ];
    cardEl.textContent = lines.join(' · ');
  }
}

// -------- Energy / JetFuel / HP HUD --------
export function updateEnergyUI() {
  const ms = GameState?.ms || DEFAULT_MS;
  const cap = Number(
    ms.current?.energyCap ??
    ms.base?.energyCap ??
    DEFAULT_MS.current.energyCap
  );
  const val = Number(GameState?.energy ?? 0);
  const regen = Number(
    ms.current?.regenPerMin ??
    ms.base?.regenPerMin ??
    DEFAULT_MS.current.regenPerMin
  );

  const textEl = document.getElementById('energy-text');
  if (textEl) {
    textEl.textContent = `${val}/${cap} (+${regen.toFixed(1)}/min)`;
  }

  const fillEl = document.querySelector('#hud-top .energyfill');
  setBarFill(fillEl, val, cap);
}

export function updateJetFuelUI(valOpt) {
  const jf = Number(
    valOpt != null ? valOpt : (GameState?.jetFuel ?? 0)
  );
  const inner = document.getElementById('jetfuel');
  if (inner) inner.textContent = String(jf);
}

export function updateHPBars() {
  const pNow = Number(window?.SCENE?.playerHP ?? GameState?.battle?.playerHP ?? 0);
  const pMax = Number(window?.SCENE?.playerMaxHP ?? GameState?.battle?.playerMaxHP ?? DEFAULT_MS.current.health);
  const eNow = Number(window?.SCENE?.enemyHP ?? GameState?.battle?.enemyHP ?? 0);
  const eMax = Number(window?.SCENE?.enemyMaxHP ?? GameState?.battle?.enemyMaxHP ?? 20);

  const pText = document.getElementById('player-hp-text');
  const eText = document.getElementById('enemy-hp-text');
  if (pText) pText.textContent = `${pNow}/${pMax}`;
  if (eText) eText.textContent = `${eNow}/${eMax}`;

  const pFill = document.querySelector('#hud-top .playerfill');
  const eFill = document.querySelector('#hud-top .enemyfill');
  setBarFill(pFill, pNow, pMax);
  setBarFill(eFill, eNow, eMax);
}

// -------- Mothership basics + Level --------
function computeMothershipLevel() {
  const ms = GameState?.ms || DEFAULT_MS;
  const lv = ms.level || {};
  const keys = ['health', 'energyCap', 'regenPerMin', 'hit', 'crit', 'dodge'];
  let total = 0;
  for (const k of keys) {
    total += lv[k] | 0;
  }
  if (!Number.isFinite(total) || total < 0) total = 0;

  // Optionally include extra levels if pct beats base
  const pct = GameState?.pct || {};
  const base = DEFAULT_MS.base || {};
  const extraHit  = Math.max(0, Number(pct.hit   ?? base.hit)   - Number(base.hit   ?? 0));
  const extraCrit = Math.max(0, Number(pct.crit  ?? base.crit)  - Number(base.crit  ?? 0));
  const extraDdg  = Math.max(0, Number(pct.dodge ?? base.dodge) - Number(base.dodge ?? 0));
  total += extraHit + extraCrit + extraDdg;

  return total;
}

export function paintMSBasics() {
  const ms = GameState?.ms || DEFAULT_MS;

  const hp = Number(
    ms.current?.health ??
    ms.base?.health ??
    DEFAULT_MS.current.health
  );
  const cap = Number(
    ms.current?.energyCap ??
    ms.base?.energyCap ??
    DEFAULT_MS.current.energyCap
  );
  const reg = Number(
    ms.current?.regenPerMin ??
    ms.base?.regenPerMin ??
    DEFAULT_MS.current.regenPerMin
  );

  // Label: "XRPixel Jet — Level N"
  const nameEl = document.getElementById('ms-name');
  const baseName = ms.name || DEFAULT_MS.name || 'Mothership';
  const lvl = computeMothershipLevel();
  if (nameEl) {
    nameEl.textContent = `${baseName} — Level ${lvl}`;
    nameEl.title = 'Mothership Level = total upgrade points across HP, Energy, Regen, Hit, Crit, Dodge.';
  }

  setText(document.getElementById('ms-health'), hp);
  setText(document.getElementById('ms-cap'), cap);
  setText(document.getElementById('ms-regen'), reg);
}

export function paintMSPct() {
  const pct = GameState?.pct || { hit: 0, crit: 0, dodge: 0 };
  setText(document.getElementById('ms-hit'), `${pct.hit | 0}%`);
  setText(document.getElementById('ms-crit'), `${pct.crit | 0}%`);
  setText(document.getElementById('ms-dodge'), `${pct.dodge | 0}%`);
}

// -------- Bulk repaint --------
export function syncHUDAll() {
  paintMSBasics();
  paintMSPct();
  updateEnergyUI();
  renderSquadStats();
  updateJetFuelUI();
  updateHPBars();
}
