// index.js — XRPixel Jets API (2025-10-26-claims5 + fractional ENERGY REGEN)
// - Regen upgrades: +0.1 per level (REGEN_STEP, env-overridable)
// - recomputeCurrent(): regenPerMin = base + level*REGEN_STEP
// - regenEnergyIfDue(): respects fractional rpm (adds whole energy over elapsed time)
// - Hooks for regen remain on /profile, /battle/start, /battle/turn
// - Everything else preserved

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
const BASE_PER_LEVEL  = Number(process.env.BASE_PER_LEVEL || 300);
const REGEN_STEP      = Number(process.env.REGEN_STEP || 0.1); // +0.1 energy/min per regen level

// ---- CORS plugin ----
await app.register(cors, {
  origin: (origin, cb) => { if (!origin) return cb(null, true); cb(null, ALLOW.includes(origin)); },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Accept','Origin','X-Wallet','Authorization','X-Idempotency-Key'],
  credentials: false
});

// Always include ACAO (even on errors)
app.addHook('onSend', async (req, reply, payload) => {
  const origin = req.headers.origin;
  if (origin && ALLOW.includes(origin)) { reply.header('Access-Control-Allow-Origin', origin); reply.header('Vary', 'Origin'); }
  return payload;
});
app.setErrorHandler((err, req, reply) => {
  const origin = req.headers.origin;
  if (origin && ALLOW.includes(origin)) { reply.header('Access-Control-Allow-Origin', origin); reply.header('Vary', 'Origin'); }
  const code = err.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
  req.log.error({ err }, 'request_error');
  reply.code(code).send({ error: 'internal_error' });
});

// ---------- DB ----------
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ---------- utils ----------
const toInt  = (x, d=0) => { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : d; };
const nowSec = () => Math.floor(Date.now()/1000);
const asciiToHex = (s) => Buffer.from(String(s),'utf8').toString('hex');

const NONCES = new Map();
const newNonce = () => crypto.randomBytes(32).toString('hex');
function storeNonce(address, nonce){ NONCES.set(address,{nonce,exp:Date.now()+5*60_000,used:false}); }
function takeNonce(address){ const r=NONCES.get(address); if(!r){return {err:'expired_nonce'}}; NONCES.delete(address); if(r.used||Date.now()>r.exp){return {err:'expired_nonce'}}; r.used=true; return {ok:true, nonce:r.nonce}; }

const isSecpPublicKeyHex   = (pk) => typeof pk==='string' && /^(02|03)[0-9A-Fa-f]{64}$/.test(pk);
const isEd25519PublicKeyHex= (pk) => typeof pk==='string' && /^ED[0-9A-Fa-f]{64}$/.test(pk);

