import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'crypto';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: (origin, cb)=>{
    const allowed = ['https://mykeygo.io','https://www.mykeygo.io','http://localhost:8000'];
    if (!origin || allowed.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed'), false);
  }
});

const SESSIONS = new Map();
const PROFILES = new Map();

function now(){ return Date.now(); }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

function defaultProfile(address){
  return {
    address,
    jetFuel: 100,
    energy: 100,
    energyCap: 100,
    regenPerMin: 1.0,
    ms: {
      base:{ health:20, energyCap:100, regenPerMin:1.0, hit:0, crit:10, dodge:0 }, // base crit 10%
      level:{ health:0, energyCap:0, regenPerMin:0, hit:0, crit:0, dodge:0 }
    },
    unlockedLevel: 5,
    lastEnergyAt: now(),
  };
}

function msFromProfile(p){
  // +1 HP, +2 cap, +0.1 regen, +1% hit/crit/dodge per level
  const health      = p.ms.base.health      + p.ms.level.health * 1;
  const energyCap   = p.ms.base.energyCap   + p.ms.level.energyCap * 2;
  const regenPerMin = Math.min(5.0, p.ms.base.regenPerMin + p.ms.level.regenPerMin * 0.1);
  const hit         = Math.min(p.ms.base.hit   + 15,  p.ms.base.hit   + p.ms.level.hit   * 1); // cap +15%
  const crit        = Math.min(p.ms.base.crit  + 25,  p.ms.base.crit  + p.ms.level.crit  * 1); // cap +25%
  const dodge       = Math.min(p.ms.base.dodge + 15,  p.ms.base.dodge + p.ms.level.dodge * 1); // cap +15%
  return { base: p.ms.base, level: p.ms.level, current: { health, energyCap, regenPerMin, hit, crit, dodge } };
}

// server-time regen
function applyRegen(p){
  const dt = Math.floor((now() - p.lastEnergyAt) / 1000);
  if (dt > 0){
    const perSec = (p.regenPerMin || 0) / 60;
    const gained = Math.floor(perSec * dt);
    if (gained > 0) p.energy = clamp(p.energy + gained, 0, p.energyCap);
  }
  p.lastEnergyAt = now();
}

async function verifySig({address, nonce/*, sig*/}) {
  const s = SESSIONS.get(address);
  if (!s || s.nonce !== nonce) return false;
  return true; // TODO: XRPL signature verification
}

app.post('/session/start', async (req, reply)=>{
  const { address } = req.body || {};
  if (!address) return reply.code(400).send({ error: 'address required' });
  const nonce = randomUUID();
  SESSIONS.set(address, { nonce, at: now() });
  if (!PROFILES.has(address)) PROFILES.set(address, defaultProfile(address));
  return reply.send({ nonce, serverTime: new Date().toUTCString() });
});

app.get('/profile', async (req, reply)=>{
  const { address } = req.query || {};
  if (!address) return reply.code(400).send({ error: 'address required' });
  const p = PROFILES.get(address) || defaultProfile(address);
  const msNow = msFromProfile(p).current;
  p.energyCap   = msNow.energyCap;
  p.regenPerMin = msNow.regenPerMin;
  applyRegen(p);
  PROFILES.set(address, p);
  return reply.send({
    address, jetFuel:p.jetFuel, energy:p.energy, energyCap:p.energyCap, regenPerMin:p.regenPerMin,
    unlockedLevel:p.unlockedLevel, ms: msFromProfile(p)
  });
});

// Upgrade costs
function stepCost(stat, lv){
  // cheaper first 3 levels; quadratic afterwards
  const easy={health:6,energyCap:8,regenPerMin:10, hit:8, crit:10, dodge:8};
  const base={health:10,energyCap:12,regenPerMin:15, hit:12, crit:14, dodge:12};
  const k=lv<3?easy:base; return k[stat]*(lv+1)*(lv+1);
}

