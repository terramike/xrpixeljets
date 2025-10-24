// server/index.js — XRPixel Jets MKG (2025-10-23 JFUEL wired)
// Features:
//  - Startup migrations (safe): adds last_claim_at and ms_hit/ms_crit/ms_dodge if missing
//  - Regen upgrade costs +50% (still base 100)
//  - Session/Profile/MS costs & upgrades
//  - Battle start/turn/finish energy accounting (matches baseline)
//  - JFUEL claim: POST /claim/start (uses ./claimJetFuel.js)
//  - JFUEL import: POST /import/onchain (simple balance import — see notes)
//
// Requirements:
//  - ENV: DATABASE_URL, CORS_ORIGIN, ISSUER_ADDR, CURRENCY_CODE, XRPL_WSS, HOT_SEED, CLAIM_COOLDOWN_HOURS
//  - Node 18+ (global fetch). If Node <18, uncomment next line & add dep:
//      import fetch from 'node-fetch';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';
import * as claim from './claimJetFuel.js';

const { Pool } = pkg;

const PORT = process.env.PORT || 10000;
const ORIGIN =
  (process.env.CORS_ORIGIN || '*')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const app = Fastify({ logger: true });

await app.register(cors, { origin: ORIGIN.length ? ORIGIN : true });

// ----------------------- DB -----------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Startup migrations (idempotent)
await pool.query(`
  alter table if not exists player_profiles
    add column if not exists last_claim_at timestamptz;

  -- add stat columns if not present (we'll mirror pct jsonb if you used it before)
  do $$
  begin
    if not exists(
      select 1 from information_schema.columns
      where table_name='player_profiles' and column_name='ms_hit'
    ) then
      alter table player_profiles add column ms_hit integer not null default 0;
    end if;
    if not exists(
      select 1 from information_schema.columns
      where table_name='player_profiles' and column_name='ms_crit'
    ) then
      alter table player_profiles add column ms_crit integer not null default 10;
    end if;
    if not exists(
      select 1 from information_schema.columns
      where table_name='player_profiles' and column_name='ms_dodge'
    ) then
      alter table player_profiles add column ms_dodge integer not null default 0;
    end if;
  end$$;
`);

// --------------------- Helpers --------------------
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const isClassic = (a) => /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test((a || '').trim());

// Cost model
const BASE_COST = (lv) => 100 + 30 * lv;
// regen +50%
const COST_FOR = (stat, lv) => stat === 'regenPerMin'
  ? Math.round(BASE_COST(lv) * 1.5)
  : BASE_COST(lv);

// Ensure profile exists
async function ensureProfile(wallet) {
  await pool.query(
    `insert into player_profiles (wallet)
     values ($1)
     on conflict (wallet) do nothing`,
    [wallet]
  );
}

async function getProfileRow(wallet) {
  const { rows } = await pool.query(
    `select wallet, jet_fuel, energy, energy_cap,
            ms_base, ms_level, ms_current,
            ms_hit, ms_crit, ms_dodge,
            unlocked_level, last_claim_at, updated_at, created_at
       from player_profiles where wallet = $1`,
    [wallet]
  );
  return rows[0] || null;
}

function recomputeCurrent(base, level) {
  const b = base || { health: 20, energyCap: 100, regenPerMin: 1 };
  const lv = level || { health: 0, energyCap: 0, regenPerMin: 0 };
  return {
    health: (b.health | 0) + (lv.health | 0),
    energyCap: (b.energyCap | 0) + (lv.energyCap | 0),
    regenPerMin: (b.regenPerMin | 0) + (lv.regenPerMin | 0),
  };
}

function toClient(row) {
  return {
    jetFuel: row.jet_fuel | 0,
    energy: row.energy | 0,
    energyCap: row.energy_cap | 0,
    ms: { base: row.ms_base, level: row.ms_level, current: row.ms_current },
    pct: { hit: row.ms_hit | 0, crit: row.ms_crit | 0, dodge: row.ms_dodge | 0 },
    unlockedLevel: row.unlocked_level | 0,
  };
}

// Regen on read (server-authoritative tick)
async function applyRegen(wallet, rowIn) {
  const row = rowIn || await getProfileRow(wallet);
  if (!row) return null;

  const current = recomputeCurrent(row.ms_base, row.ms_level);
  const cap = (row.energy_cap | 0) || (current.energyCap | 0) || 100;
  const regen = current.regenPerMin | 0;

  let newEnergy = row.energy | 0;

  const updatedAt = row.updated_at ? new Date(row.updated_at) : null;
  const now = new Date();
  if (updatedAt && regen > 0) {
    const dtMs = now.getTime() - updatedAt.getTime();
    if (dtMs > 0) {
      const minutes = dtMs / 60000;
      const gained = Math.floor(minutes * regen);
      if (gained > 0) newEnergy = clamp(newEnergy + gained, 0, cap);
    }
  }

  const needsSave =
    newEnergy !== (row.energy | 0) ||
    (row.energy_cap | 0) !== cap ||
    JSON.stringify(row.ms_current || {}) !== JSON.stringify(current);

  if (!needsSave) return row;

  const { rows } = await pool.query(
    `update player_profiles
        set energy = $2,
            energy_cap = $3,
            ms_current = $4,
            updated_at = now()
      where wallet = $1
      returning wallet, jet_fuel, energy, energy_cap, ms_base, ms_level, ms_current,
                ms_hit, ms_crit, ms_dodge, unlocked_level, last_claim_at, updated_at`,
    [wallet, newEnergy, cap, current]
  );
  return rows[0];
}

