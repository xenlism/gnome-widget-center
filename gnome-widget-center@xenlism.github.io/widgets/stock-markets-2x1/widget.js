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

export default class StockMarkets2x1Widget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._fetchJson = createStockFetcher(Soup, GLib);
        this._refreshId = null;
        this._rotateId = null;
        this._repaintId = null;
        this._quotes = {};
        this._source = "";
        this._offline = false;
        this._errors = {};
        this._activeSymbol = null;
        this._dataKey = "";
        this._disposed = false;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "stock-markets-2x1-root"
        });
        this._actor = this._layers.root;
        this._content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true
        });
        this._layers.content.add_child(this._content);
        // header: dot + title ........ tabs
        this._header = new St.BoxLayout({
            style_class: "stock-markets-2x1-header",
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._dot = new St.Widget({
            style_class: "stock-markets-2x1-dot",
            y_align: Clutter.ActorAlign.CENTER
        });
        this._titleLabel = new St.Label({
            style_class: "stock-markets-2x1-title",
            y_align: Clutter.ActorAlign.CENTER
        });
        this._headerSpacer = new St.Widget({
            x_expand: true
        });
        this._tabsBox = new St.BoxLayout({
            style_class: "stock-markets-2x1-tabs",
            y_align: Clutter.ActorAlign.CENTER
        });
        this._header.add_child(this._dot);
        this._header.add_child(this._titleLabel);
        this._header.add_child(this._headerSpacer);
        this._header.add_child(this._tabsBox);
        // middle: price block ........ graph
        this._middle = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._priceBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._priceLabel = new St.Label({
            style_class: "stock-markets-2x1-price"
        });
        this._priceLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._infoRow = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER
        });
        this._changeLabel = new St.Label({
            style_class: "stock-markets-2x1-change",
            y_align: Clutter.ActorAlign.CENTER
        });
        this._nameLabel = new St.Label({
            style_class: "stock-markets-2x1-name",
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._infoRow.add_child(this._changeLabel);
        this._infoRow.add_child(this._nameLabel);
        this._priceBox.add_child(this._priceLabel);
        this._priceBox.add_child(this._infoRow);
        this._graphArea = new St.DrawingArea({
            style_class: "stock-markets-2x1-graph",
            y_align: Clutter.ActorAlign.CENTER
        });
        this._repaintId = this._graphArea.connect("repaint", area => this._onRepaint(area));
        this._middle.add_child(this._priceBox);
        this._middle.add_child(this._graphArea);
        // footer
        this._footerLabel = new St.Label({
            style_class: "stock-markets-2x1-footer"
        });
        this._footerLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._content.add_child(this._header);
        this._content.add_child(this._middle);
        this._content.add_child(this._footerLabel);
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
        this._rebuildTabs();
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
            if (errors && Object.keys(errors).length) this._api.logger.warn(`stock-markets-2x1: no data for ${Object.keys(errors).join(", ")} via ${source}: ${JSON.stringify(errors)}`);
            this._source = source;
            this._offline = false;
        } catch (e) {
            this._offline = true;
            this._source = PROVIDER_NAMES[provider] ?? provider;
            this._api.logger.warn(`stock-markets-2x1: refresh failed (${PROVIDER_NAMES[provider] ?? provider}): ${e}`);
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
    _selectSymbol(symbol) {
        this._activeSymbol = symbol;
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
    _rebuildTabs() {
        if (!this._tabsBox) return;
        const tabsKey = this._symbols.map(c => c.symbol).join(",");
        if (tabsKey === this._tabsKey && this._tabButtons?.size) return;
        this._tabsKey = tabsKey;
        this._tabsBox.destroy_all_children();
        this._tabButtons = new Map;
        for (const item of this._symbols) {
            const button = new St.Button({
                label: item.label,
                style_class: "stock-markets-2x1-tab",
                reactive: true,
                can_focus: false
            });
            button.connect("clicked", () => this._selectSymbol(item.symbol));
            this._tabsBox.add_child(button);
            this._tabButtons.set(item.symbol, button);
        }
    }
    _render() {
        if (!this._layers) return;
        const s = this._settings;
        const pad = s.cardPadding ?? 16;
        applyLayeredCardStyle(this._layers, s, {
            cornerRadiusFallback: 18
        }, false);
        this._content.set_style(`padding: ${pad}px; spacing: 6px;`);
        // header
        const showTitle = s.showTitle ?? true;
        this._dot.visible = showTitle;
        this._titleLabel.visible = showTitle;
        this._dot.set_style(`background-color: ${cssRgba(s.dotColor, 1, "#FFD24AFF")}; border-radius: 99px; width: 9px; height: 9px; margin-right: 8px;`);
        this._titleLabel.set_text(s.titleText ?? "MARKETS");
        this._titleLabel.set_style(`color: ${cssRgba(s.titleColor)}; letter-spacing: 1.5px; ${fontCss(Pango, s.titleFont, "Sans", 11)}`);
        const showTabs = (s.showTabs ?? true) && this._symbols.length > 0;
        this._tabsBox.visible = showTabs;
        const tabFont = fontCss(Pango, s.tabFont, "Sans", 9);
        for (const [symbol, button] of this._tabButtons ?? []) {
            const active = symbol === this._activeSymbol;
            const bg = cssRgba(active ? s.tabActiveBgColor : s.tabInactiveBgColor, 1, active ? "#FFD24AFF" : "#394350FF");
            const fg = cssRgba(active ? s.tabActiveTextColor : s.tabInactiveTextColor, 1, active ? "#1E2530FF" : "#C3CCD8FF");
            button.set_style(`background-color: ${bg}; color: ${fg}; ${tabFont} border-radius: 99px; padding: 3px 10px; margin-left: 4px;`);
        }
        // price block
        const quote = this._quotes[this._activeSymbol];
        const entry = this._symbols.find(c => c.symbol === this._activeSymbol);
        const prefix = currencyPrefix(quote?.currency ?? "USD", s.showCurrencySymbol ?? true);
        const price = quote ? formatPrice(quote.price, stockPriceOptions(quote?.price, {
            separator: s.thousandsSeparator ?? "comma",
            decimals: s.priceDecimals ?? "auto"
        })) : "--";
        this._priceLabel.set_text(quote && quote.price !== null ? `${prefix}${price}` : "--");
        this._priceLabel.set_style(`color: ${cssRgba(s.priceColor)}; ${fontCss(Pango, s.priceFont, "Sans", 28)}`);
        const change = quote?.changePct ?? null;
        const trendColor = change !== null && change < 0 ? s.downColor ?? "#FF6B6BFF" : s.upColor ?? "#4ADE80FF";
        this._changeLabel.set_text(formatChange(change));
        const pill = s.changePill ?? true;
        const pillBg = pill ? `background-color: ${cssRgba(trendColor, (s.changePillOpacity ?? 25) / 100)}; border-radius: 8px; padding: 2px 9px;` : "";
        this._changeLabel.set_style(`color: ${cssRgba(trendColor)}; ${fontCss(Pango, s.changeFont, "Sans", 10)} ${pillBg}`);
        const showName = s.showName ?? true;
        this._nameLabel.visible = showName;
        this._nameLabel.set_text(this._nameText(quote, entry));
        this._nameLabel.set_style(`color: ${cssRgba(s.nameColor)}; ${fontCss(Pango, s.nameFont, "Sans", 11)} margin-left: ${pill ? 10 : 8}px;`);
        // graph
        const showGraph = s.showGraph ?? true;
        this._graphArea.visible = showGraph;
        this._graphArea.set_size(s.graphWidth ?? 128, s.graphHeight ?? 56);
        this._graphArea.queue_repaint();
        // footer
        const showFooter = s.showFooter ?? true;
        this._footerLabel.visible = showFooter;
        let footer = s.footerText ?? "Live Stock Tracking";
        if ((s.footerShowSource ?? true) && this._source) footer += ` \u00B7 ${this._source}`;
        if (this._offline || this._errors[this._activeSymbol]) footer += " \u00B7 offline";
        this._footerLabel.set_text(footer);
        this._footerLabel.set_style(`color: ${cssRgba(s.footerColor)}; ${fontCss(Pango, s.footerFont, "Sans", 8)}`);
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
