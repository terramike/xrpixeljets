// server/index.js — XRPixel Jets (2025-10-25s)
// Aligns env names to: ALLOW_ORIGIN, CORS_ORIGIN, XRPL_WSS, HOT_SEED, ISSUER_ADDR,
// CURRENCY_CODE/HEX, TOKEN_MODE, ECON_SCALE, BASE_PER_LEVEL, JWT_SECRET, DATABASE_URL,
// CLAIM_* (…_SEC, _MAX_PER_24H, _FALLBACK_TXJSON). Adds optional CLAIM_ALLOW_DEMO.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';
import jwt from 'jsonwebtoken';
import * as rippleKeypairs from 'ripple-keypairs';
import { randomBytes } from 'crypto';
import * as claim from './claimJetFuel.js';

const { Pool } = pkg;

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 10000);

// Allowlist: prefer CORS_ORIGIN, fall back to ALLOW_ORIGIN (single origin)
const ORIGIN_RAW = (process.env.CORS_ORIGIN || process.env.ALLOW_ORIGIN || 'https://mykeygo.io,https://www.mykeygo.io,http://localhost:8000');
const CORS_LIST = ORIGIN_RAW.split(',').map(s => s.trim()).filter(Boolean);

const DATABASE_URL = process.env.DATABASE_URL;
const ECON_SCALE = Number(process.env.ECON_SCALE || '0.10');
const BASE_PER_LEVEL = Number(process.env.BASE_PER_LEVEL || '300');

const MAX24 = Number(process.env.CLAIM_MAX_PER_24H || '1000');
const COOLDOWN_SEC =
  process.env.CLAIM_COOLDOWN_SEC
    ? Number(process.env.CLAIM_COOLDOWN_SEC)
    : Number(process.env.CLAIM_COOLDOWN_HOURS || 0) * 3600;

const JWT_SECRET = (process.env.JWT_SECRET || 'change-me');

// Optional: demo-mode if your hot wallet isn’t funded yet (keeps UX flowing)
const CLAIM_ALLOW_DEMO = String(process.env.CLAIM_ALLOW_DEMO || '').trim() === '1';

// ---------- DB ----------
if (!DATABASE_URL) console.error('DATABASE_URL not set');
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : (process.env.DB_SSL === '1' ? { rejectUnauthorized: false } : undefined),
}) : null;

const app = Fastify({ logger: true });

// ---------- CORS ----------
await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (CORS_LIST.length === 0) return cb(null, true);
    if (CORS_LIST.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked'), false);
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Wallet','X-Admin-Key','X-Requested-With'],
  credentials: false,
  maxAge: 86400
});

// ---------- Helpers ----------
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n|0));
const nowUTC = () => new Date();
const priceAt = (n, scale) => Math.max(1, Math.round(BASE_PER_LEVEL * (n + 1) * scale));

// Nonce store for login
const nonces = new Map(); // nonce -> { address, scope, ts, exp, used }

// Derived/current mothership stats
function recomputeCurrent(base, level) {
  const b = base || { health:20, energyCap:100, regenPerMin:1 };
  const lv = level || { health:0, energyCap:0, regenPerMin:0 };
  return {
    health: (b.health|0) + (lv.health|0),
    energyCap: (b.energyCap|0) + (lv.energyCap|0),
    regenPerMin: (b.regenPerMin|0) + (lv.regenPerMin|0),
  };
}
function toClient(row) {
  const ms_base = row.ms_base || { health:20, energyCap:100, regenPerMin:1 };
  const ms_level = row.ms_level || { health:0, energyCap:0, regenPerMin:0 };
  const ms_current = row.ms_current || recomputeCurrent(ms_base, ms_level);
  return {
    ms: { base: ms_base, level: ms_level, current: ms_current },
    pct: {
      hit: Number(row.ms_hit ?? 0),
      crit: Number(row.ms_crit ?? 10),
      dodge: Number(row.ms_dodge ?? 0),
    },
    jetFuel: Number(row.jet_fuel ?? 0),
    energy: Number(row.energy ?? 0),
    energyCap: Number(row.energy_cap ?? ms_current.energyCap ?? 100),
    unlockedLevel: Number(row.unlocked_level ?? 1),
  };
}

