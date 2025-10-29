// /jets/js/upgrades-fix.js — Sequential upgrade hotfix + stepped preview (2025-10-28b)
import * as SrvAPI from './serverApi.js';
import { GameState } from './state.js';
import { updateJetFuelUI, updateEnergyUI, syncHUDAll } from './ui.js';

const ECON_SCALE = (window && window.ECON_SCALE != null) ? window.ECON_SCALE : 0.10;

function $(s){ return document.querySelector(s); }
function byId(id){ return document.getElementById(id); }
function numFrom(id){
  return Math.max(0, parseInt((byId(id)?.textContent||'0').replace(/[^0-9-]/g,''),10) || 0);
}

const STAT_ORDER = ['health','energyCap','regenPerMin','hit','crit','dodge'];
const UI_MAP = {
  health:     { q:'q-hp',  cost:'cost-hp'  },
  energyCap:  { q:'q-cap', cost:'cost-cap' },
  regenPerMin:{ q:'q-reg', cost:'cost-reg' },
  hit:        { q:'q-hit', cost:'cost-hit' },
  crit:       { q:'q-crit',cost:'cost-crit'},
  dodge:      { q:'q-dodge',cost:'cost-dodge' },
};

function logLine(msg){
  const el = byId('log'); if (!el) return;
  const d = document.createElement('div'); d.textContent = String(msg);
  el.appendChild(d); el.scrollTop = el.scrollHeight;
}

function readQueueFromDOM(){
  return {
    health:     numFrom('q-hp'),
    energyCap:  numFrom('q-cap'),
    regenPerMin:numFrom('q-reg'),
    hit:        numFrom('q-hit'),
    crit:       numFrom('q-crit'),
    dodge:      numFrom('q-dodge'),
  };
}
function clearQueueDOM(){
  ['q-hp','q-cap','q-reg','q-hit','q-crit','q-dodge'].forEach(id=>{
    const n = byId(id); if (n) n.textContent = '0';
  });
}

/* ---------- Stepped preview helpers ---------- */

function getBaseCost(stat){
  // Try multiple shapes in case your GameState evolved
  const costs = (GameState?.ms?.costs) || GameState?.costs || {};
  // Accept both long and short keys
  const aliases = { health:'health', energyCap:'energyCap', regenPerMin:'regenPerMin',
                    hit:'hit', crit:'crit', dodge:'dodge',
                    hp:'health', cap:'energyCap', reg:'regenPerMin' };
  // Direct hit
  if (costs[stat] != null) return Number(costs[stat]) || 0;
  // Alias hit
  for (const [alias,target] of Object.entries(aliases)){
    if (stat === target && costs[alias] != null) return Number(costs[alias]) || 0;
  }
  return 0;
}

function setCostLabel(stat, text){
  const id = UI_MAP[stat]?.cost;
  if (!id) return;
  const el = byId(id);
  if (el) el.textContent = text;
}

function steppedPreviewFor(stat, qty){
  const base = getBaseCost(stat);
  if (!qty || qty <= 0) return base ? `${base} JF` : '—';
  if (qty === 1) return base ? `${base} JF` : '—';
  // Lower bound = current next cost * qty (actual will be higher due to stepping on apply)
  const lowerBound = base * qty;
  return `≥ ${lowerBound} JF (stepped)`;
}

function refreshPreviewLabels(){
  for (const stat of STAT_ORDER){
    const qId = UI_MAP[stat].q;
    const qty = numFrom(qId);
    setCostLabel(stat, steppedPreviewFor(stat, qty));
  }
}

/* ---------- Apply one-at-a-time hotfix ---------- */

async function applyOne(stat){
  const payload = { econScale: ECON_SCALE };
  payload[stat] = 1;
  return await SrvAPI.msUpgrade(payload);
}

async function applyQueueSequential(queue){
  let totalSpent = 0, totalApplied = 0;
  for (const s of STAT_ORDER){
    let n = queue[s] | 0;
    while (n-- > 0){
      const beforeJF = GameState.jetFuel | 0;
      let res;
      try { res = await applyOne(s); }
      catch (e) { logLine(`Upgrade failed on ${s}: ${e?.message||e}`); return { applied: totalApplied, spent: totalSpent, lastError: e }; }
      if (res?.error){ logLine(`Upgrade error on ${s}: ${res.error}`); return { applied: totalApplied, spent: totalSpent, lastError: new Error(res.error) }; }

      if (res?.profile){
        const p = res.profile;
        GameState.ms = p.ms || GameState.ms;
        GameState.pct = p.pct || GameState.pct;
        if (typeof p.jetFuel === 'number') GameState.jetFuel = p.jetFuel|0;
        if (typeof p.energy  === 'number') GameState.energy  = p.energy|0;
        syncHUDAll(); updateJetFuelUI(); updateEnergyUI();
      }
      // After each successful level, preview labels should reflect the new "next" costs
      refreshPreviewLabels();

      const afterJF = GameState.jetFuel | 0;
      const spent = Math.max(0, beforeJF - afterJF);
      totalSpent += spent; totalApplied += 1;
      const status = byId('upgrades-status');
      if (status) status.textContent = `Applied ${totalApplied}… (spent +${spent} JF)`;
    }
  }
  return { applied: totalApplied, spent: totalSpent };
}

/* ---------- Install wiring ---------- */

function installPreviewObservers(){
  // Refresh once immediately
  refreshPreviewLabels();

  // Click delegation over the upgrades panel to catch +/- queue changes
  const panel = byId('upgrades-panel') || document.body;
  panel.addEventListener('click', () => {
    // Let DOM update first (if counters increment in handlers), then refresh
    setTimeout(refreshPreviewLabels, 0);
  });

  // Also observe text changes on the queue counters if present
  const targets = ['q-hp','q-cap','q-reg','q-hit','q-crit','q-dodge']
    .map(id => byId(id))
    .filter(Boolean);

  if (targets.length){
    const mo = new MutationObserver(() => refreshPreviewLabels());
    targets.forEach(node => mo.observe(node, { characterData:true, childList:true, subtree:true }));
  }
}

function installHotfix(){
  // Wire stepped preview
  installPreviewObservers();

  // Replace Apply handler with sequential upgrader
  const btn = byId('btn-apply-upgrades');
  if (!btn) return;
  const clone = btn.cloneNode(true);
  btn.parentNode.replaceChild(clone, btn);

  clone.addEventListener('click', async (e)=>{
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation?.();

    const queue = readQueueFromDOM();
    const totalQueued = Object.values(queue).reduce((a,b)=>a+(b|0),0);
    if (!totalQueued){
      const st = byId('upgrades-status'); if (st) st.textContent = 'Nothing queued.';
      return false;
    }

    const st = byId('upgrades-status'); if (st) st.textContent = 'Applying…';
    const { applied, spent, lastError } = await applyQueueSequential(queue);

    if (applied>0){
      logLine(`🧩 Upgrades applied — spent ${spent} JF across ${applied} levels.`);
      clearQueueDOM();
      refreshPreviewLabels();
      const st2 = byId('upgrades-status'); if (st2) st2.textContent = `Done. Spent ${spent} JF.`;
    } else if (lastError){
      const st2 = byId('upgrades-status'); if (st2) st2.textContent = `Error: ${lastError.message||lastError}`;
    } else {
      const st2 = byId('upgrades-status'); if (st2) st2.textContent = 'No changes.';
    }
    return false;
  }, { capture: true });

  clone.dataset.hotfix = 'upgrades-sequential-2025-10-28b';
}

if (document.readyState === 'loading'){ 
  document.addEventListener('DOMContentLoaded', installHotfix);
} else { installHotfix(); }
