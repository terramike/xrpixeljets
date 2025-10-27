// index.js — XRPixel Jets API (2025-10-26-claims5 + fractional ENERGY REGEN)
// - Regen upgrades: +0.1 per level (REGEN_STEP, env-overridable)
// - recomputeCurrent(): regenPerMin = base + level*REGEN_STEP
// - regenEnergyIfDue(): respects fractional rpm (adds whole energy over elapsed time)
// - Hooks for regen remain on /profile, /battle/start, /battle/turn
// - Rewards scale defaults to ECON_SCALE (override via REWARD_SCALE if set)

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
// ⬇️ REWARD_SCALE defaults to ECON_SCALE unless explicitly set
const REWARD_SCALE    = Number.isFinite(Number(process.env.REWARD_SCALE))
  ? Number(process.env.REWARD_SCALE)
  : ECON_SCALE_ENV;

// ---- CORS plugin ----
await app.register(cors, {
  origin: (origin, cb) => { if (!origin) return cb(null, true); cb(null, ALLOW.includes(origin)); },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Accept','Origin','X-Wallet','Authorization','X-Idempotency-Key'],
  credentials: false
});

// ---- error handler ----
app.setErrorHandler((err, req, reply) => {
  const code = Number(err.statusCode || err.code || 500);
  req.log.error({ err }, 'request_error');
  reply.code(code).send({ error: 'internal_error' });
});

// ---------- DB ----------
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ---------- (optional) shop tables ----------
async function ensureShopTables(){
  await pool.query(`
    create table if not exists shop_orders(
      id bigserial primary key,
      wallet text not null,
      item_id text not null,
      cost int not null,
      tx_hash text,
      redeem_code text,
      created_at timestamp with time zone default now()
    );
  `);
}
await ensureShopTables().catch(err => app.log.error({err}, 'ensure_shop_tables_failed'));

// ---------- utils ----------
const toInt  = (x, d=0) => { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : d; };
const nowSec = () => Math.floor(Date.now()/1000);
const asciiToHex = (s) => Buffer.from(String(s),'utf8').toString('hex');

const NONCES = new Map();
const newNonce = () => crypto.randomBytes(32).toString('hex');
function storeNonce(address, nonce){ NONCES.set(address,{nonce,exp:Date.now()+5*60*1000}); }
function takeNonce(address, nonce){
  const rec = NONCES.get(address);
  NONCES.delete(address);
  if (!rec) return false;
  if (rec.exp < Date.now()) return false;
  return rec.nonce === nonce;
}

function recomputeCurrent(row){
  const base = row.ms_base || { health:20, energyCap:100, regenPerMin:1.0, hit:0, crit:10, dodge:0 };
  const lv   = row.ms_level || { health:0, energyCap:0, regenPerMin:0 };
  const pct  = { hit: toInt(row.ms_hit,0), crit: toInt(row.ms_crit,10), dodge: toInt(row.ms_dodge,0) };
  const cur = {
    health: toInt(base.health,20) + toInt(lv.health,0),
    energyCap: toInt(base.energyCap,100) + toInt(lv.energyCap,0),
    regenPerMin: Number(base.regenPerMin||1.0) + toInt(lv.regenPerMin,0)*Number(REGEN_STEP||0.1),
    hit: pct.hit,
    crit: pct.crit,
    dodge: pct.dodge
  };
  return cur;
}

async function regenEnergyIfDue(wallet){
  // Track last regen timestamp + fractional accumulation per user
  await pool.query(`
    create table if not exists energy_clock(
      wallet text primary key,
      last_at timestamptz default now(),
      acc float8 default 0
    );
  `);
  const p = await pool.query(`select jet_fuel, energy, ms_base, ms_level, ms_hit, ms_crit, ms_dodge from player_profiles where wallet=$1`, [wallet]);
  if (!p.rows.length) return null;
  const row = p.rows[0];
  const ms = recomputeCurrent(row);

  const clk = await pool.query(`insert into energy_clock(wallet) values ($1)
    on conflict(wallet) do update set wallet=excluded.wallet returning *`, [wallet]);
  const lastAt = new Date(clk.rows[0].last_at || new Date());
  const acc0   = Number(clk.rows[0].acc || 0);

  const now = new Date();
  const ds = Math.max(0, Math.floor((now - lastAt)/1000)); // seconds
  if (ds <= 0) return { energy: toInt(row.energy,0), ms };

  const perSec = Number(ms.regenPerMin || 0) / 60;
  let acc = acc0 + perSec * ds;
  let gain = 0;
  while (acc >= 1) { gain += 1; acc -= 1; }
  let newEnergy = Math.min(Number(ms.energyCap||100), toInt(row.energy,0) + gain);

  await pool.query(`update energy_clock set last_at=now(), acc=$2 where wallet=$1`, [wallet, acc]);
  if (newEnergy !== toInt(row.energy,0)) {
    await pool.query(`update player_profiles set energy=$2, updated_at=now() where wallet=$1`, [wallet, newEnergy]);
  }
  return { energy: newEnergy, ms };
}

