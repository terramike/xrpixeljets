# XRPixel Jets: A Player-Powered Game on the XRP Ledger (Whitepaper)
*Built by players, for players.*

**Author:** Terramike — Grid Wizard Labs  
**Version:** 2025.11 Early Access (Limited to 111 Jets)  
**Network:** XRPL Mainnet (`wss://xrplcluster.com`)  
**Website:** [https://mykeygo.io/jets](https://mykeygo.io/jets)



## Table of Contents
1. [Executive Summary](#executive-summary)  
2. [Game Overview & Lore](#game-overview--lore)  
3. [Core Gameplay Systems](#core-gameplay-systems)  
   - [Missions & Combat](#missions--combat)  
   - [Mothership Upgrades](#mothership-upgrades)  
   - [Energy & JetFuel Loop](#energy--jetfuel-loop)  
4. [JETS Token & Economy](#jets-token--economy)  
5. [Claim Architecture](#claim-architecture)  
   - [Wallet Authentication](#wallet-authentication)  
   - [JWT Security Model](#jwt-security-model)  
   - [Claim Flow](#claim-flow)  
6. [Marketplace & Bazaar](#marketplace--bazaar)  
7. [Accessories & Crew](#accessories--crew)  
8. [Discord Integration](#discord-integration)  
9. [Roadmap](#roadmap)  
10. [Technical Appendix](#technical-appendix)  
11. [Closing Statement](#closing-statement)



## Executive Summary

**XRPixel Jets** is an on-chain arcade RPG built on the **XRP Ledger**, blending nostalgic 16-bit gameplay with real digital ownership.  
Players pilot pixel-art fighter jets, earn **JetFuel (JFUEL)** through missions, and redeem it for **JETS tokens** — a real asset issued on the XRPL.  
Every upgrade, battle, and reward is server-authoritative, ensuring fairness while allowing on-ledger claims through **Crossmark-secured** wallets.

The ecosystem combines **gameplay**, **economy**, and **community**, creating a world where progress and creativity are verifiably yours.



## Game Overview & Lore

In the neon ruins of a lost 16-bit galaxy, pilots rebuild their fleets to reclaim the skies.  
Each **Jet NFT** represents a unique craft with its own stats — Attack, Speed, and Defense — and potential to equip accessories, crews, and mothership enhancements.

The player’s journey begins aboard the **Mothership**, where JetFuel is managed and upgrades are built.  
Through combat missions and squad tuning, players strengthen their fleets to take on harder waves, earn JetFuel faster, and climb the ranks of the digital frontier.

> “Fuel your Mothership. Upgrade your squad. Claim your future.”



## Core Gameplay Systems

### Missions & Combat

Missions are wave-based PvE encounters. Combat outcomes depend on:
- Jet stats (Attack, Speed, Defense)
- Accessory bonuses (Hit%, Crit%, Dodge%)
- Initiative and RNG-based variance tuned via **battle-tuning.js**

Each battle turn is resolved through:
- Initiative rolls (Speed-driven)
- Hit/Miss/Crit outcomes with animated emoji logs
- Defense-based damage reduction
- Energy consumption and regeneration per turn

Server-authoritative combat ensures fairness and eliminates exploitability while maintaining fast, arcade-like responsiveness.



### Mothership Upgrades

The **Mothership** is the player’s persistent progression anchor.  
Upgrades consume JetFuel, with server-calculated costs scaling by level.  
Upgradable stats include:
- Health  
- Energy Capacity  
- Regen Rate (+0.1/min per level)  
- Hit, Crit, and Dodge (percentage bonuses)

Upgrades use atomic server-side debits:
```text
baseCost = 100 + 30 × level
regenPerMin costs +50%
```

All upgrades are validated via the /ms/upgrade endpoint, ensuring synchronization between the client and authoritative PostgreSQL state.

Energy & JetFuel Loop

Energy is the gameplay currency that limits mission attempts.
It regenerates passively on the server, even while offline, based on:
```
regenPerMin = base + (level × 0.1)
```

JetFuel is the internal soft currency — earned through missions, spent on upgrades, and redeemable for on-chain JETS tokens.

This loop — Play → Earn JetFuel → Upgrade → Claim JETS → Reinvest — forms the sustainable economy of XRPixel Jets.

JETS Token & Economy
```
Token Code: JETS
Currency Hex: 4A45545300000000000000000000000000000000
Issuer: rHz5qqAo57UnEsrMtw5croE4WnK3Z3J52e
Hot Wallet (Payout Signer): rJz7ooSyXQKEiS5dSucEyjxz5t6Ewded6n
Transfer Fee: 0%
DefaultRipple: ON
Algorithm Policy: secp256k1 only

Tokenomics Summary
Metric	Description
Total Supply	1,000,000,000 JETS
Circulating Supply	Determined by claims from gameplay
Base Claim Cooldown	300 seconds
ECON_SCALE	0.10 (10% of base JetFuel converted to JETS)
BASE_PER_LEVEL	300 JFUEL
Claim Mode	Hot wallet payout (TOKEN_MODE=hot)
```
Players earn JetFuel through missions and claim JETS on-ledger.
All claim transactions are atomic and executed via the payout signer (hot wallet) on XRPL Mainnet.

Claim Architecture
Wallet Authentication

Wallet sign-ins use Crossmark with secp256k1 public keys.
No Ed25519 keys are accepted for authentication.

Flow:
```
/session/start issues a one-time nonce.

Player signs nonce||scope||ts||address with their wallet.

/session/verify validates the signature and returns a JWT.

The client stores the JWT and uses it for all authorized actions (claim, upgrade, play).

JWT Security Model

JWTs are signed with HS256 (JWT_SECRET server-side).

Expiry: ~1 hour.
```
Scope: play,upgrade,claim.

All claim endpoints require both Authorization: Bearer <jwt> and X-Wallet headers.

Claim Flow
```
Player submits claim amount via /claim/start.
```
Server validates cooldown and JetFuel balance.

If balance sufficient:
```
Debit JetFuel.
```
Attempt XRPL payment from hot wallet to player address.

On failure, auto-refund the JetFuel debit.

Returns txid or txJSON (mock mode fallback).

Client HUD updates with new profile and transaction link to XRPSCAN
.

Marketplace & Bazaar
```
The Jets Bazaar allows players to spend JETS on exclusive NFTs and upgrades.
Purchases are executed through the /shop/redeem API and logged to the player’s profile.
Future versions will integrate on-ledger escrow and peer-to-peer trading.
```
Planned Additions
```
Accessory drops purchasable in JETS

Collection-linked bonuses

Dynamic supply scaling by mission tier

Seasonal cosmetic drops (limited edition)
```
Accessories & Crew

Accessory NFTs provide stat bonuses discovered automatically from their metadata.
The game parses attributes like:
```
{
  "trait_type": "stat",
  "value": "attack",
  "bonus": 8
}

```
Bonuses stack by highest value per stat, allowing players to equip multiple accessories across categories (Attack, Speed, Defense, etc.).

Crew NFTs (such as Fuzzy Bears or Byron’s Zombies) will extend this system, granting unique passive effects and lore-driven bonuses.

Discord Integration

XRPixel Jets includes a dedicated Discord bot that mirrors the in-game experience.
Players can:

Link wallets (/link)

View profiles (/profile)

Run missions directly in Discord (/mission start, /mission turn, /mission finish)

Claim JETS (/claim amount:<n>)

View NFT hangar listings (/hangar)

The bot communicates securely with the XRPixel Jets API via Authorization: Bearer <jwt> and mirrors combat logs with emoji-based summaries.

## Roadmap 
### Phase 1  — Early Access (Live)
```
Genesis mint: 111 Jets

Fully functional play-to-claim loop

Discord mission simulator

Mothership upgrades + Energy regen

NFT accessories auto-detection

On-ledger JETS payout system (hot mode)
```
### Phase 2  — Expansion
```
Crew NFT integration

Player-vs-Player dogfights

Leaderboards & seasonal resets

Jet Bazaar with on-ledger offers

JetFuel to JETS staking tiers
```
### Phase 3  — Full Launch
```
Open mint for new Jets

Marketplace bridge

Mobile optimization

DAO-style community upgrades

Multi-chain expansion (WAX, SOL, TON)
```
## Technical Appendix 
```XRPL Configuration
XRPL_WSS	wss://xrplcluster.com	Mainnet WebSocket
ISSUER_ADDR	rHz5qqAo57UnEsrMtw5croE4WnK3Z3J52e	JETS issuer (cold)
HOT_WALLET_SEED	server only	Signs payouts
CURRENCY_HEX	4A45545300000000000000000000000000000000	JETS hex code
TOKEN_MODE	hot or mock	Determines if claims hit XRPL
CLAIM_COOLDOWN_SEC	300	Cooldown between claims
ECON_SCALE	0.10	Reward scaling factor
JWT_SECRET	server only	HS256 signing key
CORS_ORIGIN	Allowed web origins	API access guard
```
Claim Logic (Server Flow)
```
Validate amount > 0, cooldown ok.

Atomic SQL debit of JetFuel.

Submit XRPL payment from hot → player trustline.

On error, rollback debit.

Persist audit log (wallet, amount, tx_hash).
```
### Trustline Requirements

Players must set a trustline for:
```
Currency: 4A45545300000000000000000000000000000000
Issuer:   rHz5qqAo57UnEsrMtw5croE4WnK3Z3J52e
Limit:    10,000,000
```

The “Set Trustline” button enforces this configuration automatically.

Security Principles

All wallet auth restricted to secp256k1.

Ed25519 signatures rejected at verification.

Nonces expire after 5 minutes.

Server authoritative for all balances and progression.

## Closing Statement 
```
XRPixel Jets represents a fusion of retro gaming, digital ownership, and transparent blockchain design.
It’s a living experiment in how a small team and passionate community can build something lasting —
where every upgrade, every claim, and every pixel in flight belongs to its pilot.
```
Built by players, for players.
— Terramike, Grid Wizard Labs, 2025
