// jets/js/missions.js — XRPixel Jets MKG (2025-11-01-boss1)
import { GameState } from './state.js';
import { LS } from './constants.js';

const KEY_LAST = 'JETS_LAST_MISSION';

// === Boss constants ===
export const BOSS_ID = 'BOSS';
export function isBoss(id){ return String(id).toUpperCase() === BOSS_ID; }

// Base 5 fixed missions; waves auto-extend past 5
const BASE_MISSIONS = [
  { id: 1, name: 'Skirmish Intro',  enemyHP: 20, enemyAtk: 5, enemyDef: 3, enemySpd: 4 },
  { id: 2, name: 'Raider Patrol',   enemyHP: 22, enemyAtk: 6, enemyDef: 4, enemySpd: 5 },
  { id: 3, name: 'Blockade Line',   enemyHP: 24, enemyAtk: 7, enemyDef: 5, enemySpd: 6 },
  { id: 4, name: 'Carrier Escort',  enemyHP: 26, enemyAtk: 8, enemyDef: 6, enemySpd: 7 },
  { id: 5, name: 'Siege Breaker',   enemyHP: 30, enemyAtk: 9, enemyDef: 7, enemySpd: 8 },
];

function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function rewardScale(){
  const n = Number(window?.JETS_REWARD_SCALE ?? 0.10);
  return Number.isFinite(n) && n > 0 ? n : 0.10;
}
export function getServerRewardPreview(level){
  const lvl = Math.max(1, Number(level) || 1);
  let base;
  if (lvl <= 5) {
    const table = [0, 1, 1, 2, 2, 3];
    base = table[lvl] || 1;
  } else {
    const k = lvl - 6;
    const block = Math.floor(k / 3);
    base = 4 + block;
  }
  return Math.max(1, Math.round(base * rewardScale()));
}

/** Server is authoritative for rewards/unlocks. This helper only updates local UI. */
export function unlockNextIfNeeded(currentWave, victory, unlockedFromServer){
  const lvl = Math.max(1, Number(currentWave) || 1);
  const srv = Math.max(1, Number(unlockedFromServer) || 1);
  const next = (victory && lvl >= srv) ? (lvl + 1) : srv;

  try {
    const lsPrev = parseInt(localStorage.getItem(LS.UNLOCK) || '1', 10) || 1;
    const uiMax = Math.max(lsPrev, next);
    localStorage.setItem(LS.UNLOCK, String(uiMax));
  } catch {}

  if (GameState) GameState.unlockedLevel = next;
  return next;
}

export function getMission(level){
  const lvl = Math.max(1, Number(level) || 1);
  if (lvl <= 5) {
    const mission = BASE_MISSIONS[lvl - 1];
    return { ...mission, rewardFuel: getServerRewardPreview(lvl), rewardSource: 'server-estimate' };
  }

  const k = Math.max(0, (lvl|0) - 5);
  const last = BASE_MISSIONS[4];

  let hp   = Math.round(last.enemyHP * Math.pow(1.03, k));
  let atk  = Math.round(last.enemyAtk * Math.pow(1.02, k));
  let def  = Math.round(last.enemyDef * Math.pow(1.02, k));
  let spd  = Math.round(last.enemySpd * Math.pow(1.01, k));
  const fuel = getServerRewardPreview(lvl);

  hp   = clamp(hp,   1,  9999);
  atk  = clamp(atk,  1,   999);
  def  = clamp(def,  0,   999);
  spd  = clamp(spd,  1,   200);

  return { id: lvl, name:`Wave ${lvl}`, enemyHP: hp, enemyAtk: atk, enemyDef: def, enemySpd: spd, rewardFuel: fuel, rewardSource: 'server-estimate' };
}

export function buildMissionOptions(unlocked){
  const sel = document.getElementById('sel-mission') || document.getElementById('mission');
  if (!sel || typeof sel.appendChild !== 'function') return;

  const max = Math.max(1, Number(unlocked) || 1);
  sel.innerHTML = '';

  // Boss first for visibility
  const boss = document.createElement('option');
  boss.value = BOSS_ID;
  boss.textContent = '🛡️ Daily Boss';
  sel.appendChild(boss);

  for (let i = 1; i <= max; i++){
    const opt = document.createElement('option');
    const m = getMission(i);
    opt.value = String(i);
    opt.textContent = `${m.name} - est. ${m.rewardFuel} JF`;
    sel.appendChild(opt);
  }

  // Restore the player's last selection (clamped to unlocked, but allow BOSS)
  let lastRaw = '1';
  try { lastRaw = String(localStorage.getItem(KEY_LAST) || '1'); } catch {}
  if (lastRaw !== BOSS_ID) {
    const lastNum = parseInt(lastRaw, 10);
    lastRaw = (Number.isFinite(lastNum) && lastNum >= 1) ? String(Math.min(lastNum, max)) : '1';
  }
  sel.value = String(lastRaw);
}





