// server/index.js — XRPixel Jets (2025-10-25g)
// ESM imports for JWT + ripple-keypairs; nonce via crypto.randomBytes

import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';
import jwt from 'jsonwebtoken';
import * as rippleKeypairs from 'ripple-keypairs';
import { randomBytes } from 'crypto';
import * as claim from './claimJetFuel.js';

const { Pool } = pkg;

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 8080);
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const DATABASE_URL = process.env.DATABASE_URL;
const ECON_SCALE = Number(process.env.ECON_SCALE || '0.10');
const BASE_PER_LEVEL = Number(process.env.BASE_PER_LEVEL || '300');
const CLAIM_MAX_PER_24H = Number(process.env.CLAIM_MAX_PER_24H || '500');
const CLAIM_COOLDOWN_SEC =
  process.env.CLAIM_COOLDOWN_SEC
    ? Number(process.env.CLAIM_COOLDOWN_SEC)
    : Number(process.env.CLAIM_COOLDOWN_HOURS || 0) * 3600;
const ADMIN_KEY = (process.env.ADMIN_KEY || '');
const JWT_SECRET = (process.env.JWT_SECRET || 'change-me');

if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : (process.env.DB_SSL === '1' ? { rejectUnauthorized: false } : undefined),
});

const app = Fastify({ logger: true });

// ---------- CORS ----------
await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (CORS_ORIGIN.length === 0) return cb(null, true);
    if (CORS_ORIGIN.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked'), false);
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Wallet','X-Admin-Key'],
  credentials: false,
});

// ---------- helpers ----------
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n|0));
const nowUTC = () => new Date();

// in-memory nonce store
const nonces = new Map(); // nonce -> { address, scope, ts, exp, used }

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
  await pool.query(
    `insert into player_profiles (wallet)
     values ($1) on conflict (wallet) do nothing`, [wallet]
  );
}

async function getProfileRaw(wallet){
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
  } catch (e) {
    app.log.warn({ err:e }, 'regen_nonfatal');
  }
  return row;
}

// ---- rate limiter (ip|wallet) ----
const RATE = { windowMs: 10_000, maxPerWindow: 30 };
const bucket = new Map();

app.addHook('onRequest', async (req, reply) => {
  // open routes
  if (req.raw.url?.startsWith('/session/start')) return;
  if (req.raw.url?.startsWith('/session/verify')) return;

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
  if (cur.count > RATE.maxPerWindow) {
    return reply.code(429).send({ error: 'rate_limited' });
  }
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
  if (!address || !signature || !publicKey || !payload) {
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
    const ok = rippleKeypairs.verify(payload, signature, publicKey);
    if (!ok) return reply.code(401).send({ error: 'bad_signature' });
  } catch {
    return reply.code(401).send({ error: 'bad_signature' });
  }
  rec.used = true; nonces.set(nonce, rec);

  const token = jwt.sign(
    { sub: address, scope: 'play,upgrade,claim' },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '45m' }
  );
  return reply.send({ ok: true, jwt: token });
});

// Require JWT on /claim/start
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

// Costs
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
  const price = (n) => Math.max(1, Math.round(BASE_PER_LEVEL * (n + 1) * scale));
  const costs = {
    health: price(lv.health|0),
    energyCap: price(lv.energyCap|0),
    regenPerMin: price(lv.regenPerMin|0),
    hit: price(pct.hit|0),
    crit: price(pct.crit|0),
    dodge: price(pct.dodge|0),
  };
  return reply.send({ costs, levels: { ...lv, ...pct }, scale });
});

// Upgrade
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

  const priceAt = (n) => Math.max(1, Math.round(BASE_PER_LEVEL * (n + 1) * econScale));

  let spend = 0;
  const applied = { health:0, energyCap:0, regenPerMin:0, hit:0, crit:0, dodge:0 };
  const lv = { ...lv0 };
  let hit = pct0.hit, crit = pct0.crit, dodge = pct0.dodge;

  for (let i=0;i<q.health;i++){ const c=priceAt(lv.health);      if (spend+c > (p0.jet_fuel|0)) break; spend+=c; lv.health++; applied.health++; }
  for (let i=0;i<q.energyCap;i++){ const c=priceAt(lv.energyCap); if (spend+c > (p0.jet_fuel|0)) break; spend+=c; lv.energyCap++; applied.energyCap++; }
  for (let i=0;i<q.regenPerMin;i++){ const c=priceAt(lv.regenPerMin); if (spend+c > (p0.jet_fuel|0)) break; spend+=c; lv.regenPerMin++; applied.regenPerMin++; }

  for (let i=0;i<q.hit;i++){   const c=priceAt(hit);   if (spend+c > (p0.jet_fuel|0)) break; spend+=c; hit++;   applied.hit++; }
  for (let i=0;i<q.crit;i++){  const c=priceAt(crit);  if (spend+c > (p0.jet_fuel|0)) break; spend+=c; crit++;  applied.crit++; }
  for (let i=0;i<q.dodge;i++){ const c=priceAt(dodge); if (spend+c > (p0.jet_fuel|0)) break; spend+=c; dodge++; applied.dodge++; }

  const ms_current = recomputeCurrent(p0.ms_base, lv);
  const cap = Number(p0.energy_cap ?? ms_current.energyCap ?? 100);
  const energyCapped = clamp((p0.energy|0), 0, cap);

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