// Rate limit + X-Wallet (skip for /session/start and /config)
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
async function ensureProfile(wallet){
  await pool.query(
    `insert into player_profiles (wallet) values ($1) on conflict (wallet) do nothing`,
    [wallet]
  );
}
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
 from player_profiles where wallet=$1`,
    [wallet]
  );
  return rows[0] || null;
}

// NOTE: 'level' here is the *levels purchased*, recomputed into current via REGEN_STEP
function recomputeCurrent(base, level){
  const b  = base  || { health:20, energyCap:100, regenPerMin:1 };
  const lv = level || { health:0,  energyCap:0,   regenPerMin:0 };
  return {
    health:     (b.health|0)    + (lv.health|0),
    energyCap:  (b.energyCap|0) + (lv.energyCap|0),
    regenPerMin: Number(b.regenPerMin || 0) + Number(lv.regenPerMin || 0) * REGEN_STEP
  };
}
function toClient(row){
  const ms_current = row.ms_current || recomputeCurrent(row.ms_base, row.ms_level);
  return {
    ms: { base:row.ms_base, level:row.ms_level, current:ms_current },
    pct:{ hit:row.ms_hit|0, crit:row.ms_crit|0, dodge:row.ms_dodge|0 },
    jetFuel:row.jet_fuel|0, energy:row.energy|0, energyCap:row.energy_cap|0, unlockedLevel:row.unlocked_level|0
  };
}

// ---------- server-side ENERGY REGEN (fractional rpm supported) ----------
async function regenEnergyIfDue(wallet){
  let row = await getProfileRaw(wallet);
  if (!row) return null;

  const cur = row.ms_current || recomputeCurrent(row.ms_base, row.ms_level);
  const cap = Number(cur.energyCap ?? row.energy_cap ?? 100) || 100;
  const rpm = Number(cur.regenPerMin || 0); // may be fractional

  if (rpm <= 0) return row;

  const nowS   = nowSec();
  const lastS  = row.updated_at ? Math.floor(new Date(row.updated_at).getTime()/1000) : nowS;
  const deltaS = Math.max(0, nowS - lastS);

  // accrue whole energy points from fractional regen/min
  const gain = Math.floor((deltaS * rpm) / 60);
  if (gain <= 0) return row;

  const before = row.energy|0;
  if (before >= cap) return row;

  const after = Math.min(cap, before + gain);
  if (after === before) return row;

  const { rows } = await pool.query(
    `update player_profiles set energy=$2, updated_at=now() where wallet=$1 returning *`,
    [wallet, after]
  );
  return rows[0] || row;
}

// ---------- jwt ----------
function signJWT(address, scope='play,upgrade,claim'){
  const now=nowSec(); const exp=now+60*60;
  return jwt.sign({sub:address,scope,iat:now,exp}, JWT_SECRET, {algorithm:'HS256'});
}
function requireJWT(req, reply){
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { reply.code(401).send({ error:'unauthorized' }); return null; }
  try { return jwt.verify(token, JWT_SECRET, { algorithms:['HS256'] }); }
  catch { reply.code(401).send({ error:'unauthorized' }); return null; }
}

// ---------- econ ----------
function getEconScaleFrom(arg){
  const n=Number(arg);
  return (Number.isFinite(n)&&n>=0) ? n : ECON_SCALE_ENV;
}
function levelsFromRow(row){
  const lv=row?.ms_level||{};
  return {
    health:toInt(lv.health,0),
    energyCap:toInt(lv.energyCap,0),
    regenPerMin:toInt(lv.regenPerMin,0), // count of levels; recomputed to rpm via REGEN_STEP
    hit:toInt(row?.ms_hit,0),
    crit:toInt(row?.ms_crit,10),
    dodge:toInt(row?.ms_dodge,0)
  };
}
function unitCost(level,s){ const raw=BASE_PER_LEVEL*(toInt(level,0)+1); return Math.max(1, Math.round(raw*s)); }
function calcCosts(levels,s){
  return {
    health:unitCost(levels.health,s),
    energyCap:unitCost(levels.energyCap,s),
    regenPerMin:unitCost(levels.regenPerMin,s),
    hit:unitCost(levels.hit,s),
    crit:unitCost(levels.crit,s),
    dodge:unitCost(levels.dodge,s)
  };
}
function missionReward(level){
  const l=Math.max(1,Number(level)||1);
  if(l<=5) return [0,100,150,200,250,300][l];
  return Math.max(1, Math.min(10000, Math.round(300*Math.pow(1.01,l-5))));
}

// ---------- public config ----------
app.get('/config', async (_req, reply) => {
  reply.send({
    tokenMode: (process.env.TOKEN_MODE || 'mock').toLowerCase(),
    network: process.env.XRPL_WSS || process.env.NETWORK || 'wss://s.altnet.rippletest.net:51233',
    currencyCode: (process.env.CURRENCY_CODE || process.env.CURRENCY || 'JETS'),
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
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) return reply.code(400).send({ error:'bad_address' });
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

// ---------- profile ----------
app.get('/profile', async (req, reply) => {
  await ensureProfile(req.wallet);
  const rowR = await regenEnergyIfDue(req.wallet); // fractional regen here
  const row  = rowR || await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error:'not_found' });
  reply.send(toClient(row));
});

// ---------- costs & upgrade ----------
app.get('/ms/costs', async (req, reply) => {
  const scale = getEconScaleFrom(req.query?.econScale);
  const row = await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error:'not_found' });
  const levels = levelsFromRow(row);
  reply.send({ costs: calcCosts(levels, scale), levels, scale });
});
app.post('/ms/upgrade', async (req, reply) => {
  const q = req.body || {}; const scale = getEconScaleFrom(q.econScale);
  let row = await getProfileRaw(req.wallet); if (!row) return reply.code(404).send({ error:'not_found' });
  const levels = levelsFromRow(row);
  const order=['health','energyCap','regenPerMin','hit','crit','dodge'];
  let jf=row.jet_fuel|0; const applied={health:0,energyCap:0,regenPerMin:0,hit:0,crit:0,dodge:0}; let spent=0;

  for (const key of order) {
    const want = Math.max(0, toInt(q[key],0));
    for(let i=0;i<want;i++){
      const lvlNow=(key==='health'||key==='energyCap'||key==='regenPerMin')?levels[key]:(key==='hit'?levels.hit:(key==='crit'?levels.crit:levels.dodge));
      const price=Math.max(1, Math.round(BASE_PER_LEVEL*(lvlNow+1)*getEconScaleFrom(scale)));
      if (jf<price) break;
      jf-=price; spent+=price; applied[key]+=1;
      if (key==='health'||key==='energyCap'||key==='regenPerMin') levels[key]+=1;
      else if (key==='hit') levels.hit+=1; else if (key==='crit') levels.crit+=1; else levels.dodge+=1;
    }
  }
  const newCore={ health:levels.health, energyCap:levels.energyCap, regenPerMin:levels.regenPerMin }; // regen "levels"
  const ms_current=recomputeCurrent(row.ms_base, newCore); // -> applies REGEN_STEP
  const { rows } = await pool.query(
`update player_profiles set jet_fuel=$2, ms_level=$3, ms_current=$4, ms_hit=$5, ms_crit=$6, ms_dodge=$7, updated_at=now()
 where wallet=$1 returning *`,
    [req.wallet, jf, JSON.stringify(newCore), JSON.stringify(ms_current), levels.hit, levels.crit, levels.dodge]
  );
  reply.send({ ok:true, applied, spent, profile: toClient(rows[0]), scale });
});

// ---------- battle ----------
app.post('/battle/start', async (req, reply) => {
  const level = toInt((req.body||{}).level, 1);
  let row = await regenEnergyIfDue(req.wallet); if (!row) row = await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error:'not_found' });
  let energy=row.energy|0, spent=0; if (energy>=10){ energy-=10; spent=10; }
  const { rows } = await pool.query(
    `update player_profiles set energy=$2, updated_at=now() where wallet=$1 returning *`,
    [req.wallet, energy]
  );
  reply.send({ ok:true, level, spent, profile: toClient(rows[0]) });
});
app.post('/battle/turn', async (req, reply) => {
  let row = await regenEnergyIfDue(req.wallet); if (!row) row = await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error:'not_found' });
  let energy=row.energy|0, spent=0; if (energy>=1){ energy-=1; spent=1; }
  const { rows } = await pool.query(
    `update player_profiles set energy=$2, updated_at=now() where wallet=$1 returning *`,
    [req.wallet, energy]
  );
  reply.send({ ok:true, spent, profile: toClient(rows[0]) });
});
app.post('/battle/finish', async (req, reply) => {
  const lvl=Math.max(1, toInt((req.body||{}).level,1)); const victory=!!(req.body||{}).victory;
  let row = await getProfileRaw(req.wallet); if (!row) return reply.code(404).send({ error:'not_found' });
  let jf=row.jet_fuel|0, unlocked=row.unlocked_level|0, reward=0;
  if (victory){ reward=missionReward(lvl); jf+=reward; if (lvl>=unlocked) unlocked=lvl+1; }
  const { rows } = await pool.query(
    `update player_profiles set jet_fuel=$2, unlocked_level=$3, updated_at=now() where wallet=$1 returning *`,
    [req.wallet, jf, unlocked]
  );
  reply.send({ ok:true, reward, victory, level:lvl, profile: toClient(rows[0]) });
});

// ---------- claim ----------
app.post('/claim/start', async (req, reply) => {
  const jwtOk = requireJWT(req, reply); if (!jwtOk) return;

  const amt = toInt(req.body?.amount, 0);
  if (!Number.isFinite(amt) || amt <= 0) return reply.code(400).send({ error:'bad_amount' });

  const row = await getProfileRaw(req.wallet); if (!row) return reply.code(404).send({ error:'not_found' });

  // Cooldown (unchanged)
  const nowS = nowSec(); const lastS = row.last_claim_at ? Math.floor(new Date(row.last_claim_at).getTime()/1000) : 0;
  const COOL = Number(process.env.CLAIM_COOLDOWN_SEC || 300);
  if (COOL>0 && (nowS-lastS)<COOL) return reply.code(429).send({ error:'cooldown' });

  // 1) Atomically debit jet_fuel (only if enough balance)
  const debit = await pool.query(
`update player_profiles
   set jet_fuel = jet_fuel - $2,
       last_claim_at = now(),
       updated_at = now()
 where wallet = $1
   and jet_fuel >= $2
 returning *`,
    [req.wallet, amt]
  );
  if (debit.rows.length === 0) {
    return reply.code(400).send({ error:'insufficient_funds' });
  }
  const debitedProfile = toClient(debit.rows[0]);

  try {
    // 2) XRPL payout
    const sent = await claim.sendIssued({ to:req.wallet, amount: amt });

    // 3) Audit success
    await pool.query(
      `insert into claim_audit (wallet, amount, tx_hash) values ($1,$2,$3)`,
      [req.wallet, amt, sent?.txid||null]
    ).catch(()=>{});

    const latest = await getProfileRaw(req.wallet);
    return reply.send({ ok:true, txid: sent?.txid || null, txJSON: sent?.txJSON || null, profile: toClient(latest || debit.rows[0]) });
  } catch (e) {
    await pool.query(`update player_profiles set jet_fuel = jet_fuel + $2, updated_at=now() where wallet=$1`, [req.wallet, amt]).catch(()=>{});
    const msg = String(e?.message||'');
    if (msg.includes('trustline_required'))         return reply.code(400).send({ error:'trustline_required' });
    if (msg.includes('issuer_rippling_disabled'))   return reply.code(500).send({ error:'issuer_rippling_disabled' });
    if (msg.includes('hot_wallet_no_inventory'))    return reply.code(500).send({ error:'server_hot_no_inventory' });
    if (msg.includes('hot_wallet_needs_trustline')) return reply.code(500).send({ error:'server_hot_needs_trustline' });
    if (msg.includes('hot_wallet_missing'))         return reply.code(500).send({ error:'server_hot_wallet_missing' });
    if (msg.includes('issuer_missing'))             return reply.code(500).send({ error:'server_issuer_missing' });
    return reply.code(500).send({ error:'claim_failed' });
  }
});

// ---------- health ----------
app.get('/healthz', async (_req, reply) => reply.send({ ok:true }));

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`XRPixel Jets API listening on :${PORT}`);
});
