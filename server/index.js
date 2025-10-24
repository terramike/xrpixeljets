// server/index.js — XRPixel Jets MKG (2025-10-24CORS)
// - Fastify + PG
// - CORS allowlist for mykeygo.io (and localhost dev)
// - Simple rate limiter (ip|wallet)
// - Server-authoritative rewards/unlocks in /battle/finish
// - Regen-on-read, MS upgrade costs, claim passthrough

import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';
import * as claim from './claimJetFuel.js';

const { Pool } = pkg;

const PORT = process.env.PORT || 10000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

const app = Fastify({ logger: true });

// --- CORS (allow mykeygo.io, www, and local dev) ---
const ORIGIN_LIST = (process.env.CORS_ORIGIN || 'https://mykeygo.io,https://www.mykeygo.io,http://localhost:8000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                   // allow curl/SSR
    if (ORIGIN_LIST.includes(origin)) return cb(null, true);
    // Optionally allow subdomains:
    // if (origin.endsWith('.mykeygo.io')) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','X-Wallet'],
  exposedHeaders: [],
  credentials: false,
  maxAge: 86400,
  preflight: true,
  strictPreflight: true,
  hideOptionsRoute: false,
});

// ---- helpers ---- //
async function ensureProfile(wallet){
  const { rows } = await pool.query(
    `insert into player_profiles (wallet)
     values ($1)
     on conflict (wallet) do nothing
     returning wallet`, [wallet]
  );
  return rows[0]?.wallet || wallet;
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
  } catch(e) {
    // non-fatal
    app.log.warn({ err:e }, 'regen_failed_nonfatal');
  }
  return row;
}

// ---- rate limiter (in-memory; good enough for now) ----
const RATE = { windowMs: 10_000, maxPerWindow: 30 };
const bucket = new Map(); // key = ip|wallet -> {count, ts}

app.addHook('onRequest', async (req, reply) => {
  if (req.raw.url === '/session/start') return; // open endpoint
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

// ----- routes ----- //

// open: ensure profile row exists
app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) {
    return reply.code(400).send({ error: 'bad_address' });
  }
  await ensureProfile(address);
  return reply.send({ nonce: 'demo-nonce' });
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
    dodge: (body.dodge|0) || 0
  };

  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });

  const levels = p0.ms_level || { health:0, energyCap:0, regenPerMin:0 };
  const base = { health: 50, energyCap: 60, regenPerMin: 80 };
  const step = { health: 25, energyCap: 30, regenPerMin: 45 };

  function nextCost(stat, idx){
    const raw = base[stat] + step[stat] * idx;
    return (stat === 'regenPerMin') ? Math.round(1.5 * raw) : raw;
  }

  let spend = 0;
  let applied = { health:0, energyCap:0, regenPerMin:0, hit:0, crit:0, dodge:0 };
  let lv = { ...levels };

  for (const stat of ['health','energyCap','regenPerMin']) {
    const want = Math.max(0, deltas[stat]|0);
    for (let i = 0; i < want; i++) {
      const cost = nextCost(stat, (lv[stat]|0) + 1);
      if ((p0.jet_fuel|0) - spend < cost) break;
      spend += cost; applied[stat] += 1; lv[stat] = (lv[stat]|0) + 1;
    }
  }

  const pctCost = { hit: 100, crit: 120, dodge: 110 };
  for (const stat of ['hit','crit','dodge']) {
    const want = Math.max(0, deltas[stat]|0);
    for (let i = 0; i < want; i++) {
      const cost = pctCost[stat];
      if ((p0.jet_fuel|0) - spend < cost) break;
      spend += cost; applied[stat] += 1;
    }
  }

  const ms_current = recomputeCurrent(p0.ms_base, lv);
  const energyCapped = clamp(p0.energy|0, 0, (p0.energy_cap|0) || ms_current.energyCap || 100);
  const { rows } = await pool.query(
    `update player_profiles set
       jet_fuel = jet_fuel - $2,
       ms_level = $3,
       ms_current = $4,
       ms_hit = coalesce(ms_hit,0) + $5,
       ms_crit = coalesce(ms_crit,10) + $6,
       ms_dodge = coalesce(ms_dodge,0) + $7,
       energy = $8,
       updated_at = now()
     where wallet = $1
     returning *`,
    [req.wallet, spend, lv, ms_current, applied.hit|0, applied.crit|0, applied.dodge|0, energyCapped]
  );

  return reply.send({ ok:true, applied, spent: spend, profile: toClient(rows[0]) });
});

