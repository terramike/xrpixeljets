// XRPixel Jets — main.js (2025-11-21-thorns1)
// Root: Energy is SERVER-AUTHORITATIVE. Minimal overlay that paints Squad ATK/SPD/DEF
// as (Main + Wing + Accessories) and keeps HIT/CRIT/DODGE chips in sync.

import * as SrvAPI from './serverApi.js';
import { GameState } from './state.js';
import { buildMissionOptions, getMission, unlockNextIfNeeded } from './missions.js';
import {
  updateEnergyUI, updateJetFuelUI, renderSquadStats,
  setMainCard, setWingCard, paintMSBasics, paintMSPct,
  updateHPBars
} from './ui.js';
import { renderJets, recalcSquad } from './jets.js';
import * as SceneMod from './scene.js';
import { installBattleTuning } from './battle-tuning.js';
import { getAccessoryBonuses, applyAccessoryBonuses, refreshAccessoryPanel } from '/jets/js/accessories.js';
import { getCombatEffectsForWallet } from '/jets/js/combat-effects.js';

const ECON_SCALE = 0.10;
const KEY_LAST   = 'JETS_LAST_MISSION';

const $ = (s) => document.querySelector(s);
const log = (...a) => console.log('[Jets]', ...a);
function logLine(msg){
  const el = document.getElementById('log'); if (!el) return;
  const d = document.createElement('div'); d.className='log-line'; d.textContent = String(msg);
  el.appendChild(d); el.scrollTop = el.scrollHeight;
}
const toNum = (x,d=0)=>{ const n=Number(x); return Number.isFinite(n)?n:d; };

