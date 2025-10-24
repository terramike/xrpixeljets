// server/index.js — XRPixel Jets MKG (2025-10-23-jf-claim+regen50)
// Adds: JETFUEL claim endpoint with cooldown, regen upgrade cost +50%,
// and startup migration for last_claim_at. Integrates claimJetFuel module.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';
import * as claim from './claimJetFuel.js';

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

// ---------- Startup migration ----------
await pool.query(`
  alter table if not exists player_profiles
  add column if not exists last_claim_at timestamptz
`);

// ---------- Helpers ----------
const BASE_COST = (lv) => 100 + 30 * lv;
// regen only = +50% (still starts at 100)
const COST_FOR = (stat, lv) => stat === 'regenPerMin'
  ? Math.round(BASE_COST(lv) * 1.5)
  : BASE_COST(lv);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

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

async function applyRegen(wallet, row) {
  const p = row || await getProfileRaw(wallet);
  if (!p) return null;

  const cur = recomputeCurrent(p.ms_base, p.ms_level);
  const cap = (p.energy_cap|0) || (cur.energyCap|0) || 100;
  const regenPerMin = cur.regenPerMin|0;

  const updatedAt = p.updated_at ? new Date(p.updated_at) : null;
  const now = new Date();
  let newEnergy = p.energy|0;

  if (updatedAt && regenPerMin > 0) {
    const dtMs = now.getTime() - updatedAt.getTime();
    if (dtMs > 0) {
      const minutes = dtMs / 60000;
      const gained = Math.floor(minutes * regenPerMin);
      if (gained > 0) {
        newEnergy = clamp(newEnergy + gained, 0, cap);
      }
    }
  }

  if (newEnergy !== (p.energy|0)) {
    const { rows } = await pool.query(
      `update player_profiles set energy = $2, energy_cap = $3, ms_current = $4, updated_at = now()
         where wallet = $1
       returning wallet, jet_fuel, energy, energy_cap, ms_base, ms_level, ms_current,
                 ms_hit, ms_crit, ms_dodge, unlocked_level, last_claim_at, updated_at`,
      [wallet, newEnergy, cap, cur]
    );
    return rows[0];
  }
  if ((cap !== (p.energy_cap|0)) || JSON.stringify(p.ms_current||{}) !== JSON.stringify(cur)) {
    const { rows } = await pool.query(
      `update player_profiles set energy_cap = $2, ms_current = $3, updated_at = updated_at where wallet = $1
       returning wallet, jet_fuel, energy, energy_cap, ms_base, ms_level, ms_current,
                 ms_hit, ms_crit, ms_dodge, unlocked_level, last_claim_at, updated_at`,
      [wallet, cap, cur]
    );
    return rows[0];
  }
  return p;
}

// ---------- Routes ----------
app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) {
    return reply.code(400).send({ error: 'invalid address' });
  }
  await ensureProfile(address);
  return reply.send({ nonce: 'demo-nonce' });
});

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
      health: COST_FOR('health', lv.health|0),
      energyCap: COST_FOR('energyCap', lv.energyCap|0),
      regenPerMin: COST_FOR('regenPerMin', lv.regenPerMin|0),
      hit: COST_FOR('hit', p.ms_hit|0),
      crit: COST_FOR('crit', p.ms_crit|0),
      dodge: COST_FOR('dodge', p.ms_dodge|0)
    }
  };
  return reply.send(out);
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
      const curLv = (key === 'hit') ? h : (key === 'crit') ? c : (key === 'dodge') ? d : (lv[key]|0);
      const cost = COST_FOR(key, curLv);
      if (jf < cost) break;
      jf -= cost;
      applied[key]++;
      if (key === 'hit') h++; else if (key === 'crit') c++; else if (key === 'dodge') d++; else lv[key] = (lv[key]|0) + 1;
      want--;
    }
  }

  ['health','energyCap','regenPerMin','hit','crit','dodge'].forEach(applyStat);

  const spent = (p.jet_fuel|0) - jf;

  const current = recomputeCurrent(p.ms_base, lv);
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
               ms_hit, ms_crit, ms_dodge, unlocked_level, last_claim_at, updated_at`,
    [req.wallet, jf, lv, current, newCap, newEnergy, h, c, d]
  );

  const prof = rows[0];
  return reply.send({ applied, spent, profile: toClient(prof) });
});

// --------- Claim JetFuel (on-chain) ----------
const COOLDOWN_HOURS = Number(process.env.CLAIM_COOLDOWN_HOURS || 24);

app.post('/claim/start', async (req, reply) => {
  const { amount } = req.body || {};
  const dest = req.wallet; // send to the wallet in header

  const amt = Math.max(0, parseInt(amount||0, 10));
  if (!amt) return reply.code(400).send({ error: 'amount required' });

  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });

  // cooldown check
  const now = new Date();
  if (p0.last_claim_at) {
    const next = new Date(p0.last_claim_at.getTime() + COOLDOWN_HOURS*3600*1000);
    if (now < next) {
      const secs = Math.ceil((next.getTime() - now.getTime())/1000);
      return reply.code(429).send({ error: 'cooldown', seconds: secs });
    }
  }

  // balance check
  const bal = p0.jet_fuel|0;
  if (bal < amt) return reply.code(400).send({ error: 'insufficient jet_fuel' });

  // attempt XRPL send first
  try {
    const txid = await claim.sendJetFuel(dest, amt);
    // on success, deduct + set last_claim_at
    const { rows } = await pool.query(
      `update player_profiles
         set jet_fuel = jet_fuel - $2,
             last_claim_at = now(),
             updated_at = now()
       where wallet = $1
       returning wallet, jet_fuel, energy, energy_cap, ms_base, ms_level, ms_current,
                 ms_hit, ms_crit, ms_dodge, unlocked_level, last_claim_at`,
      [req.wallet, amt]
    );
    return reply.send({ ok:true, txid, profile: toClient(rows[0]) });
  } catch (e) {
    req.log.error({ err:e }, 'claim send failed');
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
