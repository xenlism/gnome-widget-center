// Shared logic for the Stock Markets widgets (stock-markets-1x1 / stock-markets-2x1).
//
// Plain module: NO gi:// imports at top level. Anything that needs Soup or GLib
// receives the module as an argument (createStockFetcher), so this file can be
// imported by the GTK4 prefs process and unit-tested in plain Node with a
// mocked fetcher. Colour / font / cairo helpers are shared with the crypto kit.
//
// Data providers (all free; only twelvedata needs a key)
//   yahoo   Yahoo Finance chart endpoint. Global tickers (AAPL, PTT.BK, ^GSPC,
//           THB=X ...). One request per symbol returns price, previous close
//           and an intraday / multi-day price series for the graph.
//   nasdaq  api.nasdaq.com quote endpoints. US-listed stocks only; the graph
//           is the current (or last) trading day, whatever graph range is set.
//   stooq   stooq.com daily CSV (no key). US + many exchanges; no .BK (Thailand).
//   cnbc    CNBC quote service (no key). Price and change only, no graph.
//   twelvedata  Twelve Data time_series. Needs a free API key; daily graph.
//   auto    yahoo -> stooq -> cnbc -> nasdaq -> twelvedata, per symbol.
//
// Most endpoints are unofficial / undocumented, so every parser is defensive:
// a missing field becomes null ("--" in the UI), never an exception.

export {
    formatPrice, formatChange, currencyPrefix, cssRgba, parseHexColor, fontCss, paintSparkline
} from "./cryptoMarketsKit.js";

export const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
export const NASDAQ_QUOTE_URL = "https://api.nasdaq.com/api/quote";

export const PROVIDER_NAMES = Object.freeze({
    yahoo: "Yahoo Finance",
    stooq: "Stooq",
    cnbc: "CNBC",
    nasdaq: "Nasdaq",
    twelvedata: "Twelve Data",
    auto: "Auto"
});

// "auto" tries these in order, per symbol, until one answers.
// twelvedata is skipped unless an API key is set.
const AUTO_ORDER = Object.freeze(["yahoo", "stooq", "cnbc", "nasdaq", "twelvedata"]);

export const MAX_SYMBOLS = 8;

// graph range -> Yahoo chart parameters
export const RANGES = Object.freeze({
    "1d": { range: "1d", interval: "5m" },
    "5d": { range: "5d", interval: "30m" },
    "1mo": { range: "1mo", interval: "1d" }
});

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---------------------------------------------------------------- symbols

// "AAPL" | "aapl" | "PTT.BK" | "^GSPC" | "BRK-B" | "KBANK.BK:Kasikorn"
//   ->  { symbol, label, name }   (null if unusable)
// The part after ":" is an optional display name used until the provider
// returns the real company name.
export function parseSymbolEntry(entry) {
    if (typeof entry !== "string") return null;
    const colon = entry.indexOf(":");
    const rawSymbol = (colon === -1 ? entry : entry.slice(0, colon)).trim();
    const rawName = colon === -1 ? "" : entry.slice(colon + 1).trim();
    const symbol = rawSymbol.toUpperCase().replace(/[^A-Z0-9.\-^=]/g, "");
    if (!symbol) return null;
    return { symbol, label: displaySymbol(symbol), name: rawName || symbol };
}

// Text shown on tabs / pills: "^GSPC" -> "GSPC"
export function displaySymbol(symbol) {
    return String(symbol).replace(/^\^/, "");
}

export function parseSymbolList(list) {
    const out = [];
    const seen = new Set();
    for (const entry of Array.isArray(list) ? list : []) {
        const item = parseSymbolEntry(entry);
        if (!item || seen.has(item.symbol)) continue;
        seen.add(item.symbol);
        out.push(item);
        if (out.length >= MAX_SYMBOLS) break;
    }
    return out;
}

// ------------------------------------------------------------ formatting

