// serverApi.js — 2025-10-31rel3 (JetsApi shim for WC + same API as rel2)
const API_BASE = window.JETS_API_BASE || 'https://xrpixeljets.onrender.com';

let AUTH_JWT = null;
try { AUTH_JWT = (localStorage.getItem('JWT') || '').trim() || null; } catch {}

export function setWallet(addr){
  try { localStorage.setItem('WALLET', (addr||'').trim()); } catch {}
  window.CURRENT_WALLET = (addr||'').trim();
}
function getWallet() {
  const el = document.getElementById('xrpl-address');
  if (el && el.value && el.value.startsWith('r')) return el.value.trim();
  const w = (window.CURRENT_WALLET || '').trim();
  if (w) return w;
  try { const ls = (localStorage.getItem('WALLET') || '').trim(); if (ls) return ls; } catch {}
  return '';
}
export function setAuthToken(jwt) {
  AUTH_JWT = jwt || null;
  try { localStorage.setItem('JWT', AUTH_JWT || ''); } catch {}
}
function headersJSON(includeWallet = true, extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (includeWallet) { const w = getWallet(); if (w) h['X-Wallet'] = w; }
  if (AUTH_JWT) h['Authorization'] = 'Bearer ' + AUTH_JWT;
  return h;
}
async function fetchJSON(path, opts = {}) {
  const res = await fetch(API_BASE + path, opts);
  const raw = await res.text().catch(()=>'');
  const data = raw ? (()=>{ try{ return JSON.parse(raw); }catch{ return {}; } })() : {};
  if (!res.ok) {
    const msg = `[API] ${res.status} @ ${path} — ${(data.error || data.message || raw || res.statusText)}`;
    console.error(msg);
    try { document.dispatchEvent(new CustomEvent('server-error', { detail: msg })); } catch {}
    throw new Error(msg);
  }
  return data;
}

// AUTH
export async function sessionStart(address) {
  if (!address || !address.startsWith('r')) throw new Error('bad_address');
  return fetchJSON('/session/start', { method:'POST', headers: headersJSON(false), body: JSON.stringify({ address }) });
}
export async function sessionVerify({ address, signature, publicKey, scope='play,upgrade,claim', ts, payload, payloadHex } = {}) {
  if (!address || !address.startsWith('r')) throw new Error('bad_address');
  if (!signature) throw new Error('bad_signature');
  if (!publicKey) throw new Error('bad_key');
  const hdrs = headersJSON(true, { 'X-Wallet': address });
  const res = await fetchJSON('/session/verify', {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify({ address, signature, publicKey, scope, ts, payload, payloadHex })
  });
  if (res?.jwt) setAuthToken(res.jwt);
  return res;
}
export const startSession  = sessionStart;
export const verifySession = sessionVerify;

// GAMEPLAY
function resolveScale(arg) {
  if (typeof arg === 'number' && Number.isFinite(arg)) return arg;
  if (typeof arg === 'string' && arg.trim() && !isNaN(arg)) return Number(arg);
  if (arg && typeof arg === 'object') {
    if ('econScale' in arg && !isNaN(arg.econScale)) return Number(arg.econScale);
    if ('scale' in arg && !isNaN(arg.scale)) return Number(arg.scale);
    if ('value' in arg && !isNaN(arg.value)) return Number(arg.value);
  }
  return null;
}
export async function getProfile() { return fetchJSON('/profile', { headers: headersJSON(true) }); }
export async function getMsCosts(arg) {
  const s = resolveScale(arg);
  const qs = `?econScale=${encodeURIComponent(s != null ? s : 0.10)}`;
  try { return await fetchJSON('/ms/costs' + qs, { headers: headersJSON(true) }); }
  catch (e) {
    const msg = String(e?.message || '');
    if (msg.includes(' 404 @ /ms/costs')) {
      try { return await fetchJSON('/ms/cost' + qs, { headers: headersJSON(true) }); } catch {}
      try { return await fetchJSON('/mothership/costs' + qs, { headers: headersJSON(true) }); } catch {}
    }
    throw e;
  }
}
export async function msUpgrade(queue) {
  return fetchJSON('/ms/upgrade', { method:'POST', headers: headersJSON(true), body: JSON.stringify(queue||{}) });
}
export async function battleStart(p)  { return fetchJSON('/battle/start',  { method:'POST', headers: headersJSON(true), body: JSON.stringify(p||{}) }); }
export async function battleTurn(p)   { return fetchJSON('/battle/turn',   { method:'POST', headers: headersJSON(true), body: JSON.stringify(p||{}) }); }
export async function battleFinish(p) { return fetchJSON('/battle/finish', { method:'POST', headers: headersJSON(true), body: JSON.stringify(p||{}) }); }

// CLAIM
export async function claimStart(amount) {
  return fetchJSON('/claim/start', { method:'POST', headers: headersJSON(true), body: JSON.stringify({ amount: Number(amount||0) }) });
}

// ---- Tiny bridge so WC can call without importing modules ----
try {
  window.JetsApi = window.JetsApi || {};
  Object.assign(window.JetsApi, {
    setWallet, setAuthToken,
    claimStart, sessionStart, sessionVerify, startSession, verifySession,
    getProfile
  });
} catch {}