// --- HOTFIX: force Squad totals (Main + Wing + Accessory) into UI pills ---
function getAcc(){ return (GameState?.accBonuses) || {}; }
function num(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
function computeBaseFromSelected(){
  const mj = (GameState.mainJet?.stats) || {};
  const wj = (GameState.wingJet?.stats) || {};
  return {
    attack:  num(mj.attack)  + num(wj.attack),
    speed:   num(mj.speed)   + num(wj.speed),
    defense: num(mj.defense) + num(wj.defense),
  };
}

function renderSquadTotalsAdjusted(){
  // Prefer the already-computed squad (from recalcSquad), else fall back to raw jet stats
  const squad = (GameState?.squad) || {};
  let baseAtk = Number(squad.attack  || 0);
  let baseSpd = Number(squad.speed   || 0);
  let baseDef = Number(squad.defense || 0);

  if (!baseAtk && !baseSpd && !baseDef) {
    const mj = (GameState.mainJet?.stats) || {};
    const wj = (GameState.wingJet?.stats) || {};
    baseAtk = Number(mj.attack||0)  + Number(wj.attack||0);
    baseSpd = Number(mj.speed ||0)  + Number(wj.speed ||0);
    baseDef = Number(mj.defense||0) + Number(wj.defense||0);
  }

  // Accessory deltas (best-of PER STAT)
  const b = (GameState?.accBonuses) || {};
  const dAtk = Number(b.attack||0);
  const dSpd = Number(b.speed ||0);
  const dDef = Number(b.defense||0);

  // If we truly have no base and no bonuses yet, don't touch the UI (avoid zeroing)
  const hasBase = (baseAtk+baseSpd+baseDef) > 0;
  const hasAcc  = (dAtk+dSpd+dDef + Number(b.hit||0) + Number(b.crit||0) + Number(b.dodge||0)) > 0;
  if (!hasBase && !hasAcc) return;

  // Squad pills (totals)
  const elA = document.getElementById('squad-atk');
  const elS = document.getElementById('squad-spd');
  const elD = document.getElementById('squad-def');
  if (elA) { elA.textContent = String(baseAtk + dAtk); elA.title = `ATK = ${baseAtk} + ${dAtk}`; }
  if (elS) { elS.textContent = String(baseSpd + dSpd); elS.title = `SPD = ${baseSpd} + ${dSpd}`; }
  if (elD) { elD.textContent = String(baseDef + dDef); elD.title = `DEF = ${baseDef} + ${dDef}`; }

  // PCT chips (base from GameState.pct + accessory bonuses)
  const pctBase = GameState?.pct || {};
  const baseHit  = Number(pctBase.hit  || 0);
  const baseCrit = Number(pctBase.crit || 0);
  const baseDdg  = Number(pctBase.dodge|| 0);
  const dHit  = Number(b.hit  || 0);
  const dCrit = Number(b.crit || 0);
  const dDdg  = Number(b.dodge|| 0);

  const elH = document.getElementById('ms-hit');
  const elC = document.getElementById('ms-crit');
  const elG = document.getElementById('ms-dodge');
  if (elH) { elH.textContent = `${baseHit + dHit}%`;  elH.title = `HIT% = ${baseHit}% + ${dHit}%`; }
  if (elC) { elC.textContent = `${baseCrit + dCrit}%`; elC.title = `CRIT% = ${baseCrit}% + ${dCrit}%`; }
  if (elG) { elG.textContent = `${baseDdg + dDdg}%`;  elG.title = `DODGE% = ${baseDdg}% + ${dDdg}%`; }
}
// --- end HOTFIX ---

// -------- scene adapter --------
function resolveSceneInstance() {
  if (SceneMod && typeof SceneMod.SCENE === 'object') return SceneMod.SCENE;
  if (SceneMod?.default) {
    const d = SceneMod.default;
    if (typeof d === 'object') return d;
    if (typeof d === 'function') { try { return new d(); } catch {} }
  }
  if (typeof SceneMod?.BattleScene === 'function') { try { return new SceneMod.BattleScene(); } catch {} }
  if (typeof window !== 'undefined' && typeof window.SCENE === 'object') return window.SCENE;
  console.warn('[Jets] scene.js didn’t export a usable instance; using a stub.');
  return { inBattle:false, seed(){}, simulateTurn(){}, startBattle(){}, nextTurn(){}, resetBattle(){}, playerHP:20, playerMaxHP:20, enemyHP:20, enemyMaxHP:20 };
}
const SCENE = resolveSceneInstance();
const callScene = (names, ...args) => { for (const n of names) { const fn = SCENE && typeof SCENE[n] === 'function' ? SCENE[n] : null; if (fn) return fn.apply(SCENE, args); } };
const sceneSeed  = (...a) => callScene(['seed','init','start','setLevel','reset','setup'], ...a);
const sceneNext  = (...a) => callScene(['simulateTurn','nextTurn','step','turn','next'], ...a);
const sceneStart = (...a) => callScene(['startBattle','seed','start','init'], ...a);
const sceneReset = (...a) => callScene(['resetBattle','reset','seed','init'], ...a);

// ⭐ Install combat tuning (initiative + variance + energy gate)
let CURRENT_LEVEL = 1;
installBattleTuning({ scene: SCENE, getMission, getCurrentLevel: () => CURRENT_LEVEL });

// ⭐ Bridge emoji combat log events into the UI
window.addEventListener('jets:combatlog', (ev) => { if (ev?.detail) logLine(ev.detail); });

// ------- energy state & UI helpers (server-authoritative) -------
function energy(){ return Math.max(0, Number(GameState.energy||0)); }
function setEnergyFromServer(val){
  GameState.energy = Math.max(0, Number(val||0));
  updateEnergyUI();
  dispatchProfile();
  refreshActionButtons();
}
function canSpend(cost){ return energy() >= Math.max(0, cost|0); }

// ------- costs preview -------
const Queue = { health:0, energyCap:0, regenPerMin:0, hit:0, crit:0, dodge:0 };
function renderQueue(){
  const ids = { health:'q-hp', energyCap:'q-cap', regenPerMin:'q-reg', hit:'q-hit', crit:'q-crit', dodge:'q-dodge' };
  for (const k in ids){ const el = $('#'+ids[k]); if (el) el.textContent = String(Queue[k]||0); }
}
function parseCostsShape(res){
  let c=res?.costs;
  if(!c){
    c={ health:res?.health?.next??res?.health,
        energyCap:res?.energyCap?.next??res?.energyCap,
        regenPerMin:res?.regenPerMin?.next??res?.regenPerMin,
        hit:res?.hit?.next??res?.hit,
        crit:res?.crit?.next??res?.crit,
        dodge:res?.dodge?.next??res?.dodge };
  }
  return {
    health:toNum(c?.health), energyCap:toNum(c?.energyCap), regenPerMin:toNum(c?.regenPerMin),
    hit:toNum(c?.hit), crit:toNum(c?.crit), dodge:toNum(c?.dodge)
  };
}
async function previewCost(){
  try{
    const raw = await SrvAPI.getMsCosts({ econScale: ECON_SCALE });
    const n = parseCostsShape(raw);
    let total=0;
    total+=n.health*(Queue.health||0);
    total+=n.energyCap*(Queue.energyCap||0);
    total+=n.regenPerMin*(Queue.regenPerMin||0);
    total+=n.hit*(Queue.hit||0);
    total+=n.crit*(Queue.crit||0);
    total+=n.dodge*(Queue.dodge||0);
    const qEl=$('#q-cost'); if(qEl) qEl.textContent=String(total);
    [['cost-hp',n.health],['cost-cap',n.energyCap],['cost-reg',n.regenPerMin],['cost-hit',n.hit],['cost-crit',n.crit],['cost-dodge',n.dodge]]
      .forEach(([id,val])=>{ const el=$('#'+id); if(el) el.textContent=String(val); });
  } catch { const qEl=$('#q-cost'); if(qEl) qEl.textContent='—'; }
}

// ------- wallet/session -------
function setWallet(addr){
  window.CURRENT_WALLET = addr;
  try { localStorage.setItem('WALLET', addr); } catch {}
  const i=$('#xrpl-address'); if (i && addr) i.value = addr;
}
async function bootWallet(){
  const addr = (localStorage.getItem('WALLET') || '').trim();
  if (!addr || !addr.startsWith('r')) { log('No signed-in wallet yet.'); return null; }
  setWallet(addr);
  await SrvAPI.startSession(addr);
  return addr;
}

// ------- profile + HUD -------
function dispatchProfile() {
  const detail = {
    energy: GameState.energy|0,
    jetFuel: GameState.jetFuel|0,
    ms: GameState.ms,
    energyCap: GameState.ms?.current?.energyCap ?? 100
  };
  try { window.dispatchEvent(new CustomEvent('jets:profile', { detail })); } catch {}
}

async function loadProfileAndHUD(){
  const prof = await SrvAPI.getProfile(); // server applies regen here
  GameState.ms = prof.ms;
  GameState.pct = prof.pct;
  GameState.jetFuel = prof.jetFuel|0;
  setEnergyFromServer(prof.energy|0);
  updateJetFuelUI(GameState.jetFuel);
  buildMissionOptions(prof.unlockedLevel|0);
  CURRENT_LEVEL = getSelectedLevel();
  paintMSBasics(); paintMSPct(); updateHPBars();
  renderSquadTotalsAdjusted();
  await previewCost();
  log('Profile loaded.', prof);
  return prof;
}

// Periodic sync to surface regen (no client prediction)
let syncTimer = null;
function startServerEnergySync(){
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(async ()=>{
    try{
      const prof = await SrvAPI.getProfile();
      GameState.ms = prof.ms; GameState.pct = prof.pct;
      GameState.jetFuel = prof.jetFuel|0; updateJetFuelUI(GameState.jetFuel);
      setEnergyFromServer(prof.energy|0);
      paintMSBasics(); paintMSPct(); updateHPBars();
      renderSquadTotalsAdjusted();
    } catch(e){ /* transient; ignore */ }
  }, 25000);
}

// ------- Accessories wiring (additive, non-invasive) -------
// Cache bonuses on GameState and refresh the tiny panel.
async function updateAccessoriesForWallet(addr){
  const w = addr || (document.getElementById('xrpl-address')?.value||'').trim();
  if (!w || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(w)) return;
  try {
    const payload = await getAccessoryBonuses(w, { force:true });
    GameState.accBonuses = payload?.bonuses || null;
    refreshAccessoryPanel(w);
    try { window.dispatchEvent(new CustomEvent('jets:accessories', { detail: { wallet:w, bonuses: GameState.accBonuses } })); } catch {}
    renderSquadTotalsAdjusted();
  } catch {}
}

// ------- Combat Effects wiring (Damage Shield, bonus attacks) -------
// Merge: combat NFTs (from combat-effects.js) + legendary jet thorns (Main/Wing)
async function updateCombatEffectsForWallet(addr){
  const w = (addr || window.CURRENT_WALLET || '').trim();
  if (!w || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(w)) {
    GameState.combatEffects = { damageShieldPerHit: 0, bonusAttacksPerTurn: 0 };
    if (SCENE && typeof SCENE === 'object') {
      SCENE.effects = { damageShieldPerHit: 0, bonusAttacksPerTurn: 0 };
    }
    return;
  }

  try {
    const base = await getCombatEffectsForWallet(w, { force: true });
    const main = GameState.mainJet || {};
    const wing = GameState.wingJet || {};

    const dsMain = Number(
      main.damageShieldPerHit ??
      main.dmgShield ??
      main.stats?.damageShieldPerHit ??
      0
    );
    const dsWing = Number(
      wing.damageShieldPerHit ??
      wing.dmgShield ??
      wing.stats?.damageShieldPerHit ??
      0
    );

    const dsLedger = Number(base?.damageShieldPerHit || 0);
    const bonusAttacks = Number(base?.bonusAttacksPerTurn || 0);

    const totalDS = Math.max(0, Math.min(10, dsLedger + dsMain + dsWing));
    const totalBA = Math.max(0, Math.min(2, bonusAttacks));

    const effects = {
      damageShieldPerHit: totalDS,
      bonusAttacksPerTurn: totalBA
    };

    GameState.combatEffects = effects;
    if (SCENE && typeof SCENE === 'object') {
      SCENE.effects = { ...effects };
    }

    try {
      window.dispatchEvent(new CustomEvent('jets:combatfx', { detail: { wallet: w, effects } }));
    } catch {}
    console.log('[Jets] CombatFX', effects);
  } catch (e) {
    console.warn('[Jets] combat effects load failed', e);
  }
}

// ------- XRPL Jets render -------
function loadScriptOnce(src){
  return new Promise((resolve, reject)=>{
    const existing = Array.from(document.scripts).find(s => (s.src||'').includes(src));
    if (existing && existing.dataset.loaded === '1') return resolve();
    if (existing) { existing.addEventListener('load', resolve); existing.addEventListener('error', () => reject(new Error('load fail: '+src))); return; }
    const s = document.createElement('script');
    s.src = src; s.async=false; s.crossOrigin='anonymous';
    s.addEventListener('load', () => { s.dataset.loaded='1'; resolve(); });
    s.addEventListener('error', () => reject(new Error('load fail: '+src)));
    document.head.appendChild(s);
  });
}
async function ensureXRPLStack() {
  if (!window.xrpl) await loadScriptOnce('/jets/js/vendor/xrpl-latest-min.js');
  await loadScriptOnce('/jets/js/wallet-xrpl.js?v=2025-11-20w2');
  await loadScriptOnce('/jets/js/wallet-jets-meta.js?v=2025-11-21jets19ds1');
  if (!window.XRPLWallet || typeof window.XRPLWallet.loadXRPLJets !== 'function') {
    console.warn('[Jets] XRPLWallet.loadXRPLJets not available after meta load.');
  }
}

async function loadAndRenderJets(address){
  try{
    if (!window.xrpl || !window.XRPLWallet) await ensureXRPLStack();
    if (!window.XRPLWallet || typeof window.XRPLWallet.loadXRPLJets !== 'function') {
      console.warn('[Jets] XRPLWallet.loadXRPLJets not available.');
      return;
    }
    const jets = await window.XRPLWallet.loadXRPLJets(address);
    GameState.jets = jets || [];
    renderJets(
      (jet)=>{
        GameState.mainJet = jet;
        setMainCard(jet);
        if (!GameState.wingJet) {
          GameState.wingJet = GameState.mainJet;
          setWingCard(GameState.wingJet);
        }
        recalcSquad();
        renderSquadStats();
        renderSquadTotalsAdjusted();
        // Recompute combat effects whenever Main changes
        updateCombatEffectsForWallet(window.CURRENT_WALLET);
      },
      (jet)=>{
        GameState.wingJet = jet;
        setWingCard(jet);
        if (!GameState.mainJet) {
          GameState.mainJet = GameState.wingJet;
          setMainCard(GameState.mainJet);
        }
        recalcSquad();
        renderSquadStats();
        renderSquadTotalsAdjusted();
        // Recompute combat effects whenever Wing changes
        updateCombatEffectsForWallet(window.CURRENT_WALLET);
      },
      GameState.jets
    );
    if (!GameState.mainJet && GameState.jets[0]) { GameState.mainJet=GameState.jets[0]; setMainCard(GameState.mainJet); }
    if (!GameState.wingJet && GameState.mainJet) { GameState.wingJet=GameState.mainJet; setWingCard(GameState.wingJet); }
    recalcSquad(); renderSquadStats(); renderSquadTotalsAdjusted();
    await updateAccessoriesForWallet(address);
    await updateCombatEffectsForWallet(address);
    log(`Loaded ${GameState.jets.length} XRPL Jets.`);
    // NEW: update buttons now that we know if a Jet exists
    refreshActionButtons();
  } catch(e){ console.error(e); }
}

// ------- mission selection helpers -------
function getSelectedLevel(){
  const sel = document.getElementById('sel-mission') || document.getElementById('mission');
  const v = parseInt(sel?.value || localStorage.getItem(KEY_LAST) || '1', 10);
  const lvl = Number.isFinite(v) && v>0 ? v : 1;
  CURRENT_LEVEL = lvl;
  try { localStorage.setItem(KEY_LAST, String(lvl)); } catch {}
  return lvl;
}
function setSelectedLevel(lvl){
  const sel = document.getElementById('sel-mission') || document.getElementById('mission');
  if (!sel) return;
  const want = String(Math.max(1, Number(lvl)||1));
  if (sel.value !== want) sel.value = want;
  CURRENT_LEVEL = Number(want);
  try { localStorage.setItem(KEY_LAST, want); } catch {}
}

// ------- jet gate helper -------
// NEW: require at least one XRPixel Jet before missions can start
function hasPixelJet(){
  const jets = GameState?.jets;
  return Array.isArray(jets) && jets.length > 0;
}

// ------- buttons state -------
function refreshActionButtons(){
  const inBattle = !!SCENE?.inBattle;
  const start = $('#btn-start');
  const next  = $('#btn-next');
  const reset = $('#btn-restart');

  const canFly = hasPixelJet(); // NEW

  if (start) start.disabled = inBattle || !canSpend(10) || !canFly;
  if (next)  next.disabled  = !inBattle || !canSpend(1);
  if (reset) reset.disabled = false;
}

// ------- battle handlers (no optimistic spending) -------
async function handleStart(){
  // NEW: hard gate start if no Jet loaded
  if (!hasPixelJet()) {
    logLine('⛔ You need an XRPixel Jet to fly missions. Load your Jets from the XRPL first.');
    refreshActionButtons();
    return;
  }

  if (!canSpend(10)) { logLine('Not enough energy to start (10⚡).'); return; }
  await updateAccessoriesForWallet(window.CURRENT_WALLET);
  await updateCombatEffectsForWallet(window.CURRENT_WALLET);

  const start = $('#btn-start'); if (start) start.disabled = true;
  try{
    const res = await SrvAPI.battleStart();
    const e = toNum(res?.profile?.energy ?? res?.energy, energy());
    setEnergyFromServer(e);

    setSelectedLevel(getSelectedLevel());
    sceneStart();
    SCENE.inBattle = true;
    logLine(`Mission ${CURRENT_LEVEL} started! (-10⚡)`);
    updateHPBars();
  } catch(e){
    console.error(e); logLine('Start failed.');
  } finally {
    refreshActionButtons();
  }
}

async function handleNextTurn(){
  if (!SCENE?.inBattle) { logLine('⛔ No active battle. Press Start (10⚡).'); refreshActionButtons(); return; }
  if (!canSpend(1)) { logLine('Not enough energy for next turn (1⚡).'); return; }

  const next = $('#btn-next'); if (next) next.disabled = true;
  try{
    const res = await SrvAPI.battleTurn();
    const e = toNum(res?.profile?.energy ?? res?.energy, energy());
    setEnergyFromServer(e);
  } catch(e){
    console.error(e); logLine('Turn spend failed.');
    refreshActionButtons();
    return;
  } finally {
    refreshActionButtons();
  }

  sceneNext();
  updateHPBars();

  const enemyDown = (SCENE?.enemyHP|0) <= 0;
  const youDown   = (SCENE?.playerHP|0) <= 0;

  if (enemyDown) {
    try{
      const fin = await SrvAPI.battleFinish({ level: CURRENT_LEVEL, victory: true });
      GameState.jetFuel = Number(fin?.profile?.jetFuel ?? GameState.jetFuel);
      updateJetFuelUI();
      const reward = Number(fin?.reward||0);
      logLine(reward>0 ? `🏆 Victory! +${reward} JetFuel 🚀` : '🏆 Victory!');
      const unlocked = Number(fin?.profile?.unlockedLevel || GameState.unlockedLevel || 1);
      GameState.unlockedLevel = unlockNextIfNeeded(CURRENT_LEVEL, true, unlocked);
      buildMissionOptions(GameState.unlockedLevel);
      setSelectedLevel(CURRENT_LEVEL);
    } catch(e){
      console.error(e); logLine('Victory! (server ack failed)');
    }
    refreshActionButtons();
  } else if (youDown) {
    logLine('💀 Defeat…');
    refreshActionButtons();
  }
}

function handleReset(){
  sceneReset();
  SCENE.inBattle = false;
  updateHPBars();
  refreshActionButtons();
  logLine('Battle reset.');
}

// ------- upgrades -------
function bindUpgradeButtons(){
  const map = [
    ['btn-up-hp','health'], ['btn-up-cap','energyCap'], ['btn-up-reg','regenPerMin'],
    ['btn-up-hit','hit'], ['btn-up-crit','crit'], ['btn-up-dodge','dodge']
  ];
  map.forEach(([id,key])=>{
    const b = $('#'+id); if (!b) return;
    b.addEventListener('click', async ()=>{
      Queue[key] = (Queue[key]||0) + 1;
      renderQueue();
      await previewCost();
    });
  });

  const btnClear = $('#btn-clear-queue');
  if (btnClear) btnClear.addEventListener('click', async ()=>{
    Object.keys(Queue).forEach(k=>Queue[k]=0);
    renderQueue();
    await previewCost();
  });

  const btnApply = $('#btn-apply-upgrades');
  if (btnApply) btnApply.addEventListener('click', async ()=>{
    try{
      const res = await SrvAPI.msUpgrade(Queue);
      Object.keys(Queue).forEach(k=>Queue[k]=0);
      renderQueue();

      const prof = res?.profile || await SrvAPI.getProfile();
      GameState.ms = prof.ms; GameState.pct = prof.pct;
      GameState.jetFuel = prof.jetFuel|0; setEnergyFromServer(prof.energy|0);
      updateJetFuelUI(); paintMSBasics(); paintMSPct(); updateHPBars();
      renderSquadTotalsAdjusted();
      await previewCost();
      logLine('Upgrades applied.');
    } catch { logLine('Upgrade failed.'); }
  });
}

// ------- bindings -------  
let BOUND = false;
function bindUI(){
  if (BOUND) return; BOUND = true;

  const sel = document.getElementById('sel-mission') || document.getElementById('mission');
  if (sel) {
    sel.addEventListener('change', ()=>{
      const lvl = getSelectedLevel();
      setSelectedLevel(lvl);
      sceneSeed(lvl);
      updateHPBars();
      logLine(`Mission set to ${lvl}.`);
      renderSquadTotalsAdjusted();          // repaint after mission change
      refreshActionButtons();
    });
  }

  const bStart = $('#btn-start');   if (bStart) bStart.addEventListener('click', handleStart);
  const bNext  = $('#btn-next');    if (bNext)  bNext.addEventListener('click', handleNextTurn);
  const bReset = $('#btn-restart'); if (bReset) bReset.addEventListener('click', handleReset);

  // Repaint on wallet auth, accessory refresh, and profile repaint events
  window.addEventListener('jets:auth', (ev) => {
    const w = ev?.detail?.address || window.CURRENT_WALLET;
    updateAccessoriesForWallet(w);
    updateCombatEffectsForWallet(w);
    renderSquadTotalsAdjusted();
  });
  window.addEventListener('jets:accessories', ()=>renderSquadTotalsAdjusted());
  window.addEventListener('jets:profile',     ()=>renderSquadTotalsAdjusted());

  bindUpgradeButtons();
  refreshActionButtons();
}

// ------- boot -------
async function init(){
  log('Booting… energy-single-writer');

  bindUI();

  const addr = await bootWallet();
  if (addr) {
    setWallet(addr);
    await updateAccessoriesForWallet(addr); // fetch bonuses and render panel on boot
    await updateCombatEffectsForWallet(addr);
  }

  await loadProfileAndHUD();

  const lvl = getSelectedLevel();
  setSelectedLevel(lvl);
  sceneSeed(lvl);
  updateHPBars();

  if (addr) await loadAndRenderJets(addr);

  // Start gentle server sync to surface regen (no client prediction)
  startServerEnergySync();

  log('Ready.');
  refreshActionButtons();
}

// Auto-run
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
