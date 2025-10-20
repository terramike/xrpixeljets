import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'crypto';

// ---- Config ----
const PORT = process.env.PORT || 8787;
const HOST = '0.0.0.0';
const ORIGINS = (process.env.ALLOW_ORIGIN || 'http://localhost:8000,https://mykeygo.io')
  .split(',').map(s=>s.trim()).filter(Boolean);

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS not allowed: ' + origin), false);
  },
  methods: ['GET','POST','OPTIONS']
});

// ---- In-memory store ----
const profiles = Object.create(null);

const DEFAULT_MS = {
  base:    { health: 20, energyCap: 100, regenPerMin: 1.0 },
  current: { health: 20, energyCap: 100, regenPerMin: 1.0 },
  level:   { health: 0,  energyCap: 0,   regenPerMin: 0 }
};
const DEFAULT_PCT = { hit: 0, crit: 10, dodge: 0 };

function ensureProfile(address){
  if (!profiles[address]){
    profiles[address] = {
      nonce: randomUUID().slice(0,8),
      jetFuel: 100,
      unlockedLevel: 5,
      energy: 100,
      ms: JSON.parse(JSON.stringify(DEFAULT_MS)),
      pct: { ...DEFAULT_PCT },
      lastTick: Date.now()
    };
  }
  return profiles[address];
}

function tickEnergy(p){
  const now = Date.now();
  const dt = now - (p.lastTick || now);
  if (dt <= 0) return;
  const perSec = (p.ms.current.regenPerMin ?? 1) / 60;
  p.energy = Math.min(p.energy + perSec*(dt/1000), p.ms.current.energyCap);
  p.lastTick = now;
}

function auth(address, nonce){
  if (!address) { const e=new Error('missing address'); e.statusCode=400; throw e; }
  const p = ensureProfile(address);
  if (nonce && p.nonce !== nonce) { const e=new Error('bad nonce'); e.statusCode=401; throw e; }
  return p;
}

function profileOut(p){
  return {
    ms: p.ms,
    energy: Math.floor(p.energy),
    energyCap: p.ms.current.energyCap,
    unlockedLevel: p.unlockedLevel,
    jetFuel: p.jetFuel,
    pct: p.pct
  };
}

// ---- Costs/caps (aligned with client) ----
// Start every stat at 100 JF and scale gently.
function baseCost(stat){ return 100; }
function costForLevel(stat, lvNext){
  // lvNext is 1,2,3,... (the next level being purchased)
  // gentle curve: base * lv^1.2 (rounded)
  const cost = baseCost(stat) * Math.pow(lvNext, 1.2);
  return Math.round(cost);
}

// caps per your spec
const CAPS = {
  health: Infinity,       // no cap
  energyCap: 450,
  regenPerMin: 5.0,
  hit: Infinity,
  crit: Infinity,
  dodge: 33               // 33% cap
};

// ---- Routes ----
app.get('/', async ()=>({ ok:true, service:'XRPixelJets API' }));
app.get('/health', async ()=>({ ok:true }));

app.post('/session/start', async (req, reply)=>{
  const { address } = req.body || {};
  if (!address) return reply.code(400).send({ error:'missing address' });
  const p = ensureProfile(address);
  p.nonce = randomUUID().slice(0,8);
  return { nonce: p.nonce };
});

app.get('/profile', async (req, reply)=>{
  const { address } = req.query || {};
  if (!address) return reply.code(400).send({ error:'missing address' });
  const p = ensureProfile(address);
  tickEnergy(p);
  return profileOut(p);
});

app.post('/battle/start', async (req, reply)=>{
  const { address, nonce } = req.body || {};
  try{
    const p = auth(address, nonce);
    tickEnergy(p);
    if (Math.floor(p.energy) < 10)
      return reply.code(400).send({ error:'insufficient energy', need:10, have: Math.floor(p.energy) });
    p.energy -= 10;
    return { ok:true, energy: Math.floor(p.energy) };
  }catch(e){
    return reply.code(e.statusCode||400).send({ error: e.message||'bad request' });
  }
});

app.post('/battle/finish', async (req, reply)=>{
  const { address, nonce, win, wave, rewardJF, energyRefill } = req.body || {};
  try{
    const p = auth(address, nonce);
    tickEnergy(p);

    const w = Math.max(1, Math.floor(wave ?? 1));
    const scale = w <= 5 ? 1 : 1 + 0.01*(w-5);
    const jf = Number.isFinite(rewardJF) ? Math.max(0, Math.floor(rewardJF)) : Math.floor(100 * scale);
    const ef = Number.isFinite(energyRefill) ? Math.max(0, Math.floor(energyRefill))
             : (win ? (3 + Math.floor(Math.random()*7)) : (1 + Math.floor(Math.random()*2)));

    if (win){
      p.jetFuel += jf;
      p.energy = Math.min(p.energy + ef, p.ms.current.energyCap);
      if (w > p.unlockedLevel) p.unlockedLevel = w;
    }else{
      p.energy = Math.min(p.energy + ef, p.ms.current.energyCap);
    }

    return reply.send({ ok:true, award:{ jetFuel:jf, energy:ef, wave:w }, profile: profileOut(p) });
  }catch(e){
    return reply.code(e.statusCode||400).send({ error: e.message||'bad request' });
  }
});

