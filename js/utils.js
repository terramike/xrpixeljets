import { LS } from './constants.js';

export const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

export const getFuel=()=>parseInt(localStorage.getItem(LS.JF)||'0',10);
export const setFuel=v=>localStorage.setItem(LS.JF,String(Math.max(0,v)));
export const addFuel=d=>{const v=Math.max(0,getFuel()+d); setFuel(v); return v;}

export const getE=()=>parseFloat(localStorage.getItem(LS.E)||'0');
export const setE=v=>localStorage.setItem(LS.E,String(Math.max(0,v)));
export const getAcc=()=>parseFloat(localStorage.getItem(LS.EACC)||'0');
export const setAcc=v=>localStorage.setItem(LS.EACC,String(v));

export const logBox=()=>document.getElementById('log');
export function log(txt,cls=''){
  const d=document.createElement('div');
  if(cls) d.style.color=cls==='good'?'#41ff93':cls==='bad'?'#ff5a8a':'#49f3ff';
  d.textContent=txt; const lb=logBox(); lb.appendChild(d); lb.scrollTop=lb.scrollHeight;
}

export function parseAttr(attrs,key){
  const a=(attrs||[]).find(x=>(x.trait_type||x.trait||'').toLowerCase()===key.toLowerCase());
  return a?String(a.value):null;
}
export function numCode(v,p){
  if(!v) return 3;
  const n=parseInt(String(v).replace(p,'').replace(/[^0-9]/g,''),10);
  return (!isNaN(n)&&n>=1&&n<=9)?n:3;
}

// Seeded stats for mocks
export function seededStats(seed){
  let x = (seed * 9301 + 49297) % 233280;
  const rnd = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  const pick19 = () => 1 + Math.floor(rnd() * 9);
  const a = pick19(), s = pick19(), d = pick19();
  const guns = ['laser','plasma','rail','ion','photon','pulse','arc'];
  const topGun    = guns[Math.floor(rnd() * guns.length)];
  const bottomGun = guns[Math.floor(rnd() * guns.length)];
  return [
    { trait_type:'Attack',  value:`a${a}` },
    { trait_type:'Speed',   value:`s${s}` },
    { trait_type:'Defense', value:`d${d}` },
    { trait_type:'Top Gun',    value: topGun },
    { trait_type:'Bottom Gun', value: bottomGun },
  ];
}