function toClient(row){
  const ms = { base: row.ms_base || { health:20, energyCap:100, regenPerMin:1.0, hit:0, crit:10, dodge:0 } };
  ms.level = row.ms_level || { health:0, energyCap:0, regenPerMin:0 };
  ms.current = recomputeCurrent(row);
  const pct = { hit: toInt(row.ms_hit,0), crit: toInt(row.ms_crit,10), dodge: toInt(row.ms_dodge,0) };
  return {
    wallet: row.wallet,
    jetFuel: toInt(row.jet_fuel,0),
    energy: toInt(row.energy,0),
    energyCap: ms.current.energyCap,
    ms,
    pct,
    unlockedLevel: toInt(row.unlocked_level, 5)
  };
}

// ---------- public config ----------
app.get('/config', async (_req, reply) => {
  reply.send({
    tokenMode: (process.env.TOKEN_MODE || 'mock'),
    network:   (process.env.XRPL_WSS || 'wss://xrplcluster.com'),
    currencyCode: (process.env.CURRENCY_CODE || 'JFUEL'),
    currencyHex:  (process.env.CURRENCY_HEX  || null),
    issuer:       (process.env.ISSUER_ADDR   || null)
  });
});

// ---------- rate limit + X-Wallet & auth helpers ----------
function verifySecpPub(pub){ return /^(02|03)[0-9A-Fa-f]{64}$/.test(String(pub||'')); }
function verifyClassic(addr){ return /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(String(addr||'')); }

app.addHook('onRequest', async (req, reply) => {
  const url = req.raw.url || '';
  if (req.method === 'OPTIONS') return;

  // Allow auth bootstrap and public config/health without X-Wallet
  if (
    url.startsWith('/session/start') ||
    url.startsWith('/session/verify') ||   // ← add this exemption
    url.startsWith('/config') ||
    url.startsWith('/healthz')
  ) return;

  const w = req.headers['x-wallet'];
  if (!w || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(w)) {
    return reply.code(400).send({ error:'missing_or_bad_X-Wallet' });
  }
  req.wallet = w;

  // (rate limit logic unchanged)
  const key = `${req.ip}|${w}`;
  const RATE = { windowMs: 10_000, maxPerWindow: 30 };
  const bucket = app._ratebucket || (app._ratebucket = new Map());
  const now = Date.now();
  const cur = bucket.get(key) || { count: 0, ts: now };
  if (now - cur.ts > RATE.windowMs) { cur.count = 0; cur.ts = now; }
  cur.count += 1; bucket.set(key, cur);
  if (cur.count > RATE.maxPerWindow) return reply.code(429).send({ error:'rate_limited' });
});

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
  const l = Math.max(1, Number(level) || 1);
  const base   = Number(process.env.REWARD_BASE   || 100);
  const growth = Number(process.env.REWARD_GROWTH || 1.03); // 3% per wave
  const val = base * Math.pow(growth, l - 1) * REWARD_SCALE;
  return Math.max(1, Math.min(10000, Math.ceil(val))); // ceil to avoid stagnation
}

// ---------- profiles ----------
app.post('/session/start', async (req, reply) => {
  const address = String(req.body?.address || '');
  if (!verifyClassic(address)) return reply.code(400).send({ error:'bad_address' });
  await pool.query(`insert into player_profiles (wallet) values ($1) on conflict (wallet) do nothing`, [address]);
  const nonce = newNonce(); storeNonce(address, nonce);
  reply.send({ nonce });
});

app.post('/session/verify', async (req, reply) => {
  const { address, signature, publicKey, ts, scope, payload, payloadHex } = req.body || {};
  const asciiToHex = (s) => Buffer.from(String(s),'utf8').toString('hex');
  const normHex = (s) => String(s||'').replace(/^0x/i,'').toLowerCase();
  const okClassic = /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(String(address||''));
  const okSecp = /^(02|03)[0-9A-Fa-f]{64}$/.test(String(publicKey||''));

  if (!okClassic) return reply.code(400).send({ error:'bad_address' });
  if (!okSecp)    return reply.code(400).send({ error:'bad_key_algo' });
  if (!signature) return reply.code(400).send({ error:'bad_signature' });

  const msgHex = normHex(payloadHex || asciiToHex(String(payload||'')));
  const sigHex = normHex(signature);

  // Nonce check must match the ASCII payload we asked the wallet to sign
  const nonceAscii = (String(payload||'').split('||')[0] || '').trim();
  if (!takeNonce(address, nonceAscii)) return reply.code(400).send({ error:'bad_nonce' });

  let ok = false;
  try { ok = keypairs.verifyMessage(msgHex, sigHex, publicKey); }
  catch(e){ req.log.warn({ e:String(e), msgLen:msgHex.length, sigLen:sigHex.length }, 'verify_throw'); return reply.code(400).send({ error:'bad_signature' }); }
  if (!ok) return reply.code(400).send({ error:'bad_signature' });

  const token = jwt.sign({ sub:address, scope:String(scope||'play,upgrade,claim') }, JWT_SECRET, { algorithm:'HS256', expiresIn:'60m' });
  reply.send({ ok:true, jwt: token });
});

