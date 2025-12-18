/* XRPixel Jets — Bazaar client (module)
 * v=2025-11-07c2
 * Expects DOM:  <div id="bazaar-grid"></div>  <div id="bazaar-status"></div>  <input id="xrpl-address">
 * Requires window.xrpl (xrpl.js) loaded on the page.
 * Optional globals you can set before this script:
 *   window.JETS_API_BASE, window.JETS_BAZAAR_ISSUER, window.JETS_BAZAAR_HOT, window.JETS_BAZAAR_TAXON, window.XRPL_NODE
 */

const API_BASE = window.JETS_API_BASE || "https://xrpixeljets.onrender.com";
const ISSUER   = window.JETS_BAZAAR_ISSUER || "rfYZ17wwhA4Be23fw8zthVmQQnrcdDRi52";
const HOT      = window.JETS_BAZAAR_HOT    || "rJz7ooSyXQKEiS5dSucEyjxz5t6Ewded6n";
const TAXON    = Number(window.JETS_BAZAAR_TAXON ?? 201);
const XRPL_WS  = window.XRPL_NODE || "wss://xrplcluster.com";

const elGrid   = document.getElementById("bazaar-grid");
const elStatus = document.getElementById("bazaar-status") || { append(){}, textContent:"" };
const addrIn   = document.getElementById("xrpl-address");

