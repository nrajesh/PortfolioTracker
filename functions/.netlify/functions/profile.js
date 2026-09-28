// GET /.netlify/functions/profile?symbols=VWCE.DE,IWDA.AS
// Returns { profiles: { <symbol>: { yield, divRate, divDate, ter, family,
//   legalType, category, exchange, quoteType, name, sector, industry,
//   sectors, stockPct, isin, via } } }
//
// Optional &isins=<isin>,<isin> (positional, blank where unknown) lets a fund
// listing Yahoo leaves bare be filled from another listing of the same ISIN.
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
async function listingsFor(isin, a) {
  const url = 'https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(isin)
    + '&quotesCount=10&newsCount=0&crumb=' + encodeURIComponent(a.crumb);
  const res = await fetch(url, { headers: Object.assign({ cookie: a.cookie }, UA) });
  if (!res.ok) return [];
  const j = await res.json();
  return ((j && j.quotes) || []).filter(q => q.symbol);
}

async function resolveSymbol(code, a) {
  if (!isIsin(code)) return code;
  const hits = await listingsFor(code, a);
  const good = hits.find(q => /ETF|MUTUALFUND|EQUITY/i.test(q.quoteType || ''));
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

async function summary(symbol, modules, a) {
  const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(symbol)
    + '?modules=' + modules + '&crumb=' + encodeURIComponent(a.crumb);
  const res = await fetch(url, { headers: Object.assign({ cookie: a.cookie }, UA) });
  if (!res.ok) return null;
  const j = await res.json();
  return (j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0]) || null;
}

async function fundProfile(symbol, a) {
  const r = await summary(symbol, 'fundProfile,defaultKeyStatistics,summaryProfile', a);
  return r ? readProfile(r) : null;
}

function readProfile(r) {
  const fp = r.fundProfile || {};
  const ks = r.defaultKeyStatistics || {};
  const fees = fp.feesExpensesInvestment || {};
  const ter = num(fees.annualReportExpenseRatio) != null ? num(fees.annualReportExpenseRatio)
    : num(ks.annualReportExpenseRatio);
  const sp = r.summaryProfile || {};
  return {
    /* Reported as a fraction (0.0022), shown as a percentage. */
    ter: isFinite(ter) ? ter * 100 : null,
    family: fp.family || null,
    legalType: fp.legalType || null,
    category: fp.categoryName || sp.industry || null,
    /* A company's own sector and industry. Funds carry neither here - their
       sectors are weights, read from topHoldings instead. */
    sector: sp.sector ? sectorLabel(sp.sector) : null,
    industry: sp.industry || null
  };
}

/* Yahoo's sector keys, in the words a reader would use. */
const SECTOR_LABELS = {
  technology: 'Technology', financial_services: 'Financial services', healthcare: 'Healthcare',
  consumer_cyclical: 'Consumer cyclical', consumer_defensive: 'Consumer defensive',
  industrials: 'Industrials', communication_services: 'Communication services',
  energy: 'Energy', basic_materials: 'Basic materials', utilities: 'Utilities', realestate: 'Real estate'
};

/* A company's sector arrives as a display name ("Financial Services") and a
   fund's as a key ("financial_services"). Both are the same eleven-sector
   scheme, so both are folded onto one label - otherwise a stock and a fund
   in the same sector would land in two buckets of a sector split. */
const SECTOR_BY_BARE = Object.fromEntries(Object.keys(SECTOR_LABELS).map(k => [k.replace(/[^a-z]/g, ''), SECTOR_LABELS[k]]));
const sectorLabel = s => SECTOR_BY_BARE[String(s).toLowerCase().replace(/[^a-z]/g, '')] || String(s);

/* Sector weights of a fund's equity holdings, from quoteSummary's topHoldings
   module - the same endpoint and crumb as fundProfile. Asked in a call of its
   own and only for funds: a share has no such module, and folding it into the
   profile call would risk losing the TER and issuer on a rejected module.
   Yahoo publishes no country or region breakdown in any module, so there is
   no geography counterpart to this. Weights come back as fractions of the
   equity sleeve; an empty or all-zero list is returned as null. stockPct is
   the share of the fund held in shares at all, so a mixed fund's bond sleeve
   is not read as more equity. */
async function fundSectors(symbol, a) {
  const r = await summary(symbol, 'topHoldings', a);
  return r ? readSectors(r) : null;
}

function readSectors(r) {
  const th = (r && r.topHoldings) || {};
  const out = [];
  (th.sectorWeightings || []).forEach(o => Object.keys(o || {}).forEach(k => {
    const w = num(o[k]);
    if (isFinite(w) && w > 0) out.push({ key: k, label: sectorLabel(k), pct: w * 100 });
  }));
  const stock = num(th.stockPosition);
  return {
    sectors: out.length ? out.sort((x, y) => y.pct - x.pct) : null,
    stockPct: isFinite(stock) ? stock * 100 : null
  };
}

