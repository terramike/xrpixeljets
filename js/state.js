import { DEFAULT_MS } from './constants.js';

export const GameState = {
  jets: [],
  mainJet: null,
  wingJet: null,
  squad: {attack:5,speed:5,defense:5,solo:true,synergy:1},
  ms: structuredClone(DEFAULT_MS),
  // missionLevel is 1-based (1..∞)
  battle: {active:false, missionLevel:1, playerHP:DEFAULT_MS.current.health, enemyHP:20, enemy:{def:3,atk:4,spd:3}}
};