function log(msg){
  if(!elStatus) return;
  const d=document.createElement("div"); d.textContent=`[Bazaar] ${msg}`; elStatus.appendChild(d);
}
async function fetchJSON(url, opts){ const r=await fetch(url,opts); if(!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }
function fmtDrops(x){ return x==null ? "—" : `${(+x/1_000_000).toFixed(6)} XRP`; }
function getJWT(){ try{ return (localStorage.getItem("JWT")||"").trim()||null; }catch{return null;} }
function getWallet(){ const a=(addrIn?.value||"").trim(); return a && a[0]==="r" ? a : ""; }

function deriveStatBonus(meta){
  const stat = String(meta?.stat ?? meta?.properties?.stat ?? "").toLowerCase();
  const bonus = Number(meta?.bonus ?? meta?.properties?.bonus ?? NaN);
  if (["attack","defense","speed"].includes(stat) && Number.isFinite(bonus) && bonus>0) return { stat, bonus };

  const atts = Object.create(null);
  if (Array.isArray(meta?.attributes)) {
    for (const a of meta.attributes) {
      const k = String(a?.trait_type ?? a?.type ?? "").toLowerCase();
      atts[k] = a?.value;
    }
  }
  const cand = ["attack","defense","speed"].find(k => Number(atts[k])>0);
  if (cand) return { stat: cand, bonus: Number(atts[cand])||1 };
  return null;
}
function priceFromMeta(meta){
  let jf = 0, xrp = 0;
  if (Array.isArray(meta?.attributes)) {
    for (const a of meta.attributes) {
      const k = String(a?.trait_type ?? a?.type ?? "").toLowerCase();
      if (k==="price (jfuel)") jf = Number(a.value)||0;
      if (k==="price (xrp)")   xrp = Number(a.value)||0;
    }
  }
  return { jf, xrpDrops: Math.round(xrp*1_000_000) };
}
function hexToUtf8(h){
  try{
    const hex = String(h||"").replace(/^0x/i,'').trim();
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length%2) return "";
    const bytes = new Uint8Array(hex.match(/.{2}/g).map(b=>parseInt(b,16)));
    return new TextDecoder().decode(bytes);
  }catch{ return ""; }
}
function ipfsToHttp(u){
  const id = String(u||"").replace(/^ipfs:\/\//,"").replace(/^ipfs\//,"");
  return [
    `https://ipfs.xrp.cafe/ipfs/${id}`,
    `https://nftstorage.link/ipfs/${id}`,
    `https://ipfs.io/ipfs/${id}`,
    `https://cloudflare-ipfs.com/ipfs/${id}`
  ];
}
async function fetchMeta(uri){
  if (!uri) return null;
  const urls = (uri.startsWith("ipfs://") || uri.startsWith("ipfs/")) ? ipfsToHttp(uri) : [uri];
  for (const url of urls){
    try{ const r=await fetch(url,{cache:"no-store"}); if(r.ok) return await r.json(); }catch{}
  }
  return null;
}

function renderSKUs(skus){
  if(!elGrid) return;
  elGrid.innerHTML = "";
  if(!skus.length){ elGrid.innerHTML = `<div class="muted">No items available right now.</div>`; return; }
  for (const s of skus){
    const card = document.createElement("div");
    card.className = "bazaar-card";
    card.innerHTML = `
      <img src="${s.image}" alt="${s.name}" class="bazaar-img"/>
      <div class="bazaar-body">
        <div class="bazaar-title">${s.name}</div>
        <div class="bazaar-buffs">${(s.previewBonuses||[]).join(' · ')}</div>
        <div class="bazaar-costs">
          <span class="chip">JetFuel: ${s.priceJetFuel}</span>
          <span class="chip">XRP: ${fmtDrops(s.priceXrpDrops)}</span>
        </div>
        <button class="btn-buy" data-sku="${s.sku}" ${s.available<=0?'disabled':''}>
          ${s.available>0?`Buy (${s.available} left)`:'Sold out'}
        </button>
      </div>`;
    elGrid.appendChild(card);
  }
  elGrid.querySelectorAll(".btn-buy").forEach(btn=>{
    btn.addEventListener("click", ()=> buy(btn.getAttribute("data-sku")));
  });
}

async function listFromServer(){
  const wallet = getWallet();
  const jwt = getJWT();
  const r = await fetchJSON(`${API_BASE}/bazaar/skus`, {
    headers: { "X-Wallet": wallet || "", "Authorization": jwt ? `Bearer ${jwt}` : "" }
  });
  return r.skus || [];
}

async function listFromChain(){
  const XRPL = window.xrpl;
  const client = new XRPL.Client(XRPL_WS);
  await client.connect();
  const nfts = [];
  try{
    let marker=null;
    do{
      const req = { command:"account_nfts", account: HOT, limit: 400 }; if (marker) req.marker=marker;
      const res = await client.request(req);
      marker = res.result.marker;
      for (const nf of (res.result.account_nfts||[])) {
        if (nf.Issuer !== ISSUER) continue;
        if (Number(nf.NFTokenTaxon) !== TAXON) continue;
        nfts.push(nf);
      }
    } while(marker);
  } finally {
    try{ await client.disconnect(); }catch{}
  }

  const tmp = new Map();
  for (const nf of nfts){
    const uri = hexToUtf8(nf.URI||"");
    const meta = await fetchMeta(uri);
    if (!meta) continue;

    const statBonus = deriveStatBonus(meta);
    const kind = statBonus?.stat || "attack";
    const sku = (meta?.properties?.sku || meta?.properties?.slugPrefix || `BAZ-${kind.toUpperCase()}-V1`)
                .toString().toUpperCase().replace(/[^A-Z0-9_-]/g,"");

    const price = priceFromMeta(meta);
    const cur = tmp.get(sku) || {
      sku,
      name: meta?.name || `Bazaar ${kind.toUpperCase()} +${statBonus?.bonus||1}`,
      image: (meta?.image||"").replace(/^ipfs:\/\//,"https://ipfs.io/ipfs/"),
      priceJetFuel: price.jf,
      priceXrpDrops: price.xrpDrops,
      previewBonuses: statBonus ? [`+${statBonus.bonus} ${kind.toUpperCase()}`] : [],
      available: 0
    };
    cur.available += 1;
    tmp.set(sku, cur);
  }
  return [...tmp.values()];
}

async function buy(sku){
  try{
    const wallet = getWallet();
    if(!wallet){ log("Connect/sign in first."); return; }
    const jwt = getJWT();
    log(`Creating directed offer for ${sku}…`);
    const r = await fetchJSON(`${API_BASE}/bazaar/purchase`, {
      method:"POST",
      headers:{ "Content-Type":"application/json", "X-Wallet": wallet, "Authorization": jwt?`Bearer ${jwt}`:"" },
      body: JSON.stringify({ sku })
    });
    const tx = { TransactionType:"NFTokenAcceptOffer", NFTokenSellOffer:r.sellOfferId, Account:wallet };

    if (window.WalletWC?.signAndSubmit){
      const out = await window.WalletWC.signAndSubmit(tx);
      log(`Offer accepted: ${out?.hash || 'submitted'}`);
    } else if (window.crossmark?.xrpl?.signAndSubmit){
      const out = await window.crossmark.xrpl.signAndSubmit(tx);
      log(`Offer accepted: ${out?.hash || 'submitted'}`);
    } else {
      log("No wallet signer detected.");
      return;
    }

    try{
      await fetchJSON(`${API_BASE}/bazaar/settle`, {
        method:"POST",
        headers:{ "Content-Type":"application/json", "X-Wallet": wallet, "Authorization": jwt?`Bearer ${jwt}`:"" },
        body: JSON.stringify({ offerId: r.sellOfferId })
      });
    }catch{}
    if (window.XRPLWallet?.loadXRPLJets) await window.XRPLWallet.loadXRPLJets(wallet);
    if (window.JETS?.refreshAccessories) window.JETS.refreshAccessories();
    log("Item delivered. Bonuses should now be active.");
  }catch(e){ console.error(e); log(`Error: ${e.message}`); }
}

async function init(){
  try{
    let skus = [];
    try{ skus = await listFromServer(); }catch(e){ /* server feed might not be ready */ }
    if (!skus?.length){
      log("Server feed empty; falling back to on-chain discovery…");
      skus = await listFromChain();
    }
    renderSKUs(skus);
  }catch(e){ log(`Failed to load bazaar: ${e.message}`); }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
