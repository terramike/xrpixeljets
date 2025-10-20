import { GameState } from './state.js';
import { LS } from './constants.js';

// Base 5 fixed missions; waves auto-extend past 5 (+1% reward each level)
const BASE_MISSIONS = [
  { id: 1, name: 'Skirmish Intro',  enemyHP: 20, enemyAtk: 5, enemyDef: 3, enemySpd: 4, rewardFuel: 100 },
  { id: 2, name: 'Raider Patrol',   enemyHP: 22, enemyAtk: 6, enemyDef: 4, enemySpd: 5, rewardFuel: 150 },
  { id: 3, name: 'Blockade Line',   enemyHP: 24, enemyAtk: 7, enemyDef: 5, enemySpd: 6, rewardFuel: 200 },
  { id: 4, name: 'Carrier Escort',  enemyHP: 26, enemyAtk: 8, enemyDef: 6, enemySpd: 7, rewardFuel: 250 },
  { id: 5, name: 'Dread Gate',      enemyHP: 28, enemyAtk: 9, enemyDef: 7, enemySpd: 8, rewardFuel: 300 }
];

function waveFor(level){
  // scale +1% per wave past 5
  const k = Math.max(0, level - 5);
  const last = BASE_MISSIONS[4];
  const hp   = Math.round(last.enemyHP * Math.pow(1.03, k)); // a bit spicier HP growth
  const atk  = Math.round(last.enemyAtk * Math.pow(1.02, k));
  const def  = Math.round(last.enemyDef * Math.pow(1.02, k));
  const spd  = Math.round(last.enemySpd * Math.pow(1.01, k));
  const fuel = Math.round(last.rewardFuel * Math.pow(1.01, k));
  return { id: level, name:`Wave ${level}`, enemyHP: hp, enemyAtk: atk, enemyDef: def, enemySpd: spd, rewardFuel: fuel };
}

export function getMission(level){
  if (level <= 5) return BASE_MISSIONS[level-1];
  return waveFor(level);
}

export function unlockNextIfNeeded(level){
  const unlocked = parseInt(localStorage.getItem(LS.UNLOCK)||'5',10);
  if (level >= unlocked){
    localStorage.setItem(LS.UNLOCK, String(level+1));
    return true;
  }
  return false;
}

/**
 * Build mission <select> options WITHOUT changing the user's current selection.
 * @param {HTMLSelectElement} sel
 * @param {number=} keepLevel - level to keep selected (defaults to GameState.battle.missionLevel or 1)
 */
export function buildMissionOptions(sel, keepLevel){
  if (!sel) return;
  const current = (typeof keepLevel === 'number' && keepLevel>0)
    ? keepLevel
    : (GameState.battle.missionLevel || 1);

  const unlocked = parseInt(localStorage.getItem(LS.UNLOCK)||'5',10);
  const maxLevel = Math.max(unlocked, current);

  // capture current value to restore after rebuild
  const restoreVal = String(current);

  // rebuild
  sel.innerHTML = '';
  for (let lvl = 1; lvl <= maxLevel; lvl++){
    const m = getMission(lvl);
    const opt = document.createElement('option');
    opt.value = String(lvl);
    opt.textContent = (lvl<=5) ? `Mission ${lvl}: ${m.name}` : `Wave ${lvl}`;
    sel.appendChild(opt);
  }

  // restore selection
  sel.value = restoreVal;

  // keep state in sync
  GameState.battle.missionLevel = parseInt(sel.value,10);
}