/* Yahoo profiles a fund per LISTING, not per fund: the XETRA line of a UCITS
   ETF often comes back bare while its London or Milan line carries the full
   profile. Every listing of one ISIN is the same share class - same holdings,
   same TER, same issuer - so when the asked-for listing is missing fund data,
   the other listings of that ISIN are tried in turn and the gaps filled from
   the first that has them. Only fund listings are tried, at most five, each
   in one call; the listing that supplied the data is returned as `via` so
   the UI can say where a figure came from. */
async function siblingFill(isin, primary, have, a) {
  const hits = (await listingsFor(isin, a))
    .filter(q => q.symbol !== primary && /ETF|MUTUALFUND/i.test(q.quoteType || ''))
    .slice(0, 5);
  const got = {};
  for (const q of hits) {
    let r = null;
    try { r = await summary(q.symbol, 'fundProfile,defaultKeyStatistics,topHoldings', a); } catch (e) { r = null; }
    if (!r) continue;
    const pf = readProfile(r), sx = readSectors(r);
    const used = [];
    if (!have.sectors && !got.sectors && sx.sectors) { got.sectors = sx.sectors; got.stockPct = sx.stockPct; used.push('sectors'); }
    ['ter', 'family', 'legalType', 'category'].forEach(k => {
      if (have[k] == null && got[k] == null && pf[k] != null) { got[k] = pf[k]; used.push(k); }
    });
    if (used.length) (got.via = got.via || []).push({ symbol: q.symbol, fields: used });
    if ((have.sectors || got.sectors) && ['ter', 'family', 'legalType'].every(k => have[k] != null || got[k] != null)) break;
  }
  return got;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const event = { queryStringParameters: Object.fromEntries(url.searchParams) };
  const symbols = (event.queryStringParameters && event.queryStringParameters.symbols || '')
    .split(',').map(s => s.trim()).filter(Boolean).slice(0, 60);
  /* Optional ISINs, positionally matched to symbols (blank where unknown).
     A symbol that is itself an ISIN needs none. */
  const isinList = (event.queryStringParameters && event.queryStringParameters.isins || '').split(',');
  const isinOf = {};
  symbols.forEach((s, i) => {
    const v = String(isinList[i] || '').trim().toUpperCase();
    isinOf[s] = isIsin(s) ? s.toUpperCase() : (isIsin(v) ? v : null);
  });
  if (!symbols.length) {
    return new Response(JSON.stringify({ error: 'symbols query param required' }), { status: 400, headers: {} })
  }
  let a;
  try {
    a = await auth();
  } catch (e) {
    return new Response(JSON.stringify({ profiles: {}, error: 'yahoo auth failed: ' + String(e && e.message || e) }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
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
    const isFund = /ETF|MUTUALFUND/i.test(q.quoteType || '') || !!(fp && (fp.legalType || fp.ter != null));
    let fs = null;
    if (isFund) {
      try { fs = await fundSectors(t, a); } catch (e) { fs = null; }
    }
    /* A listing that looks like a fund by name or type but came back without
       fund data gets the same-ISIN fallback. A quote type of EQUITY with a
       company sector is a share and is left alone. */
    const fundish = isFund || (!(fp && fp.sector) && !/EQUITY/i.test(q.quoteType || ''));
    let sib = {};
    const have = {
      sectors: fs && fs.sectors, ter: fp && fp.ter, family: fp && fp.family,
      legalType: fp && fp.legalType, category: fp && fp.category
    };
    if (fundish && isinOf[s] && (!have.sectors || have.ter == null || !have.family)) {
      try { sib = await siblingFill(isinOf[s], t, have, a); } catch (e) { sib = {}; }
    }
    if (sib.sectors) fs = { sectors: sib.sectors, stockPct: sib.stockPct };
    fp = Object.assign({}, fp || {}, Object.fromEntries(['ter', 'family', 'legalType', 'category'].filter(k => sib[k] != null).map(k => [k, sib[k]])));
    const fundNow = isFund || !!(sib.sectors || sib.ter != null || sib.family);
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
      sector: (!fundNow && fp && fp.sector) || null,
      industry: (!fundNow && fp && fp.industry) || null,
      isin: isinOf[s] || null,
      via: sib.via || null,
      sectors: (fs && fs.sectors) || null,
      stockPct: fs && fs.sectors && fs.stockPct != null ? fs.stockPct : null,
      /* Nothing came back at all - said plainly, so the UI can distinguish
         "Yahoo has no data for this listing" from "not fetched yet". */
      empty: !q.name && !(fp && (fp.ter != null || fp.family)) && !(fs && fs.sectors)
    };
  }));
  return new Response(JSON.stringify({ asked: symbols, profiles }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