// decimals: "auto" (2 for >= 1, 4 below) | "0".."4"
export function stockPriceOptions(value, { separator = "comma", decimals = "auto" } = {}) {
    let places = decimals;
    if (decimals === "auto") places = typeof value === "number" && Math.abs(value) < 1 ? "4" : "2";
    return { separator, decimals: String(places) };
}

// ---------------------------------------------------------------- network

// Builds an async (url, headers) => parsedJson function on top of libsoup.
// Unlike the crypto fetcher this one sends a browser User-Agent (Yahoo and
// Nasdaq both reject unknown clients) and REPLACES headers instead of
// appending, so Origin / Referer are never duplicated.
export function createStockFetcher(Soup, GLib) {
    let session = null;
    const fetcher = async (url, headers = {}, asText = false) => {
        if (!session) {
            session = new Soup.Session();
            session.timeout = 20;
            session.user_agent = BROWSER_UA;
        }
        const message = Soup.Message.new("GET", url);
        if (!message) throw new Error(`invalid URL: ${url}`);
        const requestHeaders = message.get_request_headers();
        requestHeaders.replace("Accept", "application/json, text/plain, */*");
        requestHeaders.replace("Accept-Language", "en-US,en;q=0.9");
        for (const [name, value] of Object.entries(headers)) requestHeaders.replace(name, value);
        const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        const status = message.get_status();
        if (status !== Soup.Status.OK) throw new Error(`HTTP ${status}`);
        const text = new TextDecoder("utf-8").decode(bytes.get_data());
        return asText ? text : JSON.parse(text);
    };
    fetcher.dispose = () => {
        if (session) session.abort();
        session = null;
    };
    return fetcher;
}

// ------------------------------------------------------------- providers

function _num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// "$1,234.56" | "-0.99%" | "N/A" -> number | null
function _parseNumberText(value) {
    if (typeof value === "number") return _num(value);
    if (typeof value !== "string") return null;
    const cleaned = value.replace(/[^0-9.\-+]/g, "");
    if (!cleaned || cleaned === "-" || cleaned === "+" || cleaned === ".") return null;
    return _num(parseFloat(cleaned));
}

function _pct(price, previousClose) {
    if (price === null || previousClose === null || previousClose === 0) return null;
    return (price - previousClose) / previousClose * 100;
}

// Last close of the trading day BEFORE the newest data point. Used for the
// 5d / 1mo ranges, where Yahoo's chartPreviousClose is the close before the
// whole range and would give a multi-day change instead of a daily one.
function _previousDayClose(timestamps, closes, gmtoffset) {
    let lastIndex = -1;
    for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] !== null) { lastIndex = i; break; }
    }
    if (lastIndex < 0) return null;
    const dayOf = t => Math.floor((t + (gmtoffset || 0)) / 86400);
    const lastDay = dayOf(timestamps[lastIndex]);
    for (let i = lastIndex - 1; i >= 0; i--) {
        if (closes[i] !== null && dayOf(timestamps[i]) < lastDay) return closes[i];
    }
    return null;
}

export function parseYahooChart(json, item, rangeKey, now = Date.now()) {
    const result = json?.chart?.result?.[0];
    if (!result || typeof result !== "object") {
        const description = json?.chart?.error?.description;
        throw new Error(description ? `Yahoo: ${description}` : "unexpected Yahoo response");
    }
    const meta = result.meta ?? {};
    const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
    const rawCloses = result.indicators?.quote?.[0]?.close;
    const closes = Array.isArray(rawCloses) ? rawCloses.map(_num) : [];
    const series = closes.filter(v => v !== null);

    const price = _num(meta.regularMarketPrice) ?? (series.length ? series[series.length - 1] : null);

    let previousClose = _num(meta.previousClose);
    if (previousClose === null) {
        previousClose = rangeKey === "1d"
            ? _num(meta.chartPreviousClose)
            : _previousDayClose(timestamps, closes, meta.gmtoffset);
    }
    if (previousClose === null) previousClose = _num(meta.chartPreviousClose);

    const regular = meta.currentTradingPeriod?.regular;
    const nowSec = now / 1000;
    const marketOpen = regular && _num(regular.start) !== null && _num(regular.end) !== null
        ? nowSec >= regular.start && nowSec <= regular.end
        : null;

    const name = [meta.longName, meta.shortName].find(n => typeof n === "string" && n.trim());
    return {
        symbol: item.symbol,
        name: name ? name.trim() : item.name,
        price,
        changePct: _pct(price, previousClose),
        changeAbs: price !== null && previousClose !== null ? price - previousClose : null,
        currency: typeof meta.currency === "string" ? meta.currency.toUpperCase() : "USD",
        marketOpen,
        series
    };
}

