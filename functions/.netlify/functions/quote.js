// GET /.netlify/functions/quote?symbols=VWCE.DE,SETFNN50.NS,0P0001IAU9.BO
// Returns { quotes: [{ symbol, price, currency, date }] }.
// Proxies Yahoo Finance's unofficial chart endpoint (no key, and no CORS
// headers of its own - hence the proxy). Symbols are used EXACTLY as given:
// the caller supplies the Yahoo code from its own file, including 0P… codes
// for Indian mutual funds, so nothing here resolves or guesses a listing.

async function yahooQuote(symbol) {
  const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=1d&interval=1d', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error('yahoo ' + res.status);
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  const meta = r && r.meta;
  if (!meta || !isFinite(meta.regularMarketPrice)) throw new Error('no price');
  const date = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10) : null;
  /* A .L line quoted in GBp (pence), or ILA/ZAc, is a hundredth of the major
     unit - reporting it as GBP would be a factor of 100 out. */
  const cur = meta.currency || null;
  const minor = /^(GBp|ILA|ZAc)$/.test(cur || '');
  return {
    price: minor ? meta.regularMarketPrice / 100 : meta.regularMarketPrice,
    currency: minor ? { GBp: 'GBP', ILA: 'ILS', ZAc: 'ZAR' }[cur] : cur,
    date
  };
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const event = { queryStringParameters: Object.fromEntries(url.searchParams) };
  const symbols = (event.queryStringParameters && event.queryStringParameters.symbols || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) {
    return new Response(JSON.stringify({ error: 'symbols query param required' }), { status: 400, headers: {} })
  }
  const quotes = await Promise.all(symbols.map(async symbol => {
    try {
      const y = await yahooQuote(symbol);
      return { symbol, price: y.price, currency: y.currency, date: y.date };
    } catch (e) {
      return { symbol, price: null, error: String(e && e.message || e) };
    }
  }));
  return new Response(JSON.stringify({ asked: symbols, quotes }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
