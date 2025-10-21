// server/index.js
import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';

const { Pool } = pkg;

const PORT = process.env.PORT || 10000;
const ORIGIN = process.env.CORS_ORIGIN || '*';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Neon uses SSL; this keeps pg happy everywhere
});

const app = Fastify({ logger: true });
await app.register(cors, { origin: ORIGIN, credentials: false });

// ------------------ DB helpers ------------------
async function getProfile(wallet) {
  const { rows } = await pool.query('select * from player_profiles where wallet = $1', [wallet]);
  if (rows.length) return rows[0];

  // Create default on first touch
  const def = {
    wallet,
    jet_fuel: 100, // start players with 100 JF
    energy: 100,
    energy_cap: 100,
    ms_base: { health: 20, energyCap: 100, regenPerMin: 1 },
    ms_level: { health: 0, energyCap: 0, regenPerMin: 0 },
    ms_current: { health: 20, energyCap: 100, regenPerMin: 1 },
    pct: { hit: 0, crit: 10, dodge: 0 }, // crit starts at 10%
    unlocked_level: 5
  };
  await pool.query(
    `insert into player_profiles
     (wallet, jet_fuel, energy, energy_cap, ms_base, ms_level, ms_current, pct, unlocked_level)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [wallet, def.jet_fuel, def.energy, def.energy_cap, def.ms_base, def.ms_level, def.ms_current, def.pct, def.unlocked_level]
  );
  return def;
}

function toClient(p) {
  return {
    ms: { base: p.ms_base, level: p.ms_level, current: p.ms_current },
    pct: p.pct,
    jetFuel: p.jet_fuel,
    energy: p.energy,
    energyCap: p.energy_cap,
    unlockedLevel: p.unlocked_level
  };
}

async function saveProfile(wallet, patch) {
  const p = await getProfile(wallet);
  const merged = {
    jet_fuel: patch.jetFuel ?? p.jet_fuel,
    energy: patch.energy ?? p.energy,
    energy_cap: patch.energyCap ?? p.energy_cap,
    ms_base: patch.ms?.base ?? p.ms_base,
    ms_level: patch.ms?.level ?? p.ms_level,
    ms_current: patch.ms?.current ?? p.ms_current,
    pct: patch.pct ?? p.pct,
    unlocked_level: patch.unlockedLevel ?? p.unlocked_level
  };
  await pool.query(
    `update player_profiles
     set jet_fuel=$2, energy=$3, energy_cap=$4,
         ms_base=$5, ms_level=$6, ms_current=$7,
         pct=$8, unlocked_level=$9, updated_at=now()
     where wallet=$1`,
    [wallet, merged.jet_fuel, merged.energy, merged.energy_cap, merged.ms_base, merged.ms_level, merged.ms_current, merged.pct, merged.unlocked_level]
  );
  return merged;
}

// ------------------ Cost model (single source of truth) ------------------
// Level 0 => 100 JF, grows +30 per level (tune anytime; client mirrors this)
function costOf(stat, level) {
  const base = 100;
  const step = 30;
  return base + step * level;
}

// Convert pct JSON to level counters (hit: level==pct; crit: level==pct-10; dodge: level==pct)
function derivePctLevels(pct) {
  return {
    hit: Math.max(0, Number(pct?.hit ?? 0)),
    crit: Math.max(0, Number((pct?.crit ?? 10) - 10)),
    dodge: Math.max(0, Number(pct?.dodge ?? 0))
  };
}

// ------------------ Routes ------------------
app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) {
    return reply.code(400).send({ error: 'invalid address' });
  }
  await getProfile(address); // ensure row exists
  return reply.send({ nonce: 'demo-nonce' }); // keeping it simple for now
});

app.get('/profile', async (req, reply) => {
  const address = req.headers['x-wallet'];
  if (!address) return reply.code(400).send({ error: 'no address' });
  const p = await getProfile(address);
  return reply.send(toClient(p));
});

// Authoritative next-costs (per stat), based on current levels
app.get('/ms/costs', async (req, reply) => {
  const address = req.headers['x-wallet'];
  if (!address) return reply.code(400).send({ error: 'no address' });

  const p = await getProfile(address);
  const L = p.ms_level || { health: 0, energyCap: 0, regenPerMin: 0 };
  const pctLevels = derivePctLevels(p.pct);

  const levels = {
    health: L.health || 0,
    energyCap: L.energyCap || 0,
    regenPerMin: L.regenPerMin || 0,
    hit: pctLevels.hit,
    crit: pctLevels.crit,
    dodge: pctLevels.dodge
  };

  const costs = {
    health: costOf('health', levels.health),
    energyCap: costOf('energyCap', levels.energyCap),
    regenPerMin: costOf('regenPerMin', levels.regenPerMin),
    hit: costOf('hit', levels.hit),
    crit: costOf('crit', levels.crit),
    dodge: costOf('dodge', levels.dodge)
  };

  return reply.send({ levels, costs, pct: p.pct });
});

// Apply queued upgrades with cost checks and clamps
app.post('/ms/upgrade', async (req, reply) => {
  const address = req.headers['x-wallet'];
  if (!address) return reply.code(400).send({ error: 'no address' });

  const ops = req.body || {};
  const p = await getProfile(address);

  const levels = { ...(p.ms_level || {}) };
  const pctLevels = derivePctLevels(p.pct || {});

  let spent = 0;
  const applied = {};

  const keys = ['health', 'energyCap', 'regenPerMin', 'hit', 'crit', 'dodge'];

  for (const key of keys) {
    const inc = Math.max(0, parseInt(ops[key] || 0, 10));
    for (let i = 0; i < inc; i++) {
      const lv =
        key === 'hit' || key === 'crit' || key === 'dodge'
          ? pctLevels[key]
          : (levels[key] || 0);

      const c = costOf(key, lv);
      if (p.jet_fuel - spent < c) break;

      if (key === 'hit' || key === 'crit' || key === 'dodge') {
        pctLevels[key] += 1;
      } else {
        levels[key] = lv + 1;
      }
      spent += c;
      applied[key] = (applied[key] || 0) + 1;
    }
  }

  if (!spent) {
    const need = costOf('health', levels.health || 0); // example min cost
    return reply.code(400).send({ error: 'insufficient JetFuel', need, have: p.jet_fuel });
  }

  // Recompute derived current
  const base = { ...p.ms_base };
  const cur = { ...p.ms_current };

  const capRegen = 5;      // per min
  const capEnergy = 450;   // absolute cap
  const maxDodge = 33;     // %

  cur.health = Math.min(base.health + (levels.health || 0) * 1, 9999);
  cur.energyCap = Math.min(base.energyCap + (levels.energyCap || 0) * 2, capEnergy);
  cur.regenPerMin = Math.min(base.regenPerMin + (levels.regenPerMin || 0) * 0.1, capRegen);

  const pct = { ...p.pct };
  pct.hit = (pct.hit || 0) + (applied.hit || 0);
  pct.crit = (pct.crit || 10) + (applied.crit || 0); // crit starts at 10%
  pct.dodge = Math.min(maxDodge, (pct.dodge || 0) + (applied.dodge || 0));

  const newEnergy = Math.min(p.energy, cur.energyCap);

  const merged = await saveProfile(address, {
    jetFuel: p.jet_fuel - spent,
    energy: newEnergy,
    energyCap: cur.energyCap,
    ms: { base, level: levels, current: cur },
    pct
  });

  return reply.send({
    applied,
    spent,
    profile: toClient({ ...merged, wallet: address })
  });
});

// Battle
app.post('/battle/start', async (req, reply) => {
  const address = req.headers['x-wallet'];
  if (!address) return reply.code(400).send({ error: 'no address' });
  const p = await getProfile(address);
  if (p.energy < 10) return reply.code(400).send({ error: 'insufficient energy', need: 10, have: p.energy });

  const merged = await saveProfile(address, {
    energy: p.energy - 10,
    energyCap: p.energy_cap,
    ms: { base: p.ms_base, level: p.ms_level, current: p.ms_current },
    pct: p.pct,
    unlockedLevel: p.unlocked_level
  });
  return reply.send({ ok: true, energy: merged.energy });
});

app.post('/battle/turn', async (req, reply) => {
  const address = req.headers['x-wallet'];
  if (!address) return reply.code(400).send({ error: 'no address' });
  const p = await getProfile(address);
  if (p.energy <= 0) return reply.code(400).send({ error: 'out of energy' });

  const merged = await saveProfile(address, {
    energy: Math.max(0, p.energy - 1),
    energyCap: p.energy_cap,
    ms: { base: p.ms_base, level: p.ms_level, current: p.ms_current },
    pct: p.pct,
    unlockedLevel: p.unlocked_level
  });
  return reply.send({ ok: true, energy: merged.energy });
});

app.post('/battle/finish', async (req, reply) => {
  const address = req.headers['x-wallet'];
  if (!address) return reply.code(400).send({ error: 'no address' });

  const { victory, wave, jf, energyReward } = req.body || {};
  const p = await getProfile(address);
  const nextUnlocked = victory ? Math.max(p.unlocked_level, wave || p.unlocked_level) : p.unlocked_level;

  const merged = await saveProfile(address, {
    jetFuel: p.jet_fuel + Math.max(0, parseInt(jf || 0, 10)),
    energy: Math.min(p.energy + Math.max(0, parseInt(energyReward || 0, 10)), p.energy_cap),
    energyCap: p.energy_cap,
    ms: { base: p.ms_base, level: p.ms_level, current: p.ms_current },
    pct: p.pct,
    unlockedLevel: nextUnlocked
  });

  return reply.send({ ok: true, profile: toClient({ ...merged, wallet: address }) });
});

app.listen({ port: PORT, host: '0.0.0.0' }, () => {
  console.log('API on', PORT);
});
