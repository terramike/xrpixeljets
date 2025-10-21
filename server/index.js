// server/index.js — XRPixel Jets MKG (2025-10-21-pctsplit)
// Fully paste‑ready Fastify API. Implements ms_hit/ms_crit/ms_dodge columns,
// keeps /profile response backward‑compatible via pct:{hit,crit,dodge}.
// Cost formula: 100 + 30*level for all stats. Server is authoritative.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';

const { Pool } = pkg;

const PORT = process.env.PORT || 10000;
const ORIGIN = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = Fastify({ logger: true });

await app.register(cors, { origin: ORIGIN.length ? ORIGIN : true });

// ---------- Helpers ----------
const COST = (lv) => 100 + 30 * lv; // next step cost based on current level
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

async function ensureProfile(wallet) {
  const q = `insert into player_profiles (wallet)
             values ($1)
             on conflict (wallet) do nothing`;
  await pool.query(q, [wallet]);
}

async function getProfile(wallet) {
  const { rows } = await pool.query(
    `select wallet, jet_fuel, energy, energy_cap,
            ms_base, ms_level, ms_current,
            coalesce(ms_hit,0)::int as ms_hit,
            coalesce(ms_crit,10)::int as ms_crit,
            coalesce(ms_dodge,0)::int as ms_dodge,
            unlocked_level, updated_at, created_at
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
    regenPerMin: (b.regenPerMin|0) + (lv.regenPerMin|0)
  };
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

// ---------- Routes ----------
app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) {
    return reply.code(400).send({ error: 'invalid address' });
  }
  await ensureProfile(address);
  // Return a simple nonce stub for future signing flow
  return reply.send({ nonce: 'demo-nonce' });
});

// All routes below expect X-Wallet
app.addHook('onRequest', async (req, reply) => {
  if (req.raw.url === '/session/start') return; // already validated above
  const w = req.headers['x-wallet'];
  if (!w || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(w)) {
    return reply.code(400).send({ error: 'missing X-Wallet' });
  }
  req.wallet = w;
});

app.get('/profile', async (req, reply) => {
  const p = await getProfile(req.wallet);
  if (!p) return reply.code(404).send({ error: 'not found' });
  return reply.send(toClient(p));
});

app.get('/ms/costs', async (req, reply) => {
  const p = await getProfile(req.wallet);
  if (!p) return reply.code(404).send({ error: 'not found' });
  const lv = p.ms_level || { health:0, energyCap:0, regenPerMin:0 };
  const out = {
    levels: {
      health: lv.health|0,
      energyCap: lv.energyCap|0,
      regenPerMin: lv.regenPerMin|0,
      hit: p.ms_hit|0,
      crit: p.ms_crit|0,
      dodge: p.ms_dodge|0
    },
    costs: {
      health: COST(lv.health|0),
      energyCap: COST(lv.energyCap|0),
      regenPerMin: COST(lv.regenPerMin|0),
      hit: COST(p.ms_hit|0),
      crit: COST(p.ms_crit|0),
      dodge: COST(p.ms_dodge|0)
    }
  };
  return reply.send(out);
});

app.post('/ms/upgrade', async (req, reply) => {
  const deltas = req.body || {};
  const p = await getProfile(req.wallet);
  if (!p) return reply.code(404).send({ error: 'not found' });

  let jf = p.jet_fuel|0;
  const applied = { health:0, energyCap:0, regenPerMin:0, hit:0, crit:0, dodge:0 };
  const lv = { ...(p.ms_level || { health:0, energyCap:0, regenPerMin:0 }) };
  let h = p.ms_hit|0, c = p.ms_crit|0, d = p.ms_dodge|0;

  function applyStat(key) {
    let want = Math.max(0, parseInt(deltas[key]||0, 10));
    while (want > 0) {
      const curLv = (key === 'hit') ? h : (key === 'crit') ? c : (key === 'dodge') ? d : (lv[key]|0);
      const cost = COST(curLv);
      if (jf < cost) break;
      jf -= cost;
      applied[key]++;
      if (key === 'hit') h++; else if (key === 'crit') c++; else if (key === 'dodge') d++; else lv[key] = (lv[key]|0) + 1;
      want--;
    }
  }

  ['health','energyCap','regenPerMin','hit','crit','dodge'].forEach(applyStat);

  const spent = (p.jet_fuel|0) - jf;

  // Recompute current + energy cap
  const current = recomputeCurrent(p.ms_base, lv);
  const newCap = current.energyCap|0;
  const newEnergy = clamp(p.energy|0, 0, newCap);

  // Persist
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
               ms_hit, ms_crit, ms_dodge, unlocked_level`,
    [req.wallet, jf, lv, current, newCap, newEnergy, h, c, d]
  );

  const prof = rows[0];
  return reply.send({ applied, spent, profile: toClient(prof) });
});

app.post('/battle/start', async (req, reply) => {
  const p = await getProfile(req.wallet);
  if (!p) return reply.code(404).send({ error: 'not found' });
  const need = 10;
  if ((p.energy|0) < need) return reply.code(400).send({ error: 'insufficient energy' });
  const newEnergy = (p.energy|0) - need;
  await pool.query(`update player_profiles set energy = $2, updated_at = now() where wallet = $1`, [req.wallet, newEnergy]);
  return reply.send({ ok:true, energy: newEnergy });
});

app.post('/battle/turn', async (req, reply) => {
  const p = await getProfile(req.wallet);
  if (!p) return reply.code(404).send({ error: 'not found' });
  if ((p.energy|0) <= 0) return reply.code(400).send({ error: 'no energy' });
  const newEnergy = (p.energy|0) - 1;
  await pool.query(`update player_profiles set energy = $2, updated_at = now() where wallet = $1`, [req.wallet, newEnergy]);
  return reply.send({ ok:true, energy: newEnergy });
});

app.post('/battle/finish', async (req, reply) => {
  const { victory, wave, jf, energyReward } = req.body || {};
  const p = await getProfile(req.wallet);
  if (!p) return reply.code(404).send({ error: 'not found' });

  const addJF = Math.max(0, parseInt(jf || 0, 10));
  const addE = Math.max(0, parseInt(energyReward || 0, 10));
  const cap = p.energy_cap|0;
  const merged = {
    jet_fuel: (p.jet_fuel|0) + addJF,
    energy: clamp((p.energy|0) + addE, 0, cap)
  };

  const nextUnlocked = Math.max(p.unlocked_level|0, Math.max(5, parseInt(wave||0,10)));

  const { rows } = await pool.query(
    `update player_profiles set
       jet_fuel = $2,
       energy = $3,
       unlocked_level = $4,
       updated_at = now()
     where wallet = $1
     returning wallet, jet_fuel, energy, energy_cap, ms_base, ms_level, ms_current,
               ms_hit, ms_crit, ms_dodge, unlocked_level`,
    [req.wallet, merged.jet_fuel, merged.energy, nextUnlocked]
  );

  return reply.send({ ok:true, profile: toClient(rows[0]) });
});

app.get('/', async (_req, reply) => reply.send({ ok:true }));

app.listen({ port: PORT, host: '0.0.0.0' }, () => {
  console.log('API listening on', PORT, 'origins', ORIGIN);
});
