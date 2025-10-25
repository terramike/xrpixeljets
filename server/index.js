// server/index.js — XRPixel Jets MKG (2025-10-25 secp-auth+jwt)
// Fastify API with CORS, simple rate limit, regen/profile, MS costs/upgrades,
// **secp256k1-only** session verification, and claim passthrough.

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

// ENV guardrails & pins (see project docs)
app.log.info({
  xrpl_wss: process.env.XRPL_WSS || process.env.NETWORK,
  token_mode: process.env.TOKEN_MODE || 'IOU',
  issuer: process.env.ISSUER_ADDR || process.env.ISSUER_ADDRESS,
  hot_wallet_pub: 'rJz7ooSyXQKEiS5dSucEyjxz5t6Ewded6n' // public only, do not store secrets
}, 'env_preview');

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
  ssl: { rejectUnauthorized: false },
});

function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

// ---------- Nonce store (single-use, 5 min) ----------
const NONCES = new Map(); // address -> { nonce, exp: ms, used: bool }
function newNonce() { return crypto.randomBytes(32).toString('hex'); }
function storeNonce(address, nonce) {
  NONCES.set(address, { nonce, exp: Date.now() + 5*60_000, used:false });
}
function takeNonce(address) {
  const rec = NONCES.get(address);
  if (!rec) return { err: 'expired_nonce' };
  NONCES.delete(address);
  if (rec.used) return { err: 'expired_nonce' };
  if (Date.now() > rec.exp) return { err: 'expired_nonce' };
  rec.used = true;
  return { ok: true, nonce: rec.nonce };
}
function asciiToHex(s){ return Buffer.from(String(s), 'utf8').toString('hex'); }
function isSecpPublicKeyHex(pk){
  // XRPL compressed secp256k1 public keys start with 0x02 or 0x03 and are 33 bytes (66 hex).
  return typeof pk === 'string' && /^(02|03)[0-9A-Fa-f]{64}$/.test(pk);
}
function isEd25519PublicKeyHex(pk){
  // XRPL Ed25519 public keys are 33 bytes beginning with 0xED (i.e., "ED" in hex).
  return typeof pk === 'string' && /^ED[0-9A-Fa-f]{64}$/.test(pk);
}