app.post('/ms/upgrade', async (req, reply)=>{
  const { address, nonce, sig, ops } = req.body || {};
  if (!address || !ops) return reply.code(400).send({ error: 'address and ops required' });
  if (!(await verifySig({address, nonce, sig}))) return reply.code(401).send({ error: 'bad signature/nonce' });

  const p = PROFILES.get(address) || defaultProfile(address);

  // Derived & regen sync first
  const msNow = msFromProfile(p).current;
  p.energyCap   = msNow.energyCap;
  p.regenPerMin = msNow.regenPerMin;
  applyRegen(p);

  const want = {
    health:      Math.max(0, Math.floor(ops.health||0)),
    energyCap:   Math.max(0, Math.floor(ops.energyCap||0)),
    regenPerMin: Math.max(0, Math.floor(ops.regenPerMin||0)),
    hit:         Math.max(0, Math.floor(ops.hit||0)),
    crit:        Math.max(0, Math.floor(ops.crit||0)),
    dodge:       Math.max(0, Math.floor(ops.dodge||0)),
  };

  // Caps
  const caps = {
    maxHealth:    p.ms.base.health + 40,
    maxEnergyCap: p.ms.base.energyCap + 200,
    maxRegen:     5.0,
    maxHit:       p.ms.base.hit   + 15,
    maxCrit:      p.ms.base.crit  + 25,
    maxDodge:     p.ms.base.dodge + 15
  };
  const cur = msNow;

  const room = {
    health:      Math.max(0, Math.floor((caps.maxHealth    - cur.health)     / 1)),
    energyCap:   Math.max(0, Math.floor((caps.maxEnergyCap - cur.energyCap)  / 2)),
    regenPerMin: Math.max(0, Math.floor(((caps.maxRegen    - cur.regenPerMin)+1e-9) / 0.1)),
    hit:         Math.max(0, caps.maxHit  - cur.hit),
    crit:        Math.max(0, caps.maxCrit - cur.crit),
    dodge:       Math.max(0, caps.maxDodge- cur.dodge),
  };

  const eff = {
    health:      Math.min(want.health,      room.health),
    energyCap:   Math.min(want.energyCap,   room.energyCap),
    regenPerMin: Math.min(want.regenPerMin, room.regenPerMin),
    hit:         Math.min(want.hit,         room.hit),
    crit:        Math.min(want.crit,        room.crit),
    dodge:       Math.min(want.dodge,       room.dodge),
  };

  let cost=0;
  for(let i=0;i<eff.health;i++)      cost+=stepCost('health',      p.ms.level.health      + i);
  for(let i=0;i<eff.energyCap;i++)   cost+=stepCost('energyCap',   p.ms.level.energyCap   + i);
  for(let i=0;i<eff.regenPerMin;i++) cost+=stepCost('regenPerMin', p.ms.level.regenPerMin + i);
  for(let i=0;i<eff.hit;i++)         cost+=stepCost('hit',         p.ms.level.hit         + i);
  for(let i=0;i<eff.crit;i++)        cost+=stepCost('crit',        p.ms.level.crit        + i);
  for(let i=0;i<eff.dodge;i++)       cost+=stepCost('dodge',       p.ms.level.dodge       + i);

  if (cost === 0){
    return reply.send({ applied: eff, cost: 0, profile: await profileOut(address) });
  }
  if (p.jetFuel < cost) return reply.code(400).send({ error: 'insufficient JetFuel', need: cost, have: p.jetFuel });

  // Apply
  p.jetFuel -= cost;
  p.ms.level.health      += eff.health;
  p.ms.level.energyCap   += eff.energyCap;
  p.ms.level.regenPerMin += eff.regenPerMin;
  p.ms.level.hit         += eff.hit;
  p.ms.level.crit        += eff.crit;
  p.ms.level.dodge       += eff.dodge;

  // Recompute derived & clamp
  const after = msFromProfile(p).current;
  p.energyCap   = after.energyCap;
  p.regenPerMin = after.regenPerMin;
  p.energy      = clamp(p.energy, 0, p.energyCap);
  p.lastEnergyAt = now();

  PROFILES.set(address, p);
  return reply.send({ applied: eff, cost, profile: await profileOut(address) });
});

// Reserve 10 at start
app.post('/battle/start', async (req, reply)=>{
  const { address, nonce, sig } = req.body || {};
  if (!address) return reply.code(400).send({ error:'address required' });
  if (!(await verifySig({address, nonce, sig}))) return reply.code(401).send({ error:'bad signature/nonce' });

  const p = PROFILES.get(address) || defaultProfile(address);
  const msNow = msFromProfile(p).current;
  p.energyCap   = msNow.energyCap;
  p.regenPerMin = msNow.regenPerMin;

  if (p.energy < 10) return reply.code(400).send({ error:'insufficient energy', need:10, have:p.energy });

  p.energy -= 10;
  p.lastEnergyAt = now(); // freeze regen during battle
  PROFILES.set(address, p);

  return reply.send({ ok:true, profile: await profileOut(address) });
});

// Finish: charge turns; add bonus; resume regen
app.post('/battle/finish', async (req, reply)=>{
  const { address, nonce, sig, missionLevel, result } = req.body || {};
  if (!address || !missionLevel || !result) return reply.code(400).send({ error:'bad payload' });
  if (!(await verifySig({address, nonce, sig}))) return reply.code(401).send({ error: 'bad signature/nonce' });

  const p = PROFILES.get(address) || defaultProfile(address);

  const msNow = msFromProfile(p).current;
  p.energyCap   = msNow.energyCap;
  p.regenPerMin = msNow.regenPerMin;

  const turns = clamp(parseInt(result.turns||0,10), 0, 200);
  if (p.energy < turns){ return reply.code(400).send({ error:'insufficient energy for turns', need: turns, have: p.energy }); }
  p.energy -= turns;

  const base5 = [100,150,200,250,300];
  function rewardFor(level){ return (level<=5)? base5[level-1] : Math.round(base5[4]*Math.pow(1.01, level-5)); }

  let granted = 0;
  if (result.win){
    granted = rewardFor(parseInt(missionLevel,10));
    if (p.unlockedLevel <= missionLevel) p.unlockedLevel = missionLevel + 1;
  }
  const bonus = clamp(parseInt(result.bonus||0,10), 0, 12);
  p.energy = clamp(p.energy + bonus, 0, p.energyCap);

  p.lastEnergyAt = now(); // regen resumes
  p.jetFuel += granted;
  PROFILES.set(address, p);

  return reply.send({ ok:true, grantedJetFuel: granted, energyBonus: bonus, profile: await profileOut(address) });
});

async function profileOut(address){
  const p = PROFILES.get(address) || defaultProfile(address);
  const ms = msFromProfile(p);
  return {
    address,
    jetFuel:p.jetFuel, energy:p.energy, energyCap:p.energyCap, regenPerMin:p.regenPerMin,
    unlockedLevel:p.unlockedLevel, ms
  };
}

const port = process.env.PORT || 8787;
app.listen({ port, host:'0.0.0.0' })
  .then(()=> console.log('API on', port))
  .catch(e=> { console.error(e); process.exit(1); });