async function ensureProfile(wallet) {
  if (!pool) return;
  await pool.query(
    `insert into player_profiles (wallet)
     values ($1) on conflict (wallet) do nothing`,
    [wallet]
  );
}
async function getProfileRaw(wallet){
  if (!pool) {
    // dev fallback if no DB is present
    return {
      wallet, jet_fuel: 0, energy: 100, energy_cap: 100,
      ms_base: { health:20, energyCap:100, regenPerMin:1 },
      ms_level: { health:0, energyCap:0, regenPerMin:0 },
      ms_current: { health:20, energyCap:100, regenPerMin:1 },
      ms_hit: 0, ms_crit: 10, ms_dodge: 0, unlocked_level: 1, updated_at: nowUTC()
    };
  }
  const { rows } = await pool.query(
    `select wallet, jet_fuel, energy, energy_cap,
            ms_base, ms_level, ms_current,
            coalesce(ms_hit,0)::int as ms_hit,
            coalesce(ms_crit,10)::int as ms_crit,
            coalesce(ms_dodge,0)::int as ms_dodge,
            coalesce(unlocked_level,1)::int as unlocked_level,
            last_claim_at, updated_at, created_at
       from player_profiles where wallet = $1`,
    [wallet]
  );
  return rows[0] || null;
}
async function applyRegen(wallet, row) {
  if (!pool) return row;
  try {
    const updated = row.updated_at ? new Date(row.updated_at) : null;
    if (!updated) return row;
    const ms_cur = row.ms_current || recomputeCurrent(row.ms_base, row.ms_level);
    const cap = Number(row.energy_cap ?? ms_cur.energyCap ?? 100);
    const rpm = Number(ms_cur.regenPerMin ?? 1);
    if (rpm <= 0) return row;

    const minutes = Math.floor((nowUTC() - updated) / 60000);
    if (minutes <= 0) return row;

    const gain = minutes * rpm;
    const nextEnergy = clamp((row.energy|0) + gain, 0, cap);

    if (nextEnergy !== (row.energy|0)) {
      const { rows: r2 } = await pool.query(
        `update player_profiles
            set energy=$2, updated_at=now()
          where wallet=$1
          returning *`,
        [wallet, nextEnergy]
      );
      return r2[0];
    }
  } catch (e) { app.log.warn({ err:e }, 'regen_nonfatal'); }
  return row;
}

// ---------- Global guard on X-Wallet (except auth & health) ----------
app.addHook('onRequest', async (req, reply) => {
  if (req.raw.url?.startsWith('/session/start')) return;
  if (req.raw.url?.startsWith('/session/verify')) return;
  if (req.raw.url?.startsWith('/healthz')) return;
  if (req.raw.url?.startsWith('/claim/health')) return;

  const w = req.headers['x-wallet'];
  if (!w || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(w)) {
    return reply.code(400).send({ error: 'missing_or_bad_X-Wallet' });
  }
  req.wallet = w;
});

// ---------- Auth (signed nonce → JWT) ----------
app.post('/session/start', async (req, reply) => {
  const address = (req.body?.address || '').trim();
  if (!address || !address.startsWith('r')) {
    return reply.code(400).send({ error: 'bad_address' });
  }
  await ensureProfile(address);

  const nonce = randomBytes(32).toString('hex');
  const scope = 'play,upgrade,claim';
  const ts = Math.floor(Date.now()/1000);
  const payload = `${nonce}||${scope}||${ts}||${address}`;
  nonces.set(nonce, { address, scope, ts, exp: ts + 5*60, used: false });
  return reply.send({ nonce, scope, ts, payload });
});

app.post('/session/verify', async (req, reply) => {
  const { address, signature, publicKey, payload } = req.body || {};
  if (!address || !signature || !payload) {
    return reply.code(400).send({ error: 'bad_signature' });
  }
  const [nonce, scope, tsStr, addr] = String(payload).split('||');
  if (!nonces.has(nonce)) return reply.code(400).send({ error: 'expired_nonce' });
  const rec = nonces.get(nonce);
  const now = Math.floor(Date.now()/1000);
  if (rec.used || rec.address !== addr || rec.address !== address || now > rec.exp) {
    nonces.delete(nonce);
    return reply.code(400).send({ error: 'expired_nonce' });
  }
  try {
    if (publicKey) {
      const ok = rippleKeypairs.verify(payload, signature, publicKey);
      if (!ok) return reply.code(401).send({ error: 'bad_signature' });
    }
  } catch {}
  rec.used = true; nonces.set(nonce, rec);
  const token = jwt.sign(
    { sub: address, scope: 'play,upgrade,claim' },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '45m' }
  );
  return reply.send({ ok: true, jwt: token });
});

// Require JWT only for /claim/start
app.addHook('preHandler', async (req, reply) => {
  if (req.routerPath !== '/claim/start') return;
  const hdr = req.headers['authorization'] || '';
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) return reply.code(401).send({ error: 'unauthorized' });
  try {
    const decoded = jwt.verify(m[1], JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.sub !== req.wallet) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    req.jwt = decoded;
  } catch {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

// ---------- Gameplay ----------
app.get('/profile', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });
  const p = await applyRegen(req.wallet, p0) || p0;
  return reply.send(toClient(p));
});

