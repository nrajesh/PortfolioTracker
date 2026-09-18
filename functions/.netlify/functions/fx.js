// GET /.netlify/functions/fx?base=EUR&symbols=USD,INR,GBP
// Returns Frankfurter's { base, date, rates } verbatim.
//
// Frankfurter sends no Access-Control-Allow-Origin, so a browser on our own
// origin cannot read the response - the call fails as a CORS error even when
// the API answered. Proxying it server-side sidesteps that, and gives a place
// to fall back to the alternate host when one of them is down (the .dev host
// intermittently returns 522).

const HOSTS = ['https://api.frankfurter.dev/v1/latest', 'https://api.frankfurter.app/latest'];

const HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*'
};

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const event = { queryStringParameters: Object.fromEntries(url.searchParams) };
  const q = event.queryStringParameters || {};
  const base = String(q.base || 'EUR').trim().toUpperCase();
  const symbols = String(q.symbols || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

  if (!symbols.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'symbols query param required' }) };
  }

  const qs = '?base=' + encodeURIComponent(base) + '&symbols=' + encodeURIComponent(symbols.join(','));
  const errors = [];

  for (const host of HOSTS) {
    try {
      const res = await fetch(host + qs, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (!j || !j.rates) throw new Error('no rates in response');
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(j) };
    } catch (e) {
      errors.push(host.replace(/^https:\/\//, '').split('/')[0] + ': ' + String(e && e.message || e));
    }
  }

  return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: errors.join(' / ') }) };
};
