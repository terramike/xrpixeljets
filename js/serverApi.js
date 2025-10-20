import { LS } from './constants.js';

const API_BASE = (window.API_BASE || 'http://localhost:8787');
const enabled = true;

let session = { address: null, nonce: null };

async function jfetch(url, opts={}){
  const r = await fetch(url, { headers: {'Content-Type':'application/json'}, ...opts });
  if(!r.ok){ const t = await r.text().catch(()=> ''); throw new Error(`HTTP ${r.status}: ${t || r.statusText}`); }
  return r.json();
}

function markEnergyTimestampNow(){
  localStorage.setItem(LS.ELAST, String(Date.now()));
  localStorage.setItem(LS.EACC, '0');
}

export async function startSession(address){
  const data = await jfetch(`${API_BASE}/session/start`, { method:'POST', body: JSON.stringify({ address }) });
  session.address = address; session.nonce = data.nonce; return data;
}

export async function getProfile(){
  if(!session.address) throw new Error('No session');
  const p = await jfetch(`${API_BASE}/profile?address=${encodeURIComponent(session.address)}`);
  localStorage.setItem(LS.JF, String(p.jetFuel));
  localStorage.setItem(LS.E, String(p.energy));
  localStorage.setItem(LS.UNLOCK, String(p.unlockedLevel));
  markEnergyTimestampNow();
  return p;
}

export async function battleStart(){
  if(!session.address) throw new Error('No session');
  const res = await jfetch(`${API_BASE}/battle/start`, {
    method:'POST',
    body: JSON.stringify({ address: session.address, nonce: session.nonce, sig:'placeholder' })
  });
  const p = res.profile;
  localStorage.setItem(LS.E, String(p.energy));
  markEnergyTimestampNow();
  return res;
}

export async function battleFinish({ missionLevel, win, bonus, turns }){
  if(!session.address) throw new Error('No session');
  const res = await jfetch(`${API_BASE}/battle/finish`, {
    method:'POST',
    body: JSON.stringify({ address: session.address, nonce: session.nonce, sig:'placeholder', missionLevel, result:{ win, bonus, turns } })
  });
  const p = res.profile;
  localStorage.setItem(LS.JF, String(p.jetFuel));
  localStorage.setItem(LS.E, String(p.energy));
  localStorage.setItem(LS.UNLOCK, String(p.unlockedLevel));
  markEnergyTimestampNow();
  return res;
}

export async function msUpgrade(ops){
  if(!session.address) throw new Error('No session');
  const res = await jfetch(`${API_BASE}/ms/upgrade`, {
    method:'POST',
    body: JSON.stringify({ address: session.address, nonce: session.nonce, sig:'placeholder', ops })
  });
  const p = res.profile;
  localStorage.setItem(LS.JF, String(p.jetFuel));
  localStorage.setItem(LS.E, String(p.energy));
  localStorage.setItem(LS.UNLOCK, String(p.unlockedLevel));
  markEnergyTimestampNow();
  return res;
}

window.API = { enabled, startSession, getProfile, battleStart, battleFinish, msUpgrade, _session:()=>({...session}), _base: API_BASE };
