/* XRPixel Jets — Bazaar (PUBLIC offers edition)
 * v=2025-11-09-live2
 * - Loads active PUBLIC SellOffers from /bazaar/hot/live
 * - Fetches NFT metadata, renders product cards
 * - Buy = NFTokenAcceptOffer signed in the user's wallet
 */
(function () {
  const API_BASE = (window.JETS_API_BASE || "https://xrpixeljets.onrender.com").replace(/\/+$/,'');
  const ISSUER   = window.JETS_BAZAAR_ISSUER || "rfYZ17wwhA4Be23fw8zthVmQQnrcdDRi52";
  const TAXON    = Number(window.JETS_BAZAAR_TAXON ?? 201);

  const elGrid   = document.getElementById("bazaar-grid");
  const elStatus = document.getElementById("bazaar-status") || { append(){}, textContent:"" };
  const addrIn   = document.getElementById("xrpl-address");

  function log(msg) {
    if (!elStatus) return;
    const d = document.createElement("div");
    d.textContent = `[Bazaar] ${msg}`;
    elStatus.appendChild(d);
  }
  function tryKeys(obj, keys) {
    for (const k of keys) {
      try {
        const v = obj.getItem ? obj.getItem(k) : obj[k];
        if (v && String(v).trim()) return String(v).trim();
      } catch {}
    }
    return "";
  }
  function getWallet() {
    const a = (addrIn?.value || "").trim();
    if (a && a[0] === "r") return a;
    return tryKeys(localStorage, ["WALLET", "xrplAddress", "address"]);
  }
  function hexToUtf8(hex) {
    if (!hex) return "";
    const clean = String(hex).replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2) return "";
    const bytes = new Uint8Array(clean.match(/.{2}/g).map(b => parseInt(b, 16)));
    try { return new TextDecoder().decode(bytes); } catch { return ""; }
  }
  function ipfsUrls(uri) {
    const id = String(uri || "").replace(/^ipfs:\/\//, "").replace(/^ipfs\//, "");
    return [
      `https://ipfs.xrp.cafe/ipfs/${id}`,
      `https://nftstorage.link/ipfs/${id}`,
      `https://ipfs.io/ipfs/${id}`,
      `https://cloudflare-ipfs.com/ipfs/${id}`,
    ];
  }
  async function fetchJsonMaybe(u) {
    try {
      const r = await fetch(u, { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch {}
    return null;
  }
  async function fetchMetadataFromURIHex(uriHex) {
    const utf = hexToUtf8(uriHex);
    const urls = (utf.startsWith("ipfs://") || utf.startsWith("ipfs/")) ? ipfsUrls(utf) : [utf];
    for (const u of urls) {
      const j = await fetchJsonMaybe(u);
      if (j) return j;
    }
    return null;
  }
  function readAttr(meta, name) {
    const atts = Array.isArray(meta?.attributes) ? meta.attributes : [];
    const hit = atts.find(a => (a?.trait_type || a?.traitType || "").toLowerCase() === name.toLowerCase());
    return hit?.value;
  }
  function previewBonus(meta) {
    const attack  = Number(readAttr(meta, "Attack")  || 0) || 0;
    const defense = Number(readAttr(meta, "Defense") || 0) || 0;
    const speed   = Number(readAttr(meta, "Speed")   || 0) || 0;
    const perks = [];
    if (attack  > 0)  perks.push(`+${attack} ATTACK`);
    if (defense > 0)  perks.push(`+${defense} DEFENSE`);
    if (speed   > 0)  perks.push(`+${speed} SPEED`);
    return perks;
  }
  function priceFromMeta(meta) {
    const priceX = Number(readAttr(meta, "Price (XRP)")   || 0) || 0;
    const priceJ = Number(readAttr(meta, "Price (JFUEL)") || 0) || 0;
    return { xrp: priceX, jf: priceJ, drops: Math.round(priceX * 1_000_000) };
  }
  function skuFromMeta(meta) {
    const explicit = String(meta?.properties?.sku || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    if (explicit) return explicit;
    const kind = String(readAttr(meta, "Kind") || "").toLowerCase();
    const K = ["attack", "defense", "speed"].includes(kind) ? kind.toUpperCase() : "ATTACK";
    return `BAZ-${K}-V1`;
  }
  function fmtXRPdrops(drops) {
    if (!Number.isFinite(+drops)) return "—";
    return `${(+drops / 1_000_000).toFixed(6)} XRP`;
  }

  // -------- inventory from /live --------
  async function loadLive() {
    const res = await fetch(`${API_BASE}/bazaar/hot/live`, { cache: "no-store" });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error || ''; } catch {}
      throw new Error(`live_failed ${res.status} ${detail}`.trim());
    }
    const { items = [] } = await res.json();

    const out = [];
    const queue = items.slice();
    const MAX = 6;
    async function work() {
      while (queue.length) {
        const it = queue.shift();
        if (Number(it.taxon) !== TAXON) continue;
        const meta = await fetchMetadataFromURIHex(it.uri);
        if (!meta) continue;
        if (String(meta?.properties?.issuer || "") !== ISSUER) continue;

        const price = priceFromMeta(meta);
        const perks = previewBonus(meta);
        const img = (meta?.image || "");
        const imgUrl = (img.startsWith("ipfs://") || img.startsWith("ipfs/")) ? ipfsUrls(img)[0] : img;

        out.push({
          offerId: it.offerId,
          nftokenId: it.nftokenId,
          name: meta?.name || "XRPixel Bazaar Upgrade",
          image: imgUrl,
          sku: skuFromMeta(meta),
          priceXRP: it.priceXRP,
          priceDrops: it.amountDrops,
          priceJFUEL: price.jf,
          perks
        });
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX, queue.length) }, work));
    return out;
  }

  // -------- render --------
  function render(cards) {
    if (!elGrid) return;
    elGrid.innerHTML = "";
    if (!cards.length) {
      elGrid.innerHTML = `<div class="muted">No items are available right now.</div>`;
      return;
    }
    const bySku = new Map();
    for (const c of cards) {
      const g = bySku.get(c.sku) || { ...c, count: 0, items: [] };
      g.count += 1;
      g.items.push(c);
      if (Number(c.priceDrops) < Number(g.priceDrops)) {
        g.priceDrops = c.priceDrops;
        g.priceXRP   = c.priceXRP;
        g.image      = c.image;
        g.name       = c.name;
      }
      bySku.set(c.sku, g);
    }
    for (const g of bySku.values()) {
      const card = document.createElement("div");
      card.className = "bazaar-card";
      card.innerHTML = `
        <img class="bazaar-img" src="${g.image}" alt="${g.name}">
        <div class="bazaar-body">
          <div class="bazaar-title">${g.name}</div>
          <div class="bazaar-buffs">${(g.perks||[]).join(" · ")}</div>
          <div class="bazaar-costs">
            <span class="chip">XRP: ${fmtXRPdrops(g.priceDrops)}</span>
            <span class="chip">JetFuel: ${g.priceJFUEL||0}</span>
            <span class="chip small">Available: ${g.count}</span>
          </div>
          <button class="btn-buy" data-sku="${g.sku}">Buy</button>
        </div>
      `;
      elGrid.appendChild(card);
    }
    elGrid.querySelectorAll(".btn-buy").forEach(btn => {
      btn.addEventListener("click", () => buy(btn.getAttribute("data-sku")));
    });
  }

  // -------- buy (AcceptOffer) --------
  let lastCards = [];
  async function buy(humanSku) {
    try {
      const wallet = getWallet();
      if (!wallet) throw new Error("connect_wallet");
      const choice = lastCards.find(c => c.sku === humanSku);
      if (!choice) throw new Error("sold_out");

      const tx = { TransactionType: "NFTokenAcceptOffer", Account: wallet, NFTokenSellOffer: choice.offerId };
      window.__lastOfferId = choice.offerId;

      if (window.WalletWC?.signAndSubmit) {
        const res = await window.WalletWC.signAndSubmit(tx);
        log(`Purchased: ${res?.hash || "submitted"}`);
      } else if (window.crossmark?.xrpl?.signAndSubmit) {
        const res = await window.crossmark.xrpl.signAndSubmit(tx);
        log(`Purchased: ${res?.hash || "submitted"}`);
      } else {
        log("No wallet signer detected (WalletConnect or Crossmark). Connect wallet and retry.");
        return;
      }

      await refresh();
      if (window.XRPLWallet?.loadXRPLJets) await window.XRPLWallet.loadXRPLJets(wallet);
      if (window.JETS?.refreshAccessories) window.JETS.refreshAccessories();
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("connect_wallet")) log("Connect your wallet first.");
      else if (msg.includes("sold_out")) log("That SKU sold out. Try another or refresh.");
      else log(`Error: ${msg}`);
      console.error(e);
    }
  }

  // -------- boot --------
  async function refresh() {
    const cards = await loadLive();
    lastCards = cards;
    render(cards);
  }
  async function init() {
    try {
      try {
        const p = await fetch(`${API_BASE}/bazaar/hot/ping`).then(r => r.json());
        if (!p?.ok) log(`Ping note: ${p?.note || "—"}`);
        else log(`HOT ${p.hot?.slice(0,6)}… algo=${p.algo} taxon=${p.taxon}`);
      } catch {}
      await refresh();
    } catch (e) {
      console.error(e);
      log("Bazaar unavailable.");
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
