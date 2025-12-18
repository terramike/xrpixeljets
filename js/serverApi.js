// /jets/js/serverApi.js — 2025-11-19 rel4
// JetsApi shim for XRPixel Jets (WC + browser modules)

const API_BASE = window.JETS_API_BASE || 'https://xrpixeljets.onrender.com';

// ---- Auth token handling ----
let AUTH_JWT = null;
try {
  AUTH_JWT = (localStorage.getItem('JWT') || '').trim() || null;
} catch {}

// ---- Wallet helpers ----
export function setWallet(addr) {
  const clean = (addr || '').trim();
  try {
    localStorage.setItem('WALLET', clean);
  } catch {}
  window.CURRENT_WALLET = clean;
}

function getWallet() {
  const input = document.getElementById('xrpl-address');
  if (input && input.value && input.value.startsWith('r')) {
    return input.value.trim();
  }
  const w = (window.CURRENT_WALLET || '').trim();
  if (w) return w;
  try {
    const ls = (localStorage.getItem('WALLET') || '').trim();
    if (ls) return ls;
  } catch {}
  return '';
}

// ---- JWT helpers ----
export function setAuthToken(jwt) {
  AUTH_JWT = jwt || null;
  try {
    localStorage.setItem('JWT', AUTH_JWT || '');
  } catch {}
}

// ---- HTTP helpers ----
function headersJSON(includeWallet = true, extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (includeWallet) {
    const w = getWallet();
    if (w) h['X-Wallet'] = w;
  }
  if (AUTH_JWT) {
    h['Authorization'] = 'Bearer ' + AUTH_JWT;
  }
  return h;
}

async function fetchJSON(path, opts = {}) {
  const res = await fetch(API_BASE + path, opts);
  const raw = await res.text().catch(() => '');
  const data = raw
    ? (() => {
        try {
          return JSON.parse(raw);
        } catch {
          return {};
        }
      })()
    : {};

  if (!res.ok) {
    const msg = `[API] ${res.status} @ ${path} — ${
      data.error || data.message || raw || res.statusText
    }`;
    console.error(msg);
    try {
      document.dispatchEvent(new CustomEvent('server-error', { detail: msg }));
    } catch {}
    throw new Error(msg);
  }

  return data;
}

// ---- AUTH ----
export async function sessionStart(address) {
  const addr = (address || '').trim();
  if (!addr || !addr.startsWith('r')) throw new Error('bad_address');
  return fetchJSON('/session/start', {
    method: 'POST',
    headers: headersJSON(false),
    body: JSON.stringify({ address: addr })
  });
}

export async function sessionVerify({
  address,
  signature,
  publicKey,
  scope = 'play,upgrade,claim',
  ts,
  payload,
  payloadHex
} = {}) {
  const addr = (address || '').trim();
  if (!addr || !addr.startsWith('r')) throw new Error('bad_address');
  if (!signature) throw new Error('bad_signature');
  if (!publicKey) throw new Error('bad_key');

  const hdrs = headersJSON(true, { 'X-Wallet': addr });
  const res = await fetchJSON('/session/verify', {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify({ address: addr, signature, publicKey, scope, ts, payload, payloadHex })
  });

  if (res?.jwt) setAuthToken(res.jwt);
  return res;
}

// Back-compat aliases
export const startSession = sessionStart;
export const verifySession = sessionVerify;

// ---- GAMEPLAY / PROFILE ----
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

export async function getProfile() {
  return fetchJSON('/profile', { headers: headersJSON(true) });
}

// NEW: alias so SrvAPI.profile() also works
export async function profile() {
  return getProfile();
}

export async function getMsCosts(arg) {
  const s = resolveScale(arg);
  const qs = `?econScale=${encodeURIComponent(s != null ? s : 0.10)}`;

  try {
    // primary path
    return await fetchJSON('/ms/costs' + qs, { headers: headersJSON(true) });
  } catch (e) {
    const msg = String(e?.message || '');
    // backwards-compat fallbacks if server is still on older routes
    if (msg.includes(' 404 @ /ms/costs')) {
      try {
        return await fetchJSON('/ms/cost' + qs, { headers: headersJSON(true) });
      } catch {}
      try {
        return await fetchJSON('/mothership/costs' + qs, { headers: headersJSON(true) });
      } catch {}
    }
    throw e;
  }
}

export async function msUpgrade(queue) {
  return fetchJSON('/ms/upgrade', {
    method: 'POST',
    headers: headersJSON(true),
    body: JSON.stringify(queue || {})
  });
}

export async function battleStart(payload) {
  return fetchJSON('/battle/start', {
    method: 'POST',
    headers: headersJSON(true),
    body: JSON.stringify(payload || {})
  });
}

export async function battleTurn(payload) {
  return fetchJSON('/battle/turn', {
    method: 'POST',
    headers: headersJSON(true),
    body: JSON.stringify(payload || {})
  });
}

export async function battleFinish(payload) {
  return fetchJSON('/battle/finish', {
    method: 'POST',
    headers: headersJSON(true),
    body: JSON.stringify(payload || {})
  });
}

// ---- CLAIM ----
export async function claimStart(amount) {
  const amtNum = Number(amount || 0);
  return fetchJSON('/claim/start', {
    method: 'POST',
    headers: headersJSON(true),
    body: JSON.stringify({ amount: amtNum })
  });
}

// ---- Tiny bridge so non-module scripts (older WC, etc.) can call API ----
try {
  window.JetsApi = window.JetsApi || {};
  Object.assign(window.JetsApi, {
    setWallet,
    setAuthToken,
    // auth
    sessionStart,
    sessionVerify,
    startSession,
    verifySession,
    // profile
    getProfile,
    profile,
    // gameplay
    getMsCosts,
    msUpgrade,
    battleStart,
    battleTurn,
    battleFinish,
    // claim
    claimStart
  });
} catch {}
