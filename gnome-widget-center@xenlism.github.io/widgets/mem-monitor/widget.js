import St from "gi://St";

import Clutter from "gi://Clutter";

import GLib from "gi://GLib";

import Gio from "gi://Gio";

import Pango from "gi://Pango";

import Cairo from "cairo";

import { SystemMetricsService } from "../../lib/systemMetricsApi.js";

import { SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
const MAX_HISTORY = 40;

const GRAPH_HEIGHT = 46;

const CARD_PADDING = 16;

function _parseHexColor(hex, fallback = "#FFFFFFFF") {
    const value = typeof hex === "string" && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex) ? hex : fallback;
    const r = parseInt(value.slice(1, 3), 16) / 255;
    const g = parseInt(value.slice(3, 5), 16) / 255;
    const b = parseInt(value.slice(5, 7), 16) / 255;
    const a = value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1;
    return {
        r: r,
        g: g,
        b: b,
        a: a
    };
}

function _splitFontDescription(fontStr, fallbackFamily = "Sans", fallbackSize = 34) {
    try {
        const desc = Pango.FontDescription.from_string(fontStr || `${fallbackFamily} Bold ${fallbackSize}`);
        const family = desc.get_family() || fallbackFamily;
        const weight = desc.get_weight() || 400;
        const style = desc.get_style();
        const styleCss = style === Pango.Style.ITALIC ? "italic" : style === Pango.Style.OBLIQUE ? "oblique" : "normal";
        const sizeRaw = desc.get_size();
        const size = sizeRaw > 0 ? Math.round(sizeRaw / Pango.SCALE) : fallbackSize;
        return {
            family: family,
            weight: weight,
            styleCss: styleCss,
            size: size
        };
    } catch (e) {
        return {
            family: fallbackFamily,
            weight: 700,
            styleCss: "normal",
            size: fallbackSize
        };
    }
}

export default class MemMonitorWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService;
        this._history = [];
        this._timerId = null;
        this._pressId = null;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "mem-monitor-root"
        });
        this._actor = this._layers.root;
        this._content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true
        });
        this._layers.content.add_child(this._content);
        this._textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true
        });
        this._valueLabel = new St.Label({
            style_class: "mem-monitor-value"
        });
        this._captionLabel = new St.Label({
            style_class: "mem-monitor-caption"
        });
        this._textBox.add_child(this._valueLabel);
        this._textBox.add_child(this._captionLabel);
        this._graphArea = new St.DrawingArea({
            style_class: "mem-monitor-graph",
            x_expand: true,
            height: GRAPH_HEIGHT
        });
        this._repaintId = this._graphArea.connect("repaint", area => this._onRepaint(area));
        this._content.add_child(this._textBox);
        this._content.add_child(this._graphArea);
        this._render();
        this._tick();
        return this._actor;
    }
    enable() {
        this._startTimer();
    }
    disable() {
        this._stopTimer();
        if (this._repaintId !== null && this._graphArea) {
            this._graphArea.disconnect(this._repaintId);
            this._repaintId = null;
        }
        this._disconnectClick();
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
        this._render();
        this._startTimer();
    }
    _startTimer() {
        this._stopTimer();
        const seconds = Math.max(1, this._settings.refreshRateSeconds ?? 3);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._connectClick();
    }
    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }
    _tick() {
        const {percent: percent} = this._metrics.getMemoryUsage();
        this._history.push(percent);
        if (this._history.length > MAX_HISTORY) this._history.shift();
        this._valueLabel.set_text(`${percent}%`);
        if (this._graphArea) this._graphArea.queue_repaint();
    }
    _disconnectClick() {
        if (this._pressId !== null && this._actor) {
            this._actor.disconnect(this._pressId);
            this._pressId = null;
        }
    }
    _connectClick() {
        this._disconnectClick();
        const path = this._settings.launchAppPath;
        if (!path) {
            this._actor.reactive = false;
            return;
        }
        this._actor.reactive = true;
        this._pressId = this._actor.connect("button-press-event", (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            if (event.get_state() & Clutter.ModifierType.MOD4_MASK) return Clutter.EVENT_PROPAGATE;
            this._launchApp();
            return Clutter.EVENT_STOP;
        });
    }
    _launchApp() {
        const path = this._settings.launchAppPath;
        if (!path) return;
        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
            if (appInfo) appInfo.launch([], null); else this._api.logger.info(`mem-monitor: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`mem-monitor: failed to launch ${path}: ${e}`);
        }
    }
    _render() {
        const fontColor = _toCssColor(this._settings.fontColor, "#FFFFFFFF");
        const graphBaseColor = _toCssColor(this._settings.graphBaseColor, "#FFFFFF12");
        const font = _splitFontDescription(this._settings.fontDesc ?? "Sans Bold 34", "Sans", 34);
        applyLayeredCardStyle(this._layers, this._settings, {
            cornerRadiusFallback: 18
        }, false);
        this._textBox.set_style(`padding: ${CARD_PADDING}px ${CARD_PADDING}px 6px ${CARD_PADDING}px; spacing: 2px;`);
        this._valueLabel.set_style(`color: ${fontColor}; ` + `font-family: ${font.family}; font-weight: ${font.weight}; font-style: ${font.styleCss}; ` + `font-size: ${font.size}px;`);
        this._captionLabel.set_text("MEM");
        this._captionLabel.set_style(`color: ${fontColor}; ` + `font-family: ${font.family}; font-weight: ${font.weight}; font-style: ${font.styleCss}; ` + `font-size: ${Math.max(12, Math.round(font.size * .4))}px;`);
        this._graphArea.set_style(`background-color: ${graphBaseColor}; margin: 6px 0 ${CARD_PADDING}px 0;`);
        if (this._graphArea) this._graphArea.queue_repaint();
    }
    _onRepaint(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        if (this._history.length >= 2) {
            const {r: r, g: g, b: b, a: a} = _parseHexColor(this._settings.graphLineColor ?? "#5AC8FAFF");
            const points = this._history;
            const stepX = width / Math.max(1, MAX_HISTORY - 1);
            const startIndex = MAX_HISTORY - points.length;
            cr.setLineWidth(2);
            cr.setSourceRGBA(r, g, b, a);
            points.forEach((value, i) => {
                const x = (startIndex + i) * stepX;
                const y = height - 6 - Math.max(0, Math.min(100, value)) / 100 * (height - 12);
                if (i === 0) cr.moveTo(x, y); else cr.lineTo(x, y);
            });
            cr.stroke();
        }
        cr.$dispose();
    }
}