async function _fetchYahoo(fetchJson, item, rangeKey, now) {
    const params = RANGES[rangeKey] ?? RANGES["1d"];
    const path = `/${encodeURIComponent(item.symbol)}?range=${params.range}&interval=${params.interval}&includePrePost=false`;
    let json;
    try {
        json = await fetchJson(YAHOO_CHART_URL + path, {});
    } catch (e) {
        json = await fetchJson(YAHOO_CHART_URL.replace("query1", "query2") + path, {}); // second host, separate rate limit
    }
    return parseYahooChart(json, item, rangeKey, now);
}

const NASDAQ_HEADERS = Object.freeze({
    Origin: "https://www.nasdaq.com",
    Referer: "https://www.nasdaq.com/"
});

export function parseNasdaq(infoJson, chartJson, item) {
    const info = infoJson?.data;
    if (!info || typeof info !== "object" || !info.primaryData) {
        const message = infoJson?.status?.bCodeMessage?.[0]?.errorMessage;
        throw new Error(message ? `Nasdaq: ${message}` : "unexpected Nasdaq response");
    }
    const primary = info.primaryData;
    const price = _parseNumberText(primary.lastSalePrice);
    let change = _parseNumberText(primary.percentageChange);
    const netChange = _parseNumberText(primary.netChange);
    // percentageChange is unsigned in some responses; trust the sign of netChange.
    if (change !== null && netChange !== null && netChange < 0 && change > 0) change = -change;
    const points = Array.isArray(chartJson?.data?.chart) ? chartJson.data.chart : [];
    const series = points.map(p => _parseNumberText(p?.y)).filter(v => v !== null);
    const name = typeof info.companyName === "string" && info.companyName.trim()
        ? info.companyName.replace(/\s+(Common Stock|Common Shares|Ordinary Shares)\b.*$/i, "").trim()
        : item.name;
    const state = typeof info.marketStatus === "string" ? info.marketStatus.toLowerCase() : "";
    return {
        symbol: item.symbol,
        name: name || item.name,
        price,
        changePct: change,
        changeAbs: netChange,
        currency: "USD",
        marketOpen: state ? state.includes("open") : null,
        series
    };
}

async function _fetchNasdaq(fetchJson, item) {
    const sym = encodeURIComponent(item.symbol.toLowerCase());
    const info = await fetchJson(`${NASDAQ_QUOTE_URL}/${sym}/info?assetclass=stocks`, NASDAQ_HEADERS);
    // The chart is only decoration: if it fails, keep the quote.
    let chart = null;
    try {
        chart = await fetchJson(`${NASDAQ_QUOTE_URL}/${sym}/chart?assetclass=stocks`, NASDAQ_HEADERS);
    } catch (e) { /* no graph */ }
    return parseNasdaq(info, chart, item);
}

// ------------------------------------------------------------- stooq

const STOOQ_URL = "https://stooq.com/q/d/l/";
const STOOQ_INDEX = Object.freeze({ "^GSPC": "^spx", "^DJI": "^dji", "^IXIC": "^ndq", "^FTSE": "^ukx", "^GDAXI": "^dax", "^N225": "^nkx", "^HSI": "^hsi" });
const STOOQ_SUFFIX = Object.freeze({ L: "uk", DE: "de", T: "jp", HK: "hk", WA: "pl", BD: "hu", US: "us" });

