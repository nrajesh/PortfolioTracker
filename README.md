# Cloudflare Pages deploy package

Static site (`index.html`) + 5 Pages Functions ported from Netlify (`netlify/functions/*.js` → Cloudflare's `onRequest(context)` signature).

Functions live at `functions/.netlify/functions/*.js` on purpose — Cloudflare Pages routes a function by its file path under `functions/`, and the frontend already calls `/.netlify/functions/...`. Keeping that path avoids touching the bundled frontend at all.

## Deploy
- Push this folder's contents to `nrajesh/PortfolioTracker` (or a subfolder, setting that as the Pages build output directory).
- In Cloudflare dashboard: Workers & Pages → Create → Pages → connect the repo. Build command: none. Output directory: `/` (or wherever this folder lands).
- `_headers` replaces the `netlify.toml` cache-control rules (Pages reads `_headers` natively; no `_redirects` needed since no rewrites are used).

## Deploy packages (Cloudflare and Netlify)
```sh
python3 tools/package.py
```
writes `dist/plexin-cloudflare.zip` and `dist/plexin-netlify.zip` (plus unzipped copies in `dist/cloudflare/` and `dist/netlify/`), each with a `DEPLOY.md`. Both carry the same `index.html`:

- **Cloudflare**: `index.html`, `_headers` and the functions as they are in this repo. Deploy with `npx wrangler pages deploy . --project-name <project> --branch <branch>`. Dashboard drag-and-drop does not build the functions folder.
- **Netlify**: `index.html`, `netlify.toml` and `netlify/functions/*.mjs`, which are this repo's functions plus a Functions v2 default export (`request => onRequest({ request })`). Deploy with `npx netlify-cli deploy --site <site> [--prod]`.

The script stops if a function starts reading anything from `context` other than `request`, since the Netlify entry would not pass it. `dist/` is not committed.

## Notes
- Functions use the Workers `fetch`/`Request`/`Response` runtime — no Node-specific APIs were used in the originals, so no rewrites were needed beyond the handler signature.
- `profile.js` caches a Yahoo auth crumb in a module-level variable (`crumbCache`) — on Cloudflare this resets per isolate the same way it does on Netlify's per-invocation coldstarts; behavior is unchanged.
- No environment variables or secrets are used by any function.

## Editing the frontend
`index.html` is a self-contained bundle: the page source is a JSON string inside `<script type="__bundler/template">`, with scripts and fonts base64-packed in the manifest. To change the UI:

```sh
python3 tools/bundle.py unpack build/   # build/template.html is the readable source
# edit build/template.html
python3 tools/bundle.py pack build/     # writes it back into index.html
```

`pack` only rewrites the template block; an unpack → pack with no edits reproduces `index.html` byte-for-byte. `build/` is scratch and not committed.
