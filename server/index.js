// server/index.js — XRPixel Jets MKG (2025-10-21-reg0.1)
// Server-authoritative API (Fastify + Postgres).
// Change in this patch:
//   • Regen upgrades are interpreted as +0.1 per level.
//   • ms_current.regenPerMin = base.regenPerMin + level.regenPerMin * 0.1 (1 decimal precision).
//
// Notes:
//   • Costs still use the integer level (regenPerMin level count), but *effect* is decimal.
//   • Energy regen is applied on every /profile, /ms/*, and /battle/* route.
//   • pct has been split into ms_hit/ms_crit/ms_dodge columns (back-compatible shaping in /profile).

import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';

const { Pool } = pkg;

// ---------- Config ----------
const PORT = process.env.PORT || 10000;
const ORIGIN = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const REGEN_STEP = 0.1;                 // +0.1 energy/min per regen level
const COST = (lv) => 100 + 30 * lv;     // next upgrade cost at current level
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ---------- DB ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------- Fastify ----------
const app = Fastify({ logger: true });
await app.register(cors, { origin: ORIGIN.length ? ORIGIN : true });

// ---------- Helpers ----------
async function ensureProfile(wallet) {
  const q = `insert into player_profiles (wallet)
             values ($1)
             on conflict (wallet) do nothing`;
  await pool.query(q, [wallet]);
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

// Build ms_current from base + level (regen uses 0.1 step)
function recomputeCurrent(base, level) {
  const b = base || { health: 20, energyCap: 100, regenPerMin: 1 };
  const lv = level || { health: 0, energyCap: 0, regenPerMin: 0 };

  const health = (Number(b.health) || 0) + (Number(lv.health) || 0);
  const energyCap = (Number(b.energyCap) || 0) + (Number(lv.energyCap) || 0);

  const bRegen = Number(b.regenPerMin) || 0;
  const lvRegen = Number(lv.regenPerMin) || 0;
  const regenRaw = bRegen + lvRegen * REGEN_STEP;
  const regenPerMin = Number(regenRaw.toFixed(1)); // persist with 1 decimal

  return { health, energyCap, regenPerMin };
}

function toClient(p) {
  return {
    jetFuel: p.jet_fuel | 0,
    energy: p.energy | 0,
    energyCap: p.energy_cap | 0,
    ms: { base: p.ms_base, level: p.ms_level, current: p.ms_current },
    pct: { hit: p.ms_hit | 0, crit: p.ms_crit | 0, dodge: p.ms_dodge | 0 },
    unlockedLevel: p.unlocked_level | 0
  };
}

// Apply passive energy regen since last updated_at, using decimal regenPerMin
async function applyRegen(wallet, row) {
  const p = row || await getProfileRaw(wallet);
  if (!p) return null;

  // Always recompute current from levels to ensure latest 0.1 logic
  const current = recomputeCurrent(p.ms_base, p.ms_level);
  const cap = (Number(p.energy_cap) || current.energyCap || 100);
  const regenPerMin = Number(current.regenPerMin) || 0;

  const updatedAt = p.updated_at ? new Date(p.updated_at) : null;
  const now = new Date();

  let newEnergy = Number(p.energy) || 0;

  if (updatedAt && regenPerMin > 0) {
    const dtMs = now.getTime() - updatedAt.getTime();
    if (dtMs > 0) {
      const minutes = dtMs / 60000; // fractional minutes ok
      const gained = Math.floor(minutes * regenPerMin);
      if (gained > 0) {
        newEnergy = clamp(newEnergy + gained, 0, cap);
      }
    }
  }

  // Persist if anything changed (energy, cap, or ms_current shape)
  const curStr = JSON.stringify(p.ms_current || {});
  const nextStr = JSON.stringify(current);
  if (newEnergy !== (p.energy | 0) || cap !== (p.energy_cap | 0) || curStr !== nextStr) {
    const { rows } = await pool.query(
      `update player_profiles set
         energy      = $2,
         energy_cap  = $3,
         ms_current  = $4,
         updated_at  = now()
       where wallet = $1
       returning wallet, jet_fuel, energy, energy_cap, ms_base, ms_level, ms_current,
                 ms_hit, ms_crit, ms_dodge, unlocked_level, updated_at`,
      [wallet, newEnergy, cap, current]
    );
    return rows[0];
  }
  return p; // unchanged
}

// ---------- Routes ----------

// Session bootstrap (no X-Wallet header here)
app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) {
    return reply.code(400).send({ error: 'invalid address' });
  }
  await ensureProfile(address);
  return reply.send({ nonce: 'demo-nonce' });
});

