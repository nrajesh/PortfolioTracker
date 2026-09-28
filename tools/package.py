#!/usr/bin/env python3
"""Build ready-to-deploy packages for Cloudflare Pages and Netlify.

  python3 tools/package.py      # writes dist/cloudflare/, dist/netlify/ and a .zip of each

Both packages carry the same index.html. The functions are written once, in
Cloudflare's format (functions/.netlify/functions/*.js, onRequest(context));
the Netlify copies are that same code plus a Functions v2 default export that
hands Netlify's Request to onRequest, so the two hosts cannot drift apart.
Both hosts serve the functions at /.netlify/functions/<name>, the path the
page already calls.
"""
import os
import re
import shutil
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FN_DIR = os.path.join(ROOT, 'functions', '.netlify', 'functions')
DIST = os.path.join(ROOT, 'dist')

NETLIFY_ENTRY = '''
/* Netlify Functions (v2) entry point. Netlify calls the default export with a
   standard Request and serves it at /.netlify/functions/<file name>; the
   Cloudflare handler above does the work. */
export default request => onRequest({ request });
'''

NETLIFY_TOML = '''# Publish this folder as-is (no build step) and deploy netlify/functions,
# which Netlify serves at /.netlify/functions/<name>.
[build]
  publish = "."
  functions = "netlify/functions"

# Always revalidate the page, so a new deploy shows on the next load.
[[headers]]
  for = "/"
  [headers.values]
    Cache-Control = "no-cache, must-revalidate"

[[headers]]
  for = "/index.html"
  [headers.values]
    Cache-Control = "no-cache, must-revalidate"
'''

CLOUDFLARE_README = '''# Plexin Ledger - Cloudflare Pages package

index.html, _headers and five Pages Functions in functions/.netlify/functions/.

Deploy with Wrangler from this folder. Dashboard drag-and-drop uploads only
static files and does not build the functions folder, so prices and FX would
stop working.

    npx wrangler login
    npx wrangler pages deploy . --project-name <project> --branch <branch>

--branch main (or your production branch) publishes to production; any other
branch name creates a preview deployment with its own URL.

A Pages project connected to the Git repository deploys a branch when it is
pushed, with no package needed.
'''

NETLIFY_README = '''# Plexin Ledger - Netlify package

index.html, netlify.toml and five functions in netlify/functions/.

Deploy with the Netlify CLI from this folder, which uploads the page and the
functions together:

    npx netlify-cli login
    npx netlify-cli deploy --site <site id or name>          # draft preview URL
    npx netlify-cli deploy --site <site id or name> --prod   # production

The functions need no environment variables.
'''


def function_names():
    names = sorted(f[:-3] for f in os.listdir(FN_DIR) if f.endswith('.js'))
    if not names:
        raise SystemExit('no functions found in ' + FN_DIR)
    return names


def read_function(name):
    src = open(os.path.join(FN_DIR, name + '.js'), encoding='utf-8').read()
    # The Netlify entry passes only the request. Refuse to package a function
    # that has started reading anything else from the Cloudflare context
    # (env, params, waitUntil), rather than shipping one that breaks at runtime.
    if 'export async function onRequest(context)' not in src:
        raise SystemExit(name + '.js: expected "export async function onRequest(context)"')
    other = sorted(set(re.findall(r'\bcontext\.(\w+)', src)) - {'request'})
    if other:
        raise SystemExit(name + '.js reads context.' + ', context.'.join(other) + '; extend NETLIFY_ENTRY first')
    return src


def fresh(path):
    shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path)
    return path


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def zip_dir(src, dest):
    with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:
        for base, dirs, files in os.walk(src):
            dirs.sort()
            for f in sorted(files):
                full = os.path.join(base, f)
                z.write(full, os.path.relpath(full, src))


def main():
    names = function_names()
    sources = {n: read_function(n) for n in names}
    os.makedirs(DIST, exist_ok=True)

    cf = fresh(os.path.join(DIST, 'cloudflare'))
    shutil.copy2(os.path.join(ROOT, 'index.html'), cf)
    shutil.copy2(os.path.join(ROOT, '_headers'), cf)
    os.makedirs(os.path.join(cf, 'functions', '.netlify', 'functions'))
    for n in names:
        shutil.copy2(os.path.join(FN_DIR, n + '.js'), os.path.join(cf, 'functions', '.netlify', 'functions'))
    write(os.path.join(cf, 'DEPLOY.md'), CLOUDFLARE_README)

    nl = fresh(os.path.join(DIST, 'netlify'))
    shutil.copy2(os.path.join(ROOT, 'index.html'), nl)
    write(os.path.join(nl, 'netlify.toml'), NETLIFY_TOML)
    for n in names:
        # .mjs so Netlify loads the ES module syntax without a package.json.
        write(os.path.join(nl, 'netlify', 'functions', n + '.mjs'), sources[n].rstrip('\n') + '\n' + NETLIFY_ENTRY)
    write(os.path.join(nl, 'DEPLOY.md'), NETLIFY_README)

    for host, folder in (('cloudflare', cf), ('netlify', nl)):
        dest = os.path.join(DIST, 'plexin-%s.zip' % host)
        zip_dir(folder, dest)
        print('%-10s %s (%d KB)' % (host, os.path.relpath(dest, ROOT), os.path.getsize(dest) // 1024))
    print('functions:', ', '.join(names))


if __name__ == '__main__':
    main()
