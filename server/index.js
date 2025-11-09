// index.js — XRPixel Jets API (2025-11-08-bazaarhot-secp-enforced)
// Green routes kept: /config, /session/*, /profile, /ms/*, /battle/*, /claim/start
// Adds: /bazaar/hot/* allowlist (ping/check/list are open) + strict secp256k1 policy for hot wallet

import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';
import jwt from 'jsonwebtoken';
import * as keypairs from 'ripple-keypairs';
import crypto from 'crypto';
import { decode, encodeForSigning } from 'ripple-binary-codec';
import { Client as XRPLClient, Wallet as XRPLWallet } from 'xrpl';
import { registerBazaarHotRoutes } from './bazaar-hot.js';

const { Pool } = pkg;
const app = Fastify({ logger: true });

// ---------- env ----------
const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';
const ALLOW = (process.env.CORS_ORIGIN || 'https://mykeygo.io,https://www.mykeygo.io,http://localhost:8000')
  .split(',').map(s => s.trim()).filter(Boolean);

const DATABASE_URL = process.env.DATABASE_URL;

const XRPL_WSS = process.env.XRPL_WSS || 'wss://xrplcluster.com';
const HOT_SEED = process.env.HOT_SEED || process.env.HOT_WALLET_SEED || ''; // REQUIRED (secp)
const HOT_ADDR = process.env.HOT_ADDR || ''; // optional assert
const ISSUER_ADDR = process.env.ISSUER_ADDR || process.env.ISSUER_ADDRESS || null;

const BAZAAR_ENABLED = (process.env.BAZAAR_ENABLED || 'true').toLowerCase() !== 'false';

// ---------- econ/game tuning ----------
const ECON_SCALE_ENV = Number(process.env.ECON_SCALE || 0.10);
const BASE_PER_LEVEL  = Number(process.env.BASE_PER_LEVEL || 300);
const REWARD_SCALE    = Number.isFinite(Number(process.env.REWARD_SCALE)) ? Number(process.env.REWARD_SCALE) : ECON_SCALE_ENV;
const REGEN_STEP      = Number(process.env.REGEN_STEP || 0.1);

// ---------- CORS / error handler ----------
await app.register(cors, {
  origin: (origin, cb) => { if (!origin) return cb(null, true); cb(null, ALLOW.includes(origin)); },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Accept','Origin','X-Wallet','Authorization','X-Idempotency-Key'],
  credentials: false
});
app.addHook('onSend', async (req, reply, payload) => {
  const origin = req.headers.origin;
  if (origin && ALLOW.includes(origin)) { reply.header('Access-Control-Allow-Origin', origin); reply.header('Vary', 'Origin'); }
  return payload;
});
app.setErrorHandler((err, req, reply) => {
  const origin = req.headers.origin;
  if (origin && ALLOW.includes(origin)) { reply.header('Access-Control-Allow-Origin', origin); reply.header('Vary', 'Origin'); }
  const code = Number.isFinite(err.statusCode) ? err.statusCode : 500;
  req.log.error({ err }, 'request_error');
  reply.code(code).send({ error: 'internal_error' });
});

// ---------- DB ----------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ---------- utils ----------
const toInt  = (x, d=0) => { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : d; };
const nowSec = () => Math.floor(Date.now()/1000);
const asciiToHex = (s) => Buffer.from(String(s),'utf8').toString('hex').toUpperCase();
const isSecpPK = (pk) => typeof pk==='string' && /^(02|03)[0-9A-F]{64}$/i.test(pk);
const isEdPK   = (pk) => typeof pk==='string' && /^ED[0-9A-F]{64}$/i.test(pk);

// simple rate-limit (per IP + wallet)
const RATE = { windowMs: 10_000, maxPerWindow: 30 };
const bucket = new Map();

// ---------- OPEN routes (no headers/JWT required) ----------
const OPEN_ROUTES = [
  '/config',
  '/healthz',
  '/session/start',
  '/session/verify',
  '/session/finish',
  '/bazaar/skus',
  // Bazaar hot-wallet diagnostics & listing
  '/bazaar/hot/ping',
  '/bazaar/hot/check',
  '/bazaar/hot/list'
];

