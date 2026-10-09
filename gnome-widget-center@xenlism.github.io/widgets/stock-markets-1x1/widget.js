import St from "gi://St";

import Clutter from "gi://Clutter";

import GLib from "gi://GLib";

import Pango from "gi://Pango";

import Soup from "gi://Soup?version=3.0";

import Cairo from "cairo";

import { SHADOW_DEFAULTS, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';

import {
    parseSymbolList, fetchStocks, seriesForQuote, createStockFetcher, paintSparkline,
    formatPrice, stockPriceOptions, formatChange, currencyPrefix, cssRgba, parseHexColor, fontCss, PROVIDER_NAMES
} from "../../lib/stockMarketsKit.js";

export default class StockMarkets1x1Widget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._fetchJson = createStockFetcher(Soup, GLib);
        this._refreshId = null;
        this._rotateId = null;
        this._repaintId = null;
        this._quotes = {};
        this._offline = false;
        this._errors = {};
        this._activeSymbol = null;
        this._dataKey = "";
        this._disposed = false;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "stock-markets-1x1-root"
        });
        this._actor = this._layers.root;
        this._content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true
        });
        this._layers.content.add_child(this._content);
        // top row: symbol pill ........ daily change
        this._topRow = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._pill = new St.Button({
            style_class: "stock-markets-1x1-pill",
            reactive: true,
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._pill.connect("clicked", () => this._cycleSymbol(1));
        this._topSpacer = new St.Widget({
            x_expand: true
        });
        this._changeLabel = new St.Label({
            style_class: "stock-markets-1x1-change",
            y_align: Clutter.ActorAlign.CENTER
        });
        this._topRow.add_child(this._pill);
        this._topRow.add_child(this._topSpacer);
        this._topRow.add_child(this._changeLabel);
        this._priceLabel = new St.Label({
            style_class: "stock-markets-1x1-price",
            x_expand: true
        });
        this._priceLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._nameLabel = new St.Label({
            style_class: "stock-markets-1x1-name",
            x_expand: true
        });
        this._nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._flex = new St.Widget({
            y_expand: true
        });
        this._graphArea = new St.DrawingArea({
            style_class: "stock-markets-1x1-graph",
            x_expand: true
        });
        this._repaintId = this._graphArea.connect("repaint", area => this._onRepaint(area));
        this._content.add_child(this._topRow);
        this._content.add_child(this._priceLabel);
        this._content.add_child(this._nameLabel);
        this._content.add_child(this._flex);
        this._content.add_child(this._graphArea);
        this._syncSymbols();
        this._render();
        this._refresh();
        return this._actor;
    }
    enable() {
        this._startTimers();
    }
    disable() {
        this._disposed = true;
        this._stopTimers();
        if (this._repaintId !== null && this._graphArea) {
            this._graphArea.disconnect(this._repaintId);
            this._repaintId = null;
        }
        this._fetchJson?.dispose?.();
    }
    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
        };
    }
    onSettingsChanged() {
        const keyBefore = this._dataKey;
        this._syncSymbols();
        this._render();
        this._startTimers();
        if (this._dataKey !== keyBefore) this._refresh();
    }
    // ---- timers -------------------------------------------------------
    _startTimers() {
        this._stopTimers();
        const refresh = Math.max(30, this._settings.refreshSeconds ?? 60);
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, refresh, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
        const rotate = this._settings.autoRotateSeconds ?? 0;
        if (rotate > 0) {
            this._rotateId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, rotate, () => {
                this._cycleSymbol(1);
                return GLib.SOURCE_CONTINUE;
            });
        }
    }
    _stopTimers() {
        for (const name of [ "_refreshId", "_rotateId" ]) {
            if (this[name] !== null) {
                GLib.source_remove(this[name]);
                this[name] = null;
            }
        }
    }
    // ---- data ---------------------------------------------------------
    _matchSymbol(text) {
        const upper = String(text ?? "").trim().toUpperCase();
        if (!upper) return null;
        const bare = s => String(s ?? "").toUpperCase().replace(/\.[A-Z]{1,3}$/, "");
        const hit = (this._symbols ?? []).find(c => String(c.symbol).toUpperCase() === upper) ?? (this._symbols ?? []).find(c => bare(c.symbol) === bare(upper) || String(c.label ?? "").toUpperCase() === upper);
        return hit ? hit.symbol : null;
    }
    _syncSymbols() {
        this._symbols = parseSymbolList(this._settings.symbols ?? [ "AAPL", "MSFT", "NVDA" ]);
        const symbols = this._symbols.map(c => c.symbol);
        // "Starting symbol": applied on first load AND whenever the user changes
        // it in Settings (it used to be read only while no symbol was active, so
        // editing it afterwards did nothing). The ".BK"-style suffix is optional,
        // and the display label also matches.
        const wantedRaw = String(this._settings.defaultSymbol ?? "").trim();
        const wanted = this._matchSymbol(wantedRaw);
        const defaultChanged = wantedRaw !== this._lastDefaultSymbol;
        this._lastDefaultSymbol = wantedRaw;
        if (!this._activeSymbol || !symbols.includes(this._activeSymbol) || (defaultChanged && wanted)) {
            this._activeSymbol = wanted ?? symbols[0] ?? null;
        }
        this._dataKey = [ this._settings.provider, this._settings.twelveDataKey, this._settings.graphRange, symbols.join(",") ].join("|");
    }
    async _refresh() {
        if (!this._symbols?.length) return;
        const provider = this._settings.provider ?? "yahoo";
        try {
            const { quotes, errors, source } = await fetchStocks({
                fetchJson: this._fetchJson,
                provider: provider,
                symbols: this._symbols,
                graphRange: this._settings.graphRange ?? "1d",
                apiKey: String(this._settings.twelveDataKey ?? "").trim()
            });
            // a symbol whose request failed this round keeps its last good quote
            this._quotes = { ...this._quotes, ...quotes };
            this._errors = errors;
            if (errors && Object.keys(errors).length) this._api.logger.warn(`stock-markets-1x1: no data for ${Object.keys(errors).join(", ")} via ${source}: ${JSON.stringify(errors)}`);
            this._source = source;
            this._offline = false;
        } catch (e) {
            this._offline = true;
            this._source = PROVIDER_NAMES[provider] ?? provider;
            this._api.logger.warn(`stock-markets-1x1: refresh failed (${PROVIDER_NAMES[provider] ?? provider}): ${e}`);
        }
        if (!this._disposed) this._render();
    }
    _cycleSymbol(step) {
        const symbols = this._symbols.map(c => c.symbol);
        if (symbols.length < 2) return;
        const index = Math.max(0, symbols.indexOf(this._activeSymbol));
        this._activeSymbol = symbols[(index + step + symbols.length) % symbols.length];
        this._render();
    }
    _nameText(quote, entry) {
        let text = quote?.name ?? entry?.name ?? "";
        if ((this._settings.showMarketState ?? true) && quote && typeof quote.marketOpen === "boolean") {
            text += quote.marketOpen ? " \u00B7 Open" : " \u00B7 Closed";
        }
        if (this._offline || this._errors[this._activeSymbol]) text += " \u00B7 offline";
        return text;
    }
    // ---- ui -----------------------------------------------------------
    _render() {
        if (!this._layers) return;
        const s = this._settings;
        const pad = s.cardPadding ?? 14;
        applyLayeredCardStyle(this._layers, s, {
            cornerRadiusFallback: 18
        }, false);
        this._content.set_style(`padding: ${pad}px; spacing: 4px;`);
        const quote = this._quotes[this._activeSymbol];
        const entry = this._symbols.find(c => c.symbol === this._activeSymbol);
        // symbol pill (click = next symbol)
        this._pill.set_label(entry?.label ?? "--");
        this._pill.set_style(`background-color: ${cssRgba(s.tabActiveBgColor, 1, "#FFD24AFF")}; ` + `color: ${cssRgba(s.tabActiveTextColor, 1, "#1E2530FF")}; ${fontCss(Pango, s.tabFont, "Sans", 10)} ` + "border-radius: 99px; padding: 3px 11px;");
        // daily change
        const change = quote?.changePct ?? null;
        const trendColor = change !== null && change < 0 ? s.downColor ?? "#FF6B6BFF" : s.upColor ?? "#4ADE80FF";
        this._changeLabel.set_text(formatChange(change));
        const pill = s.changePill ?? true;
        const pillBg = pill ? `background-color: ${cssRgba(trendColor, (s.changePillOpacity ?? 25) / 100)}; border-radius: 8px; padding: 2px 8px;` : "";
        this._changeLabel.set_style(`color: ${cssRgba(trendColor)}; ${fontCss(Pango, s.changeFont, "Sans", 10)} ${pillBg}`);
        // price
        const prefix = currencyPrefix(quote?.currency ?? "USD", s.showCurrencySymbol ?? true);
        this._priceLabel.set_text(quote && quote.price !== null ? `${prefix}${formatPrice(quote.price, stockPriceOptions(quote?.price, {
            separator: s.thousandsSeparator ?? "comma",
            decimals: s.priceDecimals ?? "auto"
        }))}` : "--");
        this._priceLabel.set_style(`color: ${cssRgba(s.priceColor)}; ${fontCss(Pango, s.priceFont, "Sans", 26)} margin-top: 6px;`);
        // name (+ offline marker so a stale price is never mistaken for a live one)
        const showName = s.showName ?? true;
        this._nameLabel.visible = showName;
        this._nameLabel.set_text(this._nameText(quote, entry));
        this._nameLabel.set_style(`color: ${cssRgba(s.nameColor)}; ${fontCss(Pango, s.nameFont, "Sans", 11)}`);
        // graph
        const showGraph = s.showGraph ?? true;
        this._graphArea.visible = showGraph;
        this._graphArea.set_height(s.graphHeight ?? 52);
        this._graphArea.queue_repaint();
    }
    _onRepaint(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const s = this._settings;
        const quote = this._quotes[this._activeSymbol];
        const values = seriesForQuote(quote);
        const change = quote?.changePct ?? null;
        const useCustom = (s.graphLineColorMode ?? "trend") === "custom";
        const hex = useCustom ? s.graphLineColor ?? "#5AC8FAFF" : change !== null && change < 0 ? s.downColor ?? "#FF6B6BFF" : s.upColor ?? "#4ADE80FF";
        paintSparkline(cr, width, height, values, {
            color: parseHexColor(hex),
            lineWidth: s.graphLineWidth ?? 2,
            smooth: s.graphSmooth ?? false,
            fill: s.graphFill ?? false,
            fillOpacity: (s.graphFillOpacity ?? 25) / 100,
            Cairo: Cairo
        });
        cr.$dispose();
    }
}
