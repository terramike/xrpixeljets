import { GameState } from './state.js';
import { getMission } from './missions.js';
import { getE, setE, log } from './utils.js';
import { updateHPBars, updateEnergyUI, updateMSUI } from './ui.js';

export class BattleScene extends Phaser.Scene{
  constructor(){ super('battle'); this._turns = 0; }
  preload(){ this.load.image('space','assets/space_1.png'); this.load.image('fallback','assets/XRPjets.png'); }
  create(){
    const w=800,h=600;
    const ts=this.add.tileSprite(w/2,h/2,w,h,'space');
    this.events.on('update',()=>{ts.tilePositionX+=.1; ts.tilePositionY+=.05});
    this.playerSprite=this.add.image(220,430,'fallback').setScale(.48).setAlpha(.95);
    this.enemySprite =this.add.image(580,220,'fallback').setScale(.48).setAlpha(.95);

    this.resetBattle(); this.updateHUD();

    window.SCENE=this; document.dispatchEvent(new Event('scene-ready'));
  }
  setPlayerTexture(url){ const key='playerTex_'+Date.now(); this.load.image(key,url);
    this.load.once(Phaser.Loader.Events.COMPLETE,()=>{ if(this.playerSprite && this.textures.exists(key)) this.playerSprite.setTexture(key);}); this.load.start(); }
  setEnemyTexture(url){ const key='enemyTex_'+Date.now(); this.load.image(key,url);
    this.load.once(Phaser.Loader.Events.COMPLETE,()=>{ if(this.enemySprite && this.textures.exists(key)) this.enemySprite.setTexture(key);}); this.load.start(); }

  resetBattle(){
    const m=getMission(GameState.battle.missionLevel);
    GameState.battle.playerHP = GameState.ms.current.health;
    GameState.battle.enemyHP  = m.enemyHP;
    GameState.battle.enemyMaxHP = m.enemyHP; // <- lock this for UI bars/labels
    GameState.battle.enemy  = {def:m.enemyDef, atk:m.enemyAtk, spd:m.enemySpd};
    GameState.battle.active = false;
    this._turns = 0;

    const btnNext=document.getElementById('btn-next');
    const btnRestart=document.getElementById('btn-restart');
    if(btnNext) btnNext.disabled=true;
    if(btnRestart) btnRestart.disabled=true;

    if(GameState.mainJet){ this.setPlayerTexture(GameState.mainJet.image); }
    if(GameState.wingJet){ this.setEnemyTexture(GameState.wingJet.image); }

    this.updateHUD();
  }
  updateHUD(){ updateHPBars(); }
  async startBattle(){
    if(GameState.battle.active) return;
    try{ await window.API.battleStart(); }catch(e){ log(`Start failed: ${e.message}`,'bad'); return; }
    const lvl=GameState.battle.missionLevel, m=getMission(lvl);
    log(`${lvl<=5?`Mission ${lvl}`:`Wave ${lvl}`} — ${m.name} engaged!`);
    GameState.battle.active=true; this._turns = 0;
    updateEnergyUI(); updateHPBars();
    const btnNext=document.getElementById('btn-next'); if(btnNext) btnNext.disabled=false;
  }

  _roll(p){ return Math.random()<p; }

  nextTurn(){
    if(!GameState.battle.active){ log('Start a battle first.','bad'); return; }
    const eNow = Math.floor(getE()); if(eNow<1){ log('Insufficient Energy — need 1 per turn.','bad'); return; }
    setE(eNow-1); updateEnergyUI(); this._turns++;

    const pInit=GameState.squad.speed+(Math.floor(Math.random()*6)+1);
    const eInit=GameState.battle.enemy.spd+((Math.floor(Math.random()*6)+1));
    const order=(pInit>=eInit)?['p','e']:['e','p'];

    const ms=GameState.ms.current;
    const missP_player = Math.max(0, 0.05 - (ms.hit||0)/100);
    const critP_player = Math.min(0.50, 0.10 + (ms.crit||0)/100);
    const missP_enemy  = Math.min(0.60, 0.05 + (ms.dodge||0)/100);

    for(const who of order){
      if(GameState.battle.playerHP<=0||GameState.battle.enemyHP<=0) break;
      if(who==='p'){
        const miss=this._roll(missP_player), rf=.9+Math.random()*.2;
        let dmg=miss?0:Math.max(0,Math.round((GameState.squad.attack*(GameState.squad.synergy||1)*rf)-(GameState.battle.enemy.def*.3)));
        if(GameState.squad.solo) dmg=Math.round(dmg*1.5);
        const crit = (!miss && this._roll(critP_player)); if(crit) dmg*=2;
        GameState.battle.enemyHP=Math.max(0,GameState.battle.enemyHP-dmg);
        log(miss?'You missed!':`You hit for ${dmg}${crit?' (CRIT)':''}.`, miss?'bad':(crit?'good':''));
      }else{
        const miss=this._roll(missP_enemy), rf=.9+Math.random()*.2;
        let dmg=miss?0:Math.max(0,Math.round((GameState.battle.enemy.atk*rf)-(GameState.squad.defense*.3)));
        const crit = (!miss && Math.random()<0.10); if(crit) dmg*=2;
        GameState.battle.playerHP=Math.max(0,GameState.battle.playerHP-dmg);
        log(miss?'Enemy missed!':`Enemy hit for ${dmg}${crit?' (CRIT)':''}.`, miss?'good':'bad');
      }
    }
    updateHPBars(); updateEnergyUI();
    if(GameState.battle.enemyHP<=0 || GameState.battle.playerHP<=0) this.finishBattle();
  }

  async finishBattle(){
    GameState.battle.active=false;
    const lvl=GameState.battle.missionLevel;
    const win = (GameState.battle.enemyHP<=0 && GameState.battle.playerHP>0);
    const bonus = win ? (3+Math.floor(Math.random()*7)) : (1+Math.floor(Math.random()*2));

    try{
      const res = await window.API.battleFinish({ missionLevel: lvl, win, bonus, turns: this._turns });
      const p = res.profile;
      GameState.ms.base   = p.ms.base;
      GameState.ms.level  = p.ms.level;
      GameState.ms.current= p.ms.current;
      updateMSUI(); updateEnergyUI(); updateHPBars();
      log(win
        ? `Victory! +${res.grantedJetFuel} JetFuel (server), +${res.energyBonus}⚡.`
        : `Defeat. +${res.energyBonus}⚡ consolation (server).`,
        win ? 'good':'bad');
    }catch(e){ log(`Server battle settle failed: ${e.message}`, 'bad'); }

    const btnStart   = document.getElementById('btn-start');
    const btnNext    = document.getElementById('btn-next');
    const btnRestart = document.getElementById('btn-restart');
    if(btnStart) btnStart.disabled=false;
    if(btnNext) btnNext.disabled=true;
    if(btnRestart) btnRestart.disabled=false;

    document.dispatchEvent(new Event('missions-updated'));
  }
}
