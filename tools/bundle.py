#!/usr/bin/env python3
"""Unpack / repack the self-contained index.html bundle.

index.html is a bundler shell: the real page lives in a JSON-encoded
<script type="__bundler/template"> block, and its scripts/fonts in a
base64 (optionally gzipped) <script type="__bundler/manifest"> block.

  python3 tools/bundle.py unpack build/    # writes build/template.html + assets
  python3 tools/bundle.py pack build/      # writes build/template.html back into index.html

Only the template block is rewritten on pack; the manifest and loader are
left byte-for-byte as they were.
"""
import base64
import gzip
import json
import os
import re
import sys

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


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('unpack', 'pack'):
        sys.exit(__doc__)
    (unpack if sys.argv[1] == 'unpack' else pack)(sys.argv[2])
