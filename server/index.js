// XRPixel Jets — main.js (2025-10-25fix3; battle flow resilient)
import * as API from './serverApi.js';
import { GameState } from './state.js';
import { buildMissionOptions } from './missions.js';
import {
  updateEnergyUI, updateJetFuelUI, renderSquadStats,
  setMainCard, setWingCard, paintMSBasics, paintMSPct,
  updateHPBars, syncHUDAll
} from './ui.js';
import { renderJets, recalcSquad } from './jets.js';
import * as SceneMod from './scene.js';

const ECON_SCALE = 0.10;
const $ = (s) => document.querySelector(s);
const log = (...a) => console.log('[Jets]', ...a);
function logLine(msg){ const el=$('#log'); if(!el) return; const d=document.createElement('div'); d.className='log-line'; d.textContent=msg; el.appendChild(d); el.scrollTop=el.scrollHeight; }

// Scene adapter
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
const sceneSeed  = (...a) => (SCENE.seed||SCENE.init||SCENE.reset||(()=>{})).apply(SCENE,a);
const sceneStart = (...a) => (SCENE.startBattle||SCENE.seed||SCENE.init||(()=>{})).apply(SCENE,a);
const sceneNext  = (...a) => (SCENE.simulateTurn||SCENE.nextTurn||SCENE.turn||(()=>{})).apply(SCENE,a);
const sceneReset = (...a) => (SCENE.resetBattle||SCENE.reset||SCENE.seed||(()=>{})).apply(SCENE,a);

function dispatchProfile() {
  const detail = {
    energy: GameState.energy|0,
    jetFuel: GameState.jetFuel|0,
    ms: GameState.ms,
    energyCap: GameState.ms?.current?.energyCap ?? 100
  };
  window.dispatchEvent(new CustomEvent('jets:profile', { detail }));
}

// Upgrade queue
const Queue = { health:0, energyCap:0, regenPerMin:0, hit:0, crit:0, dodge:0 };
function toNum(x,d=0){ const n=Number(x); return Number.isFinite(n)?n:d; }
function parseCostsShape(res){
  let c=res?.costs;
  if(!c){
    c={
      health:res?.health?.next??res?.health??res?.nextHealth,
      energyCap:res?.energyCap?.next??res?.energyCap??res?.nextEnergyCap,
      regenPerMin:res?.regenPerMin?.next??res?.regenPerMin??res?.nextRegenPerMin,
      hit:res?.hit?.next??res?.nextHit??res?.hit,
      crit:res?.crit?.next??res?.nextCrit??res?.crit,
      dodge:res?.dodge?.next??res?.nextDodge??res?.dodge
    };
  }
  return {
    health:toNum(c?.health), energyCap:toNum(c?.energyCap), regenPerMin:toNum(c?.regenPerMin),
    hit:toNum(c?.hit), crit:toNum(c?.crit), dodge:toNum(c?.dodge)
  };
}
async function previewCost(){
  try{
    const raw = await API.getMsCosts({ econScale: ECON_SCALE });
    const n = parseCostsShape(raw);
    let total=0;
    total+=n.health*(Queue.health||0);
    total+=n.energyCap*(Queue.energyCap||0);
    total+=n.regenPerMin*(Queue.regenPerMin||0);
    total+=n.hit*(Queue.hit||0);
    total+=n.crit*(Queue.crit||0);
    total+=n.dodge*(Queue.dodge||0);
    const qEl=document.getElementById('q-cost'); if(qEl) qEl.textContent=String(total);
    [['cost-hp',n.health],['cost-cap',n.energyCap],['cost-reg',n.regenPerMin],['cost-hit',n.hit],['cost-crit',n.crit],['cost-dodge',n.dodge]]
      .forEach(([id,val])=>{ const el=document.getElementById(id); if(el) el.textContent=String(val); });
  } catch {
    const qEl=document.getElementById('q-cost'); if(qEl) qEl.textContent='—';
  }
}
function renderQueue() { const ids = { health:'q-hp', energyCap:'q-cap', regenPerMin:'q-reg', hit:'q-hit', crit:'q-crit', dodge:'q-dodge' }; for (const k in ids) { const el = $('#'+ids[k]); if (el) el.textContent = String(Queue[k]||0); } }

// Wallet/session boot
function setWallet(addr){ window.CURRENT_WALLET = addr; try { localStorage.setItem('WALLET', addr); } catch {} const i=$('#xrpl-address'); if (i && addr) i.value=addr; }
async function bootWallet() {
  let addr = (localStorage.getItem('WALLET') || '').trim();
  const i = $('#xrpl-address');
  if ((!addr || !addr.startsWith('r')) && i?.value?.startsWith('r')) addr = i.value.trim();
  if (!addr) { log('No wallet yet. You can still load NFTs manually.'); return null; }
  if (!addr.startsWith('r')) { console.warn('Use a classic r-address for server calls.'); return null; }
  setWallet(addr);
  await API.startSession(addr);
  return addr;
}
async function loadProfileAndHUD() {
  const prof = await API.getProfile();
  GameState.ms = prof.ms;
  GameState.pct = prof.pct;
  GameState.jetFuel = prof.jetFuel|0;
  GameState.energy = prof.energy|0;
  GameState.unlockedLevel = prof.unlockedLevel|0;

  updateJetFuelUI(GameState.jetFuel);
  updateEnergyUI();
  buildMissionOptions(GameState.unlockedLevel);
  paintMSBasics(); paintMSPct();
  renderSquadStats(); updateHPBars();
  dispatchProfile();
  log('[Jets] Profile loaded.', prof);
}