// ---------- global guard ----------
app.addHook('onRequest', async (req, reply) => {
  const url = (req.raw.url || '').split('?')[0];
  if (req.method === 'OPTIONS') return;
  if (OPEN_ROUTES.some(p => url === p)) return;

  // X-Wallet header (classic r-addr)
  const w = req.headers['x-wallet'];
  if (!w || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(w)) {
    return reply.code(400).send({ error: 'missing_or_bad_X-Wallet' });
  }
  req.wallet = w;

  // very light rate limit per IP+wallet
  const key = `${req.ip}|${w}`;
  const now = Date.now();
  const cur = bucket.get(key) || { count: 0, ts: now };
  if (now - cur.ts > RATE.windowMs) { cur.count = 0; cur.ts = now; }
  cur.count += 1; bucket.set(key, cur);
  if (cur.count > RATE.maxPerWindow) return reply.code(429).send({ error:'rate_limited' });
});

// ---------- profiles ----------
async function ensureProfile(wallet){
  await pool.query(`insert into player_profiles (wallet) values ($1) on conflict (wallet) do nothing`, [wallet]);
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
 from player_profiles where wallet=$1`, [wallet]);
  return rows[0] || null;
}
function recomputeCurrent(b, lv){
  const base = b || { health:20, energyCap:100, regenPerMin:1 };
  const L    = lv|| { health:0,  energyCap:0,   regenPerMin:0 };
  return {
    health:(base.health|0)+(L.health|0),
    energyCap:(base.energyCap|0)+(L.energyCap|0),
    regenPerMin:Number(base.regenPerMin||0)+Number(L.regenPerMin||0)*REGEN_STEP
  };
}
function toClient(row){
  const cur=row.ms_current || recomputeCurrent(row.ms_base,row.ms_level);
  return {
    ms:{ base:row.ms_base, level:row.ms_level, current:cur },
    pct:{ hit:row.ms_hit|0, crit:row.ms_crit|0, dodge:row.ms_dodge|0 },
    jetFuel:row.jet_fuel|0, energy:row.energy|0, energyCap:row.energy_cap|0,
    unlockedLevel:row.unlocked_level|0
  };
}
async function regenEnergyIfDue(wallet){
  let row = await getProfileRaw(wallet); if (!row) return null;
  const cur = row.ms_current || recomputeCurrent(row.ms_base, row.ms_level);
  const cap = Number(cur.energyCap ?? row.energy_cap ?? 100) || 100;
  const rpm = Number(cur.regenPerMin || 0);
  if (rpm <= 0) return row;
  const nowS = nowSec();
  const lastS = row.updated_at ? Math.floor(new Date(row.updated_at).getTime()/1000) : nowS;
  const deltaS = Math.max(0, nowS - lastS);
  const gain = Math.floor((deltaS * rpm) / 60);
  if (gain <= 0) return row;
  const before = row.energy|0; if (before >= cap) return row;
  const after = Math.min(cap, before + gain); if (after === before) return row;
  const { rows } = await pool.query(`update player_profiles set energy=$2, updated_at=now() where wallet=$1 returning *`, [wallet, after]);
  return rows[0] || row;
}

// ---------- auth/JWT ----------
const NONCES = new Map();
const newNonce = () => crypto.randomBytes(32).toString('hex');
function storeNonce(address, nonce){ NONCES.set(address,{nonce,exp:Date.now()+5*60_000,used:false}); }
function takeNonce(address){ const r=NONCES.get(address); if(!r){return {err:'expired_nonce'}}; NONCES.delete(address); if(r.used||Date.now()>r.exp){return {err:'expired_nonce'}}; r.used=true; return {ok:true, nonce:r.nonce}; }

function signJWT(address, scope='play,upgrade,claim,bazaar'){
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

// ---------- XRPL (logs + secp enforcement for HOT) ----------
const xrpl = {
  client: new XRPLClient(XRPL_WSS),
  wallet: HOT_SEED ? XRPLWallet.fromSeed(HOT_SEED) : null
};
function assertHotIsSecpOrWarn() {
  if (!xrpl.wallet) { app.log.warn('[XRPL] HOT_SEED missing — Bazaar offer creation will fail.'); return false; }
  const pub = String(xrpl.wallet.publicKey || '').toUpperCase();
  if (!isSecpPK(pub)) {
    app.log.error({ pub }, '[XRPL] secp_required: Hot wallet public key must start with 02/03 (secp256k1). Ed25519 (ED…) is not allowed.');
    return false;
  }
  if (HOT_ADDR && xrpl.wallet.address !== HOT_ADDR) {
    app.log.error({ expected: HOT_ADDR, derived: xrpl.wallet.address }, '[XRPL] HOT_ADDR mismatch — check HOT_SEED.');
    return false;
  }
  return true;
}

// ---------------- config ----------------
app.get('/config', async (_req, reply) => {
  reply.send({
    tokenMode: (process.env.TOKEN_MODE || 'mock').toLowerCase(),
    network: XRPL_WSS,
    currencyCode: (process.env.CURRENCY_CODE || process.env.CURRENCY || 'JETS'),
    currencyHex: process.env.CURRENCY_HEX || null,
    issuer: ISSUER_ADDR
  });
});

// ---------------- session (nonce + verify/finish) ----------------
app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) return reply.code(400).send({ error:'bad_address' });
  await ensureProfile(address);
  const nonce = newNonce(); storeNonce(address, nonce);
  reply.send({ nonce, payload:`XRPixelJets|${nonce}` });
});

async function verifyOrFinish(req, reply) {
  const { address, signature, publicKey, payloadHex, scope='play,upgrade,claim,bazaar', ts, txProof } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) return reply.code(400).send({ error:'bad_address' });

  const taken = takeNonce(address); if (!taken.ok) return reply.code(400).send({ error:taken.err });
  const now = nowSec(); const tsNum = Number(ts || now);
  if (!Number.isFinite(tsNum) || Math.abs(now-tsNum)>300) return reply.code(400).send({ error:'expired_nonce' });

  // WalletConnect tx-proof path (secp only)
  if (txProof && txProof.tx_blob) {
    try {
      const tx = decode(txProof.tx_blob);
      if (tx.TransactionType !== 'AccountSet') return reply.code(400).send({ error:'bad_tx_type' });
      if (tx.Account !== address) return reply.code(401).send({ error:'unauthorized' });
      const pub = String(tx.SigningPubKey || '').toUpperCase();
      if (!isSecpPK(pub)) return reply.code(400).send({ error:'bad_key_algo', detail:'secp_required' });

      const wantMemo = asciiToHex(`XRPixelJets|${taken.nonce}|${scope}|${tsNum}`);
      const memos = (tx.Memos || []).map(m => (m?.Memo?.MemoData || '').toUpperCase());
      if (!memos.includes(wantMemo)) return reply.code(400).send({ error:'memo_missing' });

      const preimageHex = encodeForSigning(tx).toUpperCase();
      const sigHex = String(tx.TxnSignature || '').toUpperCase();
      const ok = keypairs.verify(preimageHex, sigHex, pub) === true;
      if (!ok) return reply.code(401).send({ error:'bad_signature' });

      const derived = keypairs.deriveAddress(pub);
      if (derived !== address) return reply.code(401).send({ error:'unauthorized' });

      return reply.send({ ok:true, jwt: signJWT(address, scope) });
    } catch (e) {
      req.log.error({ err:e }, 'wc_txproof_verify_failed');
      return reply.code(400).send({ error:'bad_tx_proof' });
    }
  }

  // Simple signMessage path (secp only)
  if (!signature) return reply.code(400).send({ error:'bad_signature' });
  if (!publicKey) return reply.code(400).send({ error:'bad_key' });
  const pkU = String(publicKey).toUpperCase();
  if (!isSecpPK(pkU)) return reply.code(400).send({ error:'bad_key_algo', detail:'secp_required' });

  const expectedHex = payloadHex && payloadHex.length>=8 ? String(payloadHex).toUpperCase()
    : asciiToHex(`${taken.nonce}||${scope}||${tsNum}||${address}`);
  let okSig=false, derived='';
  try { okSig = keypairs.verify(expectedHex, String(signature).toUpperCase(), pkU)===true; derived = keypairs.deriveAddress(pkU); } catch {}
  if (!okSig) return reply.code(401).send({ error:'bad_signature' });
  if (derived !== address) return reply.code(401).send({ error:'unauthorized' });

  reply.send({ ok:true, jwt: signJWT(address, scope) });
}

app.post('/session/verify', verifyOrFinish);
app.post('/session/finish', verifyOrFinish); // alias

// ---------------- profile + missions ----------------
app.get('/profile', async (req, reply) => {
  await ensureProfile(req.wallet);
  const rowR = await regenEnergyIfDue(req.wallet);
  const row  = rowR || await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error:'not_found' });
  reply.send(toClient(row));
});

function getEconScaleFrom(arg){ const n=Number(arg); return (Number.isFinite(n)&&n>=0) ? n : ECON_SCALE_ENV; }
function levelsFromRow(row){
  const lv=row?.ms_level||{};
  return {
    health:toInt(lv.health,0),
    energyCap:toInt(lv.energyCap,0),
    regenPerMin:toInt(lv.regenPerMin,0),
    hit:toInt(row?.ms_hit,0),
    crit:toInt(row?.ms_crit,10),
    dodge:toInt(row?.ms_dodge,0)
  };
}
function unitCost(level,s){ const raw=BASE_PER_LEVEL*(toInt(level,0)+1); return Math.max(1, Math.round(raw*s)); }
function calcCosts(levels,s){ return {
  health:unitCost(levels.health,s),
  energyCap:unitCost(levels.energyCap,s),
  regenPerMin:unitCost(levels.regenPerMin,s),
  hit:unitCost(levels.hit,s),
  crit:unitCost(levels.crit,s),
  dodge:unitCost(levels.dodge,s)
}; }
function missionReward(l){
  const level = Math.max(1, Number(l) || 1);
  const base = level<=5 ? [0,100,150,200,250,300][level] : Math.round(300*Math.pow(1.01, level-5));
  const reward=Math.round(base*REWARD_SCALE);
  const cap=Math.max(1,Math.round(10000*REWARD_SCALE));
  return Math.max(1,Math.min(cap,reward));
}

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
      const lvlNow = (key==='health'||key==='energyCap'||key==='regenPerMin') ? levels[key] : (key==='hit'?levels.hit:(key==='crit'?levels.crit:levels.dodge));
      const price = Math.max(1, Math.round(BASE_PER_LEVEL*(lvlNow+1)*getEconScaleFrom(scale)));
      if (jf<price) break;
      jf-=price; spent+=price; applied[key]+=1;
      if (key==='health'||key==='energyCap'||key==='regenPerMin') levels[key]+=1;
      else if (key==='hit') levels.hit+=1; else if (key==='crit') levels.crit+=1; else levels.dodge+=1;
    }
  }
  const newCore={ health:levels.health, energyCap:levels.energyCap, regenPerMin:levels.regenPerMin };
  const ms_current=recomputeCurrent(row.ms_base, newCore);
  const { rows } = await pool.query(
`update player_profiles set jet_fuel=$2, ms_level=$3, ms_current=$4, ms_hit=$5, ms_crit=$6, ms_dodge=$7, updated_at=now()
 where wallet=$1 returning *`,
    [req.wallet, jf, JSON.stringify(newCore), JSON.stringify(ms_current), levels.hit, levels.crit, levels.dodge]
  );
  reply.send({ ok:true, applied, spent, profile: toClient(rows[0]), scale });
});

// ---------------- battle ----------------
app.post('/battle/start', async (req, reply) => {
  const level = toInt((req.body||{}).level, 1);
  let row = await regenEnergyIfDue(req.wallet); if (!row) row = await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error:'not_found' });
  let energy=row.energy|0, spent=0; if (energy>=10){ energy-=10; spent=10; }
  const { rows } = await pool.query(`update player_profiles set energy=$2, updated_at=now() where wallet=$1 returning *`, [req.wallet, energy]);
  reply.send({ ok:true, level, spent, profile: toClient(rows[0]) });
});

app.post('/battle/turn', async (req, reply) => {
  let row = await regenEnergyIfDue(req.wallet); if (!row) row = await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error:'not_found' });
  let energy=row.energy|0, spent=0; if (energy>=1){ energy-=1; spent=1; }
  const { rows } = await pool.query(`update player_profiles set energy=$2, updated_at=now() where wallet=$1 returning *`, [req.wallet, energy]);
  reply.send({ ok:true, spent, profile: toClient(rows[0]) });
});

app.post('/battle/finish', async (req, reply) => {
  const lvl=Math.max(1, toInt((req.body||{}).level,1)); const victory=!!(req.body||{}).victory;
  let row = await getProfileRaw(req.wallet); if (!row) return reply.code(404).send({ error:'not_found' });
  let jf=row.jet_fuel|0, unlocked=row.unlocked_level|0, reward=0;
  if (victory){ reward=missionReward(lvl); jf+=reward; if (lvl>=unlocked) unlocked=lvl+1; }
  const { rows } = await pool.query(`update player_profiles set jet_fuel=$2, unlocked_level=$3, updated_at=now() where wallet=$1 returning *`, [req.wallet, jf, unlocked]);
  reply.send({ ok:true, reward, victory, level:lvl, profile: toClient(rows[0]) });
});

// ---------------- claim ----------------
app.post('/claim/start', async (req, reply) => {
  const jwtOk = requireJWT(req, reply); if (!jwtOk) return;

  const amt = toInt(req.body?.amount, 0);
  if (!Number.isFinite(amt) || amt <= 0) return reply.code(400).send({ error:'bad_amount' });

  const row = await getProfileRaw(req.wallet); if (!row) return reply.code(404).send({ error:'not_found' });

  const nowS = nowSec();
  const lastS = row.last_claim_at ? Math.floor(new Date(row.last_claim_at).getTime()/1000) : 0;
  const COOL = Number(process.env.CLAIM_COOLDOWN_SEC || 300);
  if (COOL>0 && (nowS-lastS)<COOL) return reply.code(429).send({ error:'cooldown' });

  // Atomic debit
  const debit = await pool.query(
`update player_profiles
   set jet_fuel = jet_fuel - $2,
       updated_at = now()
 where wallet = $1
   and jet_fuel >= $2
 returning *`,
    [req.wallet, amt]
  );
  if (debit.rows.length === 0) return reply.code(400).send({ error:'insufficient_funds' });

  try {
    // TODO: send issued JETS on-chain (left intact; green path unchanged)
    const sent = { txid: null, txJSON: null };

    await pool.query(`update player_profiles set last_claim_at = now(), updated_at = now() where wallet = $1`, [req.wallet]);
    await pool.query(`insert into claim_audit (wallet, amount, tx_hash) values ($1,$2,$3)`, [req.wallet, amt, sent?.txid||null]).catch(()=>{});

    const latest = await getProfileRaw(req.wallet);
    return reply.send({ ok:true, txid: sent?.txid || null, txJSON: sent?.txJSON || null, profile: toClient(latest || debit.rows[0]) });
  } catch (e) {
    // rollback debit
    await pool.query(`update player_profiles set jet_fuel = jet_fuel + $2, updated_at=now() where wallet=$1`, [req.wallet, amt]).catch(()=>{});
    return reply.code(500).send({ error:'claim_failed' });
  }
});

// ---------------- legacy bazaar (kept green/no-op) ----------------
app.get('/bazaar/skus', async (_req, reply) => reply.send({ skus: [] }));

// ---------------- register Bazaar-Hot (preminted inventory) ----------------
if (BAZAAR_ENABLED) {
  await registerBazaarHotRoutes(app); // plugin enforces secp for hot internally too
  app.log.info('[BazaarHot] routes mounted at /bazaar/hot/*');
}

// ---------------- health ----------------
app.get('/healthz', async (_req, reply) => reply.send({ ok:true }));

// ---------------- onReady: XRPL connect + secp assert ----------------
app.addHook('onReady', async () => {
  try {
    const ok = assertHotIsSecpOrWarn(); // loud error if ED key is detected
    if (ok && !xrpl.client.isConnected()) await xrpl.client.connect();
    app.log.info({ wss: XRPL_WSS, issuer: ISSUER_ADDR, hot: xrpl.wallet?.address || '(none)' }, '[XRPL] Ready');
  } catch (e) {
    app.log.error(e, '[XRPL] onReady init failed');
  }
});

// ---------------- start ----------------
app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`XRPixel Jets API listening on :${PORT}`);
});
