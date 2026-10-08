// Shared logic for the Crypto Markets widgets (crypto-markets-1x1 / crypto-markets-2x1).
//
// Plain module: NO gi:// imports at top level. Anything that needs Soup, GLib
// or Pango receives the module as an argument (createSoupFetcher, fontCss), so
// this file can be imported by the GTK4 prefs process and unit-tested in plain
// Node with a mocked fetcher.
//
// Data providers
//   coingecko      free, no API key. One /coins/markets call returns price,
//                  24h change and a 7-day hourly sparkline for every coin.
//   coinmarketcap  needs an API key (X-CMC_PRO_API_KEY). Returns price and
//                  24h change only, so the graph is built from the samples
//                  this session has collected (kept in memory).

export const COINGECKO_MARKETS_URL = "https://api.coingecko.com/api/v3/coins/markets";

// CoinMarketCap "latest quotes" endpoint - looks coins up by symbol (id and
// slug also work). Editable in the widget settings, so a different CMC-style
// endpoint can be pointed at without touching code.
export const CMC_DEFAULT_ENDPOINT = "https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest";

export const PROVIDER_NAMES = Object.freeze({
    coingecko: "CoinGecko",
    coinmarketcap: "CoinMarketCap"
});

export const MAX_COINS = 12;
const MAX_HISTORY_SAMPLES = 400;

// symbol -> CoinGecko id + display name. Anything not listed here can still
// be used by writing "SYMBOL:coingecko-id" in the coin list (e.g. "KAS:kaspa").
export const KNOWN_COINS = Object.freeze({
    BTC: { id: "bitcoin", name: "Bitcoin" },
    ETH: { id: "ethereum", name: "Ethereum" },
    SOL: { id: "solana", name: "Solana" },
    BNB: { id: "binancecoin", name: "BNB" },
    XRP: { id: "ripple", name: "XRP" },
    ADA: { id: "cardano", name: "Cardano" },
    DOGE: { id: "dogecoin", name: "Dogecoin" },
    TRX: { id: "tron", name: "TRON" },
    TON: { id: "the-open-network", name: "Toncoin" },
    AVAX: { id: "avalanche-2", name: "Avalanche" },
    DOT: { id: "polkadot", name: "Polkadot" },
    LINK: { id: "chainlink", name: "Chainlink" },
    LTC: { id: "litecoin", name: "Litecoin" },
    BCH: { id: "bitcoin-cash", name: "Bitcoin Cash" },
    SHIB: { id: "shiba-inu", name: "Shiba Inu" },
    XLM: { id: "stellar", name: "Stellar" },
    ATOM: { id: "cosmos", name: "Cosmos" },
    UNI: { id: "uniswap", name: "Uniswap" },
    NEAR: { id: "near", name: "NEAR Protocol" },
    APT: { id: "aptos", name: "Aptos" },
    ARB: { id: "arbitrum", name: "Arbitrum" },
    OP: { id: "optimism", name: "Optimism" },
    SUI: { id: "sui", name: "Sui" },
    ETC: { id: "ethereum-classic", name: "Ethereum Classic" },
    XMR: { id: "monero", name: "Monero" },
    FIL: { id: "filecoin", name: "Filecoin" },
    ICP: { id: "internet-computer", name: "Internet Computer" },
    HBAR: { id: "hedera-hashgraph", name: "Hedera" },
    AAVE: { id: "aave", name: "Aave" },
    PEPE: { id: "pepe", name: "Pepe" },
    USDT: { id: "tether", name: "Tether" },
    USDC: { id: "usd-coin", name: "USD Coin" }
});

export const CURRENCY_SYMBOLS = Object.freeze({
    USD: "$", THB: "฿", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", KRW: "₩", AUD: "A$"
});

// ---------------------------------------------------------------- coins

// "BTC" | "btc" | "KAS:kaspa"  ->  { symbol, id, name }   (null if unusable)
export function parseCoinEntry(entry) {
    if (typeof entry !== "string") return null;
    const [rawSymbol, rawId] = entry.split(":").map(part => part.trim());
    const symbol = (rawSymbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!symbol) return null;
    const known = KNOWN_COINS[symbol];
    const id = (rawId && rawId.toLowerCase()) || known?.id || symbol.toLowerCase();
    return { symbol, id, name: known?.name ?? symbol };
}