// Require X-Wallet for all subsequent routes
app.addHook('onRequest', async (req, reply) => {
  if (req.raw.url === '/session/start') return;
  const w = req.headers['x-wallet'];
  if (!w || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(w)) {
    return reply.code(400).send({ error: 'missing X-Wallet' });
  }
  req.wallet = w;
});

// Profile (regen applied)
app.get('/profile', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;
  return reply.send(toClient(p));
});

// Costs (levels are integers; regen effect is computed from level * 0.1)
app.get('/ms/costs', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;

  const lv = p.ms_level || { health: 0, energyCap: 0, regenPerMin: 0 };

  const levels = {
    health: lv.health | 0,
    energyCap: lv.energyCap | 0,
    regenPerMin: lv.regenPerMin | 0, // integer level count
    hit: p.ms_hit | 0,
    crit: p.ms_crit | 0,
    dodge: p.ms_dodge | 0
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

// Apply upgrades (regenPerMin delta is number of *levels*; each level = +0.1/min)
app.post('/ms/upgrade', async (req, reply) => {
  const deltas = req.body || {};
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0; // regen before spending

  let jf = p.jet_fuel | 0;
  const applied = { health: 0, energyCap: 0, regenPerMin: 0, hit: 0, crit: 0, dodge: 0 };

  const lv = { ...(p.ms_level || { health: 0, energyCap: 0, regenPerMin: 0 }) };
  let h = p.ms_hit | 0, c = p.ms_crit | 0, d = p.ms_dodge | 0;

  function applyStat(key) {
    let want = Math.max(0, parseInt(deltas[key] || 0, 10));
    while (want > 0) {
      const curLv =
        key === 'hit' ? h :
        key === 'crit' ? c :
        key === 'dodge' ? d :
        (lv[key] | 0);

      const cost = COST(curLv);
      if (jf < cost) break;

      jf -= cost;
      applied[key]++;

      if (key === 'hit') h++;
      else if (key === 'crit') c++;
      else if (key === 'dodge') d++;
      else lv[key] = (lv[key] | 0) + 1;

      want--;
    }
  }

  ['health', 'energyCap', 'regenPerMin', 'hit', 'crit', 'dodge'].forEach(applyStat);

  const spent = (p.jet_fuel | 0) - jf;

  // Recompute current using 0.1 regen step
  const current = recomputeCurrent(p.ms_base, lv);
  const newCap = current.energyCap | 0;
  const newEnergy = clamp(p.energy | 0, 0, newCap);

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

  const prof = rows[0];
  return reply.send({ applied, spent, profile: toClient(prof) });
});

// Battle routes (regen applied before each; server-authoritative deductions)
app.post('/battle/start', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;

  const need = 10;
  if ((p.energy | 0) < need) return reply.code(400).send({ error: 'not enough energy' });

  const left = (p.energy | 0) - need;
  await pool.query(
    `update player_profiles
        set energy = $2, updated_at = now()
      where wallet = $1`,
    [req.wallet, left]
  );
  return reply.send({ ok: true, energy: left });
});

app.post('/battle/turn', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;

  const need = 1;
  if ((p.energy | 0) < need) return reply.code(400).send({ error: 'not enough energy' });

  const left = (p.energy | 0) - need;
  await pool.query(
    `update player_profiles
        set energy = $2, updated_at = now()
      where wallet = $1`,
    [req.wallet, left]
  );
  return reply.send({ ok: true, energy: left });
});

app.post('/battle/finish', async (req, reply) => {
  const body = req.body || {};
  const victory = !!body.victory;
  const wave = Math.max(1, parseInt(body.wave || 1, 10));
  const jfGain = Math.max(0, parseInt(body.jf || 0, 10));
  const energyReward = Math.max(0, parseInt(body.energyReward || 0, 10));

  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;

  const current = recomputeCurrent(p.ms_base, p.ms_level);
  const cap = current.energyCap | 0;

  const nextJF = (p.jet_fuel | 0) + jfGain;
  const nextEnergy = clamp((p.energy | 0) + energyReward, 0, cap);
  const nextUnlock = victory ? Math.max(p.unlocked_level | 0, wave) : (p.unlocked_level | 0);

  const { rows } = await pool.query(
    `update player_profiles set
       jet_fuel = $2,
       energy   = $3,
       unlocked_level = $4,
       ms_current = $5,
       energy_cap = $6,
       updated_at = now()
     where wallet = $1
     returning wallet, jet_fuel, energy, energy_cap, ms_base, ms_level, ms_current,
               ms_hit, ms_crit, ms_dodge, unlocked_level, updated_at`,
    [req.wallet, nextJF, nextEnergy, nextUnlock, current, cap]
  );

  const prof = rows[0];
  return reply.send({ ok: true, profile: toClient(prof) });
});

// ---------- Start ----------
app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`XRPixel Jets API listening on :${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