// Yahoo-style symbol -> stooq symbol (null = not on stooq, e.g. PTT.BK)
export function stooqSymbol(symbol) {
    const s = symbol.toUpperCase();
    if (STOOQ_INDEX[s]) return STOOQ_INDEX[s];
    if (s.includes("=") || s.startsWith("^")) return null;
    const dot = s.lastIndexOf(".");
    if (dot === -1) return `${s.toLowerCase()}.us`;
    const suffix = STOOQ_SUFFIX[s.slice(dot + 1)];
    return suffix ? `${s.slice(0, dot).toLowerCase()}.${suffix}` : null;
}

// CSV "Date,Open,High,Low,Close,Volume" -> quote
export function parseStooq(csv, item) {
    const rows = String(csv).trim().split(/\r?\n/).slice(1).map(l => l.split(","));
    const closes = rows.map(r => _num(parseFloat(r[4]))).filter(v => v !== null);
    if (closes.length < 2) throw new Error("Stooq: no data");
    const price = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    return {
        symbol: item.symbol, name: item.name, price,
        changePct: _pct(price, prev), changeAbs: price - prev,
        currency: "USD", marketOpen: null, series: closes.slice(-22)
    };
}

async function _fetchStooq(fetchJson, item) {
    const code = stooqSymbol(item.symbol);
    if (!code) throw new Error(`Stooq: unsupported symbol ${item.symbol}`);
    const csv = await fetchJson(`${STOOQ_URL}?s=${encodeURIComponent(code)}&i=d`, {}, true);
    return parseStooq(csv, item);
}

// -------------------------------------------------------------- cnbc

const CNBC_URL = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol";

export function parseCnbc(json, item) {
    const q = json?.FormattedQuoteResult?.FormattedQuote?.[0];
    const price = _parseNumberText(q?.last);
    if (price === null) throw new Error("CNBC: no data");
    const state = typeof q.curmktstatus === "string" ? q.curmktstatus : "";
    return {
        symbol: item.symbol,
        name: typeof q.name === "string" && q.name.trim() ? q.name.trim() : item.name,
        price,
        changePct: _parseNumberText(q.change_pct),
        changeAbs: _parseNumberText(q.change),
        currency: typeof q.currencyCode === "string" && q.currencyCode ? q.currencyCode.toUpperCase() : "USD",
        marketOpen: state ? state === "REG_MKT" : null,
        series: []
    };
}

async function _fetchCnbc(fetchJson, item) {
    const sym = item.symbol.replace(/^\^/, ".");
    const json = await fetchJson(`${CNBC_URL}?symbols=${encodeURIComponent(sym)}&requestMethod=itv&noform=1&fund=1&exthrs=1&output=json`, {});
    return parseCnbc(json, item);
}

// -------------------------------------------------------- twelve data

const TWELVE_URL = "https://api.twelvedata.com/time_series";

export function parseTwelveData(json, item) {
    if (json?.status === "error" || !Array.isArray(json?.values)) {
        throw new Error(`Twelve Data: ${json?.message ?? "unexpected response"}`);
    }
    const closes = json.values.map(v => _parseNumberText(v?.close)).filter(v => v !== null).reverse(); // API is newest-first
    if (closes.length < 2) throw new Error("Twelve Data: no data");
    const price = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    return {
        symbol: item.symbol, name: item.name, price,
        changePct: _pct(price, prev), changeAbs: price - prev,
        currency: typeof json.meta?.currency === "string" ? json.meta.currency.toUpperCase() : "USD",
        marketOpen: null, series: closes
    };
}

