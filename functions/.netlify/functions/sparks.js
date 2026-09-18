// GET /.netlify/functions/sparks?symbols=VWCE.DE,MSFT&range=5y
// Returns { series: { SYMBOL: { closes: {"YYYY-MM-DD": n}, currency } }, missing, reasons }
//
// This deliberately makes the SAME call the quote function makes, because that
// call demonstrably works: the chart endpoint, a plain "Mozilla/5.0", no
// cookie, no crumb, no extra query parameters. Earlier versions used the spark
// endpoint with a browser-like User-Agent plus a consent cookie and crumb, and
// Yahoo answered 429 in under a second every time - it was the dressing-up
// that got refused, not the volume (quote fetches 26 symbols in parallel
// without complaint). Only the range differs from quote's.
//
// One browser request covers a whole chunk of symbols, which is the point:
// the client no longer fires one request per instrument.

const UA = 'Mozilla/5.0';
const RANGES = ['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max'];

async function chartOne(symbol, range, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
      + encodeURIComponent(symbol) + '?range=' + range + '&interval=1d';
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error('yahoo ' + res.status);
    const j = await res.json();
    const r = j && j.chart && j.chart.result && j.chart.result[0];
    const ts = r && r.timestamp;
    if (!Array.isArray(ts) || !ts.length) throw new Error('no series');
    /* Adjusted closes when present, so a split does not draw a cliff. */
    const adj = r.indicators && r.indicators.adjclose && r.indicators.adjclose[0];
    const raw = r.indicators && r.indicators.quote && r.indicators.quote[0];
    const arr = (adj && adj.adjclose) || (raw && raw.close) || [];
    const cur = (r.meta && r.meta.currency) || null;
    const minor = /^(GBp|ILA|ZAc)$/.test(cur || '');
    const closes = {};
    ts.forEach((t, i) => {
      const v = arr[i];
      if (!isFinite(v) || v === null || v <= 0) return;
      closes[new Date(t * 1000).toISOString().slice(0, 10)] = minor ? v / 100 : v;
    });
    if (!Object.keys(closes).length) throw new Error('no usable closes');
    return { closes, currency: minor ? { GBp: 'GBP', ILA: 'ILS', ZAc: 'ZAR' }[cur] : cur };
  } finally {
    clearTimeout(timer);
  }
}

/* A second provider for anything Yahoo will not serve. Stooq is free CSV with
   no key; its symbol names differ, and it has no Indian mutual funds or UCITS
   ETFs, so it is a supplement rather than a replacement. */
const STOOQ_ALIAS = {
  '^GSPC': '^spx', '^IXIC': '^ndq', '^NDX': '^ndx', '^DJI': '^dji',
  '^GDAXI': '^dax', '^FTSE': '^ukx', '^STOXX50E': '^stx50',
  '^NSEI': '^nifty', '^BSESN': '^sensex', '^N225': '^nkx'
};

function stooqSymbol(sym) {
  const up = sym.toUpperCase();
  if (STOOQ_ALIAS[up]) return STOOQ_ALIAS[up];
  if (up.charAt(0) === '^') return null;
  const dot = up.lastIndexOf('.');
  if (dot < 0) return up.toLowerCase() + '.us';
  const base = up.slice(0, dot).toLowerCase();
  const suffix = { L: 'uk', DE: 'de', F: 'de', SG: 'de', MU: 'de', BE: 'de', DU: 'de', PA: 'fr', AS: 'nl', MI: 'it', MC: 'es', SW: 'ch' }[up.slice(dot + 1)];
  return suffix ? base + '.' + suffix : null;
}

async function stooqOne(symbol, ms) {
  const s = stooqSymbol(symbol);
  if (!s) throw new Error('no Stooq equivalent');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch('https://stooq.com/q/d/l/?s=' + encodeURIComponent(s) + '&i=d', { signal: ctrl.signal });
    if (!res.ok) throw new Error('stooq ' + res.status);
    const text = await res.text();
    const lines = text.trim().split('\n');
    if (lines.length < 3 || !/^Date/i.test(lines[0])) throw new Error('stooq has no series for ' + s);
    const cols = lines[0].split(',').map(x => x.trim().toLowerCase());
    const di = cols.indexOf('date'), ci = cols.indexOf('close');
    if (di < 0 || ci < 0) throw new Error('unexpected stooq columns');
    const closes = {};
    lines.slice(1).forEach(l => {
      const c = l.split(',');
      const d = (c[di] || '').trim();
      const v = parseFloat(c[ci]);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && isFinite(v) && v > 0) closes[d] = v;
    });
    if (!Object.keys(closes).length) throw new Error('stooq returned no closes');
    return { closes, currency: null, via: 'stooq ' + s };
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const event = { queryStringParameters: Object.fromEntries(url.searchParams) };
  const q = event.queryStringParameters || {};
  const symbols = (q.symbols || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
  if (!symbols.length) {
    return new Response(JSON.stringify({ error: 'symbols query param required' }), { status: 400, headers: {} })
  }
  const range = RANGES.includes(q.range) ? q.range : 'max';

  /* Parallel, exactly as the quote function does it - it fetches 26 symbols at
     once without being refused. Everything is bounded so the invocation always
     returns inside the platform's limit. */
  const T0 = Date.now();
  const series = {}, missing = [], reasons = {};

  await Promise.all(symbols.map(async symbol => {
    let why = '';
    try {
      series[symbol] = await chartOne(symbol, range, 6000);
      return;
    } catch (e) {
      why = String((e && e.name) === 'AbortError' ? 'timed out' : (e && e.message) || e);
    }
    try {
      series[symbol] = await stooqOne(symbol, 2500);
      return;
    } catch (e2) {
      why += ' · ' + String((e2 && e2.message) || e2);
    }
    reasons[symbol] = why;
    missing.push(symbol);
  }));

  return new Response(JSON.stringify({ series, missing, reasons, range, ms: Date.now() - T0 }), { status: 200, headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
      /* Netlify's edge cache: the same symbols asked for again cost Yahoo
         nothing at all. */
      'netlify-cdn-cache-control': 'public, durable, s-maxage=21600'
    } })
}
