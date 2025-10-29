// js/mothership.js — XRPixel Jets MKG (2025-10-23k)
// Queue & cost helpers. Matches server costs exactly:
// baseCost = 100 + 30*level; regenPerMin costs +50%.

import { GameState } from './state.js';

export const pending = { health:0, energyCap:0, regenPerMin:0, hit:0, crit:0, dodge:0 };

export function queue(stat, n){
  if (!(stat in pending)) return;
  pending[stat] = (pending[stat] || 0) + (n||1);
  if (pending[stat] < 0) pending[stat] = 0;
  document.dispatchEvent(new CustomEvent('queue-updated', { detail:{...pending} }));
}

export function clearQueue(){
  Object.keys(pending).forEach(k => pending[k]=0);
  document.dispatchEvent(new CustomEvent('queue-updated', { detail:{...pending} }));
}

function baseCost(lv){ return 100 + 30*lv; }
function costFor(stat, lv){ return (stat === 'regenPerMin') ? Math.round(baseCost(lv) * 1.5) : baseCost(lv); }

export function totalQueuedCost(){
  const ms = GameState.ms || { level:{ health:0, energyCap:0, regenPerMin:0 } };
  const lv0 = {
    health: ms.level?.health|0,
    energyCap: ms.level?.energyCap|0,
    regenPerMin: ms.level?.regenPerMin|0,
    hit: (GameState.pctLevel?.hit|0) || 0,
    crit: (GameState.pctLevel?.crit|0) || 0,
    dodge: (GameState.pctLevel?.dodge|0) || 0
  };

  const stats = ['health','energyCap','regenPerMin','hit','crit','dodge'];
  let total = 0;
  for (const s of stats) {
    let cnt = pending[s]|0;
    let lv = lv0[s]|0;
    while (cnt-- > 0) { lv += 1; total += costFor(s, lv); }
  }
  return total;
}

export function loadMS(){
  GameState.pct = GameState.pct || { hit:0, crit:10, dodge:0 };
}