async function ensureProfile(wallet){
  await pool.query(
    `insert into player_profiles (wallet) values ($1) on conflict (wallet) do nothing`,
    [wallet]
  );
}
async function getProfileRaw(wallet){
  const { rows } = await pool.query(
`select wallet, coalesce(jet_fuel,0) as jet_fuel, coalesce(energy,0) as energy,
        coalesce(ms_base,'{"health":20,"energyCap":100,"regenPerMin":1.0,"hit":0,"crit":10,"dodge":0}') as ms_base,
        coalesce(ms_level,'{"health":0,"energyCap":0,"regenPerMin":0}') as ms_level,
        coalesce(ms_hit,0)   as ms_hit,
        coalesce(ms_crit,10) as ms_crit,
        coalesce(ms_dodge,0) as ms_dodge,
        coalesce(unlocked_level,5) as unlocked_level,
        last_claim_at, updated_at
   from player_profiles where wallet=$1`,
    [wallet]
  );
  return rows[0] || null;
}

app.get('/profile', async (req, reply) => {
  await ensureProfile(req.wallet);
  const res = await regenEnergyIfDue(req.wallet);
  const row = await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error:'not_found' });
  const cur = res?.ms ? res : { energy: toInt(row.energy,0), ms: recomputeCurrent(row) };
  const payload = toClient({ ...row, ...{ energy: cur.energy } });
  payload.ms.current = cur.ms;
  reply.send(payload);
});

// ---------- battle ----------
app.post('/battle/start', async (req, reply) => {
  const row = await getProfileRaw(req.wallet); if (!row) return reply.code(404).send({ error:'not_found' });
  const cur = recomputeCurrent(row);
  const energy = toInt(row.energy,0);
  const cost = 10;
  if (energy < cost) return reply.code(400).send({ error:'insufficient_energy' });
  await pool.query(`update player_profiles set energy = $2, updated_at=now() where wallet=$1`, [req.wallet, energy - cost]);
  reply.send({ ok:true, energy: energy - cost, profile: toClient({ ...row, energy: energy - cost }) });
});

app.post('/battle/turn', async (req, reply) => {
  const row = await getProfileRaw(req.wallet); if (!row) return reply.code(404).send({ error:'not_found' });
  const cur = recomputeCurrent(row);
  const energy = toInt(row.energy,0);
  const cost = 1;
  if (energy < cost) return reply.code(400).send({ error:'insufficient_energy' });
  await pool.query(`update player_profiles set energy = $2, updated_at=now() where wallet=$1`, [req.wallet, energy - cost]);
  reply.send({ ok:true, energy: energy - cost, profile: toClient({ ...row, energy: energy - cost }) });
});

