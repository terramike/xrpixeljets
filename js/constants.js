export const LS = {
  MS:'ms_obj', JF:'jetFuel', E:'energy', ELAST:'energy_last_srv', EACC:'energy_acc', UNLOCK:'unlock_level'
};

export const DEFAULT_MS = {
  id: 'starter-ms',
  name: 'Starter Mothership',
  image: 'assets/mothership_default.png',
  base:   { health: 20, energyCap: 100, regenPerMin: 1.0, hit: 0,  crit: 10, dodge: 0 },
  current:{ health: 20, energyCap: 100, regenPerMin: 1.0, hit: 0,  crit: 10, dodge: 0 },
  level:  { health: 0,  energyCap: 0,   regenPerMin: 0,   hit: 0,  crit: 0,  dodge: 0 }
};