app.get('/ms/costs', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });

  const scale = Math.max(0.01, Number(req.query?.econScale || ECON_SCALE));
  const lv = p0.ms_level || { health:0, energyCap:0, regenPerMin:0 };
  const pct = {
    hit: Number(p0.ms_hit ?? 0),
    crit: Number(p0.ms_crit ?? 10),
    dodge: Number(p0.ms_dodge ?? 0),
  };
  const costs = {
    health:      priceAt(lv.health|0,      scale),
    energyCap:   priceAt(lv.energyCap|0,   scale),
    regenPerMin: priceAt(lv.regenPerMin|0, scale),
    hit:   priceAt(pct.hit|0,   scale),
    crit:  priceAt(pct.crit|0,  scale),
    dodge: priceAt(pct.dodge|0, scale),
  };
  return reply.send({ costs, levels: { ...lv, ...pct }, scale });
});

app.post('/ms/upgrade', async (req, reply) => {
  const body = req.body || {};
  const econScale = Math.max(0.01, Number(body.econScale || ECON_SCALE));
  const q = {
    health: clamp(Number(body.health||0), 0, 9999),
    energyCap: clamp(Number(body.energyCap||0), 0, 9999),
    regenPerMin: clamp(Number(body.regenPerMin||0), 0, 9999),
    hit: clamp(Number(body.hit||0), 0, 9999),
    crit: clamp(Number(body.crit||0), 0, 9999),
    dodge: clamp(Number(body.dodge||0), 0, 9999),
  };

  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });

  const lv0 = p0.ms_level || { health:0, energyCap:0, regenPerMin:0 };
  const pct0 = {
    hit: Number(p0.ms_hit ?? 0),
    crit: Number(p0.ms_crit ?? 10),
    dodge: Number(p0.ms_dodge ?? 0),
  };

  let spend = 0;
  const applied = { health:0, energyCap:0, regenPerMin:0, hit:0, crit:0, dodge:0 };
  const lv = { ...lv0 };
  let hit = pct0.hit, crit = pct0.crit, dodge = pct0.dodge;

  const spendOne = (getLevel, setLevel) => {
    const c = priceAt(getLevel(), econScale);
    if (spend + c > (p0.jet_fuel|0)) return false;
    spend += c; setLevel(); return true;
  };

  for (let i=0;i<q.health;i++)      if (spendOne(()=>lv.health,      ()=>{lv.health++; applied.health++;})) {}
  for (let i=0;i<q.energyCap;i++)   if (spendOne(()=>lv.energyCap,   ()=>{lv.energyCap++; applied.energyCap++;})) {}
  for (let i=0;i<q.regenPerMin;i++) if (spendOne(()=>lv.regenPerMin, ()=>{lv.regenPerMin++; applied.regenPerMin++;})) {}
  for (let i=0;i<q.hit;i++)         if (spendOne(()=>hit,            ()=>{hit++; applied.hit++;})) {}
  for (let i=0;i<q.crit;i++)        if (spendOne(()=>crit,           ()=>{crit++; applied.crit++;})) {}
  for (let i=0;i<q.dodge;i++)       if (spendOne(()=>dodge,          ()=>{dodge++; applied.dodge++;})) {}

  const ms_current = recomputeCurrent(p0.ms_base, lv);
  const cap = Number(p0.energy_cap ?? ms_current.energyCap ?? 100);
  const energyCapped = clamp((p0.energy|0), 0, cap);

  if (!pool) return reply.send({ ok:true, applied, spent: spend, profile: toClient({
    ...p0, jet_fuel: (p0.jet_fuel|0) - spend, ms_level: lv, ms_current, ms_hit: hit, ms_crit: crit, ms_dodge: dodge, energy: energyCapped
  }), scale: econScale });

  const { rows } = await pool.query(
    `update player_profiles
        set jet_fuel = jet_fuel - $2,
            ms_level = $3,
            ms_current = $4,
            ms_hit = $5,
            ms_crit = $6,
            ms_dodge = $7,
            energy = $8,
            updated_at = now()
      where wallet = $1
      returning *`,
    [req.wallet, spend, lv, ms_current, hit, crit, dodge, energyCapped]
  );
  return reply.send({ ok:true, applied, spent: spend, profile: toClient(rows[0]), scale: econScale });
});

