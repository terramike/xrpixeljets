// server/index.js — XRPixel Jets MKG (2025-10-25 secp-auth+jwt + ms/costs + ms/upgrade)
import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';
import jwt from 'jsonwebtoken';
import * as keypairs from 'ripple-keypairs';
import crypto from 'crypto';
import * as claim from './claimJetFuel.js';

const { Pool } = pkg;
const app = Fastify({ logger: true });

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';
const CORS_ALLOW = (process.env.CORS_ORIGIN || 'https://mykeygo.io,https://www.mykeygo.io,http://localhost:8000')
  .split(',').map(s => s.trim()).filter(Boolean);

// Economy env
const ECON_SCALE_ENV = Number(process.env.ECON_SCALE || 0.10);
const BASE_PER_LEVEL = Number(process.env.BASE_PER_LEVEL || 300);

await app.register(cors, {
  origin: CORS_ALLOW,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Accept','Origin','X-Wallet','Authorization'],
  credentials: false,
  maxAge: 86400,
  preflight: true,
  strictPreflight: false,
  hideOptionsRoute: false,
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------- Helpers ----------
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const toInt = (x, d=0) => { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : d; };
const nowSec = () => Math.floor(Date.now()/1000);

// Nonce (single-use, 5 min)
const NONCES = new Map(); // address -> { nonce, exp: ms, used: bool }
const newNonce = () => crypto.randomBytes(32).toString('hex');
function storeNonce(address, nonce) { NONCES.set(address, { nonce, exp: Date.now() + 5*60_000, used:false }); }
function takeNonce(address) {
  const rec = NONCES.get(address);
  if (!rec) return { err: 'expired_nonce' };
  NONCES.delete(address);
  if (rec.used) return { err: 'expired_nonce' };
  if (Date.now() > rec.exp) return { err: 'expired_nonce' };
  rec.used = true;
  return { ok: true, nonce: rec.nonce };
}
const asciiToHex = (s) => Buffer.from(String(s), 'utf8').toString('hex');
const isSecpPublicKeyHex = (pk) => typeof pk === 'string' && /^(02|03)[0-9A-Fa-f]{64}$/.test(pk);
const isEd25519PublicKeyHex = (pk) => typeof pk === 'string' && /^ED[0-9A-Fa-f]{64}$/.test(pk);

// Rate limit + X-Wallet guard
const RATE = { windowMs: 10_000, maxPerWindow: 30 };
const bucket = new Map();
app.addHook('onRequest', async (req, reply) => {
  // Allow /session/start without X-Wallet
  if (req.raw.url.startsWith('/session/start')) return;

  const w = req.headers['x-wallet'];
  if (!w || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(w)) {
    return reply.code(400).send({ error: 'missing_or_bad_X-Wallet' });
  }
  req.wallet = w;

  // Simple ip|wallet bucket
  const key = `${req.ip}|${w}`;
  const now = Date.now();
  const cur = bucket.get(key) || { count: 0, ts: now };
  const since = now - cur.ts;
  if (since > RATE.windowMs) { cur.count = 0; cur.ts = now; }
  cur.count += 1; bucket.set(key, cur);
  if (cur.count > RATE.maxPerWindow) return reply.code(429).send({ error: 'rate_limited' });
});

// ---------- Profile helpers ----------
async function ensureProfile(wallet){
  await pool.query(`insert into player_profiles (wallet) values ($1) on conflict (wallet) do nothing`, [wallet]);
  return wallet;
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
   from player_profiles where wallet = $1`, [wallet]);
  return rows[0] || null;
}
function recomputeCurrent(base, level) {
  const b = base || { health:20, energyCap:100, regenPerMin:1 };
  const lv = level || { health:0, energyCap:0, regenPerMin:0 };
  return {
    health: (b.health|0) + (lv.health|0),
    energyCap: (b.energyCap|0) + (lv.energyCap|0),
    regenPerMin: (b.regenPerMin|0) + (lv.regenPerMin|0),
  };
}
function toClient(row){
  const ms_current = row.ms_current || recomputeCurrent(row.ms_base, row.ms_level);
  return {
    ms: { base: row.ms_base, level: row.ms_level, current: ms_current },
    pct: { hit: row.ms_hit|0, crit: row.ms_crit|0, dodge: row.ms_dodge|0 },
    jetFuel: row.jet_fuel|0,
    energy: row.energy|0,
    energyCap: row.energy_cap|0,
    unlockedLevel: row.unlocked_level|0,
  };
}
async function applyRegen(wallet, row) {
  try {
    const now = new Date();
    const updated = new Date(row.updated_at);
    const minutes = Math.max(0, Math.floor((now - updated)/60000));
    const ms = recomputeCurrent(row.ms_base, row.ms_level);
    const regenPerMin = (ms.regenPerMin|0) || 1;
    if (minutes > 0 && regenPerMin > 0) {
      const cap = (row.energy_cap|0) || 100;
      const next = clamp((row.energy|0) + minutes * regenPerMin, 0, cap);
      if (next !== (row.energy|0)) {
        const { rows } = await pool.query(
`update player_profiles
   set energy = $2, ms_current = $3, updated_at = now()
 where wallet = $1
 returning *`, [wallet, next, JSON.stringify(ms)]);
        return rows[0];
      }
    }
  } catch (e) { app.log.warn({ err:e }, 'regen_nonfatal'); }
  return row;
}

// ---------- JWT ----------
function signJWT(address, scope='play,upgrade,claim'){
  const now = nowSec();
  const exp = now + 60*60;
  return jwt.sign({ sub: address, scope, iat: now, exp }, JWT_SECRET, { algorithm: 'HS256' });
}
function requireJWT(req, reply){
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { reply.code(401).send({ error: 'unauthorized' }); return null; }
  try { return jwt.verify(token, JWT_SECRET, { algorithms:['HS256'] }); }
  catch { reply.code(401).send({ error: 'unauthorized' }); return null; }
}

// ---------- Economy helpers (costs/upgrade) ----------
function getEconScaleFrom(arg) {
  const n = Number(arg);
  if (Number.isFinite(n) && n >= 0) return n;
  return ECON_SCALE_ENV;
}
function levelsFromRow(row) {
  const lvl = row?.ms_level || {};
  return {
    health: toInt(lvl.health, 0),
    energyCap: toInt(lvl.energyCap, 0),
    regenPerMin: toInt(lvl.regenPerMin, 0),
    hit: toInt(row?.ms_hit, 0),
    crit: toInt(row?.ms_crit, 10), // default 10 baseline crit%
    dodge: toInt(row?.ms_dodge, 0),
  };
}
function unitCost(level, econScale) {
  const raw = BASE_PER_LEVEL * (toInt(level,0) + 1);
  const scaled = Math.round(raw * econScale);
  return Math.max(1, scaled);
}
function calcCosts(levels, econScale) {
  return {
    health:     unitCost(levels.health,     econScale),
    energyCap:  unitCost(levels.energyCap,  econScale),
    regenPerMin:unitCost(levels.regenPerMin,econScale),
    hit:        unitCost(levels.hit,        econScale),
    crit:       unitCost(levels.crit,       econScale),
    dodge:      unitCost(levels.dodge,      econScale),
  };
}

// ---------- Routes ----------
// Auth
app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) return reply.code(400).send({ error: 'bad_address' });
  await ensureProfile(address);
  const nonce = newNonce(); storeNonce(address, nonce);
  return reply.send({ nonce });
});

app.post('/session/verify', async (req, reply) => {
  const { address, signature, publicKey, payload, payloadHex, scope='play,upgrade,claim', ts } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) return reply.code(400).send({ error: 'bad_address' });
  if (!signature || typeof signature !== 'string') return reply.code(400).send({ error: 'bad_signature' });
  if (!publicKey) return reply.code(400).send({ error: 'bad_key' });
  if (isEd25519PublicKeyHex(publicKey)) return reply.code(400).send({ error: 'bad_key_algo', detail:'secp_required' });
  if (!isSecpPublicKeyHex(publicKey)) return reply.code(400).send({ error: 'bad_key' });

  const taken = takeNonce(address);
  if (!taken.ok) return reply.code(400).send({ error: taken.err });

  const now = nowSec();
  const tsNum = Number(ts || now);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > 5*60) return reply.code(400).send({ error: 'expired_nonce' });

  const expected = `${taken.nonce}||${scope}||${tsNum}||${address}`;
  const msgHex = (payloadHex && typeof payloadHex === 'string' && payloadHex.length >= 8) ? payloadHex : asciiToHex(expected);

  let okSig = false, derivedAddr = '';
  try {
    okSig = keypairs.verify(msgHex, signature, publicKey) === true;
    derivedAddr = keypairs.deriveAddress(publicKey);
  } catch {}
  if (!okSig) return reply.code(401).send({ error: 'bad_signature' });
  if (derivedAddr !== address) return reply.code(401).send({ error: 'unauthorized' });

  const token = signJWT(address, scope);
  return reply.send({ ok: true, jwt: token });
});

// Profile (regen-on-read)
app.get('/profile', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });
  const p = await applyRegen(req.wallet, p0) || p0;
  return reply.send(toClient(p));
});

// ---------- Mothership Costs ----------
async function sendCosts(req, reply) {
  const p = await getProfileRaw(req.wallet);
  if (!p) return reply.code(404).send({ error: 'not_found' });

  const econScale = getEconScaleFrom(req.query?.econScale);
  const lv = levelsFromRow(p);
  const costs = calcCosts(lv, econScale);

  return reply.send({
    costs,
    levels: lv,
    scale: econScale
  });
}
app.get('/ms/costs', sendCosts);
// Legacy alias for older clients
app.get('/ms/cost', sendCosts);

// ---------- Upgrades ----------
app.post('/ms/upgrade', async (req, reply) => {
  const q = req.body || {};
  const econScale = getEconScaleFrom(q.econScale);

  const row = await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error: 'not_found' });

  let jf = toInt(row.jet_fuel, 0);

  // Current levels
  const core = { ...(row.ms_level || { health:0, energyCap:0, regenPerMin:0 }) };
  core.health     = toInt(core.health, 0);
  core.energyCap  = toInt(core.energyCap, 0);
  core.regenPerMin= toInt(core.regenPerMin, 0);

  let hit   = toInt(row.ms_hit, 0);
  let crit  = toInt(row.ms_crit, 10);
  let dodge = toInt(row.ms_dodge, 0);

  // Desired increments
  const want = {
    health:     Math.max(0, toInt(q.health, 0)),
    energyCap:  Math.max(0, toInt(q.energyCap, 0)),
    regenPerMin:Math.max(0, toInt(q.regenPerMin, 0)),
    hit:        Math.max(0, toInt(q.hit, 0)),
    crit:       Math.max(0, toInt(q.crit, 0)),
    dodge:      Math.max(0, toInt(q.dodge, 0)),
  };

  const applied = { health:0, energyCap:0, regenPerMin:0, hit:0, crit:0, dodge:0 };
  let spent = 0;

  function tryUpgrade(stat) {
    let level;
    switch (stat) {
      case 'health':      level = core.health; break;
      case 'energyCap':   level = core.energyCap; break;
      case 'regenPerMin': level = core.regenPerMin; break;
      case 'hit':         level = hit; break;
      case 'crit':        level = crit; break;
      case 'dodge':       level = dodge; break;
      default: return false;
    }
    const cost = unitCost(level, econScale);
    if (jf < cost) return false;
    jf -= cost; spent += cost; applied[stat] += 1;
    switch (stat) {
      case 'health':      core.health += 1; break;
      case 'energyCap':   core.energyCap += 1; break;
      case 'regenPerMin': core.regenPerMin += 1; break;
      case 'hit':         hit += 1; break;
      case 'crit':        crit += 1; break;
      case 'dodge':       dodge += 1; break;
    }
    return true;
  }

  // Iterate level-by-level per stat, preserving per-level pricing
  const order = ['health','energyCap','regenPerMin','hit','crit','dodge'];
  let something = true;
  while (something) {
    something = false;
    for (const stat of order) {
      if (want[stat] > applied[stat]) {
        if (tryUpgrade(stat)) { something = true; }
      }
    }
  }

  // Persist if anything changed
  let updated = row;
  if (spent > 0) {
    const ms_current = recomputeCurrent(row.ms_base, core);
    const { rows } = await pool.query(
`update player_profiles
    set ms_level   = $2::jsonb,
        ms_hit     = $3::int,
        ms_crit    = $4::int,
        ms_dodge   = $5::int,
        jet_fuel   = $6::int,
        ms_current = $7::jsonb,
        updated_at = now()
  where wallet = $1
returning *`,
      [req.wallet, JSON.stringify(core), hit, crit, dodge, jf, JSON.stringify(ms_current)]
    );
    updated = rows[0];
  }

  const profile = toClient(updated);
  return reply.send({ ok:true, applied, spent, profile, scale: econScale });
});

// ---------- Battle (keep your existing implementations if any) ----------
// (No changes here; assuming /battle/start|turn|finish already exist in your codebase.)

// ---------- Claim ----------
app.post('/claim/start', async (req, reply) => {
  const jwtClaims = requireJWT(req, reply); if (!jwtClaims) return;
  const { amount } = req.body || {};
  const amt = Number(amount||0); if (!Number.isFinite(amt) || amt <= 0) return reply.code(400).send({ error:'bad_amount' });

  // Limits / Cooldown
  const MAX24 = Number(process.env.CLAIM_MAX_PER_24H || 1000);
  const COOLD = Number(process.env.CLAIM_COOLDOWN_SEC || 300);

  const row = await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error: 'not_found' });

  const lastTs = row.last_claim_at ? Math.floor(new Date(row.last_claim_at).getTime()/1000) : 0;
  const now = nowSec();
  if (COOLD > 0 && (now - lastTs) < COOLD) return reply.code(429).send({ error:'cooldown' });

  try {
    const mode = (process.env.CLAIM_MODE || 'server-send').toLowerCase();
    const dest = req.wallet;
    if (mode === 'user-sign') {
      const prep = await claim.prepareIssued({ to: dest, amount: amt });
      await pool.query(`insert into claim_audit (wallet, amount, tx_hash) values ($1,$2,$3)`, [dest, amt, null]).catch(()=>{});
      return reply.send({ ok:true, txJSON: prep.txJSON || null });
    } else {
      const sent = await claim.sendIssued({ to: dest, amount: amt });
      await pool.query(`update player_profiles set last_claim_at = now() where wallet=$1`, [dest]).catch(()=>{});
      await pool.query(`insert into claim_audit (wallet, amount, tx_hash) values ($1,$2,$3)`, [dest, amt, sent?.txid||null]).catch(()=>{});
      return reply.send({ ok:true, txid: sent?.txid || null });
    }
  } catch (e) {
    return reply.code(500).send({ error: String(e?.message || e) });
  }
});

// ---------- Listen ----------
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
  app.log.info(`XRPixel Jets API listening on ${PORT}`);
});
