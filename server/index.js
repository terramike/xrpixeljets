// index.js — XRPixel Jets API (2025-11-06-bazaar-json3-auto)
// Base: 2025-11-06-bazaar-json2 + auto reload + janitor + admin append/scan

import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';
import jwt from 'jsonwebtoken';
import * as keypairs from 'ripple-keypairs';
import crypto from 'crypto';
import * as claim from './claimJetFuel.js';
import { decode, encodeForSigning } from 'ripple-binary-codec';

// XRPL (for Bazaar offers)
import { Client as XRPLClient, Wallet as XRPLWallet } from 'xrpl';

// Bazaar JSON store (now with automation helpers)
import {
  loadBazaarFromFiles,
  getLiveSkus,
  getSku,
  reserveOneFromInventory,
  markSold,
  getLoadedInfo,
  startFileWatchers,
  appendInventory,
  reclaimExpiredOffers,
  scanHotWalletAndCollect
} from './bazaar-store.js';

const { Pool } = pkg;
const app = Fastify({ logger: true });

const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';
const ALLOW = (process.env.CORS_ORIGIN || 'https://mykeygo.io,https://www.mykeygo.io,http://localhost:8000')
  .split(',').map(s => s.trim()).filter(Boolean);

const ECON_SCALE_ENV = Number(process.env.ECON_SCALE || 0.10);
const BASE_PER_LEVEL  = Number(process.env.BASE_PER_LEVEL || 300);
const REGEN_STEP      = Number(process.env.REGEN_STEP || 0.1);
const REWARD_SCALE    = Number.isFinite(Number(process.env.REWARD_SCALE))
  ? Number(process.env.REWARD_SCALE)
  : ECON_SCALE_ENV;

// XRPL config for Bazaar
const XRPL_WSS = process.env.XRPL_WSS || process.env.NETWORK || 'wss://xrplcluster.com';
const HOT_WALLET_SEED = process.env.HOT_WALLET_SEED || process.env.HOT_SEED || ''; // secp seed for rJz…
const xrpl = {
  client: new XRPLClient(XRPL_WSS),
  wallet: HOT_WALLET_SEED ? XRPLWallet.fromSeed(HOT_WALLET_SEED) : null
};

// Bazaar feature/env
const BAZAAR_ENABLED = (process.env.BAZAAR_ENABLED || 'true').toLowerCase() !== 'false';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