// Battle flow (resilient)
function currentLevel(){
  const sel = document.getElementById('sel-mission') || document.getElementById('mission');
  const v = parseInt(sel?.value || '1', 10);
  return Number.isFinite(v) && v>0 ? v : 1;
}
async function doStart(){
  const lvl = currentLevel();
  // Spend energy on server (non-blocking)
  const s = await API.battleStart({ level: lvl });
  if (s?.profile) {
    GameState.energy = s.profile.energy|0;
    GameState.jetFuel = s.profile.jetFuel|0;
    GameState.ms = s.profile.ms;
    updateEnergyUI(); updateJetFuelUI();
  } else if (s?.offline) {
    logLine('Server not available — starting in local demo mode.');
  }
  // Always start combat
  sceneStart();
}
async function doNext(){
  const s = await API.battleTurn({ level: currentLevel() });
  if (s?.profile) { GameState.energy = s.profile.energy|0; updateEnergyUI(); }
  sceneNext();

  // Detect finish & report outcome
  const win = (SCENE.enemyHP|0) <= 0;
  const lose = (SCENE.playerHP|0) <= 0;
  if (win || lose){
    const res = await API.battleFinish({ level: currentLevel(), victory: !!win });
    if (res?.profile) {
      GameState.jetFuel = res.profile.jetFuel|0;
      GameState.unlockedLevel = res.profile.unlockedLevel|0;
      updateJetFuelUI(); buildMissionOptions(GameState.unlockedLevel);
    }
    if (res?.reward) logLine(`Server reward: +${res.reward} JF.`);
  }
}
function doReset(){ sceneReset(); }

// Bindings
function bind(){
  if ($('#btn-start') && !$('#btn-start').__bound) {
    $('#btn-start').__bound = true;
    $('#btn-start').addEventListener('click', () => { doStart().catch(()=>{}); }, { passive:true });
  }
  if ($('#btn-next') && !$('#btn-next').__bound) {
    $('#btn-next').__bound = true;
    $('#btn-next').addEventListener('click', () => { doNext().catch(()=>{}); }, { passive:true });
  }
  if ($('#btn-restart') && !$('#btn-restart').__bound) {
    $('#btn-restart').__bound = true;
    $('#btn-restart').addEventListener('click', () => { doReset(); }, { passive:true });
  }

  // Upgrades
  [['btn-up-hp','health'],['btn-up-cap','energyCap'],['btn-up-reg','regenPerMin'],['btn-up-hit','hit'],['btn-up-crit','crit'],['btn-up-dodge','dodge']]
    .forEach(([id,key])=>{ const b=$( '#'+id ); if(!b) return; b.addEventListener('click',()=>{ Queue[key]=(Queue[key]||0)+1; renderQueue(); previewCost(); }); });
  const apply=$('#btn-apply-upgrades');
  if (apply){
    apply.addEventListener('click', async()=>{
      try{
        const res=await API.msUpgrade({ ...Queue, econScale: ECON_SCALE });
        for (const k in Queue) Queue[k]=0;
        renderQueue();
        if(res?.profile){
          const beforeJF=GameState.jetFuel|0;
          const p=res.profile;
          GameState.ms=p.ms; GameState.pct=p.pct; GameState.jetFuel=p.jetFuel|0; GameState.energy=p.energy|0;
          syncHUDAll(); const spent=Math.max(0, beforeJF-GameState.jetFuel);
          if(spent) logLine(`Upgrades applied — spent ${spent} JF.`);
        }
        await previewCost();
        const uEl=document.getElementById('upgrades-status'); if(uEl) uEl.textContent = res?.spent?`Spent ${res.spent} JF`:'No changes';
      } catch {
        const uEl=document.getElementById('upgrades-status'); if(uEl) uEl.textContent='Upgrade failed';
      }
    });
  }
  const clear=$('#btn-clear-queue');
  if (clear) clear.addEventListener('click',()=>{ for(const k in Queue) Queue[k]=0; renderQueue(); previewCost(); const uEl=document.getElementById('upgrades-status'); if(uEl) uEl.textContent='Cleared'; });

  renderQueue(); previewCost();
}

// Boot
(async function boot(){
  try {
    await bootWallet();           // starts session if wallet present
    await loadProfileAndHUD();    // paints HUD/costs/missions
  } catch(e){ log('boot warning:', e); }
  bind();
})();
