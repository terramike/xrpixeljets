import { LS } from './constants.js';
import { GameState } from './state.js';
import { getE,setE,getAcc,setAcc } from './utils.js';

const SRV={off:parseInt(localStorage.getItem(LS.SOFF)||'0',10)||0};
export const nowSrv=()=>Date.now()+(SRV.off||0);

export async function syncSrv(){
  try{
    const tryFetch=async u=>{const r=await fetch(u,{cache:'no-store'});const d=r.headers.get('Date');return d?new Date(d).getTime():null};
    let t=await tryFetch(location.href); if(!t) t=await tryFetch('index.html'); if(!t) t=await tryFetch('assets/space_1.png');
    if(t){ SRV.off=t-Date.now(); localStorage.setItem(LS.SOFF,String(SRV.off)); if(!localStorage.getItem(LS.ELAST)) localStorage.setItem(LS.ELAST,String(t)); }
  }catch{}
}

export function startRegen(updateEnergyUI, updateHUD){
  setInterval(()=>{
    const now=nowSrv(); const last=parseInt(localStorage.getItem(LS.ELAST)||String(now),10);
    let ds=Math.floor((now-last)/1000); if(ds<0) ds=0; ds=Math.min(ds,300);
    if(ds>0){
      const perSec=(GameState.ms.current.regenPerMin||0)/60;
      let acc=getAcc()+perSec*ds; let gain=0;
      while(acc>=1){ gain++; acc-=1; }
      if(gain>0){ setE(Math.min(GameState.ms.current.energyCap, Math.floor(getE())+gain)); }
      setAcc(acc); localStorage.setItem(LS.ELAST,String(last+ds*1000));
      updateEnergyUI(); updateHUD?.();
    }
  },1000);
}
