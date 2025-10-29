// jets/js/scene.js — XRPixel Jets MKG (2025-10-28 hp-after-accessories + deflog)
// HP is now derived AFTER accessories:
//   HP(final) = (adj.health) + 0.5 * (adj.defense)
// where adj.health starts from mothership HP and includes any HP accessory.
// DEF shown in enemy hit log is the same adj.defense used in reduction.

import { GameState } from './state.js';
import { updateHPBars } from './ui.js';
import { applyAccessoryBonuses } from '/jets/js/accessories.js';

const LOG_EL_ID = 'log';
function logLine(msg) {
  const el = document.getElementById(LOG_EL_ID);
  if (!el) return;
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function getLevel() {
  const sel = document.getElementById('sel-mission') || document.getElementById('mission');
  const v = parseInt(sel?.value || '1', 10);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function enemyMaxHPFromLevel(level) {
  const hp = Math.round(20 * Math.pow(1.03, Math.max(0, level - 1)));
  return Math.max(1, hp);
}

function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function pct(n) { return clamp(Number(n)||0, 0, 100); }

function rollPlayerHit() {
  const adj = SCENE?.adj;
  const baseHit = adj ? pct(adj.hit) : pct(GameState?.pct?.hit);
  const spdBoost = adj ? Math.min(15, Math.max(0, (adj.speed||0) * 0.5)) : 0; // +0.5% per SPD, cap +15%
  const chance = clamp(75 + baseHit + spdBoost, 0, 100);
  return (Math.random() * 100) < chance;
}
function rollEnemyHit() {
  const adj = SCENE?.adj;
  const baseDodge = adj ? pct(adj.dodge) : pct(GameState?.pct?.dodge);
  const spdAssist = adj ? Math.min(10, Math.max(0, (adj.speed||0) * 0.2)) : 0;
  const dodgeEff = baseDodge + spdAssist;
  const chance = 75 - Math.min(60, dodgeEff * 0.6);
  return (Math.random() * 100) < clamp(chance, 0, 100);
}
function rollCrit() {
  const adj = SCENE?.adj;
  const c = adj ? pct(adj.crit) : pct(GameState?.pct?.crit);
  return (Math.random() * 100) < c;
}

function calcPlayerDamage() {
  const adj = SCENE?.adj;
  const atk = Math.max(0, adj ? Number(adj.attack||0) : Number(GameState?.squad?.attack||0));
  const syn = Math.max(1, Number(GameState?.squad?.synergy || 1));
  const base = Math.ceil((atk * syn) / 5);
  return Math.max(1, base);
}

// Returns { dmg, defUsed } and uses the SAME adj.defense as in HP calc
function calcEnemyDamage(level) {
  const base = 3 + Math.floor(level / 5);
  const adj = SCENE?.adj;
  const def = Math.max(0, adj ? Number(adj.defense||0) : Number(GameState?.squad?.defense||0));
  const red = Math.min(4, Math.floor(def * 0.2)); // every +5 DEF shaves ~1 dmg, cap -4
  const dmg = Math.max(1, base - red);
  return { dmg, defUsed: def };
}

const SCENE = {
  inBattle: false,
  level: 1,
  playerHP: 20,
  playerMaxHP: 20,
  enemyHP: 20,
  enemyMaxHP: 20,
  adj: null, // accessory-adjusted snapshot for this seed

  seed(level = getLevel()) {
    this.level = level;

    // RAW base (no derived HP here):
    const msHP  = Number(GameState?.ms?.current?.health ?? 20);
    const base = {
      // health = mothership HP only; HP synergy from DEF applied AFTER bonuses
      health:  msHP,
      attack:  Number(GameState?.squad?.attack  || 0),
      speed:   Number(GameState?.squad?.speed   || 0),
      defense: Number(GameState?.squad?.defense || 0),
      hit:     Number(GameState?.pct?.hit       || 0),
      crit:    Number(GameState?.pct?.crit      || 0),
      dodge:   Number(GameState?.pct?.dodge     || 0)
    };

    // Apply accessories to RAW base
    const adj0 = applyAccessoryBonuses({ ...base }, (window.CURRENT_WALLET || ''));
    // Derive FINAL HP using adj.defense and adj.health (which may include HP accessory)
    const adjHealth   = Math.max(1, Number(adj0.health || msHP));
    const adjDefense  = Math.max(0, Number(adj0.defense || 0));
    const hpFromDef   = Math.round(adjDefense * 0.5);
    const finalHP     = Math.max(1, Math.round(adjHealth + hpFromDef));

    // Persist adjusted snapshot used by all rolls
    this.adj = {
      health:  finalHP,                // use the derived HP
      attack:  Number(adj0.attack || 0),
      speed:   Number(adj0.speed  || 0),
      defense: adjDefense,
      hit:     Number(adj0.hit    || 0),
      crit:    Number(adj0.crit   || 0),
      dodge:   Number(adj0.dodge  || 0)
    };

    this.playerMaxHP = this.adj.health;
    this.enemyMaxHP  = enemyMaxHPFromLevel(level);

    this.playerHP = this.playerMaxHP;
    this.enemyHP  = this.enemyMaxHP;

    logLine(`Seeded L${level}: Enemy HP ${this.enemyMaxHP}, You HP ${this.playerMaxHP}.`);
    updateHPBars();
  },

  startBattle() {
    if (!this.inBattle) {
      this.seed(getLevel());
      this.inBattle = true;
      logLine(`Mission ${this.level} — Skirmish engaged!`);
    }
  },

  simulateTurn() {
    if (!this.inBattle) return;

    // Player action
    if (rollPlayerHit()) {
      let dmg = calcPlayerDamage();
      if (rollCrit()) { dmg = Math.round(dmg * 2); logLine(`You hit for ${dmg} (CRIT).`); }
      else            { logLine(`You hit for ${dmg}.`); }
      this.enemyHP = Math.max(0, this.enemyHP - dmg);
    } else {
      logLine(`You miss.`);
    }

    updateHPBars();
    if (this.enemyHP <= 0) { this.inBattle = false; logLine(`🏆 Victory!`); return; }

    // Enemy action
    if (rollEnemyHit()) {
      const { dmg: edmg, defUsed } = calcEnemyDamage(this.level);
      this.playerHP = Math.max(0, this.playerHP - edmg);
      logLine(`Enemy hits for ${edmg} (🛡️${Math.round(defUsed)}).`);
    } else {
      logLine(`Enemy misses.`);
    }

    updateHPBars();
    if (this.playerHP <= 0) { this.inBattle = false; logLine(`💀 Defeat…`); }
  },

  resetBattle() { this.inBattle = false; this.seed(getLevel()); }
};

SCENE.init = SCENE.seed;
SCENE.start = SCENE.startBattle;
SCENE.nextTurn = SCENE.simulateTurn;
SCENE.reset = SCENE.resetBattle;
SCENE.setLevel = (lv) => { SCENE.seed(Number(lv) || 1); };

window.SCENE = SCENE;
export default SCENE;
export { SCENE };
