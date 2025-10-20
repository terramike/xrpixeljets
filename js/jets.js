import { GameState } from './state.js';
import { seededStats, parseAttr, numCode, log } from './utils.js';

// Try to load metadata.json (if present); otherwise, build from /assets/
async function loadFromMetadata(limit){
  try{
    const r=await fetch('metadata.json',{cache:'no-store'}); if(!r.ok) return null;
    const tx=await r.text(); if(tx.trim().startsWith('<')) return null;
    const data=JSON.parse(tx); const col=Array.isArray(data.collection)?data.collection:[];
    let mapped=col.map((j,i)=>({
      id: j.name || ('jet_'+i),
      name: j.name || ('XRPixel Jet #'+(i+1)),
      image: (j.image && !j.image.startsWith('http'))
              ? ('assets/'+j.image.replace(/^assets\//,''))
              : (j.image || 'assets/XRPjets.png'),
      attributes: (Array.isArray(j.attributes) && j.attributes.length) ? j.attributes : seededStats(i+1)
    }));
    if(mapped.length<limit){ mapped = mapped.concat(assetJets(limit - mapped.length)); }
    return mapped.slice(0,limit);
  }catch{ return null; }
}

function assetJets(limit){
  const TOTAL=111;
  const idxs=Array.from({length:TOTAL},(_,i)=>i+1).sort(()=>Math.random()-0.5).slice(0,limit);
  return idxs.map(n=>({
    id:'jet_'+n, name:'XRPixel Jet #'+n, image:`assets/xrpixeljet_${n}.png`, attributes: seededStats(n)
  }));
}

export async function loadMockJets(limit=10){
  const md=await loadFromMetadata(limit);
  GameState.jets = md || assetJets(limit);
}

function statTriple(attrs){
  const A=parseAttr(attrs,'Attack')||'a3';
  const S=parseAttr(attrs,'Speed') ||'s3';
  const D=parseAttr(attrs,'Defense')||'d3';
  return {
    a:numCode(A,'a'),
    s:numCode(S,'s'),
    d:numCode(D,'d')
  };
}

function gunPair(attrs){
  const top = parseAttr(attrs,'Top Gun')    || '—';
  const bot = parseAttr(attrs,'Bottom Gun') || '—';
  return { top, bottom: bot };
}

export function recalcSquad(){
  const j=GameState.mainJet, w=GameState.wingJet;
  if(!j){ GameState.squad={attack:5,speed:5,defense:5,solo:true,synergy:1}; return; }
  const js=statTriple(j.attributes);
  let atk=js.a, spd=js.s, def=js.d;
  let solo=!w; let syn=1;
  if(w){
    const ws=statTriple(w.attributes);
    atk+=ws.a; spd+=ws.s;
    const top=parseAttr(j.attributes,'Top Gun'); const bot=parseAttr(w.attributes,'Bottom Gun');
    if(top && bot && top.toLowerCase()===bot.toLowerCase()) syn=1.1;
  }else{
    atk=Math.round(atk*1.5); spd=Math.round(spd*1.2);
  }
  GameState.squad={attack:atk,speed:spd,defense:def,solo,synergy:syn};
}

export function renderJets(onMain,onWing){
  const grid=document.getElementById('jet-grid');
  grid.innerHTML='';

  // Synergy explainer (once)
  const helpId='synergy-help';
  let help=document.getElementById(helpId);
  if(!help){
    help=document.createElement('div');
    help.id=helpId;
    help.className='tiny';
    help.style.cssText='margin:6px 0 8px;color:#aad7ff;line-height:1.4;';
    help.innerHTML = 'Synergy: <b>Solo</b> gives +50% ATK & +20% SPD. <b>Duo</b> gives +10% ATK if <u>Main Top Gun</u> matches <u>Wing Bottom Gun</u>.';
    const panel=document.querySelector('.panel.selector');
    if(panel){ panel.insertBefore(help, panel.querySelector('.jet-grid')); }
  }

  GameState.jets.forEach(j=>{
    const card=document.createElement('div'); card.className='jet-card';

    // Image
    const img=document.createElement('img'); img.src=j.image; img.alt=j.name;

    // Name
    const name=document.createElement('div'); name.className='jet-name'; name.textContent=j.name;

    // Stats (A/S/D)
    const st=statTriple(j.attributes);
    const stats=document.createElement('div'); stats.className='jet-stats';
    stats.textContent=`A${st.a}  S${st.s}  D${st.d}`;

    // Guns
    const gp=gunPair(j.attributes);
    const guns=document.createElement('div'); guns.className='guns';
    guns.textContent=`Top: ${gp.top}  /  Bottom: ${gp.bottom}`;

    // Buttons
    const actions=document.createElement('div'); actions.className='jet-actions';
    const mainBtn=document.createElement('button'); mainBtn.textContent='Main'; mainBtn.className='tiny';
    const wingBtn=document.createElement('button'); wingBtn.textContent='Wing'; wingBtn.className='tiny';

    mainBtn.onclick=()=>{
      onMain(j);
      log(`Main set: ${j.name}`);
    };
    wingBtn.onclick=()=>{
      onWing(j);
      log(`Wingman set: ${j.name}`);
    };

    actions.appendChild(mainBtn);
    actions.appendChild(wingBtn);

    // Assemble
    [img,name,stats,guns,actions].forEach(n=>card.appendChild(n));
    grid.appendChild(card);
  });
}
