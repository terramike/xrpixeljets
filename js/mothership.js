import { LS, DEFAULT_MS } from './constants.js';
import { GameState } from './state.js';
import { clamp, getFuel, setFuel, getE, setE } from './utils.js';

export function loadMS(){
  const saved=JSON.parse(localStorage.getItem(LS.MS)||'null');
  GameState.ms = saved || structuredClone(DEFAULT_MS);
  localStorage.setItem(LS.MS, JSON.stringify(GameState.ms));
}
export const saveMS=()=>localStorage.setItem(LS.MS, JSON.stringify(GameState.ms));

// costs
function stepCost(stat,lv){
  const easy={health:6,energyCap:8,regenPerMin:10, hit:8, crit:10, dodge:8};
  const base={health:10,energyCap:12,regenPerMin:15, hit:12, crit:14, dodge:12};
  const k=lv<3?easy:base; return k[stat]*(lv+1)*(lv+1);
}

export const pending={health:0,energyCap:0,regenPerMin:0, hit:0, crit:0, dodge:0};
export function clearQueue(){ for(const k of Object.keys(pending)) pending[k]=0; }
export function queue(stat,delta=1){ pending[stat]=Math.max(0,(pending[stat]||0)+delta); }

function caps(ms){
  return {
    maxHealth:    ms.base.health + 40,
    maxEnergyCap: ms.base.energyCap + 200,
    maxRegen:     5.0,
    maxHit:       ms.base.hit   + 15,
    maxCrit:      ms.base.crit  + 25,
    maxDodge:     ms.base.dodge + 15,
    step: { health:1, energyCap:2, regenPerMin:0.1, hit:1, crit:1, dodge:1 }
  };
}

function effectiveCounts(ms){
  const c=caps(ms), cur=ms.current;
  const hpRoom    = Math.max(0, Math.floor((c.maxHealth    - cur.health)     / c.step.health));
  const capRoom   = Math.max(0, Math.floor((c.maxEnergyCap - cur.energyCap)  / c.step.energyCap));
  const regenRoom = Math.max(0, Math.floor(((c.maxRegen    - cur.regenPerMin)+1e-9)/c.step.regenPerMin));
  const hitRoom   = Math.max(0, c.maxHit   - cur.hit);
  const critRoom  = Math.max(0, c.maxCrit  - cur.crit);
  const dodgeRoom = Math.max(0, c.maxDodge - cur.dodge);
  return {
    health:      Math.min(pending.health,      hpRoom),
    energyCap:   Math.min(pending.energyCap,   capRoom),
    regenPerMin: Math.min(pending.regenPerMin, regenRoom),
    hit:         Math.min(pending.hit,         hitRoom),
    crit:        Math.min(pending.crit,        critRoom),
    dodge:       Math.min(pending.dodge,       dodgeRoom),
    room:{hpRoom,capRoom,regenRoom,hitRoom,critRoom,dodgeRoom}
  };
}

export function totalQueuedCost(){
  const eff = effectiveCounts(GameState.ms);
  let sum=0;
  for(let i=0;i<eff.health;i++)      sum+=stepCost('health',      GameState.ms.level.health + i);
  for(let i=0;i<eff.energyCap;i++)   sum+=stepCost('energyCap',   GameState.ms.level.energyCap + i);
  for(let i=0;i<eff.regenPerMin;i++) sum+=stepCost('regenPerMin', GameState.ms.level.regenPerMin + i);
  for(let i=0;i<eff.hit;i++)         sum+=stepCost('hit',         GameState.ms.level.hit + i);
  for(let i=0;i<eff.crit;i++)        sum+=stepCost('crit',        GameState.ms.level.crit + i);
  for(let i=0;i<eff.dodge;i++)       sum+=stepCost('dodge',       GameState.ms.level.dodge + i);

  // show MAX badges if you added them in HTML
  const ids=[['q-hp-cap',eff.room.hpRoom],['q-cap-cap',eff.room.capRoom],['q-reg-cap',eff.room.regenRoom],['q-hit-cap',eff.room.hitRoom],['q-crit-cap',eff.room.critRoom],['q-dodge-cap',eff.room.dodgeRoom]];
  ids.forEach(([id,room])=>{ const el=document.getElementById(id); if(el) el.textContent=(room<=0?'MAX':''); });

  return sum;
}