app.post('/battle/finish', async (req, reply) => {
  const lvl = toInt(req.body?.level, 1);
  const row = await getProfileRaw(req.wallet); if (!row) return reply.code(404).send({ error:'not_found' });

  const reward = missionReward(lvl);
  const unlocked = Math.max(toInt(row.unlocked_level,5), lvl+1);
  const upd = await pool.query(
    `update player_profiles
        set jet_fuel = coalesce(jet_fuel,0) + $2,
            unlocked_level = $3,
            updated_at = now()
      where wallet = $1
   returning *`,
    [req.wallet, reward, unlocked]
  );
  const r1 = upd.rows[0];
  reply.send({ ok:true, reward, unlockedLevel: unlocked, profile: toClient(r1) });
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
  // write back levels + debit
  await pool.query(
`update player_profiles
    set jet_fuel = $2,
        ms_level = jsonb_build_object(
          'health',$3,'energyCap',$4,'regenPerMin',$5
        ),
        ms_hit   = $6,
        ms_crit  = $7,
        ms_dodge = $8,
        updated_at = now()
  where wallet = $1`,
    [req.wallet, jf, levels.health|0, levels.energyCap|0, levels.regenPerMin|0, levels.hit|0, levels.crit|0, levels.dodge|0]
  );
  row = await getProfileRaw(req.wallet);
  reply.send({ ok:true, applied, spent, profile: toClient(row), scale: getEconScaleFrom(scale) });
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

  // 2) Attempt XRPL payout (TOKEN_MODE=hot) via claim module
  try {
    const dest = req.wallet;
    const res = await claim.payout({
      amount: amt,
      destination: dest,
      currencyHex: process.env.CURRENCY_HEX,
      issuer: process.env.ISSUER_ADDR,
      xrplWss: process.env.XRPL_WSS || 'wss://xrplcluster.com',
      mode: String(process.env.TOKEN_MODE||'mock').toLowerCase()
    });

    // 3) If failed, refund debit
    if (!res?.ok) {
      await pool.query(
        `update player_profiles set jet_fuel = jet_fuel + $2, updated_at = now() where wallet=$1`,
        [req.wallet, amt]
      );
      return reply.code(500).send({ error:'claim_failed' });
    }

    // 4) Return txid/txJSON + profile
    const profile = toClient((await getProfileRaw(req.wallet)));
    reply.send({ ok:true, txid: res.txid||null, txJSON: res.txJSON||null, profile });
  } catch (e) {
    // Refund on any throw
    await pool.query(
      `update player_profiles set jet_fuel = jet_fuel + $2, updated_at = now() where wallet=$1`,
      [req.wallet, amt]
    );
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

// ---------- shop catalog ----------
const SHOP_ITEMS = [
  {
    id: 'skin_neon_blue',
    name: 'Neon Blue Jet Skin (NFT)',
    desc: 'Cosmetic livery for your XRPixel Jet. Limited.',
    cost: 500,
    type: 'nft',
    image: 'https://mykeygo.io/jets/assets/shop/skin_neon_blue.png'
  },
  {
    id: 'badge_ace',
    name: 'ACE Pilot Badge (Code)',
    desc: 'Profile badge + Discord flair (redeem code).',
    cost: 150,
    type: 'code',
    image: 'https://mykeygo.io/jets/assets/shop/badge_ace.png'
  },
  {
    id: 'theme_chiptune_1',
    name: 'Chiptune Theme Pack',
    desc: 'OST pack unlock (account-bound).',
    cost: 200,
    type: 'upgrade',
    image: 'https://mykeygo.io/jets/assets/shop/theme_chiptune_1.png'
  }
];
function getItemById(id){ return SHOP_ITEMS.find(x => x.id === String(id)); }

// ---------- shop endpoints ----------
app.get('/shop/items', async (req, reply) => {
  reply.send({ items: SHOP_ITEMS });
});

app.post('/shop/redeem', async (req, reply) => {
  const jwtPayload = requireJWT(req, reply); if (!jwtPayload) return;
  const wallet = req.wallet;
  if (!wallet || jwtPayload.sub !== wallet) return reply.code(401).send({ error:'unauthorized' });

  const itemId = String(req.body?.itemId || '');
  const item = getItemById(itemId);
  if (!item) return reply.code(400).send({ error:'bad_item' });

  const cost = Number(item.cost || 0);
  if (!Number.isFinite(cost) || cost <= 0) return reply.code(400).send({ error:'bad_cost' });

  // Atomic debit
  const debit = await pool.query(
    `update player_profiles
       set jet_fuel = jet_fuel - $2,
           updated_at = now()
     where wallet = $1
       and coalesce(jet_fuel,0) >= $2
     returning coalesce(jet_fuel,0)::int as jet_fuel`,
    [wallet, cost]
  );
  if (!debit.rows.length) return reply.code(400).send({ error:'insufficient_funds' });
  const newBalance = debit.rows[0].jet_fuel|0;

  let txid = null, redeemCode = null, message = 'purchase_ok';

  if (item.type === 'nft') {
    message = 'NFT queued for mint.';
  } else if (item.type === 'code') {
    redeemCode = crypto.randomBytes(6).toString('hex').toUpperCase();
    message = 'Redeem code issued.';
  } else if (item.type === 'upgrade') {
    message = 'Theme pack unlocked.';
  }

  await pool.query(
    `insert into shop_orders(wallet,item_id,cost,tx_hash,redeem_code)
      values ($1,$2,$3,$4,$5)`,
    [wallet, item.id, cost, txid, redeemCode]
  );

  reply.send({ ok:true, item: { id:item.id, name:item.name, type:item.type, cost:item.cost }, newBalance, message, txid, redeemCode });
});

// ---------- health ----------
app.get('/healthz', async (_req, reply) => reply.send({ ok:true }));

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`XRPixel Jets API listening on :${PORT}`);
});


