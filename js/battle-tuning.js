// XRPixel Jets — battle-tuning.js (2025-12-24-combat6-bonus-attacks)
// Fixes: Respect battle state + clear it on KO so Next Turn can't bypass 10⚡ entry.
// Features: initiative per turn, hit/crit/dodge, damage variance, emoji logs.
// New: Damage Shield (thorns) + Bonus Attacks from scene.effects / GameState.combatEffects.

import { GameState } from './state.js';

// --- Tuning knobs ---
const BASE_PLAYER_HIT = 78;
const PLAYER_HIT_MIN  = 65;
const PLAYER_HIT_MAX  = 98;

const ENEMY_HIT_BASE  = 68;
const ENEMY_HIT_MIN   = 55;
const ENEMY_HIT_MAX   = 93;
const ENEMY_DODGE_CAP = 25;

const VARIANCE_MIN = 0.75;
const VARIANCE_MAX = 1.25;
const DEF_RAND_MIN = 0.25;
const DEF_RAND_MAX = 0.60;

const CRIT_MIN = 1.40;
const CRIT_MAX = 1.80;

const PLAYER_DAMAGE_MIN = 2;
const PLAYER_ATTACK_FLAT_BONUS = 1;
const LOW_ATTACK_ASSIST_CUTOFF = 7;
const LOW_ATTACK_ASSIST_SCALE = 0.35;

// --------------------------------------
function emit(line){
  try {
    window.dispatchEvent(new CustomEvent('jets:combatlog', { detail: line }));
  } catch {}
}
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function rint(lo, hi){ return Math.floor(Math.random()*(hi-lo+1))+lo; }
function rfloat(lo, hi){ return lo + Math.random()*(hi-lo); }

