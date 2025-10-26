// index.js — XRPixel Jets API (2025-10-26-cors2)
import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';
import jwt from 'jsonwebtoken';
import * as keypairs from 'ripple-keypairs';
import crypto from 'crypto';
import * as claim from './claimJetFuel.js';

const { Pool } = pkg;
const app = Fastify({ logger: true });

const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';
const ALLOW = (process.env.CORS_ORIGIN || 'https://mykeygo.io,https://www.mykeygo.io,http://localhost:8000')
  .split(',').map(s => s.trim()).filter(Boolean);

const ECON_SCALE_ENV = Number(process.env.ECON_SCALE || 0.10);
const BASE_PER_LEVEL = Number(process.env.BASE_PER_LEVEL || 300);

// ---- CORS (permissive allowlist fn + OPTIONS catch-all) ----
await app.register(cors, {
  origin: (origin, cb) => {
    // allow same-origin/non-browser and any listed origin
    if (!origin) return cb(null, true);
    const ok = ALLOW.includes(origin);
    cb(null, ok);
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Accept','Origin','X-Wallet','Authorization'],
  credentials: false
});
// Preflight fallback (some proxies strip plugin headers on 502s)
app.options('/*', async (req, reply) => {
  const o = req.headers.origin || '';
  if (o && ALLOW.includes(o)) reply.header('Access-Control-Allow-Origin', o);
  reply
    .header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    .header('Access-Control-Allow-Headers', 'Content-Type,Accept,Origin,X-Wallet,Authorization')
    .send();
});

// ---------- DB ----------
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ---------- utils ----------
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const toInt = (x, d=0) => { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : d; };
const nowSec = () => Math.floor(Date.now()/1000);
const asciiToHex = (s) => Buffer.from(String(s),'utf8').toString('hex');

const NONCES = new Map();
const newNonce = () => crypto.randomBytes(32).toString('hex');
function storeNonce(address, nonce){ NONCES.set(address, { nonce, exp: Date.now()+5*60_000, used:false }); }
function takeNonce(address){ const r = NONCES.get(address); if(!r){return {err:'expired_nonce'}}; NONCES.delete(address); if(r.used || Date.now()>r.exp){return {err:'expired_nonce'}}; r.used=true; return {ok:true, nonce:r.nonce}; }

const isSecpPublicKeyHex = (pk) => typeof pk==='string' && /^(02|03)[0-9A-Fa-f]{64}$/.test(pk);
const isEd25519PublicKeyHex = (pk) => typeof pk==='string' && /^ED[0-9A-Fa-f]{64}$/.test(pk);

// Rate limit + X-Wallet (skip for unauth’d + preflights)
const RATE = { windowMs: 10_000, maxPerWindow: 30 };
const bucket = new Map();
app.addHook('onRequest', async (req, reply) => {
  const url = req.raw.url || '';
  if (req.method === 'OPTIONS') return;
  if (url.startsWith('/session/start') || url.startsWith('/config')) return;

  const w = req.headers['x-wallet'];
  if (!w || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(w)) return reply.code(400).send({ error:'missing_or_bad_X-Wallet' });
  req.wallet = w;

  const key = `${req.ip}|${w}`;
  const now = Date.now();
  const cur = bucket.get(key) || { count: 0, ts: now };
  if (now - cur.ts > RATE.windowMs) { cur.count = 0; cur.ts = now; }
  cur.count += 1; bucket.set(key, cur);
  if (cur.count > RATE.maxPerWindow) return reply.code(429).send({ error:'rate_limited' });
});

// ---------- profile helpers ----------
async function ensureProfile(wallet){ await pool.query(`insert into player_profiles (wallet) values ($1) on conflict (wallet) do nothing`, [wallet]); }
async function getProfileRaw(wallet){
  const { rows } = await pool.query(
`select wallet,
  coalesce(jet_fuel,0)::int as jet_fuel,
  coalesce(energy,0)::int as energy,
  coalesce(energy_cap,100)::int as energy_cap,
  ms_base, ms_level, ms_current,
  coalesce(ms_hit,0)::int as ms_hit,
  coalesce(ms_crit,10)::int as ms_crit,
  coalesce(ms_dodge,0)::int as ms_dodge,
  coalesce(unlocked_level,1)::int as unlocked_level,
  last_claim_at, updated_at, created_at
 from player_profiles where wallet=$1`, [wallet]);
  return rows[0] || null;
}
function recomputeCurrent(base, level) {
  const b = base || { health:20, energyCap:100, regenPerMin:1 };
  const lv = level || { health:0, energyCap:0, regenPerMin:0 };
  return { health:(b.health|0)+(lv.health|0), energyCap:(b.energyCap|0)+(lv.energyCap|0), regenPerMin:(b.regenPerMin|0)+(lv.regenPerMin|0) };
}
function toClient(row){
  const ms_current = row.ms_current || recomputeCurrent(row.ms_base, row.ms_level);
  return { ms:{base:row.ms_base, level:row.ms_level, current:ms_current},
           pct:{hit:row.ms_hit|0, crit:row.ms_crit|0, dodge:row.ms_dodge|0},
           jetFuel:row.jet_fuel|0, energy:row.energy|0, energyCap:row.energy_cap|0, unlockedLevel:row.unlocked_level|0 };
}
async function applyRegen(wallet,row){
  try {
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(row.updated_at))/60000));
    const ms = recomputeCurrent(row.ms_base, row.ms_level);
    const regen = (ms.regenPerMin|0)||1;
    if (minutes>0 && regen>0) {
      const cap = (row.energy_cap|0)||100;
      const next = Math.max(0, Math.min(cap, (row.energy|0) + minutes*regen));
      if (next !== (row.energy|0)) {
        const { rows } = await pool.query(
`update player_profiles set energy=$2, ms_current=$3, updated_at=now() where wallet=$1 returning *`,
          [wallet, next, JSON.stringify(ms)]);
        return rows[0];
      }
    }
  } catch {}
  return row;
}

