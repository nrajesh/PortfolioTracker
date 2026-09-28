// GET /.netlify/functions/history?symbol=IWDA.AS&from=2019-01-01
// Returns { symbol, currency, first, last, closes: { "YYYY-MM-DD": number }, via }.
//
// Same Yahoo chart endpoint the quote function proxies, asked for a daily
// series instead of a single day. Only adjusted-for-splits closes are kept:
// a benchmark comparison spanning a split would otherwise show a cliff that
// never happened.
//
// Thinly traded lines - Stuttgart-listed bonds such as XS2940466316.SG - trade
// a few days a year, so a daily request starting before the listing existed
// comes back empty though the symbol is valid. One escalation covers that:
// range=max at a weekly interval. Anything beyond that costs more than it
// returns - a long ladder run per symbol overruns the function's own time
// budget and the whole load stalls, which is worse than a named gap. Every
// fetch is therefore bounded, and there are at most three.

const TIMEOUT_MS = 4000;
// A plain "Mozilla/5.0", as quote and sparks use: Yahoo rate-limits a full
// desktop-Chrome string from server IPs.
const UA = 'Mozilla/5.0';

async function attempt(host, symbol, params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = 'https://' + host + '/v8/finance/chart/' + encodeURIComponent(symbol) + '?' + params;
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error('yahoo ' + res.status);
    const j = await res.json();
    const err = j && j.chart && j.chart.error;
    if (err) throw new Error(err.description || err.code || 'chart error');
    const r = j && j.chart && j.chart.result && j.chart.result[0];
    const ts = r && r.timestamp;
    if (!r || !Array.isArray(ts) || !ts.length) throw new Error('no series');
    const adj = r.indicators && r.indicators.adjclose && r.indicators.adjclose[0];
    const raw = r.indicators && r.indicators.quote && r.indicators.quote[0];
    const series = (adj && adj.adjclose) || (raw && raw.close) || [];
    const cur = (r.meta && r.meta.currency) || null;
    /* A .L line quoted in pence, or ILA/ZAc, is a hundredth of the major unit -
       matching the quote function so both sides speak the same currency. */
    const minor = /^(GBp|ILA|ZAc)$/.test(cur || '');
    const div = minor ? 100 : 1;
    const closes = {};
    let first = null, last = null;
    ts.forEach((t, i) => {
      const v = series[i];
      if (!isFinite(v) || v === null || v <= 0) return;
      const d = new Date(t * 1000).toISOString().slice(0, 10);
      closes[d] = v / div;
      if (!first || d < first) first = d;
      if (!last || d > last) last = d;
    });
    if (!first) throw new Error('series carried no usable closes');
    return {
      currency: minor ? { GBp: 'GBP', ILA: 'ILS', ZAc: 'ZAR' }[cur] : cur,
      first, last, closes
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const event = { queryStringParameters: Object.fromEntries(url.searchParams) };
  const q = event.queryStringParameters || {};
  const symbol = (q.symbol || '').trim();
  if (!symbol) {
    return new Response(JSON.stringify({ error: 'symbol query param required' }), { status: 400, headers: {} })
  }
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : '2015-01-01';
  const p1 = Math.floor(new Date(from + 'T00:00:00Z').getTime() / 1000);
  const p2 = Math.floor(Date.now() / 1000) + 86400;

  const plan = [
    ['query1.finance.yahoo.com', 'daily', 'period1=' + p1 + '&period2=' + p2 + '&interval=1d&events=div%2Csplit'],
    ['query2.finance.yahoo.com', 'daily (alt host)', 'period1=' + p1 + '&period2=' + p2 + '&interval=1d&events=div%2Csplit'],
    ['query1.finance.yahoo.com', 'weekly, full history', 'range=max&interval=1wk&events=div%2Csplit']
  ];

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let lastErr = 'no data';
  for (const [host, how, params] of plan) {
    try {
      const got = await attempt(host, symbol, params);
      return new Response(JSON.stringify(Object.assign({ symbol, via: how }, got)), { status: 200, headers: {
          'content-type': 'application/json',
          'cache-control': 'public, max-age=3600',
          'netlify-cdn-cache-control': 'public, durable, s-maxage=21600'
        } })
    } catch (e) {
      lastErr = String((e && e.name) === 'AbortError' ? 'timed out' : (e && e.message) || e);
      /* A 429 means the burst was too fast, not that the symbol is unknown -
         one backed-off retry turns most of them into data. */
      if (/429/.test(lastErr)) {
        await sleep(1200);
        try {
          const got = await attempt(host, symbol, params);
          return new Response(JSON.stringify(Object.assign({ symbol, via: how + ' (retried)' }, got)), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' } })
        } catch (e2) {
          lastErr = String((e2 && e2.name) === 'AbortError' ? 'timed out' : (e2 && e2.message) || e2);
        }
      }
    }
  }
  return new Response(JSON.stringify({ symbol, error: lastErr }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