app.post('/battle/start', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });
  const p = await applyRegen(req.wallet, p0) || p0;
  const next = clamp((p.energy|0) - 10, 0, (p.energy_cap|0)||100);
  const { rows } = await pool.query(
    `update player_profiles set energy=$2, updated_at=now() where wallet=$1 returning *`,
    [req.wallet, next]
  );
  return reply.send({ ok:true, energy: rows[0].energy|0 });
});

app.post('/battle/turn', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });
  const p = await applyRegen(req.wallet, p0) || p0;
  const next = clamp((p.energy|0) - 1, 0, (p.energy_cap|0)||100);
  const { rows } = await pool.query(
    `update player_profiles set energy=$2, updated_at=now() where wallet=$1 returning *`,
    [req.wallet, next]
  );
  return reply.send({ ok:true, energy: rows[0].energy|0 });
});

// SERVER-AUTHORITATIVE finish (prevents LS tamper for unlock/reward)
app.post('/battle/finish', async (req, reply) => {
  const { victory, wave } = req.body || {};
  const lvl = Math.max(1, parseInt(wave || 1, 10));

  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });
  const p = await applyRegen(req.wallet, p0) || p0;

  const base = (lvl <= 5)
    ? [0,100,150,200,250,300][lvl]
    : Math.round(300 * Math.pow(1.01, (lvl - 5)));

  const jfEarned = victory ? base : 0;
  const energyReward = victory ? (3 + Math.floor(Math.random()*4)) : (1 + Math.floor(Math.random()*2));

  // Allow finishing current unlocked or the very next
  const srvUnlocked = p.unlocked_level | 0; // defaults to 5 on new profiles
  if (lvl > Math.max(1, srvUnlocked + 1)) {
    return reply.code(400).send({ error: 'wave_not_unlocked' });
  }

  const nextUnlocked = (victory && lvl >= srvUnlocked) ? (lvl + 1) : srvUnlocked;
  const cap = (p.energy_cap|0) || 100;
  const newEnergy = clamp((p.energy|0) + energyReward, 0, cap);
  const newJF = (p.jet_fuel|0) + jfEarned;

  const { rows } = await pool.query(
    `update player_profiles
       set jet_fuel = $2,
           energy = $3,
           unlocked_level = $4,
           updated_at = now()
     where wallet = $1
     returning *`,
    [req.wallet, newJF, newEnergy, nextUnlocked]
  );
  return reply.send({ ok:true, profile: toClient(rows[0]) });
});

// claim JFUEL via XRPL hot wallet (kept)
app.post('/claim/start', async (req, reply) => {
  const { amount } = req.body || {};
  const amt = Math.max(1, parseInt(amount||0, 10));

  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });

  const last = p0.last_claim_at ? new Date(p0.last_claim_at) : null;
  if (last && (Date.now() - last.getTime()) < 5*60*1000) {
    return reply.code(429).send({ error: 'cooldown' });
  }

  try {
    const txid = await claim.sendIssued(req.wallet, amt);
    const { rows } = await pool.query(
      `update player_profiles set last_claim_at = now(), updated_at = now() where wallet = $1 returning *`,
      [req.wallet]
    );
    return reply.send({ ok:true, txid, profile: toClient(rows[0]) });
  } catch (e) {
    req.log.error({ err:e }, 'claim_send_failed');
    return reply.code(502).send({ error: 'send_failed', message: e.message || String(e) });
  }
});

app.listen({ port: PORT, host: '0.0.0.0' }, (err, addr) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Server listening at ${addr}`);
});