app.post('/ms/upgrade', async (req, reply)=>{
  const { address, nonce, ops } = req.body || {};
  try{
    const p = auth(address, nonce);
    tickEnergy(p);

    const apply = {
      health:      Math.max(0, ops?.health|0),
      energyCap:   Math.max(0, ops?.energyCap|0),
      regenPerMin: Math.max(0, ops?.regenPerMin|0),
      hit:         Math.max(0, ops?.hit|0),
      crit:        Math.max(0, ops?.crit|0),
      dodge:       Math.max(0, ops?.dodge|0)
    };

    // progressive cost per-stat using next levels
    let totalCost = 0;
    const next = {
      health: p.ms.level.health + 1,
      energyCap: p.ms.level.energyCap + 1,
      regenPerMin: p.ms.level.regenPerMin + 1,
      hit: (p.pct.hitLevel||0) + 1,
      crit: (p.pct.critLevel||0) + 1,
      dodge: (p.pct.dodgeLevel||0) + 1
    };
    const add = (stat, times)=>{ for(let i=0;i<times;i++){ totalCost += costForLevel(stat, next[stat]); next[stat]++; } };
    add('health', apply.health);
    add('energyCap', apply.energyCap);
    add('regenPerMin', apply.regenPerMin);
    add('hit', apply.hit);
    add('crit', apply.crit);
    add('dodge', apply.dodge);

    if (p.jetFuel < totalCost) return reply.code(400).send({ error:'insufficient JetFuel', need: totalCost, have: p.jetFuel });

    // Deduct and apply (report the exact spend for this Apply click)
    p.jetFuel -= totalCost;

    if (apply.health){
      p.ms.level.health += apply.health;
      p.ms.current.health = Math.min(p.ms.current.health + (1 * apply.health), CAPS.health);
    }
    if (apply.energyCap){
      p.ms.level.energyCap += apply.energyCap;
      p.ms.current.energyCap = Math.min(p.ms.current.energyCap + (2 * apply.energyCap), CAPS.energyCap);
      p.energy = Math.min(p.energy, p.ms.current.energyCap);
    }
    if (apply.regenPerMin){
      p.ms.level.regenPerMin += apply.regenPerMin;
      p.ms.current.regenPerMin = Math.min(
        Math.round((p.ms.current.regenPerMin + 0.1 * apply.regenPerMin) * 10)/10,
        CAPS.regenPerMin
      );
    }
    if (apply.hit){
      p.pct.hitLevel = (p.pct.hitLevel||0) + apply.hit;
      p.pct.hit = Math.min(100, (p.pct.hit||0) + 1*apply.hit);
    }
    if (apply.crit){
      p.pct.critLevel = (p.pct.critLevel||0) + apply.crit;
      p.pct.crit = (p.pct.crit||0) + 1*apply.crit; // no cap
    }
    if (apply.dodge){
      p.pct.dodgeLevel = (p.pct.dodgeLevel||0) + apply.dodge;
      p.pct.dodge = Math.min(CAPS.dodge, (p.pct.dodge||0) + 1*apply.dodge);
    }

    const labels = { health:'HP', energyCap:'ENERGY', regenPerMin:'REGEN', hit:'HIT', crit:'CRIT', dodge:'DODGE' };
    const pretty = Object.fromEntries(Object.entries(apply).filter(([_,v])=>v>0).map(([k,v])=>[labels[k], v]));

    return reply.send({ ok:true, applied: pretty, spent: totalCost, profile: profileOut(p) });
  }catch(e){
    return reply.code(e.statusCode||400).send({ error: e.message||'bad request' });
  }
});

// server regen
setInterval(()=>{
  const now = Date.now();
  for (const addr of Object.keys(profiles)){
    const p = profiles[addr];
    const dt = now - (p.lastTick || now);
    if (dt <= 0){ p.lastTick = now; continue; }
    const perSec = (p.ms.current.regenPerMin ?? 1)/60;
    p.energy = Math.min(p.energy + perSec*(dt/1000), p.ms.current.energyCap);
    p.lastTick = now;
  }
}, 1000);

app.listen({ port: PORT, host: HOST }).then(()=>{
  app.log.info(`API listening on http://${HOST}:${PORT}`);
  app.log.info(`Allowed origins: ${ORIGINS.join(', ')}`);
});