// ---------- jwt ----------
function signJWT(address, scope='play,upgrade,claim'){ const now=nowSec(); const exp=now+60*60; return jwt.sign({sub:address,scope,iat:now,exp}, JWT_SECRET, {algorithm:'HS256'}); }
function requireJWT(req, reply){
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { reply.code(401).send({ error:'unauthorized' }); return null; }
  try { return jwt.verify(token, JWT_SECRET, { algorithms:['HS256'] }); } catch { reply.code(401).send({ error:'unauthorized' }); return null; }
}

// ---------- econ ----------
function getEconScaleFrom(arg){ const n=Number(arg); return (Number.isFinite(n)&&n>=0) ? n : ECON_SCALE_ENV; }
function levelsFromRow(row){ const lv=row?.ms_level||{}; return { health:toInt(lv.health,0), energyCap:toInt(lv.energyCap,0), regenPerMin:toInt(lv.regenPerMin,0), hit:toInt(row?.ms_hit,0), crit:toInt(row?.ms_crit,10), dodge:toInt(row?.ms_dodge,0) }; }
function unitCost(level,s){ const raw=BASE_PER_LEVEL*(toInt(level,0)+1); return Math.max(1, Math.round(raw*s)); }
function calcCosts(levels,s){ return { health:unitCost(levels.health,s), energyCap:unitCost(levels.energyCap,s), regenPerMin:unitCost(levels.regenPerMin,s), hit:unitCost(levels.hit,s), crit:unitCost(levels.crit,s), dodge:unitCost(levels.dodge,s) }; }
function missionReward(level){ const l=Math.max(1,Number(level)||1); if(l<=5) return [0,100,150,200,250,300][l]; return Math.max(1, Math.min(10000, Math.round(300*Math.pow(1.01,l-5)))); }

// ---------- public config ----------
app.get('/config', async (_req, reply) => {
  reply.send({
    tokenMode: (process.env.TOKEN_MODE || 'mock').toLowerCase(),
    network: process.env.XRPL_WSS || process.env.NETWORK || 'wss://s.altnet.rippletest.net:51233',
    currencyCode: process.env.CURRENCY_CODE || process.env.CURRENCY || 'JFUEL',
    currencyHex: process.env.CURRENCY_HEX || null,
    issuer: process.env.ISSUER_ADDRESS || process.env.ISSUER_ADDR || null
  });
});