await app.register(cors, {
  origin: (origin, cb) => { if (!origin) return cb(null, true); cb(null, ALLOW.includes(origin)); },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Accept','Origin','X-Wallet','Authorization','X-Idempotency-Key','X-Admin-Key'],
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
  const code = err.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
  req.log.error({ err }, 'request_error');
  reply.code(code).send({ error: 'internal_error' });
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const toInt  = (x, d=0) => { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : d; };
const nowSec = () => Math.floor(Date.now()/1000);
const asciiToHex = (s) => Buffer.from(String(s),'utf8').toString('hex').toUpperCase();

const NONCES = new Map();
const newNonce = () => crypto.randomBytes(32).toString('hex');
function storeNonce(address, nonce){ NONCES.set(address,{nonce,exp:Date.now()+5*60_000,used:false}); }
function takeNonce(address){ const r=NONCES.get(address); if(!r){return {err:'expired_nonce'}}; NONCES.delete(address); if(r.used||Date.now()>r.exp){return {err:'expired_nonce'}}; r.used=true; return {ok:true, nonce:r.nonce}; }

const isSecpPublicKeyHex   = (pk) => typeof pk==='string' && /^(02|03)[0-9A-Fa-f]{64}$/.test(pk);
const isEd25519PublicKeyHex= (pk) => typeof pk==='string' && /^ED[0-9A-Fa-f]{64}$/.test(pk);

const RATE = { windowMs: 10_000, maxPerWindow: 30 };
const bucket = new Map();
app.addHook('onRequest', async (req, reply) => {
  const url = req.raw.url || '';
  if (req.method === 'OPTIONS') return;
  if (url.startsWith('/session/start') || url.startsWith('/config') || url.startsWith('/healthz')) return;

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

// ---------- helpers ----------
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
  return { health:(base.health|0)+(L.health|0), energyCap:(base.energyCap|0)+(L.energyCap|0), regenPerMin:Number(base.regenPerMin||0)+Number(L.regenPerMin||0)*REGEN_STEP };
}
function toClient(row){
  const cur=row.ms_current || recomputeCurrent(row.ms_base,row.ms_level);
  return { ms:{ base:row.ms_base, level:row.ms_level, current:cur }, pct:{ hit:row.ms_hit|0, crit:row.ms_crit|0, dodge:row.ms_dodge|0 }, jetFuel:row.jet_fuel|0, energy:row.energy|0, energyCap:row.energy_cap|0, unlockedLevel:row.unlocked_level|0 };
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

function getEconScaleFrom(arg){ const n=Number(arg); return (Number.isFinite(n)&&n>=0) ? n : ECON_SCALE_ENV; }
function levelsFromRow(row){
  const lv=row?.ms_level||{};
  return { health:toInt(lv.health,0), energyCap:toInt(lv.energyCap,0), regenPerMin:toInt(lv.regenPerMin,0), hit:toInt(row?.ms_hit,0), crit:toInt(row?.ms_crit,10), dodge:toInt(row?.ms_dodge,0) };
}
function unitCost(level,s){ const raw=BASE_PER_LEVEL*(toInt(level,0)+1); return Math.max(1, Math.round(raw*s)); }
function calcCosts(levels,s){ return { health:unitCost(levels.health,s), energyCap:unitCost(levels.energyCap,s), regenPerMin:unitCost(levels.regenPerMin,s), hit:unitCost(levels.hit,s), crit:unitCost(levels.crit,s), dodge:unitCost(levels.dodge,s) }; }
function missionReward(l){ const level = Math.max(1, Number(l) || 1); const base = level<=5 ? [0,100,150,200,250,300][level] : Math.round(300*Math.pow(1.01, level-5)); const reward=Math.round(base*REWARD_SCALE); const cap=Math.max(1,Math.round(10000*REWARD_SCALE)); return Math.max(1,Math.min(cap,reward)); }

// XRPL helpers (Bazaar)
async function ensureXRPL() {
  if (!xrpl.wallet) throw new Error('hot_wallet_missing');
  if (!xrpl.client.isConnected()) await xrpl.client.connect();
}
async function createDirectedSellOffer({ nftoken_id, buyer, amountDrops }) {
  await ensureXRPL();
  const tx = {
    TransactionType: 'NFTokenCreateOffer',
    Account: xrpl.wallet.address,
    NFTokenID: nftoken_id,
    Amount: String(amountDrops ?? 0), // drops, "0" allowed
    Destination: buyer
  };
  const prepared = await xrpl.client.autofill(tx);
  const signed = xrpl.wallet.sign(prepared);
  const sub = await xrpl.client.submitAndWait(signed.tx_blob);
  const result = sub?.result;
  if (result?.engine_result !== 'tesSUCCESS') {
    const detail = result?.engine_result || 'unknown';
    throw new Error(`xrpl_offer_failed:${detail}`);
  }
  const nodes = result.meta?.AffectedNodes || [];
  for (const n of nodes) {
    const cn = n.CreatedNode;
    if (cn && cn.LedgerEntryType === 'NFTokenOffer') {
      return cn.LedgerIndex || cn.NewFields?.OfferID || cn.LedgerIndexHex || null;
    }
  }
  throw new Error('offer_id_parse_failed');
}

// ---------- initial Bazaar JSON load + automation ----------
if (BAZAAR_ENABLED) {
  try {
    const info = await loadBazaarFromFiles();
    app.log.info({ info }, '[Bazaar] JSON loaded');
  } catch (e) {
    app.log.error(e, '[Bazaar] Failed to load JSON');
  }
  // auto-reload when JSON files change
  startFileWatchers((msg)=>app.log.info(msg));

  // simple janitor: reclaim stale offers every 5 minutes (older than 15m)
  setInterval(() => {
    try {
      const n = reclaimExpiredOffers(15*60*1000);
      if (n>0) app.log.info(`[Bazaar] Reclaimed ${n} stale offers`);
    } catch {}
  }, 5*60*1000);
}

// ---------------- core endpoints (unchanged) ----------------
app.get('/config', async (_req, reply) => {
  reply.send({
    tokenMode: (process.env.TOKEN_MODE || 'mock').toLowerCase(),
    network: process.env.XRPL_WSS || process.env.NETWORK || 'wss://xrplcluster.com',
    currencyCode: (process.env.CURRENCY_CODE || process.env.CURRENCY || 'JETS'),
    currencyHex: process.env.CURRENCY_HEX || null,
    issuer: process.env.ISSUER_ADDRESS || process.env.ISSUER_ADDR || null
  });
});

app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) return reply.code(400).send({ error:'bad_address' });
  await ensureProfile(address);
  const nonce = newNonce(); storeNonce(address, nonce);
  reply.send({ nonce });
});

app.post('/session/verify', async (req, reply) => {
  const { address, signature, publicKey, payloadHex, scope='play,upgrade,claim,bazaar', ts, txProof } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) return reply.code(400).send({ error:'bad_address' });

  const taken = takeNonce(address); if (!taken.ok) return reply.code(400).send({ error:taken.err });
  const now = nowSec(); const tsNum = Number(ts || now);
  if (!Number.isFinite(tsNum) || Math.abs(now-tsNum)>300) return reply.code(400).send({ error:'expired_nonce' });

  if (txProof && txProof.tx_blob) {
    try {
      const tx = decode(txProof.tx_blob);
      if (tx.TransactionType !== 'AccountSet') return reply.code(400).send({ error:'bad_tx_type' });
      if (tx.Account !== address) return reply.code(401).send({ error:'unauthorized' });
      const pub = String(tx.SigningPubKey || '').toUpperCase();
      if (!(pub.startsWith('02') || pub.startsWith('03'))) return reply.code(400).send({ error:'bad_key_algo', detail:'secp_required' });
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

  if (!signature) return reply.code(400).send({ error:'bad_signature' });
  if (!publicKey) return reply.code(400).send({ error:'bad_key' });
  if (isEd25519PublicKeyHex(publicKey)) return reply.code(400).send({ error:'bad_key_algo', detail:'secp_required' });
  if (!isSecpPublicKeyHex(publicKey)) return reply.code(400).send({ error:'bad_key' });

  const expectedHex = payloadHex && payloadHex.length>=8 ? String(payloadHex).toUpperCase()
    : asciiToHex(`${taken.nonce}||${scope}||${tsNum}||${address}`);
  let okSig=false, derived='';
  try { okSig = keypairs.verify(expectedHex, String(signature).toUpperCase(), String(publicKey).toUpperCase())===true; derived = keypairs.deriveAddress(publicKey); } catch {}
  if (!okSig) return reply.code(401).send({ error:'bad_signature' });
  if (derived !== address) return reply.code(401).send({ error:'unauthorized' });

  reply.send({ ok:true, jwt: signJWT(address, scope) });
});

app.get('/profile', async (req, reply) => {
  await ensureProfile(req.wallet);
  const rowR = await regenEnergyIfDue(req.wallet);
  const row  = rowR || await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error:'not_found' });
  reply.send(toClient(row));
});

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
  const newCore={ health:levels.health, energyCap:levels.energyCap, regenPerMin:levels.regenPerMin };
  const ms_current=recomputeCurrent(row.ms_base, newCore);
  const { rows } = await pool.query(
`update player_profiles set jet_fuel=$2, ms_level=$3, ms_current=$4, ms_hit=$5, ms_crit=$6, ms_dodge=$7, updated_at=now()
 where wallet=$1 returning *`,
    [req.wallet, jf, JSON.stringify(newCore), JSON.stringify(ms_current), levels.hit, levels.crit, levels.dodge]
  );
  reply.send({ ok:true, applied, spent, profile: toClient(rows[0]), scale });
});

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

