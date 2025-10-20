import { LS, DEFAULT_MS } from './constants.js';
import { GameState } from './state.js';
import { log, getE, setE } from './utils.js';
import { buildMissionOptions, getMission } from './missions.js';
import { syncSrv, nowSrv, startRegen } from './time.js';
import { loadMS, pending, queue, clearQueue } from './mothership.js';
import { loadMockJets, recalcSquad, renderJets } from './jets.js';
import { ui, updateEnergyUI, updateMSUI, updateHPBars, renderSquadStats, setMainCard, setWingCard } from './ui.js';
import { BattleScene } from './scene.js';
import * as API from './serverApi.js';

const USE_SERVER = true;

function applyServerProfile(p){
  // Server is authoritative for energy + mothership
  GameState.ms.base   = p.ms.base;
  GameState.ms.level  = p.ms.level;
  GameState.ms.current= p.ms.current;

  // clamp and reflect server energy locally so UI matches server
  setE(Math.min(p.energy ?? 0, GameState.ms.current.energyCap));
  updateMSUI(); updateEnergyUI(); updateHPBars(); renderSquadStats();
}

window.addEventListener('DOMContentLoaded', async ()=>{
  await syncSrv(); setInterval(syncSrv,60000);

  if(localStorage.getItem(LS.JF)===null) localStorage.setItem(LS.JF,'100');
  if(localStorage.getItem(LS.UNLOCK)===null) localStorage.setItem(LS.UNLOCK,'5');
  loadMS();

  if(localStorage.getItem(LS.E)===null) setE(GameState.ms.current.energyCap);
  setE(Math.min(getE(), GameState.ms.current.energyCap));
  if(localStorage.getItem(LS.EACC)===null) localStorage.setItem(LS.EACC,'0');

  updateMSUI(); updateEnergyUI();
  startRegen(updateEnergyUI, ()=>window.SCENE?.updateHUD());

  const btnStart   = document.getElementById('btn-start');
  const btnNext    = document.getElementById('btn-next');
  const btnRestart = document.getElementById('btn-restart');
  const btnConnect = document.getElementById('btn-connect');
  const btnClearWing=document.getElementById('btn-clear-wing');
  const btnApplyUp = document.getElementById('btn-apply');
  const btnClearQ  = document.getElementById('btn-clear-q');
  const sel        = document.getElementById('sel-mission');

  if (!GameState.battle.missionLevel) GameState.battle.missionLevel = 1;
  buildMissionOptions(sel, GameState.battle.missionLevel);

  document.addEventListener('missions-updated', ()=>{ buildMissionOptions(sel, GameState.battle.missionLevel); });
  document.addEventListener('scene-ready', ()=>{ btnStart.disabled=false; });

  // START button — refresh server profile first, trust server energy
  btnStart.onclick = async ()=>{
    try{
      if (USE_SERVER && window.API?.enabled){
        const prof = await API.refreshProfile();           // <— sync first
        applyServerProfile(prof);

        const need = 10;
        const have = prof.energy ?? 0;
        if (have < need){
          log(`Insufficient Energy — need ${need}, have ${have}.`, 'bad');
          return;
        }
      }
      if(window.SCENE){
        window.SCENE.startBattle();
        btnStart.disabled=true; btnNext.disabled=false; btnRestart.disabled=false;
        updateHPBars();
      }
    }catch(e){
      const msg = e.message || 'Start failed';
      log(`Start failed: ${msg}`, 'bad');
    }
  };

  let lastNext=0;
  btnNext.onclick =()=>{ const n=nowSrv(); if(n-lastNext<600){log('Cooldown 0.6s','bad');return;} lastNext=n; if(window.SCENE){ window.SCENE.nextTurn(); updateHPBars(); } };
  btnRestart.onclick=()=>{ if(window.SCENE){ window.SCENE.resetBattle(); window.SCENE.updateHUD(); } btnStart.disabled=false; btnNext.disabled=true; btnRestart.disabled=true; log('Battle reset.'); updateHPBars(); };

  btnConnect.onclick=async ()=>{
    log('Connecting wallet (mock)…');
    await loadMockJets(10);
    renderJets(
      (j)=>{ GameState.mainJet=j; setMainCard(j.name, j.image); recalcSquad(); renderSquadStats(); window.SCENE?.setPlayerTexture(j.image); },
      (j)=>{ GameState.wingJet=j; setWingCard(j.name, j.image);  recalcSquad(); renderSquadStats(); window.SCENE?.setEnemyTexture(j.image); }
    );

    if (USE_SERVER && window.API?.enabled){
      const address = 'rDEMO_ADDR_123';
      await API.startSession(address);
      const prof = await API.getProfile();
      applyServerProfile(prof);
      log(`Server session started for ${address}`);
    }
    btnStart.disabled=false; btnNext.disabled=true; btnRestart.disabled=true;
  };

  // Queue wiring (unchanged)
  [['btn-up-hp','q-hp','health'],['btn-up-cap','q-cap','energyCap'],['btn-up-reg','q-reg','regenPerMin'],
   ['btn-up-hit','q-hit','hit'],['btn-up-crit','q-crit','crit'],['btn-up-dodge','q-dodge','dodge']].forEach(([bId,qId,key])=>{
    const b=document.getElementById(bId); if(!b) return;
    b.onclick=()=>{ queue(key,1); const q=document.getElementById(qId); if(q) q.textContent=pending[key]; updateQueueCost(); };
  });

  btnClearQ.onclick = ()=>{ clearQueue(); ['q-hp','q-cap','q-reg','q-hit','q-crit','q-dodge','q-cost'].forEach(id=>{ const el=document.getElementById(id); if(el) el.textContent='0'; }); };

  function updateQueueCost(){
    import('./mothership.js').then(({ totalQueuedCost })=>{
      const cost = totalQueuedCost();
      const el = document.getElementById('q-cost'); if(el) el.textContent = cost;
    });
  }

  // Mission change
  sel.onchange = e => {
    GameState.battle.missionLevel = parseInt(e.target.value,10) || GameState.battle.missionLevel || 1;
    if (window.SCENE){ window.SCENE.resetBattle(); window.SCENE.updateHUD(); }
    btnStart.disabled=false; btnNext.disabled=true; btnRestart.disabled=true;
    updateHPBars();
    const m = getMission(GameState.battle.missionLevel);
    const lvl = GameState.battle.missionLevel;
    log(`Selected ${lvl<=5?`Mission ${lvl}`:`Wave ${lvl}`}: ${m.name}.`);
  };

  new Phaser.Game({ type:Phaser.AUTO, parent:'game-root', width:800, height:600, scene:[BattleScene] });
});