async function _fetchTwelveData(fetchJson, item, apiKey) {
    if (!apiKey) throw new Error("Twelve Data: no API key");
    // "PTT.BK" -> symbol=PTT&exchange=SET ; other suffixes are passed through untouched
    const bk = /^(.+)\.BK$/.exec(item.symbol);
    const q = bk ? `symbol=${encodeURIComponent(bk[1])}&exchange=SET` : `symbol=${encodeURIComponent(item.symbol)}`;
    const json = await fetchJson(`${TWELVE_URL}?${q}&interval=1day&outputsize=22&apikey=${encodeURIComponent(apiKey)}`, {});
    return parseTwelveData(json, item);
}

// ---------------------------------------------------------------- service

const _cache = new Map(); // requestKey -> { at, result } | { inflight }

async function _fetchVia(provider, fetchJson, item, rangeKey, now, apiKey) {
    const quote = await ({
        yahoo: () => _fetchYahoo(fetchJson, item, rangeKey, now),
        stooq: () => _fetchStooq(fetchJson, item),
        cnbc: () => _fetchCnbc(fetchJson, item),
        nasdaq: () => _fetchNasdaq(fetchJson, item),
        twelvedata: () => _fetchTwelveData(fetchJson, item, apiKey)
    }[provider] ?? (() => { throw new Error(`unknown provider ${provider}`); }))();
    return { ...quote, via: PROVIDER_NAMES[provider] };
}

async function _fetchOne(fetchJson, provider, item, rangeKey, now, apiKey) {
    if (provider !== "auto") return _fetchVia(provider, fetchJson, item, rangeKey, now, apiKey);
    const errors = [];
    for (const p of AUTO_ORDER) {
        if (p === "twelvedata" && !apiKey) continue;
        try {
            return await _fetchVia(p, fetchJson, item, rangeKey, now, apiKey);
        } catch (e) {
            errors.push(e.message);
        }
    }
    throw new Error(errors.join("; "));
}

// Shared by every stock widget instance: two widgets asking for the same
// symbols within `ttlMs` cost one round of HTTP requests.
// Resolves with { quotes, errors, source }. Partial failure is normal: a
// symbol that fails is simply absent from `quotes` and listed in `errors`.
// Rejects only when EVERY symbol failed.
export async function fetchStocks({ fetchJson, provider = "yahoo", symbols, graphRange = "1d", ttlMs = 20000, now = Date.now(), apiKey = "" }) {
    const source = PROVIDER_NAMES[provider] ?? provider;
    if (!symbols.length) return { quotes: {}, errors: {}, source };
    const rangeKey = RANGES[graphRange] ? graphRange : "1d";
    const key = [provider, apiKey ? "k" : "", rangeKey, symbols.map(s => s.symbol).join(",")].join("|");
    const hit = _cache.get(key);
    if (hit?.result && now - hit.at < ttlMs) return hit.result;
    if (hit?.inflight) return hit.inflight;
    const inflight = (async () => {
        const settled = await Promise.allSettled(symbols.map(item => _fetchOne(fetchJson, provider, item, rangeKey, now, apiKey)));
        const quotes = {};
        const errors = {};
        settled.forEach((outcome, i) => {
            const { symbol } = symbols[i];
            if (outcome.status === "fulfilled") quotes[symbol] = outcome.value;
            else errors[symbol] = String(outcome.reason?.message ?? outcome.reason);
        });
        if (!Object.keys(quotes).length) {
            throw new Error(Object.values(errors)[0] ?? "no data");
        }
        // auto: name the provider(s) that actually answered
        const via = [...new Set(Object.values(quotes).map(q => q.via))].join(" / ");
        const result = { quotes, errors, source: provider === "auto" && via ? via : source };
        _cache.set(key, { at: now, result });
        return result;
    })();
    _cache.set(key, { inflight });
    try {
        return await inflight;
    } catch (e) {
        _cache.delete(key);
        throw e;
    }
}

// Price series to draw for a quote. The provider already returned the series
// for the configured range, so this only guards against missing data.
export function seriesForQuote(quote) {
    return Array.isArray(quote?.series) ? quote.series : [];
}

// Test hook
export function _resetStockCaches() {
    _cache.clear();
}