// --------------------- Hooks ----------------------
app.addHook('onRequest', async (req, reply) => {
  // allow /session/start without wallet
  if (req.raw.url === '/session/start') return;
  const w = req.headers['x-wallet'];
  if (!w || !isClassic(w)) {
    return reply.code(400).send({ error: 'missing X-Wallet' });
  }
  req.wallet = w;
});

// ---------------------- Routes --------------------

// Session bootstrap – create/ensure a profile
app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!isClassic(address)) return reply.code(400).send({ error: 'invalid address' });
  await ensureProfile(address);
  return reply.send({ nonce: 'demo-nonce' });
});

// Read profile (applies regen)
app.get('/profile', async (req, reply) => {
  const p0 = await getProfileRow(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;
  return reply.send(toClient(p));
});

// Get mothership costs (+50% regen)
app.get('/ms/costs', async (req, reply) => {
  const p0 = await getProfileRow(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;

  const lv = p.ms_level || { health: 0, energyCap: 0, regenPerMin: 0 };
  const out = {
    levels: {
      health: lv.health | 0,
      energyCap: lv.energyCap | 0,
      regenPerMin: lv.regenPerMin | 0,
      hit: p.ms_hit | 0,
      crit: p.ms_crit | 0,
      dodge: p.ms_dodge | 0
    },
    costs: {
      health: COST_FOR('health', lv.health | 0),
      energyCap: COST_FOR('energyCap', lv.energyCap | 0),
      regenPerMin: COST_FOR('regenPerMin', lv.regenPerMin | 0),
      hit: COST_FOR('hit', p.ms_hit | 0),
      crit: COST_FOR('crit', p.ms_crit | 0),
      dodge: COST_FOR('dodge', p.ms_dodge | 0)
    }
  };
  return reply.send(out);
});

// Apply queued upgrades (server-authoritative)
app.post('/ms/upgrade', async (req, reply) => {
  const deltas = req.body || {};
  const p0 = await getProfileRow(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;

  let jf = p.jet_fuel | 0;

  const applied = { health: 0, energyCap: 0, regenPerMin: 0, hit: 0, crit: 0, dodge: 0 };
  const lv = { ...(p.ms_level || { health: 0, energyCap: 0, regenPerMin: 0 }) };
  let hit = p.ms_hit | 0, crit = p.ms_crit | 0, dodge = p.ms_dodge | 0;

  function applyStat(key) {
    let want = Math.max(0, parseInt(deltas[key] || 0, 10));
    while (want > 0) {
      const curLv = (key === 'hit') ? hit : (key === 'crit') ? crit : (key === 'dodge') ? dodge : (lv[key] | 0);
      const cost = COST_FOR(key, curLv);
      if (jf < cost) break;
      jf -= cost;
      applied[key]++;

      if (key === 'hit') hit++;
      else if (key === 'crit') crit++;
      else if (key === 'dodge') dodge++;
      else lv[key] = (lv[key] | 0) + 1;

      want--;
    }
  }

  ['health', 'energyCap', 'regenPerMin', 'hit', 'crit', 'dodge'].forEach(applyStat);

  const spent = (p.jet_fuel | 0) - jf;

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
               ms_hit, ms_crit, ms_dodge, unlocked_level, last_claim_at, updated_at`,
    [req.wallet, jf, lv, current, newCap, newEnergy, hit, crit, dodge]
  );

  return reply.send({ applied, spent, profile: toClient(rows[0]) });
});

// Battle endpoints (minimal energy logic consistent with baseline)
app.post('/battle/start', async (req, reply) => {
  const p0 = await getProfileRow(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;

  if ((p.energy | 0) < 10) return reply.code(400).send({ error: 'not_enough_energy' });

  const { rows } = await pool.query(
    `update player_profiles set energy = energy - 10, updated_at = now()
       where wallet = $1
       returning energy`,
    [req.wallet]
  );
  return reply.send({ ok: true, energy: rows[0].energy | 0 });
});

app.post('/battle/turn', async (req, reply) => {
  const p0 = await getProfileRow(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  const p = await applyRegen(req.wallet, p0) || p0;

  if ((p.energy | 0) < 1) return reply.code(400).send({ error: 'not_enough_energy' });

  const { rows } = await pool.query(
    `update player_profiles set energy = energy - 1, updated_at = now()
       where wallet = $1
       returning energy`,
    [req.wallet]
  );
  return reply.send({ ok: true, energy: rows[0].energy | 0 });
});

app.post('/battle/finish', async (req, reply) => {
  // Body may contain: { victory, wave, jf, energyReward }
  const { victory, jf = 0, energyReward = 0 } = req.body || {};
  const p0 = await getProfileRow(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not found' });
  await applyRegen(req.wallet, p0); // settle regen before credit

  const { rows } = await pool.query(
    `update player_profiles
        set jet_fuel = jet_fuel + $2,
            energy   = least(energy_cap, energy + $3),
            updated_at = now()
      where wallet = $1
      returning wallet, jet_fuel, energy, energy_cap, ms_base, ms_level, ms_current,
                ms_hit, ms_crit, ms_dodge, unlocked_level, last_claim_at, updated_at`,
    [req.wallet, Math.max(0, jf | 0), Math.max(0, energyReward | 0)]
  );
  return reply.send({ ok: true, profile: toClient(rows[0]) });
});

// --------- Claim JetFuel (on-chain) ----------
const COOLDOWN_HOURS = Number(process.env.CLAIM_COOLDOWN_HOURS || 24);

app.post('/claim/start', async (req, reply) => {
  const { amount } = req.body || {};
  const amt = Math.max(0, parseInt(amount || 0, 10));
  if (!amt) return reply.code(400).send({ error: 'amount_required' });

  const p0 = await getProfileRow(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });

  // cooldown
  const now = new Date();
  if (p0.last_claim_at) {
    const next = new Date(new Date(p0.last_claim_at).getTime() + COOLDOWN_HOURS * 3600 * 1000);
    if (now < next) {
      const secs = Math.ceil((next.getTime() - now.getTime()) / 1000);
      return reply.code(429).send({ error: 'cooldown', seconds: secs });
    }
  }

  // balance check
  if ((p0.jet_fuel | 0) < amt) return reply.code(400).send({ error: 'insufficient_jet_fuel' });

  try {
    const txid = await claim.sendJetFuel(req.wallet, amt);
    // deduct on success
    const { rows } = await pool.query(
      `update player_profiles
         set jet_fuel = jet_fuel - $2,
             last_claim_at = now(),
             updated_at = now()
       where wallet = $1
       returning wallet, jet_fuel, energy, energy_cap, ms_base, ms_level, ms_current,
                 ms_hit, ms_crit, ms_dodge, unlocked_level, last_claim_at, updated_at`,
      [req.wallet, amt]
    );
    return reply.send({ ok: true, txid, profile: toClient(rows[0]) });
  } catch (e) {
    req.log.error({ err: e }, 'claim send failed');
    return reply.code(502).send({ error: 'send_failed', message: e.message || String(e) });
  }
});

// --------- Import on-chain JFUEL into off-chain balance ----------
// NOTE: Convenience import. It trusts the current on-chain balance and credits off-chain.
// For production economics, consider "burn-for-credit" instead.
app.post('/import/onchain', async (req, reply) => {
  const wallet = req.wallet;
  const ISSUER = process.env.ISSUER_ADDR;
  const CODE = (process.env.CURRENCY_CODE || 'JFUEL').toUpperCase();
  if (!ISSUER) return reply.code(500).send({ error: 'server_misconfig', message: 'ISSUER_ADDR missing' });

  const p0 = await getProfileRow(wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });
  await applyRegen(wallet, p0);

  try {
    const rpc = process.env.XRPL_RPC_HTTP || 'https://s1.ripple.com:51234/';
    const r = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'account_lines', params: [{ account: wallet }] })
    });
    const j = await r.json();
    const lines = j?.result?.lines || [];

    // Prefer exact issuer + CODE match, fallback to hex currency includes
    let line = lines.find(l => l.account === ISSUER && l.currency === CODE);
    if (!line) line = lines.find(l => l.account === ISSUER && (l.currency || '').toUpperCase().includes(CODE));

    const onchain = line ? Number(line.balance || 0) : 0;
    const importAmt = Math.floor(onchain); // off-chain uses integer JF
    if (!importAmt) return reply.send({ ok: false, message: 'no_onchain_balance' });

    const { rows } = await pool.query(
      `update player_profiles
         set jet_fuel = jet_fuel + $2,
             updated_at = now()
       where wallet = $1
       returning wallet, jet_fuel, energy, energy_cap, ms_base, ms_level, ms_current,
                 ms_hit, ms_crit, ms_dodge, unlocked_level, last_claim_at, updated_at`,
      [wallet, importAmt]
    );

    return reply.send({ ok: true, imported: importAmt, profile: toClient(rows[0]) });
  } catch (e) {
    req.log.error({ err: e }, 'onchain import failed');
    return reply.code(502).send({ ok: false, error: 'import_failed', message: e.message || String(e) });
  }
});

// ------------------- Boot ------------------------
app.listen({ port: PORT, host: '0.0.0.0' }, (err, addr) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Server listening at ${addr}`);
});
