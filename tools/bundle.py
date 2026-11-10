#!/usr/bin/env python3
"""Unpack / repack the self-contained index.html bundle.

index.html is a bundler shell: the real page lives in a JSON-encoded
<script type="__bundler/template"> block, and its scripts/fonts in a
base64 (optionally gzipped) <script type="__bundler/manifest"> block.

  python3 tools/bundle.py unpack build/    # writes build/template.html + assets
  python3 tools/bundle.py pack build/      # writes build/template.html back into index.html
  python3 tools/bundle.py prune build/     # drops packed fonts the template no longer uses
  python3 tools/bundle.py add font.woff2   # packs a font file and prints the id to use in url("...")

Only the template block is rewritten on pack; the manifest and loader are
left byte-for-byte as they were. prune and add are the two commands that edit
the manifest: prune removes font entries whose id no longer appears in the
page, add packs a new .woff2 under a fresh id.
"""
import base64
import gzip
import json
import os
import re
import sys
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, 'index.html')


def block_re(kind):
    return re.compile(r'(<script type="__bundler/%s">)(.*?)(</script>)' % re.escape(kind), re.S)


def unpack(out):
    html = open(INDEX, encoding='utf-8').read()
    os.makedirs(out, exist_ok=True)
    tpl = json.loads(block_re('template').search(html).group(2))
    open(os.path.join(out, 'template.html'), 'w', encoding='utf-8').write(tpl)
    manifest = json.loads(block_re('manifest').search(html).group(2))
    for uuid, entry in manifest.items():
        data = base64.b64decode(entry['data'])
        if entry.get('compressed'):
            data = gzip.decompress(data)
        ext = entry['mime'].split('/')[-1].replace('javascript', 'js')
        open(os.path.join(out, '%s.%s' % (uuid, ext)), 'wb').write(data)
    print('unpacked template + %d assets into %s' % (len(manifest), out))


def pack(src):
    html = open(INDEX, encoding='utf-8').read()
    tpl = open(os.path.join(src, 'template.html'), encoding='utf-8').read()
    # The loader JSON.parses the block's textContent, so "</" must not close
    # the <script> element early.
    enc = json.dumps(tpl, ensure_ascii=False).replace('</', '<\\u002F')
    m = block_re('template').search(html)
    body = m.group(2)
    lead = body[:len(body) - len(body.lstrip())]
    trail = body[len(body.rstrip()):]
    html = html[:m.start(2)] + lead + enc + trail + html[m.end(2):]
    open(INDEX, 'w', encoding='utf-8').write(html)
    print('packed %s into index.html (%d bytes)' % (src, len(html.encode('utf-8'))))


def prune(_src):
    html = open(INDEX, encoding='utf-8').read()
    m = block_re('manifest').search(html)
    manifest = json.loads(m.group(2))
    page = html[:m.start(2)] + html[m.end(2):]
    unused = [u for u, e in manifest.items() if e['mime'].startswith('font/') and u not in page]
    if not unused:
        print('nothing to prune')
        return
    for u in unused:
        del manifest[u]
    html = write_manifest(html, m, manifest)
    open(INDEX, 'w', encoding='utf-8').write(html)
    print('pruned %d unused fonts; index.html is now %d bytes' % (len(unused), len(html.encode('utf-8'))))


def write_manifest(html, m, manifest):
    body = m.group(2)
    lead = body[:len(body) - len(body.lstrip())]
    trail = body[len(body.rstrip()):]
    enc = json.dumps(manifest, ensure_ascii=False, separators=(',', ':'))
    return html[:m.start(2)] + lead + enc + trail + html[m.end(2):]


def add(path):
    if not path.endswith('.woff2'):
        sys.exit('add takes a .woff2 file')
    html = open(INDEX, encoding='utf-8').read()
    m = block_re('manifest').search(html)
    manifest = json.loads(m.group(2))
    data = base64.b64encode(open(path, 'rb').read()).decode('ascii')
    for u, e in manifest.items():
        if e['data'] == data:
            print(u)
            return
    new_id = str(uuid.uuid4())
    manifest[new_id] = {'mime': 'font/woff2', 'compressed': False, 'data': data}
    open(INDEX, 'w', encoding='utf-8').write(write_manifest(html, m, manifest))
    print(new_id)


if __name__ == '__main__':
    cmds = {'unpack': unpack, 'pack': pack, 'prune': prune, 'add': add}
    if len(sys.argv) != 3 or sys.argv[1] not in cmds:
        sys.exit(__doc__)
    cmds[sys.argv[1]](sys.argv[2])
