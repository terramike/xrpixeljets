# XRPixelJets

Canonical source repo for the XRPixelJets client and backend.

## Layout

- `js/`: client-side game modules and browser helpers
- `server/`: Fastify backend used by the game client

## Runtime config

The client now supports centralized host configuration through globals set before the app boots:

- `JETS_CLIENT_ASSET_BASE`: base URL used to load client scripts
- `JETS_API_BASE`: backend API base URL
- `JETS_WEB_BASE`: legacy/current web base used for game assets and return URLs

Defaults preserve the current live behavior:

- web base: `https://mykeygo.io/jets`
- API base: `https://xrpixeljets.onrender.com`

For repo-hosted or custom-domain cutovers, override those values instead of editing individual modules.