// Battle
app.post('/battle/start', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });
  const p = await applyRegen(req.wallet, p0) || p0;
  const next = clamp((p.energy|0) - 10, 0, Number(p.energy_cap ?? 100));
  const { rows } = await pool.query(
    `update player_profiles set energy=$2, updated_at=now() where wallet=$1 returning *`,
    [req.wallet, next]
  );
  return reply.send({ ok:true, profile: toClient(rows[0]) });
});
app.post('/battle/turn', async (_req, reply) => reply.send({ ok:true }));
app.post('/battle/finish', async (req, reply) => {
  const body = req.body || {};
  const victory = !!body.victory;
  const wave = Math.max(1, Number(body.wave || 1));
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });

  const base = 10;
  const reward = victory ? Math.max(0, Math.round(base * wave * ECON_SCALE)) : 0;

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

// ---------- CLAIM (audit-based caps) ----------
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

    const { rows: agg } = await pool.query(
      `with today as (
         select coalesce(sum(amount),0)::int as sum_today
           from claim_audit
          where wallet = $1
            and ts >= date_trunc('day', now())
            and ts <  date_trunc('day', now()) + interval '1 day'
       ),
       last as (
         select max(ts) as last_ts
           from claim_audit
          where wallet = $1
       )
       select today.sum_today, last.last_ts
         from today cross join last`,
      [wallet]
    );
    const sumToday = Number(agg[0]?.sum_today || 0);
    const lastTs = agg[0]?.last_ts ? new Date(agg[0].last_ts) : null;

    if (sumToday + amount > CLAIM_MAX_PER_24H) {
      return reply.code(429).send({ error: 'limit_exceeded' });
    }
    if (CLAIM_COOLDOWN_SEC > 0 && lastTs) {
      const diff = (nowUTC() - lastTs) / 1000;
      if (diff < CLAIM_COOLDOWN_SEC) {
        return reply.code(429).send({ error: 'cooldown', retry_in: Math.ceil(CLAIM_COOLDOWN_SEC - diff) });
      }
    }

    const out = await claim.sendIssued({ to: wallet, amount });
    let txid = null, txJSON = null;
    if (typeof out === 'string' && out) txid = out;
    else if (out && out.txJSON) txJSON = out.txJSON;

    await pool.query(
      `insert into claim_audit (wallet, amount, ts, txid)
       values ($1, $2, now(), $3)`,
      [wallet, amount, txid || null]
    );

    try { await pool.query(`update player_profiles set last_claim_at = now() where wallet=$1`, [wallet]); } catch {}

    return reply.send({ ok:true, txid, txJSON });
  } catch (e) {
    const m = String(e?.message || e);
    if (m.includes('dest_account_not_found')) {
      return reply.code(502).send({ error:'send_failed', message:'Destination account not found (network mismatch or unfunded address).' });
    }
    if (m.includes('issuer_account_not_found')) {
      return reply.code(502).send({ error:'send_failed', message:'Issuer account not found on this network.' });
    }
    app.log.error({ err:e }, 'claim_send_failed');
    return reply.code(502).send({ error: 'send_failed', message: m });
  }
});

// ---------- Admin: diagnostics ----------
app.get('/debug/claim/ping', async (req, reply) => {
  if (!ADMIN_KEY || (req.headers['x-admin-key'] || '') !== ADMIN_KEY) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const wallet = (req.query.wallet || '').trim();
  try {
    const info = await claim.diagnostics({ dest: wallet || null });
    return reply.send({ ok:true, info });
  } catch (e) {
    return reply.code(500).send({ error: 'ping_failed', message: e.message || String(e) });
  }
});
app.get('/debug/claim/inspect', async (req, reply) => {
  if (!ADMIN_KEY || (req.headers['x-admin-key'] || '') !== ADMIN_KEY) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const wallet = (req.query.wallet || '').trim();
  if (!wallet || !wallet.startsWith('r')) return reply.code(400).send({ error: 'missing_wallet' });
  try {
    const ok = await claim.hasTrustline({ account: wallet });
    return reply.send({ ok:true, trustline: !!ok });
  } catch (e) {
    return reply.code(500).send({ error: 'inspect_failed', message: e.message || String(e) });
  }
});
app.post('/debug/claim/reset', async (req, reply) => {
  if (!ADMIN_KEY || (req.headers['x-admin-key'] || '') !== ADMIN_KEY) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const wallet = (req.headers['x-wallet'] || req.body?.wallet || '').trim();
  if (!wallet || !wallet.startsWith('r')) return reply.code(400).send({ error: 'missing_or_bad_X-Wallet' });
  try {
    await pool.query(
      `delete from claim_audit
        where wallet=$1
          and ts >= date_trunc('day', now())
          and ts <  date_trunc('day', now()) + interval '1 day'`,
      [wallet]
    );
    return reply.send({ ok:true });
  } catch (e) { return reply.code(500).send({ error: 'db_error' }); }
});

app.listen({ port: PORT, host: '0.0.0.0' }, (err, addr) => {
  if (err) { app.log.error(err); process.exit(1); }
  app.log.info(`Server listening at ${addr}`);
});