function readIntTxt(id, fallback){
  const el = document.getElementById(id);
  if (!el) return fallback;
  const n = parseInt(String(el.textContent || '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function getPlayerStats(){
  const atk = readIntTxt('squad-atk', 6);
  const spd = readIntTxt('squad-spd', 6);
  const def = readIntTxt('squad-def', 4);

  const plusHit = Number(GameState?.pct?.hit ?? 0);
  const crit    = Number(GameState?.pct?.crit ?? 10);
  const dodge   = Number(GameState?.pct?.dodge ?? 5);

  const hit = clamp(BASE_PLAYER_HIT + plusHit, PLAYER_HIT_MIN, PLAYER_HIT_MAX);
  return { atk, spd, def, hit, crit, dodge };
}

function getEnemyDerived(mission){
  const { enemyAtk:atk = 6, enemyDef:def = 4, enemySpd:spd = 5 } = mission || {};
  const hit   = clamp(ENEMY_HIT_BASE + Math.round((spd - 5) * 3), ENEMY_HIT_MIN, ENEMY_HIT_MAX);
  const crit  = clamp(5 + Math.round((atk - 5) * 0.5), 5, 18);
  const dodge = clamp(Math.round(spd * 0.7), 0, ENEMY_DODGE_CAP);
  return { atk, def, spd, hit, crit, dodge };
}

function dmgRoll(att, def, opts){
  const { hitPct = 75, critPct = 10, player = false } = opts || {};
  if (Math.random() * 100 > hitPct) return { dmg:0, miss:true, crit:false };

  const variance = rfloat(VARIANCE_MIN, VARIANCE_MAX);
  const lowAttackAssist = player ? Math.max(0, LOW_ATTACK_ASSIST_CUTOFF - att) * LOW_ATTACK_ASSIST_SCALE : 0;
  const effectiveAttack = att + (player ? PLAYER_ATTACK_FLAT_BONUS : 0) + lowAttackAssist;
  let base = Math.round(Math.max(1, effectiveAttack * variance - def * rfloat(DEF_RAND_MIN, DEF_RAND_MAX)));
  if (player) base = Math.max(PLAYER_DAMAGE_MIN, base);

  const isCrit = (Math.random() * 100 < critPct);
  if (isCrit) base = Math.round(base * rfloat(CRIT_MIN, CRIT_MAX));

  return { dmg: Math.max(0, base), miss:false, crit:isCrit };
}

// Pull current combat effects (Damage Shield, bonus attacks) from scene/GameState
function getCombatEffects(scene){
  const fx = (scene && scene.effects) || (GameState && GameState.combatEffects) || {};
  const ds = Math.max(0, Number(fx.damageShieldPerHit || 0));
  const ba = Math.max(0, Number(fx.bonusAttacksPerTurn || 0));
  return { damageShieldPerHit: ds, bonusAttacksPerTurn: ba };
}

export function installBattleTuning({ scene, getMission, getCurrentLevel }){
  if (!scene || scene.__jetsTuningInstalled) return;
  scene.__jetsTuningInstalled = true;
  console.log('[Jets] Combat tuning active (initiative + variance + energy gate + thorns + bonus attacks)');

  const tuned = function tunedNextTurn(){
    // HARD GATE: must be in an active battle (set by startBattle → 10⚡ server spend)
    if (!scene.inBattle) {
      emit('⛔ No active battle. Press Start (10⚡).');
      return;
    }

    const pMax = Number(scene.playerMaxHP ?? 20) || 20;
    const eMax = Number(scene.enemyMaxHP  ?? 20) || 20;
    let   pHP  = Number(scene.playerHP    ?? 20) || 20;
    let   eHP  = Number(scene.enemyHP     ?? 20) || 20;

    const lvl     = typeof getCurrentLevel === 'function' ? getCurrentLevel() : 1;
    const mission = typeof getMission === 'function' ? getMission(lvl) : {};
    const P       = getPlayerStats();
    const E       = getEnemyDerived(mission);
    const fx      = getCombatEffects(scene);
    const damageShieldPerHit   = fx.damageShieldPerHit;
    const bonusAttacksPerTurn  = fx.bonusAttacksPerTurn;

    // Initiative per turn
    const pRoll = P.spd + rint(0, Math.max(1, Math.ceil(P.spd / 2)));
    const eRoll = E.spd + rint(0, Math.max(1, Math.ceil(E.spd / 2)));
    const playerFirst = (pRoll > eRoll) || (pRoll === eRoll && Math.random() < 0.5);
    emit(`🧭 Initiative — You ${pRoll} vs ${eRoll} (${playerFirst ? 'you first' : 'enemy first'})`);

    function resolve(label, A, D){
      // returns a rich result so we can hook DS on enemy hits
      if (Math.random() * 100 < D.dodge) {
        emit(label === 'you' ? '💨 You were dodged!' : '🌀 Enemy was dodged!');
        return { dmg:0, miss:false, dodged:true, crit:false, label };
      }

      const out = dmgRoll(A.atk, D.def, { hitPct: A.hit, critPct: A.crit, player: label === 'you' });
      if (out.miss) {
        emit(label === 'you' ? '💨 You miss!' : '💨 Enemy misses!');
        return { dmg:0, miss:true, dodged:false, crit:false, label };
      }

      if (out.crit) {
        emit(label === 'you'
          ? `✨ CRIT! ${out.dmg} dmg`
          : `⚡ Enemy CRIT! ${out.dmg} dmg`
        );
      } else {
        emit(label === 'you'
          ? `💥 You hit for ${out.dmg}.`
          : `💢 Enemy hits for ${out.dmg}.`
        );
      }

      return { dmg: out.dmg, miss:false, dodged:false, crit:out.crit, label };
    }

    function applyThornsIfAny(taken){
      if (!damageShieldPerHit) return { pHP, eHP };
      if (!taken || taken.dmg <= 0) return { pHP, eHP };
      if (pHP <= 0 || eHP <= 0) return { pHP, eHP };

      const reflect = Math.min(damageShieldPerHit, eHP);
      if (reflect > 0) {
        eHP = clamp(eHP - reflect, 0, eMax);
        emit(`🛡️ Your shield reflects ${reflect} damage back!`);
      }
      return { pHP, eHP };
    }

    // Player turn: base attack + bonus attacks
    function playerAttackPhase(){
      if (eHP <= 0) return; // Enemy already dead

      // Base attack
      const dealt = resolve('you', P, E);
      eHP = clamp(eHP - dealt.dmg, 0, eMax);

      // Bonus attacks (if any)
      if (bonusAttacksPerTurn > 0 && eHP > 0) {
        for (let i = 0; i < bonusAttacksPerTurn; i++) {
          if (eHP <= 0) break; // Stop if enemy dies
          
          const bonusDealt = resolve('you', P, E);
          eHP = clamp(eHP - bonusDealt.dmg, 0, eMax);
          
          if (i === 0 && bonusAttacksPerTurn > 0) {
            // Only show the emoji once at the start of bonus attacks
            emit(`⚔️ Bonus attack ${i + 1}!`);
          }
        }
      }
    }

    // Enemy turn: single attack
    function enemyAttackPhase(){
      if (pHP <= 0) return; // Player already dead

      const taken = resolve('enemy', E, P);
      pHP = clamp(pHP - taken.dmg, 0, pMax);
      ({ pHP, eHP } = applyThornsIfAny(taken));
    }

    // Execute turn based on initiative
    if (playerFirst) {
      playerAttackPhase();
      if (eHP > 0) {
        enemyAttackPhase();
      }
    } else {
      enemyAttackPhase();
      if (pHP > 0) {
        playerAttackPhase();
      }
    }

    // Write back
    scene.playerHP = pHP;
    scene.enemyHP  = eHP;

    // KO checks: clear battle state so client must press Start again (→ 10⚡)
    if (eHP <= 0 || pHP <= 0) {
      scene.inBattle = false;
    }

    emit(`❤️ You ${pHP}/${pMax} | 👾 Enemy ${eHP}/${eMax}`);
  };

  // Force our tuned turn logic
  scene.nextTurn = tuned;
  if (typeof scene.simulateTurn === 'function') scene.simulateTurn = tuned;
}