export function parseCoinList(list) {
    const out = [];
    const seen = new Set();
    for (const entry of Array.isArray(list) ? list : []) {
        const coin = parseCoinEntry(entry);
        if (!coin || seen.has(coin.symbol)) continue;
        seen.add(coin.symbol);
        out.push(coin);
        if (out.length >= MAX_COINS) break;
    }
    return out;
}

// ----------------------------------------------------------- formatting

// separator: "space" (27 978 263) | "comma" (27,978,263) | "none"
// decimals:  "auto" | "0".."8"
export function formatPrice(value, { separator = "space", decimals = "auto" } = {}) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "--";
    let places;
    if (decimals === "auto") {
        const abs = Math.abs(value);
        if (abs >= 1000) places = 0;
        else if (abs >= 1) places = 2;
        else if (abs >= 0.01) places = 4;
        else places = 6;
    } else {
        places = Math.max(0, Math.min(8, parseInt(decimals, 10) || 0));
    }
    const [intPart, fracPart] = Math.abs(value).toFixed(places).split(".");
    const glue = separator === "comma" ? "," : separator === "none" ? "" : "\u00A0";
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, glue);
    return (value < 0 ? "-" : "") + grouped + (fracPart ? `.${fracPart}` : "");
}

export function formatChange(pct) {
    if (typeof pct !== "number" || !Number.isFinite(pct)) return "--";
    const sign = pct > 0 ? "+" : pct < 0 ? "-" : "";
    return `${sign}${Math.abs(pct).toFixed(2)}%`;
}

export function currencyPrefix(currency, show) {
    if (!show) return "";
    return CURRENCY_SYMBOLS[String(currency).toUpperCase()] ?? `${String(currency).toUpperCase()} `;
}

// ---------------------------------------------------------------- colors

export function parseHexColor(hex, fallback = "#FFFFFFFF") {
    const ok = typeof hex === "string" && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex);
    const value = ok ? hex : fallback;
    return {
        r: parseInt(value.slice(1, 3), 16) / 255,
        g: parseInt(value.slice(3, 5), 16) / 255,
        b: parseInt(value.slice(5, 7), 16) / 255,
        a: value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1
    };
}