// Authoritative energy: -10 at start, -1 per turn
app.post('/battle/start', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });

  const p = await applyRegen(req.wallet, p0) || p0;
  const ms_cur = p.ms_current || recomputeCurrent(p.ms_base, p.ms_level);
  const cap = Number(p.energy_cap ?? ms_cur.energyCap ?? 100);
  const next = clamp((p.energy|0) - 10, 0, cap);

  if (!pool) return reply.send({ ok:true, profile: toClient({ ...p, energy: next }) });

  const { rows } = await pool.query(
    `update player_profiles set energy=$2, updated_at=now() where wallet=$1 returning *`,
    [req.wallet, next]
  );
  return reply.send({ ok:true, profile: toClient(rows[0]) });
});

app.post('/battle/turn', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });

  const p = await applyRegen(req.wallet, p0) || p0;
  const ms_cur = p.ms_current || recomputeCurrent(p.ms_base, p.ms_level);
  const cap = Number(p.energy_cap ?? ms_cur.energyCap ?? 100);
  const next = clamp((p.energy|0) - 1, 0, cap);

  if (!pool) return reply.send({ ok:true, profile: toClient({ ...p, energy: next }) });

  const { rows } = await pool.query(
    `update player_profiles set energy=$2, updated_at=now() where wallet=$1 returning *`,
    [req.wallet, next]
  );
  return reply.send({ ok:true, profile: toClient(rows[0]) });
});

app.post('/battle/finish', async (req, reply) => {
  const body = req.body || {};
  const victory = !!body.victory;
  const wave = Math.max(1, Number(body.wave || 1));
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });

  const base = 10;
  const reward = victory ? Math.max(0, Math.round(base * wave * ECON_SCALE)) : 0;

  if (!pool) return reply.send({ ok:true, reward, profile: toClient({ ...p0, jet_fuel: (p0.jet_fuel|0) + reward }) });

  const { rows } = await pool.query(
    `update player_profiles
        set jet_fuel = jet_fuel + $2,
            updated_at = now()
      where wallet=$1
      returning *`,
    [req.wallet, reward]
  );
  return reply.send({ ok:true, reward, profile: toClient(rows[0]) });
});

// ---------- Claim ----------
app.post('/claim/start', async (req, reply) => {
  try {
    const wallet = (req.headers['x-wallet'] || '').trim();
    if (!wallet || !wallet.startsWith('r')) {
      return reply.code(400).send({ error: 'missing_or_bad_X-Wallet' });
    }
    const amount = parseInt(req.body?.amount, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      return reply.code(400).send({ error: 'bad_amount' });
    }
    await ensureProfile(wallet);

    // in-memory per-24h and cooldown (DB audit can be layered later)
    const key = `claim:${wallet}`;
    app.claimMem ||= new Map();
    const rec = app.claimMem.get(key) || { last: 0, sum: 0, window: Date.now() };
    const now = Date.now();
    if (now - rec.window > 24*3600_000) { rec.window = now; rec.sum = 0; }
    if (COOLDOWN_SEC > 0 && (now - rec.last) < COOLDOWN_SEC*1000) {
      return reply.code(429).send({ error: 'cooldown' });
    }
    if (rec.sum + amount > MAX24) {
      return reply.code(429).send({ error: 'limit_exceeded' });
    }

    let out;
    try {
      out = await claim.sendIssued({ to: wallet, amount });
    } catch (e) {
      const msg = String(e?.message || e);
      if (/hot_wallet_missing/i.test(msg)) {
        if (CLAIM_ALLOW_DEMO) {
          const demo = `demo-${Date.now()}`;
          rec.last = now; rec.sum += amount; app.claimMem.set(key, rec);
          app.log.warn({ wallet, amount, demo }, 'claim_demo_txid_returned_hot_wallet_missing');
          return reply.send({ ok:true, txid: demo, mode: 'demo' });
        }
        return reply.code(502).send({ error: 'hot_wallet_missing', message: 'Hot wallet account not found on selected XRPL network.' });
      }
      // XRPL engine codes, trustline, etc.
      return reply.code(502).send({ error: 'send_failed', message: msg });
    }

    rec.last = now; rec.sum += amount; app.claimMem.set(key, rec);
    return reply.send({ ok:true, ...(typeof out === 'string' ? { txid: out } : out) });
  } catch (e) {
    return reply.code(502).send({ error: 'send_failed', message: e?.message || String(e) });
  }
});

// Public health (no secrets)
app.get('/claim/health', async (_req, reply) => {
  const info = await claim.health();
  return reply.send(info);
});

app.get('/healthz', async () => ({ ok: true, ts: Date.now() }));

app.listen({ port: PORT, host: '0.0.0.0' }, (err, addr) => {
  if (err) { app.log.error(err); process.exit(1); }
  app.log.info(`Server listening at ${addr}`);
});