// ---------- Rate limiting (ip|wallet) ----------
const RATE = { windowMs: 10_000, maxPerWindow: 30 };
const bucket = new Map(); // key -> {count, ts}
app.addHook('onRequest', async (req, reply) => {
  // Keep /session/start open for first touch
  if (req.raw.url === '/session/start') return;

  const w = req.headers['x-wallet'];
  if (!w || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(w)) {
    return reply.code(400).send({ error: 'missing_or_bad_X-Wallet' });
  }
  req.wallet = w;

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
  await pool.query(
    `insert into player_profiles (wallet) values ($1) on conflict (wallet) do nothing`,
    [wallet]
  );
  return wallet;
}
async function getProfileRaw(wallet){
  const { rows } = await pool.query(
    `select wallet, jet_fuel, energy, energy_cap,
            ms_base, ms_level, ms_current,
            coalesce(ms_hit,0)::int as ms_hit,
            coalesce(ms_crit,10)::int as ms_crit,
            coalesce(ms_dodge,0)::int as ms_dodge,
            unlocked_level, last_claim_at, updated_at, created_at
       from player_profiles where wallet = $1`, [wallet]
  );
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
           returning *`,
          [wallet, next, JSON.stringify(ms)]
        );
        return rows[0];
      }
    }
  } catch (e) {
    app.log.warn({ err:e }, 'regen_nonfatal');
  }
  return row;
}

// ---------- JWT guard ----------
function signJWT(address, scope='play,upgrade,claim'){
  const now = Math.floor(Date.now()/1000);
  const exp = now + 60*60; // 60 min
  return jwt.sign({ sub: address, scope, iat: now, exp }, JWT_SECRET, { algorithm: 'HS256' });
}
function requireJWT(req, reply){
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { reply.code(401).send({ error: 'unauthorized' }); return null; }
  try { return jwt.verify(token, JWT_SECRET, { algorithms:['HS256'] }); }
  catch { reply.code(401).send({ error: 'unauthorized' }); return null; }
}

// ---------- Routes ----------

// Open: create profile and issue nonce
app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) {
    return reply.code(400).send({ error: 'bad_address' });
  }
  await ensureProfile(address);
  const nonce = newNonce();
  storeNonce(address, nonce);
  return reply.send({ nonce });
});

// Verify: **secp256k1 only** signed payload
app.post('/session/verify', async (req, reply) => {
  const { address, signature, publicKey, payload, payloadHex, scope='play,upgrade,claim', ts } = req.body || {};

  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address))
    return reply.code(400).send({ error: 'bad_address' });
  if (!signature || typeof signature !== 'string')
    return reply.code(400).send({ error: 'bad_signature' });

  if (!publicKey) return reply.code(400).send({ error: 'bad_key' });
  if (isEd25519PublicKeyHex(publicKey)) return reply.code(400).send({ error: 'bad_key_algo', detail:'secp_required' });
  if (!isSecpPublicKeyHex(publicKey)) return reply.code(400).send({ error: 'bad_key' });

  // Nonce (single-use, 5 min)
  const taken = takeNonce(address);
  if (!taken.ok) return reply.code(400).send({ error: taken.err });

  // Rebuild the expected payload from server-side nonce to avoid replay/mismatch
  const now = Math.floor(Date.now()/1000);
  const tsNum = Number(ts || now);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > 5*60) {
    return reply.code(400).send({ error: 'expired_nonce' });
  }
  const expected = `${taken.nonce}||${scope}||${tsNum}||${address}`;

  const msgHex = (payloadHex && typeof payloadHex === 'string' && payloadHex.length >= 8)
    ? payloadHex
    : asciiToHex(expected);

  // Verify signature & that the pubkey derives the provided classic address
  let okSig = false, derivedAddr = '';
  try {
    okSig = keypairs.verify(msgHex, signature, publicKey) === true;
    derivedAddr = keypairs.deriveAddress(publicKey);
  } catch (e) {
    app.log.warn({ err:e }, 'verify_exception');
  }
  if (!okSig) return reply.code(401).send({ error: 'bad_signature' });
  if (derivedAddr !== address) return reply.code(401).send({ error: 'unauthorized' });

  // All good — mint short-lived JWT
  const token = signJWT(address, scope);
  return reply.send({ ok: true, jwt: token });
});

app.get('/profile', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });
  const p = await applyRegen(req.wallet, p0) || p0;
  return reply.send(toClient(p));
});

app.get('/ms/costs', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });
  const msLevel = p0.ms_level || { health:0, energyCap:0, regenPerMin:0 };
  const base = { health: 50, energyCap: 60, regenPerMin: 80 };
  const step = { health: 25, energyCap: 30, regenPerMin: 45 };
  const nextCosts = {
    health: base.health + step.health * ((msLevel.health|0) + 1),
    energyCap: base.energyCap + step.energyCap * ((msLevel.energyCap|0) + 1),
    regenPerMin: Math.round(1.5 * (base.regenPerMin + step.regenPerMin * ((msLevel.regenPerMin|0) + 1))),
    // pct stat prices are aligned on server; include if you price them here too
    hit: 40 + 20 * ((p0.ms_hit|0) + 1),
    crit: 60 + 30 * ((p0.ms_crit|0) + 1),
    dodge: 45 + 25 * ((p0.ms_dodge|0) + 1),
  };
  return reply.send({ ok:true, levels: msLevel, costs: nextCosts });
});

app.post('/ms/upgrade', async (req, reply) => {
  const body = req.body || {};
  const deltas = {
    health: (body.health|0) || 0,
    energyCap: (body.energyCap|0) || 0,
    regenPerMin: (body.regenPerMin|0) || 0,
    hit: (body.hit|0) || 0,
    crit: (body.crit|0) || 0,
    dodge: (body.dodge|0) || 0,
  };

  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });

  // Pull current costs (server-authoritative) and spend jet_fuel iteratively
  const base = { health: 50, energyCap: 60, regenPerMin: 80 };
  const step = { health: 25, energyCap: 30, regenPerMin: 45 };
  const priceFor = (k, lvl) => {
    if (k === 'hit') return 40 + 20 * (lvl + 1);
    if (k === 'crit') return 60 + 30 * (lvl + 1);
    if (k === 'dodge') return 45 + 25 * (lvl + 1);
    if (k === 'health') return base.health + step.health * (lvl + 1);
    if (k === 'energyCap') return base.energyCap + step.energyCap * (lvl + 1);
    if (k === 'regenPerMin') return Math.round(1.5 * (base.regenPerMin + step.regenPerMin * (lvl + 1)));
    return 0;
  };

  let jf = p0.jet_fuel|0;
  const msL = { ...(p0.ms_level || {health:0,energyCap:0,regenPerMin:0}) };
  let hit = p0.ms_hit|0, crit = p0.ms_crit|0, dodge = p0.ms_dodge|0;

  const applied = {};
  for (const [k, cntRaw] of Object.entries(deltas)) {
    let cnt = Math.max(0, cntRaw|0);
    applied[k] = 0;
    while (cnt > 0) {
      const lvl = (k==='hit')?hit:(k==='crit')?crit:(k==='dodge')?dodge:msL[k]|0;
      const cost = priceFor(k, lvl);
      if (jf < cost) break;
      jf -= cost;
      if (k==='hit') hit++; else if (k==='crit') crit++; else if (k==='dodge') dodge++; else msL[k] = (msL[k]|0) + 1;
      applied[k]++; cnt--;
    }
  }

  const msC = recomputeCurrent(p0.ms_base, msL);
  const { rows } = await pool.query(
    `update player_profiles
       set jet_fuel=$2, ms_level=$3, ms_current=$4,
           ms_hit=$5, ms_crit=$6, ms_dodge=$7, updated_at=now()
     where wallet=$1
     returning *`,
    [req.wallet, jf, JSON.stringify(msL), JSON.stringify(msC), hit, crit, dodge]
  );
  const p = rows[0];
  return reply.send({ ok:true, applied, spent: (p0.jet_fuel|0) - jf, profile: toClient(p), scale: 1.0 });
});

// Minimal battle endpoints (unchanged shapes)
app.post('/battle/start', async (req, reply) => reply.send({ ok:true }));
app.post('/battle/turn', async (req, reply) => reply.send({ ok:true }));
app.post('/battle/finish', async (req, reply) => reply.send({ ok:true, reward: 10 }));

// ---------- Claim (JWT + X-Wallet required) ----------
app.post('/claim/start', async (req, reply) => {
  const tok = requireJWT(req, reply); if (!tok) return;
  const wallet = req.wallet;
  if (tok.sub !== wallet) return reply.code(401).send({ error: 'unauthorized' });

  const { amount } = req.body || {};
  const amt = Number(amount||0);
  if (!Number.isFinite(amt) || amt <= 0) return reply.code(400).send({ error: 'bad_amount' });

  // Cooldown / limits (best-effort)
  const coolSec = Number(process.env.CLAIM_COOLDOWN_SEC || 300);
  const max24h  = Number(process.env.CLAIM_MAX_PER_24H || 1000);

  const row = await getProfileRaw(wallet);
  if (!row) return reply.code(404).send({ error: 'not_found' });

  if (row.last_claim_at) {
    const since = (Date.now() - new Date(row.last_claim_at).getTime())/1000;
    if (since < coolSec) return reply.code(429).send({ error: 'cooldown' });
  }

  // Optional 24h cap — if you maintain a claim_audit table
  try {
    const { rows } = await pool.query(
      `select coalesce(sum(amount),0)::int as s
         from claim_audit
        where wallet=$1 and ts > now() - interval '24 hours'`, [wallet]);
    const day = rows[0]?.s|0;
    if (day + amt > max24h) return reply.code(429).send({ error: 'limit_exceeded' });
  } catch { /* ignore if table absent */ }

  // Send (server-send) or prepare txJSON (fallback)
  try {
    const res = await claim.sendIssued({ to: wallet, amount: amt });
    // Persist last_claim_at and audit row (best-effort)
    await pool.query(`update player_profiles set last_claim_at=now() where wallet=$1`, [wallet]);
    try {
      await pool.query(`insert into claim_audit (wallet, amount, txid, ts) values ($1,$2,$3,now())`,
        [wallet, amt, res?.txid || null]);
    } catch {}
    return reply.send({ ok:true, txid: res?.txid || null });
  } catch (e) {
    app.log.error({ err:e }, 'claim_failed');
    return reply.code(500).send({ error: 'server_error' });
  }
});

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`XRPixel Jets API listening on ${PORT}`);
});