// "#RRGGBB[AA]" + alpha 0..1 (multiplied into the colour's own alpha) -> css rgba()
export function cssRgba(hex, alpha01 = 1, fallback = "#FFFFFFFF") {
    const { r, g, b, a } = parseHexColor(hex, fallback);
    const alpha = Math.round(Math.max(0, Math.min(1, a * alpha01)) * 1000) / 1000;
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

// Pango font string -> css declarations. `Pango` is passed in by the widget.
export function fontCss(Pango, fontStr, fallbackFamily = "Sans", fallbackSize = 16, sizeScale = 1) {
    let family = fallbackFamily, weight = 400, style = "normal", size = fallbackSize;
    try {
        const desc = Pango.FontDescription.from_string(fontStr || `${fallbackFamily} ${fallbackSize}`);
        family = desc.get_family() || fallbackFamily;
        weight = desc.get_weight() || 400;
        const pangoStyle = desc.get_style();
        style = pangoStyle === Pango.Style.ITALIC ? "italic" : pangoStyle === Pango.Style.OBLIQUE ? "oblique" : "normal";
        const raw = desc.get_size();
        if (raw > 0) size = Math.round(raw / Pango.SCALE);
    } catch (e) {
        weight = 700;
    }
    const px = Math.max(6, Math.round(size * sizeScale));
    return `font-family: "${family}"; font-weight: ${weight}; font-style: ${style}; font-size: ${px}px;`;
}

// -------------------------------------------------------------- network

// Builds an async (url, headers) => parsedJson function on top of libsoup.
export function createSoupFetcher(Soup, GLib) {
    let session = null;
    const fetcher = async (url, headers = {}) => {
        if (!session) {
            session = new Soup.Session();
            session.timeout = 20;
            session.user_agent = "gnome-widget-center/1.0";
        }
        const message = Soup.Message.new("GET", url);
        if (!message) throw new Error(`invalid URL: ${url}`);
        const requestHeaders = message.get_request_headers();
        requestHeaders.append("Accept", "application/json");
        for (const [name, value] of Object.entries(headers)) requestHeaders.append(name, value);
        const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        const status = message.get_status();
        if (status !== Soup.Status.OK) throw new Error(`HTTP ${status}`);
        return JSON.parse(new TextDecoder("utf-8").decode(bytes.get_data()));
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

async function _fetchCoinGecko(fetchJson, coins, currency) {
    const ids = coins.map(c => c.id).join(",");
    const url = `${COINGECKO_MARKETS_URL}?vs_currency=${encodeURIComponent(currency.toLowerCase())}` +
        `&ids=${encodeURIComponent(ids)}&order=market_cap_desc&per_page=${coins.length}&page=1` +
        "&sparkline=true&price_change_percentage=24h";
    const rows = await fetchJson(url, {});
    if (!Array.isArray(rows)) throw new Error("unexpected CoinGecko response");
    const quotes = {};
    for (const coin of coins) {
        const row = rows.find(r => r?.id === coin.id);
        if (!row) continue;
        const series = Array.isArray(row.sparkline_in_7d?.price) ? row.sparkline_in_7d.price.filter(v => _num(v) !== null) : [];
        quotes[coin.symbol] = {
            symbol: coin.symbol,
            name: typeof row.name === "string" && row.name ? row.name : coin.name,
            price: _num(row.current_price),
            change24h: _num(row.price_change_percentage_24h_in_currency) ?? _num(row.price_change_percentage_24h),
            series7d: series
        };
    }
    return quotes;
}

async function _fetchCoinMarketCap(fetchJson, coins, currency, apiKey, endpoint) {
    if (!apiKey) throw new Error("CoinMarketCap API key is not set");
    const cur = currency.toUpperCase();
    const base = (endpoint || CMC_DEFAULT_ENDPOINT).trim();
    const url = `${base}${base.includes("?") ? "&" : "?"}symbol=${encodeURIComponent(coins.map(c => c.symbol).join(","))}` +
        `&convert=${encodeURIComponent(cur)}`;
    const json = await fetchJson(url, { "X-CMC_PRO_API_KEY": apiKey });
    const data = json?.data;
    if (!data || typeof data !== "object") throw new Error("unexpected CoinMarketCap response");
    const quotes = {};
    for (const coin of coins) {
        let entry = data[coin.symbol];
        if (Array.isArray(entry)) entry = entry[0];
        if (!entry || typeof entry !== "object") continue;
        // Standard shape: entry.quote[CUR].price / percent_change_24h.
        // Flat shape (simple/price style): entry.price / entry.percent_change_24h.
        const quote = entry.quote?.[cur] ?? (entry.quote ? Object.values(entry.quote)[0] : null) ?? entry;
        quotes[coin.symbol] = {
            symbol: coin.symbol,
            name: typeof entry.name === "string" && entry.name ? entry.name : coin.name,
            price: _num(quote?.price),
            change24h: _num(quote?.percent_change_24h),
            series7d: []
        };
    }
    return quotes;
}

// ---------------------------------------------------------------- service

const _cache = new Map(); // requestKey -> { at, quotes } | { inflight }
const _history = new Map(); // "provider|CUR|SYM" -> [{ t, p }]  (CoinMarketCap graph source)

function _recordHistory(provider, currency, quotes, now) {
    for (const quote of Object.values(quotes)) {
        if (quote.price === null) continue;
        const key = `${provider}|${currency}|${quote.symbol}`;
        const samples = _history.get(key) ?? [];
        samples.push({ t: now, p: quote.price });
        if (samples.length > MAX_HISTORY_SAMPLES) samples.splice(0, samples.length - MAX_HISTORY_SAMPLES);
        _history.set(key, samples);
    }
}

// Shared by every crypto widget instance: two widgets asking for the same
// coins within `ttlMs` cost one HTTP request (keeps free-tier rate limits happy).
export async function fetchMarkets({ fetchJson, provider, coins, currency, apiKey = "", endpoint = "", ttlMs = 20000, now = Date.now() }) {
    if (!coins.length) return { quotes: {}, source: PROVIDER_NAMES[provider] ?? provider };
    const cur = String(currency || "USD").toUpperCase();
    const key = [provider, cur, coins.map(c => `${c.symbol}:${c.id}`).join(","), provider === "coinmarketcap" ? endpoint : ""].join("|");
    const hit = _cache.get(key);
    if (hit?.quotes && now - hit.at < ttlMs) return hit.result;
    if (hit?.inflight) return hit.inflight;
    const inflight = (async () => {
        const quotes = provider === "coinmarketcap"
            ? await _fetchCoinMarketCap(fetchJson, coins, cur, apiKey, endpoint)
            : await _fetchCoinGecko(fetchJson, coins, cur);
        if (provider === "coinmarketcap") _recordHistory(provider, cur, quotes, now);
        const result = { quotes, source: PROVIDER_NAMES[provider] ?? provider };
        _cache.set(key, { at: now, quotes, result });
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

// Price series to draw for a quote: "24h" or "7d".
export function seriesForRange(provider, currency, quote, range, now = Date.now()) {
    if (!quote) return [];
    if (provider === "coinmarketcap") {
        const samples = _history.get(`${provider}|${String(currency).toUpperCase()}|${quote.symbol}`) ?? [];
        const windowMs = (range === "7d" ? 7 : 1) * 24 * 3600 * 1000;
        return samples.filter(s => now - s.t <= windowMs).map(s => s.p);
    }
    const series = quote.series7d ?? [];
    return range === "7d" ? series : series.slice(-25); // hourly points: 24h = last 25
}

// Test hook
export function _resetCryptoCaches() {
    _cache.clear();
    _history.clear();
}

// --------------------------------------------------------------- painting

function _downsample(values, maxPoints) {
    if (values.length <= maxPoints) return values;
    const out = [];
    const step = (values.length - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints; i++) out.push(values[Math.round(i * step)]);
    return out;
}

// Draws a sparkline with a cairo context. Works on a cleared surface.
//   opts: { color:{r,g,b,a}, lineWidth, smooth, fill, fillOpacity(0..1), padding, Cairo }
export function paintSparkline(cr, width, height, values, opts) {
    const { color, lineWidth = 2, smooth = false, fill = false, fillOpacity = 0.25, padding = 3, Cairo = null } = opts;
    if (!Array.isArray(values) || values.length < 2 || width <= 0 || height <= 0) return false;
    const data = _downsample(values, 90);
    let min = Math.min(...data), max = Math.max(...data);
    if (max - min < 1e-12) { min -= 1; max += 1; }
    const innerW = width - padding * 2, innerH = height - padding * 2;
    const pts = data.map((v, i) => ({
        x: padding + i / (data.length - 1) * innerW,
        y: padding + (1 - (v - min) / (max - min)) * innerH
    }));
    const trace = () => {
        cr.moveTo(pts[0].x, pts[0].y);
        if (!smooth) {
            for (let i = 1; i < pts.length; i++) cr.lineTo(pts[i].x, pts[i].y);
            return;
        }
        // Catmull-Rom -> cubic bezier
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
            cr.curveTo(
                p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
                p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
                p2.x, p2.y
            );
        }
    };
    if (fill) {
        trace();
        cr.lineTo(pts[pts.length - 1].x, height);
        cr.lineTo(pts[0].x, height);
        cr.closePath();
        let filled = false;
        if (Cairo?.LinearGradient) {
            try {
                const gradient = new Cairo.LinearGradient(0, 0, 0, height);
                gradient.addColorStopRGBA(0, color.r, color.g, color.b, color.a * fillOpacity);
                gradient.addColorStopRGBA(1, color.r, color.g, color.b, 0);
                cr.setSource(gradient);
                cr.fill();
                filled = true;
            } catch (e) { /* fall through to solid fill */ }
        }
        if (!filled) {
            cr.setSourceRGBA(color.r, color.g, color.b, color.a * fillOpacity * 0.6);
            cr.fill();
        }
    }
    trace();
    cr.setLineWidth(lineWidth);
    cr.setLineCap(1);  // Cairo.LineCap.ROUND
    cr.setLineJoin(1); // Cairo.LineJoin.ROUND
    cr.setSourceRGBA(color.r, color.g, color.b, color.a);
    cr.stroke();
    return true;
}