// ---------- auth ----------
app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) return reply.code(400).send({ error:'bad_address' });
  await ensureProfile(address);
  const nonce = newNonce(); storeNonce(address, nonce);
  reply.send({ nonce });
});
app.post('/session/verify', async (req, reply) => {
  const { address, signature, publicKey, payloadHex, scope='play,upgrade,claim', ts } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.est(address)) return reply.code(400).send({ error:'bad_address' });
  if (!signature) return reply.code(400).send({ error:'bad_signature' });
  if (!publicKey) return reply.code(400).send({ error:'bad_key' });
  if (isEd25519PublicKeyHex(publicKey)) return reply.code(400).send({ error:'bad_key_algo', detail:'secp_required' });
  if (!isSecpPublicKeyHex(publicKey)) return reply.code(400).send({ error:'bad_key' });
  const taken = takeNonce(address); if (!taken.ok) return reply.code(400).send({ error:taken.err });
  const now = nowSec(); const tsNum = Number(ts || now);
  if (!Number.isFinite(tsNum) || Math.abs(now-tsNum)>300) return reply.code(400).send({ error:'expired_nonce' });
  const expectedHex = payloadHex && payloadHex.length>=8 ? payloadHex : asciiToHex(`${taken.nonce}||${scope}||${tsNum}||${address}`);
  let okSig=false, derived='';
  try { okSig = keypairs.verify(expectedHex, signature, publicKey)===true; derived = keypairs.deriveAddress(publicKey); } catch {}
  if (!okSig) return reply.code(401).send({ error:'bad_signature' });
  if (derived !== address) return reply.code(401).send({ error:'unauthorized' });
  reply.send({ ok:true, jwt: signJWT(address, scope) });
});

// ---------- routes (profile, costs, upgrades, battle) ----------
/* (unchanged from your working build) — keep your handlers here verbatim */

// ---------- claim ----------
app.post('/claim/start', async (req, reply) => {
  const jwtOk = requireJWT(req, reply); if (!jwtOk) return;
  const amt = Number(req.body?.amount || 0);
  if (!Number.isFinite(amt) || amt<=0) return reply.code(400).send({ error:'bad_amount' });

  const row = await getProfileRaw(req.wallet); if (!row) return reply.code(404).send({ error:'not_found' });
  const nowS = nowSec(); const lastS = row.last_claim_at ? Math.floor(new Date(row.last_claim_at).getTime()/1000) : 0;
  const COOL = Number(process.env.CLAIM_COOLDOWN_SEC || 300);
  if (COOL>0 && (nowS-lastS)<COOL) return reply.code(429).send({ error:'cooldown' });

  try {
    const sent = await claim.sendIssued({ to:req.wallet, amount: amt }); // may fallback on path issues
    await pool.query(`update player_profiles set last_claim_at=now(), updated_at=now() where wallet=$1`, [req.wallet]).catch(()=>{});
    await pool.query(`insert into claim_audit (wallet, amount, tx_hash) values ($1,$2,$3)`, [req.wallet, amt, sent?.txid||null]).catch(()=>{});
    reply.send({ ok:true, txid: sent?.txid || null, txJSON: sent?.txJSON || null });
  } catch (e) {
    const msg = String(e?.message||'');
    if (msg.includes('trustline_required'))         return reply.code(400).send({ error:'trustline_required' });
    if (msg.includes('path_liquidity'))             return reply.code(500).send({ error:'server_path_liquidity' });
    if (msg.includes('hot_wallet_no_inventory'))    return reply.code(500).send({ error:'server_hot_no_inventory' });
    if (msg.includes('hot_wallet_needs_trustline')) return reply.code(500).send({ error:'server_hot_needs_trustline' });
    if (msg.includes('hot_wallet_missing'))         return reply.code(500).send({ error:'server_hot_wallet_missing' });
    if (msg.includes('issuer_missing'))             return reply.code(500).send({ error:'server_issuer_missing' });
    return reply.code(500).send({ error:'claim_failed' });
  }
});

app.get('/healthz', async (_req, reply) => reply.send({ ok:true }));

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`XRPixel Jets API listening on :${PORT}`);
});
