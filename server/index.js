// server/index.js — XRPixel Jets MKG (2025-10-21-reg0.1+unlock)
// - Regen upgrades = +0.1/min per level (server-authoritative)
// - /battle/finish unlocks next wave on victory: unlocked_level = max(old, wave + 1)
// - pct split saved in ms_hit/ms_crit/ms_dodge; /profile still returns pct:{...}

import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';

const { Pool } = pkg;

const PORT = process.env.PORT || 10000;
const ORIGIN = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const REGEN_STEP = 0.1;                 // +0.1 energy/min per regen level
const COST = (lv) => 100 + 30 * lv;     // next upgrade cost at current level
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = Fastify({ logger: true });
await app.register(cors, { origin: ORIGIN.length ? ORIGIN : true });

// ---------- helpers ----------
async function ensureProfile(wallet) {
  await pool.query(
    `insert into player_profiles (wallet)
     values ($1)
     on conflict (wallet) do nothing`,
     [wallet]
  );
}

async function getProfileRaw(wallet) {
  const { rows } = await pool.query(
    `select wallet, jet_fuel, energy, energy_cap,
            ms_base, ms_level, ms_current,
            coalesce(ms_hit,0)::int as ms_hit,
            coalesce(ms_crit,10)::int as ms_crit,
            coalesce(ms_dodge,0)::int as ms_dodge,
            unlocked_level, updated_at, created_at
       from player_profiles
      where wallet = $1`,
    [wallet]
  );
  return rows[0] || null;
}

function recomputeCurrent(base, level) {
  const b = base || { health:20, energyCap:100, regenPerMin:1 };
  const lv = level || { health:0, energyCap:0, regenPerMin:0 };
  const health = (Number(b.health)||0) + (Number(lv.health)||0);
  const energyCap = (Number(b.energyCap)||0) + (Number(lv.energyCap)||0);
  const regenRaw = (Number(b.regenPerMin)||0) + (Number(lv.regenPerMin)||0) * REGEN_STEP;
  const regenPerMin = Number(regenRaw.toFixed(1)); // persist with 1 decimal
  return { health, energyCap, regenPerMin };
}

function toClient(p) {
  return {
    jetFuel: p.jet_fuel|0,
    energy: p.energy|0,
    energyCap: p.energy_cap|0,
    ms: { base: p.ms_base, level: p.ms_level, current: p.ms_current },
    pct: { hit: p.ms_hit|0, crit: p.ms_crit|0, dodge: p.ms_dodge|0 },
    unlockedLevel: p.unlocked_level|0
  };
}

async function applyRegen(wallet, row) {
  const p = row || await getProfileRaw(wallet);
  if (!p) return null;

  const current = recomputeCurrent(p.ms_base, p.ms_level);
  const cap = (Number(p.energy_cap) || current.energyCap || 100);
  const regenPerMin = Number(current.regenPerMin) || 0;

  const updatedAt = p.updated_at ? new Date(p.updated_at) : null;
  let newEnergy = Number(p.energy) || 0;

  if (updatedAt && regenPerMin > 0) {
    const dtMs = Date.now() - updatedAt.getTime();
    const minutes = dtMs / 60000;
    const gained = Math.floor(minutes * regenPerMin);
    if (gained > 0) newEnergy = clamp(newEnergy + gained, 0, cap);
  }

  const curStr = JSON.stringify(p.ms_current || {});
  const nextStr = JSON.stringify(current);
  if (newEnergy !== (p.energy|0) || cap !== (p.energy_cap|0) || curStr !== nextStr) {
    const { rows } = await pool.query(
      `update player_profiles set
         energy     = $2,
         energy_cap = $3,
         ms_current = $4,
         updated_at = now()
       where wallet = $1
       returning wallet, jet_fuel, energy, energy_cap, ms_base, ms_level, ms_current,
                 ms_hit, ms_crit, ms_dodge, unlocked_level, updated_at`,
      [wallet, newEnergy, cap, current]
    );
    return rows[0];
  }
  return p;
}

// ---------- routes ----------
app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) {
    return reply.code(400).send({ error: 'invalid address' });
  }
  await ensureProfile(address);
  return reply.send({ nonce: 'demo-nonce' });
});

// X-Wallet required for the rest
app.addHook('onRequest', async (req, reply) => {
  if (req.raw.url === '/session/start') return;
  const w = req.headers['x-wallet'];
  if (!w || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(w)) {
    return reply.code(400).send({ error: 'missing X-Wallet' });
  }
  req.wallet = w;
});

app.get('/profile', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;
  return reply.send(toClient(p));
});

