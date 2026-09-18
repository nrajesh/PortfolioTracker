// GET /.netlify/functions/profile?symbols=VWCE.DE,IWDA.AS
// Returns { profiles: { <symbol>: { yield, divRate, divDate, ter, family,
//   legalType, category, exchange, quoteType, name } } }
//
// Two upstream calls per symbol, both unofficial and both best-effort:
//
//   v7/finance/quote     - dividend yield / rate / next pay date. Cheap, wide
//                          coverage, but Yahoo gates it behind a crumb.
//   quoteSummary?modules - expense ratio, fund family, legal structure. Only
//     =fundProfile,        populated for funds Yahoo actually profiles, which
//      defaultKeyStatistics in practice means US and Ireland-domiciled listings;
//                          European venue listings often come back empty.
//
// Anything missing comes back null rather than guessed - a blank cell in the
// UI is honest, an invented TER is not.

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36' };

let crumbCache = null;

/* The quote and quoteSummary endpoints require a cookie plus a matching
   crumb. One handshake serves every symbol in the batch. */
async function auth() {
  if (crumbCache && Date.now() - crumbCache.at < 30 * 60 * 1000) return crumbCache;
  const r1 = await fetch('https://fc.yahoo.com', { headers: UA, redirect: 'manual' });
  const cookie = (r1.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('no cookie');
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: Object.assign({ cookie }, UA)
  });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.length > 32) throw new Error('no crumb');
  crumbCache = { cookie, crumb, at: Date.now() };
  return crumbCache;
}

const num = v => (v && typeof v === 'object' ? v.raw : v);

const isIsin = s => /^[A-Z]{2}[0-9A-Z]{9}[0-9]$/.test(String(s || '').trim().toUpperCase());

/* Yahoo's quote and quoteSummary endpoints only answer to their own tickers,
   so a ledger that identifies a holding by ISIN gets nothing back. The search
   endpoint does resolve an ISIN - it returns the listings carrying it - so an
   ISIN is turned into a ticker first. European ISINs usually resolve to
   several venue listings; the first equity/ETF hit is taken, since the
   profile fields asked for here (issuer, structure, TER) are properties of
   the fund and identical across its listings. */
async function resolveSymbol(code, a) {
  if (!isIsin(code)) return code;
  const url = 'https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(code)
    + '&quotesCount=8&newsCount=0&crumb=' + encodeURIComponent(a.crumb);
  const res = await fetch(url, { headers: Object.assign({ cookie: a.cookie }, UA) });
  if (!res.ok) return code;
  const j = await res.json();
  const hits = (j && j.quotes) || [];
  const good = hits.find(q => q.symbol && /ETF|MUTUALFUND|EQUITY/i.test(q.quoteType || ''));
  return (good && good.symbol) || (hits[0] && hits[0].symbol) || code;
}

async function quoteFields(symbols, a) {
  const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols='
    + encodeURIComponent(symbols.join(',')) + '&crumb=' + encodeURIComponent(a.crumb);
  const res = await fetch(url, { headers: Object.assign({ cookie: a.cookie }, UA) });
  if (!res.ok) throw new Error('quote ' + res.status);
  const j = await res.json();
  const out = {};
  ((j.quoteResponse && j.quoteResponse.result) || []).forEach(q => {
    out[q.symbol] = {
      name: q.longName || q.shortName || null,
      exchange: q.fullExchangeName || null,
      quoteType: q.quoteType || null,
      /* Yahoo reports an equity yield as a fraction and a fund's as a
         percentage already - normalise both to percent. */
      yield: isFinite(q.trailingAnnualDividendYield) ? q.trailingAnnualDividendYield * 100
        : (isFinite(q.yield) ? q.yield * 100 : (isFinite(q.trailingPE) ? null : null)),
      divRate: isFinite(q.trailingAnnualDividendRate) ? q.trailingAnnualDividendRate : null,
      divDate: q.dividendDate ? new Date(q.dividendDate * 1000).toISOString().slice(0, 10) : null
    };
  });
  return out;
}

async function fundProfile(symbol, a) {
  const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(symbol)
    + '?modules=fundProfile,defaultKeyStatistics,summaryProfile&crumb=' + encodeURIComponent(a.crumb);
  const res = await fetch(url, { headers: Object.assign({ cookie: a.cookie }, UA) });
  if (!res.ok) return null;
  const j = await res.json();
  const r = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
  if (!r) return null;
  const fp = r.fundProfile || {};
  const ks = r.defaultKeyStatistics || {};
  const fees = fp.feesExpensesInvestment || {};
  const ter = num(fees.annualReportExpenseRatio) != null ? num(fees.annualReportExpenseRatio)
    : num(ks.annualReportExpenseRatio);
  return {
    /* Reported as a fraction (0.0022), shown as a percentage. */
    ter: isFinite(ter) ? ter * 100 : null,
    family: fp.family || null,
    legalType: fp.legalType || null,
    category: fp.categoryName || (r.summaryProfile && r.summaryProfile.industry) || null
  };
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const event = { queryStringParameters: Object.fromEntries(url.searchParams) };
  const symbols = (event.queryStringParameters && event.queryStringParameters.symbols || '')
    .split(',').map(s => s.trim()).filter(Boolean).slice(0, 60);
  if (!symbols.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'symbols query param required' }) };
  }
  let a;
  try {
    a = await auth();
  } catch (e) {
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ profiles: {}, error: 'yahoo auth failed: ' + String(e && e.message || e) })
    };
  }
  /* Resolve every ISIN to a ticker before asking for anything. */
  const resolved = {};
  await Promise.all(symbols.map(async s => {
    try { resolved[s] = await resolveSymbol(s, a); } catch (e) { resolved[s] = s; }
  }));
  const tickers = [...new Set(Object.values(resolved))];
  let quotes = {};
  try { quotes = await quoteFields(tickers, a); } catch (e) { quotes = {}; }
  const profiles = {};
  await Promise.all(symbols.map(async s => {
    const t = resolved[s] || s;
    let fp = null;
    try { fp = await fundProfile(t, a); } catch (e) { fp = null; }
    const q = quotes[t] || {};
    profiles[s] = {
      resolved: t !== s ? t : null,
      name: q.name || null, exchange: q.exchange || null, quoteType: q.quoteType || null,
      yield: q.yield != null ? q.yield : null,
      divRate: q.divRate != null ? q.divRate : null,
      divDate: q.divDate || null,
      ter: fp && fp.ter != null ? fp.ter : null,
      family: (fp && fp.family) || null,
      legalType: (fp && fp.legalType) || null,
      category: (fp && fp.category) || null,
      /* Nothing came back at all - said plainly, so the UI can distinguish
         "Yahoo has no data for this listing" from "not fetched yet". */
      empty: !q.name && !(fp && (fp.ter != null || fp.family))
    };
  }));
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ asked: symbols, profiles })
  };
};
