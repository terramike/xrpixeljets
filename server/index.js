// server/index.js — XRPixel Jets MKG (2025-10-24 pct+core upgrades aligned)
// - Upgrades: health, energyCap, regenPerMin, hit, crit, dodge
// - Next cost = scaled(BASE_PER_LEVEL * (level+1))  (ECON_SCALE default 0.10)
// - Rewards remain scaled (tens). CORS + regen + rate limit unchanged.

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

// ===== Economy =====
const ECON_SCALE_DEFAULT = Number(process.env.ECON_SCALE || 0.10);
const BASE_PER_LEVEL = Number(process.env.BASE_PER_LEVEL || 300); // 300 raw -> 30 visible w/scale 0.10

function pickScale(req){
  const q = Number(req.query?.econScale);
  const b = Number(req.body?.econScale);
  return (Number.isFinite(b) && b > 0) ? b : (Number.isFinite(q) && q > 0 ? q : ECON_SCALE_DEFAULT);
}
function scaled(n, s){ return Math.max(1, Math.round((Number(n)||0) * s)); }
function rawCostForNextLevel(currentLevel) {
  const idx = (Number(currentLevel) || 0) + 1;
  return BASE_PER_LEVEL * idx;
}

const app = Fastify({ logger: true });

// ===== CORS =====
const ORIGIN_LIST = (process.env.CORS_ORIGIN || 'https://mykeygo.io,https://www.mykeygo.io,http://localhost:8000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

await app.register(cors, {
  origin: ORIGIN_LIST,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Origin', 'X-Requested-With', 'X-Wallet'],
  credentials: false,
  maxAge: 86400,
  preflight: true,
  strictPreflight: false,
  hideOptionsRoute: false,
});

// ===== Helpers =====
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
  } catch (e) {
    app.log.warn({ err:e }, 'regen_nonfatal');
  }
  return row;
}

// ===== Rate limit =====
const RATE = { windowMs: 10_000, maxPerWindow: 30 };
const bucket = new Map();

app.addHook('onRequest', async (req, reply) => {
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
  if (cur.count > RATE.maxPerWindow) {
    return reply.code(429).send({ error: 'rate_limited' });
  }
});

// ===== Routes =====
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

// --- Costs for all 6 stats (scaled) ---
app.get('/ms/costs', async (req, reply) => {
  const scale = pickScale(req);
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });

  const lvCore = p0.ms_level || { health:0, energyCap:0, regenPerMin:0 };
  const lvPct  = { hit: p0.ms_hit|0, crit: p0.ms_crit|0, dodge: p0.ms_dodge|0 };

  const costs = {
    health:      scaled(rawCostForNextLevel(lvCore.health|0),      scale),
    energyCap:   scaled(rawCostForNextLevel(lvCore.energyCap|0),   scale),
    regenPerMin: scaled(rawCostForNextLevel(lvCore.regenPerMin|0), scale),
    hit:         scaled(rawCostForNextLevel(lvPct.hit|0),          scale),
    crit:        scaled(rawCostForNextLevel(lvPct.crit|0),         scale),
    dodge:       scaled(rawCostForNextLevel(lvPct.dodge|0),        scale),
  };

  return reply.send({ ok:true, levels: { ...lvCore, ...lvPct }, costs, scale });
});

// --- Apply upgrades (for all 6 stats) ---
app.post('/ms/upgrade', async (req, reply) => {
  const scale = pickScale(req);
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

  const lvCore = { ...(p0.ms_level || { health:0, energyCap:0, regenPerMin:0 }) };
  const lvPct  = { hit: p0.ms_hit|0, crit: p0.ms_crit|0, dodge: p0.ms_dodge|0 };

  let spend = 0;
  const applied = { health:0, energyCap:0, regenPerMin:0, hit:0, crit:0, dodge:0 };

  for (const stat of ['health','energyCap','regenPerMin']) {
    const want = Math.max(0, deltas[stat]|0);
    for (let i = 0; i < want; i++) {
      const raw = rawCostForNextLevel(lvCore[stat]|0);
      const cost = scaled(raw, scale);
      if ((p0.jet_fuel|0) - spend < cost) break;
      spend += cost; applied[stat] += 1; lvCore[stat] = (lvCore[stat]|0) + 1;
    }
  }

  for (const stat of ['hit','crit','dodge']) {
    const want = Math.max(0, deltas[stat]|0);
    for (let i = 0; i < want; i++) {
      const raw = rawCostForNextLevel(lvPct[stat]|0);
      const cost = scaled(raw, scale);
      if ((p0.jet_fuel|0) - spend < cost) break;
      spend += cost; applied[stat] += 1; lvPct[stat] = (lvPct[stat]|0) + 1;
    }
  }

  const ms_current = recomputeCurrent(p0.ms_base, lvCore);
  const energyCapped = clamp(p0.energy|0, 0, (p0.energy_cap|0) || ms_current.energyCap || 100);

  const { rows } = await pool.query(
    `update player_profiles set
       jet_fuel = jet_fuel - $2,
       ms_level = $3,
       ms_current = $4,
       ms_hit = $5,
       ms_crit = $6,
       ms_dodge = $7,
       energy = $8,
       updated_at = now()
     where wallet = $1
     returning *`,
    [req.wallet, spend, lvCore, ms_current, lvPct.hit|0, lvPct.crit|0, lvPct.dodge|0, energyCapped]
  );

  return reply.send({ ok:true, applied, spent: spend, profile: toClient(rows[0]), scale });
});

// --- Energy endpoints ---
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

// --- Rewards (scaled to tens) ---
app.post('/battle/finish', async (req, reply) => {
  const scale = pickScale(req);
  const { victory, wave } = req.body || {};
  const lvl = Math.max(1, parseInt(wave || 1, 10));

  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });
  const p = await applyRegen(req.wallet, p0) || p0;

  const baseRaw = (lvl <= 5)
    ? [0,100,150,200,250,300][lvl]
    : Math.round(300 * Math.pow(1.01, (lvl - 5)));

  const jfEarned = victory ? scaled(baseRaw, scale) : 0;
  const energyReward = victory ? (3 + Math.floor(Math.random()*4)) : (1 + Math.floor(Math.random()*2));

  const srvUnlocked = p.unlocked_level | 0;
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
  return reply.send({ ok:true, profile: toClient(rows[0]), scale, jfEarned, energyReward });
});

// --- Claim passthrough ---
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
    await pool.query(
      `update player_profiles set last_claim_at = now(), updated_at = now() where wallet = $1`,
      [req.wallet]
    );
    return reply.send({ ok:true, txid });
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
  app.log.info(`Server listening at ${addr} (ECON_SCALE=${ECON_SCALE_DEFAULT}, BASE_PER_LEVEL=${BASE_PER_LEVEL})`);
});