export function applyQueue(updateMSUI, updateEnergyUI, resetBattle, updateHUD, log){
  const ms = GameState.ms;
  const eff = effectiveCounts(ms);

  let cost=0;
  for(let i=0;i<eff.health;i++)      cost+=stepCost('health',      ms.level.health + i);
  for(let i=0;i<eff.energyCap;i++)   cost+=stepCost('energyCap',   ms.level.energyCap + i);
  for(let i=0;i<eff.regenPerMin;i++) cost+=stepCost('regenPerMin', ms.level.regenPerMin + i);
  for(let i=0;i<eff.hit;i++)         cost+=stepCost('hit',         ms.level.hit + i);
  for(let i=0;i<eff.crit;i++)        cost+=stepCost('crit',        ms.level.crit + i);
  for(let i=0;i<eff.dodge;i++)       cost+=stepCost('dodge',       ms.level.dodge + i);

  if ((eff.health+eff.energyCap+eff.regenPerMin+eff.hit+eff.crit+eff.dodge)===0){
    const c=caps(ms);
    log(`No upgrades applied (caps: HP≤${c.maxHealth}, CAP≤${c.maxEnergyCap}, REGEN≤${c.maxRegen.toFixed(1)}/m, HIT≤${c.maxHit}%, CRIT≤${c.maxCrit}%, DODGE≤${c.maxDodge}%).`, 'bad');
    clearQueue(); updateMSUI(); updateEnergyUI(); return;
  }
  if(getFuel() < cost){ log(`Not enough JetFuel (${cost} needed)`, 'bad'); return; }

  setFuel(getFuel()-cost);

  // apply
  for(let i=0;i<eff.health;i++){      ms.current.health    = Math.min(ms.current.health + 1, ms.base.health + 40); ms.level.health++; }
  for(let i=0;i<eff.energyCap;i++){   ms.current.energyCap = Math.min(ms.current.energyCap + 2, ms.base.energyCap + 200); ms.level.energyCap++; }
  for(let i=0;i<eff.regenPerMin;i++){ ms.current.regenPerMin = Math.min(Math.round((ms.current.regenPerMin + 0.1)*10)/10, 5.0); ms.level.regenPerMin++; }
  for(let i=0;i<eff.hit;i++){         ms.current.hit   = Math.min(ms.current.hit   + 1, ms.base.hit   + 15); ms.level.hit++; }
  for(let i=0;i<eff.crit;i++){        ms.current.crit  = Math.min(ms.current.crit  + 1, ms.base.crit  + 25); ms.level.crit++; }
  for(let i=0;i<eff.dodge;i++){       ms.current.dodge = Math.min(ms.current.dodge + 1, ms.base.dodge + 15); ms.level.dodge++; }

  setE(Math.min(getE(), ms.current.energyCap));
  clearQueue(); saveMS();
  updateMSUI(); updateEnergyUI(); /* do not force reset mid-battle */ updateHUD();

  const parts=[];
  if(eff.health) parts.push(`HP x${eff.health}`);
  if(eff.energyCap) parts.push(`CAP x${eff.energyCap}`);
  if(eff.regenPerMin) parts.push(`REGEN x${eff.regenPerMin}`);
  if(eff.hit) parts.push(`HIT x${eff.hit}`);
  if(eff.crit) parts.push(`CRIT x${eff.crit}`);
  if(eff.dodge) parts.push(`DODGE x${eff.dodge}`);
  log(`Upgrades applied (${parts.join(', ')}) for ${cost} JF`, 'good');
}
