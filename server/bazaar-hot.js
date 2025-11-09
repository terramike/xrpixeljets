// jets/js/bazaar.js — 2025-11-08 hot-metadata c6
const API = window.JETS_API_BASE || "https://xrpixeljets.onrender.com";
const TAXON = 201;

function wallet(){ try{ return localStorage.getItem("WALLET") || ""; }catch{ return ""; } }
function auth(){ try{ return localStorage.getItem("JWT") || ""; }catch{ return ""; } }

async function fetchJSON(url, opt={}){
  const w = wallet();
  const hdrs = Object.assign({
    "Content-Type": "application/json",
    "X-Wallet": w
  }, opt.headers||{});
  if (auth()) hdrs["Authorization"] = `Bearer ${auth()}`;
  const res = await fetch(url, Object.assign(opt, { headers: hdrs }));
  if (!res.ok){
    const t = await res.text().catch(()=> "");
    throw new Error(`${res.status} ${url}\n${t || ""}`.trim());
  }
  return res.json();
}

async function load(){
  // hits server/hot route
  const data = await fetchJSON(`${API}/bazaar/hot/list?taxon=${TAXON}`);
  return data?.groups || [];
}

function renderGroup(g){
  const wrap = document.createElement("div");
  wrap.className = "bazaar-card";
  const title = document.createElement("div");
  title.innerHTML = `<div class="bazaar-title">${g.uri ? "XRPixel Bazaar Item" : "Bazaar Item"}</div>
    <div class="muted">Available: ${g.count}</div>`;
  const btn = document.createElement("button");
  btn.className = "btn-buy";
  btn.disabled = g.count <= 0;
  btn.textContent = g.count > 0 ? "Buy" : "Sold out";
  btn.onclick = () => buy(g);
  wrap.appendChild(title);
  wrap.appendChild(btn);
  return wrap;
}

async function buy(group){
  const $status = document.getElementById("bazaar-status");
  try {
    $status.textContent = "[Bazaar] Creating directed offer…";
    const body = { taxon: TAXON, priceDrops: 250000 }; // 0.25 XRP
    const r = await fetchJSON(`${API}/bazaar/hot/purchase`, { method:"POST", body: JSON.stringify(body) });
    $status.textContent = `[Bazaar] Offer ready. OfferID=${r.sellOfferId}. Accept in your wallet.`;
  } catch (e) {
    const s = String(e.message||"");
    if (s.includes("409")) $status.textContent = "[Bazaar] Sold out (race). Try again.";
    else if (s.includes("401")) $status.textContent = "[Bazaar] Sign in first.";
    else $status.textContent = `[Bazaar] Error: ${s}`;
    console.error(e);
  }
}

async function render(){
  const grid = document.getElementById("bazaar-grid");
  const status = document.getElementById("bazaar-status");
  grid.innerHTML = ""; status.textContent = "";
  try{
    const groups = await load();
    if (!groups.length){
      status.textContent = "Bazaar unavailable.";
      return;
    }
    for (const g of groups){
      grid.appendChild(renderGroup(g));
    }
  } catch (e) {
    status.textContent = "Bazaar unavailable.";
    console.error("[Bazaar] list error:", e);
  }
}

document.addEventListener("DOMContentLoaded", render);
