# Stock Markets (2x1)

2x1 card: header with symbol tabs, live price, daily change pill, line graph and footer.
Data (no API key): Yahoo Finance (world markets, intraday graph) or Nasdaq (US stocks only), or Auto (Yahoo, then Nasdaq).

- Symbols: `AAPL`, `MSFT`, ... Thai stocks use `.BK` (`PTT.BK`), indices start with `^` (`^GSPC`), FX like `THB=X`. Optional display name after a colon: `KBANK.BK:Kasikorn`. Up to 8.
- Click a tab to switch symbol; optional auto-rotate.
- Graph: line color (follow trend or custom), width, smooth, fill, range 1 day / 5 days / 1 month (Nasdaq always draws the trading day).
- Refresh: 30 s - 1 h. Both providers are unofficial endpoints, so very short intervals may be throttled.
- Prices are shown in each stock's own currency; "Show market open / closed" adds the exchange state after the company name.
- Card settings (background, corner radius, blur, shadow, border, opacity) come from the shared Appearance tab.
