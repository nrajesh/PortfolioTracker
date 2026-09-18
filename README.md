# Cloudflare Pages deploy package

Static site (`index.html`) + 5 Pages Functions ported from Netlify (`netlify/functions/*.js` → Cloudflare's `onRequest(context)` signature).

Functions live at `functions/.netlify/functions/*.js` on purpose — Cloudflare Pages routes a function by its file path under `functions/`, and the frontend already calls `/.netlify/functions/...`. Keeping that path avoids touching the bundled frontend at all.

## Deploy
- Push this folder's contents to `nrajesh/PortfolioTracker` (or a subfolder, setting that as the Pages build output directory).
- In Cloudflare dashboard: Workers & Pages → Create → Pages → connect the repo. Build command: none. Output directory: `/` (or wherever this folder lands).
- `_headers` replaces the `netlify.toml` cache-control rules (Pages reads `_headers` natively; no `_redirects` needed since no rewrites are used).

## Notes
- Functions use the Workers `fetch`/`Request`/`Response` runtime — no Node-specific APIs were used in the originals, so no rewrites were needed beyond the handler signature.
- `profile.js` caches a Yahoo auth crumb in a module-level variable (`crumbCache`) — on Cloudflare this resets per isolate the same way it does on Netlify's per-invocation coldstarts; behavior is unchanged.
- No environment variables or secrets are used by any function.