app.get('/ms/costs', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;

  const lv = p.ms_level || { health:0, energyCap:0, regenPerMin:0 };
  const levels = {
    health: lv.health|0,
    energyCap: lv.energyCap|0,
    regenPerMin: lv.regenPerMin|0, // integer level count; effect is *0.1
    hit: p.ms_hit|0,
    crit: p.ms_crit|0,
    dodge: p.ms_dodge|0
  };
  const costs = {
    health: COST(levels.health),
    energyCap: COST(levels.energyCap),
    regenPerMin: COST(levels.regenPerMin),
    hit: COST(levels.hit),
    crit: COST(levels.crit),
    dodge: COST(levels.dodge)
  };
  return reply.send({ levels, costs });
});

app.post('/ms/upgrade', async (req, reply) => {
  const deltas = req.body || {};
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;

  let jf = p.jet_fuel|0;
  const applied = { health:0, energyCap:0, regenPerMin:0, hit:0, crit:0, dodge:0 };
  const lv = { ...(p.ms_level || { health:0, energyCap:0, regenPerMin:0 }) };
  let h = p.ms_hit|0, c = p.ms_crit|0, d = p.ms_dodge|0;

  function applyStat(key) {
    let want = Math.max(0, parseInt(deltas[key]||0, 10));
    while (want > 0) {
      const curLv = (key==='hit')?h:(key==='crit')?c:(key==='dodge')?d:(lv[key]|0);
      const cost = COST(curLv);
      if (jf < cost) break;
      jf -= cost;
      applied[key]++;
      if (key==='hit') h++; else if (key==='crit') c++; else if (key==='dodge') d++; else lv[key] = (lv[key]|0)+1;
      want--;
    }
  }

  ['health','energyCap','regenPerMin','hit','crit','dodge'].forEach(applyStat);

  const current = recomputeCurrent(p.ms_base, lv);
  const spent = (p.jet_fuel|0) - jf;
  const newCap = current.energyCap|0;
  const newEnergy = clamp(p.energy|0, 0, newCap);

  const { rows } = await pool.query(
    `update player_profiles set
       jet_fuel = $2,
       ms_level = $3,
       ms_current = $4,
       energy_cap = $5,
       energy = $6,
       ms_hit = $7,
       ms_crit = $8,
       ms_dodge = $9,
       updated_at = now()
     where wallet = $1
     returning wallet, jet_fuel, energy, energy_cap, ms_base, ms_level, ms_current,
               ms_hit, ms_crit, ms_dodge, unlocked_level, updated_at`,
    [req.wallet, jf, lv, current, newCap, newEnergy, h, c, d]
  );
  return reply.send({ applied, spent, profile: toClient(rows[0]) });
});

// ----- Battle -----
app.post('/battle/start', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;

  const need = 10;
  if ((p.energy|0) < need) return reply.code(400).send({ error: 'not enough energy' });

  const left = (p.energy|0) - need;
  await pool.query(`update player_profiles set energy=$2, updated_at=now() where wallet=$1`, [req.wallet, left]);
  return reply.send({ ok:true, energy:left });
});

app.post('/battle/turn', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;

  if ((p.energy|0) <= 0) return reply.code(400).send({ error: 'no energy' });
  const left = (p.energy|0) - 1;
  await pool.query(`update player_profiles set energy=$2, updated_at=now() where wallet=$1`, [req.wallet, left]);
  return reply.send({ ok:true, energy:left });
});

// ✅ Re-dropped unlock rule: unlock next wave when victorious
app.post('/battle/finish', async (req, reply) => {
  const { victory, wave, jf, energyReward } = req.body || {};
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;

  const win = !!victory;
  const lvl = Math.max(1, parseInt(wave || 1, 10));
  const jfGain = Math.max(0, parseInt(jf || 0, 10));
  const eGain = Math.max(0, parseInt(energyReward || 0, 10));

  const current = recomputeCurrent(p.ms_base, p.ms_level);
  const cap = current.energyCap|0;

  const nextJF = (p.jet_fuel|0) + jfGain;
  const nextEnergy = clamp((p.energy|0) + eGain, 0, cap);
  const nextUnlock = win ? Math.max(p.unlocked_level|0, lvl + 1) : (p.unlocked_level|0);

  const { rows } = await pool.query(
    `update player_profiles set
       jet_fuel = $2,
       energy = $3,
       unlocked_level = $4,
       ms_current = $5,
       energy_cap = $6,
       updated_at = now()
     where wallet = $1
     returning wallet, jet_fuel, energy, energy_cap, ms_base, ms_level, ms_current,
               ms_hit, ms_crit, ms_dodge, unlocked_level, updated_at`,
    [req.wallet, nextJF, nextEnergy, nextUnlock, current, cap]
  );

  return reply.send({ ok:true, profile: toClient(rows[0]) });
});

app.get('/', async (_req, reply) => reply.send({ ok:true }));

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`XRPixel Jets API listening on :${PORT}`))
  .catch((err) => { app.log.error(err); process.exit(1); });