// ---------- claim (cooldown only after successful payout) ----------
app.post('/claim/start', async (req, reply) => {
  const jwtOk = requireJWT(req, reply); if (!jwtOk) return;

  const amt = toInt(req.body?.amount, 0);
  if (!Number.isFinite(amt) || amt <= 0) return reply.code(400).send({ error:'bad_amount' });

  const row = await getProfileRaw(req.wallet); if (!row) return reply.code(404).send({ error:'not_found' });

  const nowS = nowSec();
  const lastS = row.last_claim_at ? Math.floor(new Date(row.last_claim_at).getTime()/1000) : 0;
  const COOL = Number(process.env.CLAIM_COOLDOWN_SEC || 300);
  if (COOL>0 && (nowS-lastS)<COOL) return reply.code(429).send({ error:'cooldown' });

  // Atomic debit (no cooldown set yet)
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
    const sent = await claim.sendIssued({ to:req.wallet, amount: amt });

    await pool.query(`update player_profiles set last_claim_at = now(), updated_at = now() where wallet = $1`, [req.wallet]);
    await pool.query(`insert into claim_audit (wallet, amount, tx_hash) values ($1,$2,$3)`, [req.wallet, amt, sent?.txid||null]).catch(()=>{});

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

// ---------- Bazaar (JSON-backed) ----------
app.get('/bazaar/skus', async (req, reply) => {
  if (!BAZAAR_ENABLED) return reply.send({ skus: [] });
  try {
    const list = getLiveSkus();
    reply.send({ skus: list });
  } catch (e) {
    req.log.error(e, 'bazaar_skus_error');
    reply.send({ skus: [] });
  }
});

app.get('/bazaar/sku/:id', async (req, reply) => {
  if (!BAZAAR_ENABLED) return reply.code(404).send({ error:'not_found' });
  const s = getSku(req.params.id);
  if (!s || !s.active) return reply.code(404).send({ error:'not_found' });
  const live = getLiveSkus().find(x => x.sku === s.sku);
  reply.send({ sku: { ...s, available: live?.available ?? 0 } });
});

app.post('/bazaar/purchase', async (req, reply) => {
  if (!BAZAAR_ENABLED) return reply.code(404).send({ error:'not_found' });
  const jwtOk = requireJWT(req, reply); if (!jwtOk) return;

  try {
    const buyer = req.wallet;
    const { sku } = req.body || {};
    const s = getSku(sku);
    if (!s || !s.active) return reply.code(400).send({ error:'invalid_sku' });

    // 1) Reserve one inventory item (transitions to offered_to_wallet)
    const stock = reserveOneFromInventory(sku);
    if (!stock) return reply.code(409).send({ error:'sold_out' });

    // 2) Atomic JetFuel debit
    if ((s.priceJetFuel|0) > 0) {
      const debit = await pool.query(
        `update player_profiles
            set jet_fuel = jet_fuel - $2,
                updated_at = now()
          where wallet = $1
            and jet_fuel >= $2
        returning *`,
        [buyer, s.priceJetFuel|0]
      );
      if (debit.rows.length === 0) {
        // revert reservation on failure
        stock.status = 'minted_stock';
        return reply.code(402).send({ error:'insufficient_funds' });
      }
    }

    // 3) Directed SellOffer (player pays accept fee + tiny XRP price)
    const sellOfferId = await createDirectedSellOffer({
      nftoken_id: stock.nftoken_id,
      buyer,
      amountDrops: s.priceXrpDrops|0
    });

    // 4) Return details; client will AcceptOffer and optionally call /bazaar/settle
    const orderId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    reply.send({ ok:true, orderId, sellOfferId, nftokenId: stock.nftoken_id, inventoryId: stock.id });
  } catch (e) {
    const msg = String(e?.message || '');
    req.log.error({ err:e }, 'bazaar_purchase_error');
    if (msg.startsWith('xrpl_offer_failed')) return reply.code(500).send({ error:'xrpl_offer_failed', detail: msg.split(':')[1]||'unknown' });
    if (msg.includes('hot_wallet_missing')) return reply.code(500).send({ error:'server_hot_wallet_missing' });
    return reply.code(500).send({ error:'server_error' });
  }
});

app.post('/bazaar/settle', async (req, reply) => {
  if (!BAZAAR_ENABLED) return reply.code(404).send({ error:'not_found' });
  const jwtOk = requireJWT(req, reply); if (!jwtOk) return;

  const { offerId, inventoryId } = req.body || {};
  if (inventoryId != null) markSold(inventoryId);
  reply.send({ ok:true });
});

// --- Admin: hot-reload bazaar JSON (safe; requires ADMIN_KEY) ---
app.post('/admin/bazaar/reload', async (req, reply) => {
  const key = req.headers['x-admin-key'] || '';
  if (!ADMIN_KEY || key !== ADMIN_KEY) return reply.code(401).send({ error:'unauthorized' });
  try{
    const info = await loadBazaarFromFiles();
    reply.send({ ok:true, info });
  }catch(e){
    req.log.error(e, 'bazaar_reload_error');
    reply.code(500).send({ error:'reload_failed', detail:String(e.message||e) });
  }
});
app.get('/admin/bazaar/status', async (_req, reply) => {
  const info = getLoadedInfo();
  reply.send({ ok:true, info });
});

// --- Admin: append inventory (paste NFTokenIDs) ---
app.post('/admin/bazaar/inventory/append', async (req, reply) => {
  if (!BAZAAR_ENABLED) return reply.code(404).send({ error:'not_found' });
  const key = req.headers['x-admin-key'] || '';
  if (!ADMIN_KEY || key !== ADMIN_KEY) return reply.code(401).send({ error:'unauthorized' });

  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return reply.code(400).send({ error:'bad_request' });

  try{
    const res = await appendInventory(items); // items: [{ sku, nftoken_id, status? }]
    reply.send({ ok:true, ...res });
  }catch(e){
    reply.code(400).send({ error:'append_failed', detail:String(e.message||e) });
  }
});

// --- Admin: scan hot wallet & auto-ingest by SKU ---
app.post('/admin/bazaar/scan-hotwallet', async (req, reply) => {
  if (!BAZAAR_ENABLED) return reply.code(404).send({ error:'not_found' });
  const key = req.headers['x-admin-key'] || '';
  if (!ADMIN_KEY || key !== ADMIN_KEY) return reply.code(401).send({ error:'unauthorized' });

  const { sku, uriPrefix } = req.body || {};
  if (!sku) return reply.code(400).send({ error:'bad_request' });

  try{
    const owner = xrpl.wallet?.address;
    if (!owner) return reply.code(500).send({ error:'server_hot_wallet_missing' });

    const res = await scanHotWalletAndCollect({ xrplClient: xrpl.client, owner, sku, uriPrefix });
    reply.send({ ok:true, ...res });
  }catch(e){
    reply.code(400).send({ error:'scan_failed', detail:String(e.message||e) });
  }
});

// ---------------- /healthz ----------------
app.get('/healthz', async (_req, reply) => reply.send({ ok:true }));

// Startup
app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`XRPixel Jets API listening on :${PORT}`);
  if (xrpl.wallet) app.log.info(`[XRPL] Hot wallet: ${xrpl.wallet.address}`);
  else app.log.warn('[XRPL] HOT_WALLET_SEED missing — Bazaar offer creation will fail.');
});
