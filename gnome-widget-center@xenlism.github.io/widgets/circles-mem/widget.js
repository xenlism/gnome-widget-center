import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import Gio from "gi://Gio";

import Cairo from "cairo";

import { SystemMetricsService } from "../../lib/systemMetricsApi.js";

import { SHADOW_DEFAULTS, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
const RING_SIZE = 128;

export default class CirclesMemWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService;
        this._timerId = null;
        this._pressId = null;
        this._fraction = 0;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "circles-mem-root"
        });
        this._actor = this._layers.root;
        const outerBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true
        });
        this._layers.content.add_child(outerBox);
        outerBox.set_style("padding: 14px;");
        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            width: RING_SIZE,
            height: RING_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true
        });
        outerBox.add_child(this._stack);
        this._ringArea = new St.DrawingArea({
            width: RING_SIZE,
            height: RING_SIZE
        });
        this._stack.add_child(this._ringArea);
        this._repaintId = this._ringArea.connect("repaint", () => this._onRepaint());
        const textBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true
        });
        this._labelLabel = new St.Label({
            text: "MEM",
            style_class: "circles-mem-label"
        });
        this._valueLabel = new St.Label({
            text: "0%",
            style_class: "circles-mem-value"
        });
        textBox.add_child(this._labelLabel);
        textBox.add_child(this._valueLabel);
        this._stack.add_child(textBox);
        this._render();
        this._tick();
        this._applyClickHandler();
        return this._actor;
    }
    enable() {
        this._startTimer();
    }
    disable() {
        this._stopTimer();
        if (this._repaintId !== null && this._ringArea) {
            this._ringArea.disconnect(this._repaintId);
            this._repaintId = null;
        }
        this._removeClickHandler();
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
        const seconds = Math.max(1, this._settings.refreshRateSeconds ?? 2);
        this._tick();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._applyClickHandler();
    }
    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }
    async _tick() {
        const {percent: percent} = await this._metrics.getMemoryUsage();
        const clamped = Math.max(0, Math.min(100, percent ?? 0));
        this._fraction = clamped / 100;
        this._valueLabel.set_text(`${Math.round(clamped)}%`);
        if (this._ringArea) this._ringArea.queue_repaint();
    }
    _applyClickHandler() {
        this._removeClickHandler();
        const path = this._settings.launchAppPath ?? "";
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
    _removeClickHandler() {
        if (this._pressId !== null && this._actor) {
            this._actor.disconnect(this._pressId);
            this._pressId = null;
        }
    }
    _launchApp() {
        const path = this._settings.launchAppPath ?? "";
        if (!path) return;
        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
            if (appInfo) appInfo.launch([], null); else this._api.logger.info(`circles-mem: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`circles-mem: failed to launch ${path}: ${e}`);
        }
    }
    _render() {
        const backgroundColor = _toCssColor(this._settings.backgroundColor, "#FFFFFF00");
        const cornerRadius = this._settings.cornerRadius ?? 18;
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorFallback: "#FFFFFF00",
            cornerRadiusFallback: 18
        }, false);
        const labelColor = _toCssColor(this._settings.labelColor, "#FFFFFFB3");
        const percentColor = _toCssColor(this._settings.percentColor, "#FFFFFFFF");
        const labelFont = _parseFontDescription(this._settings.labelFont ?? "Sans 12", "Sans", 12);
        const percentFont = _parseFontDescription(this._settings.percentFont ?? "Sans Bold 22", "Sans Bold", 22);
        this._labelLabel.set_style(`color: ${labelColor}; font-family: ${labelFont.family}; ` + `font-size: ${labelFont.size}px; text-align: center;`);
        this._valueLabel.set_style(`color: ${percentColor}; font-family: ${percentFont.family}; ` + `font-size: ${percentFont.size}px; font-weight: bold; text-align: center;`);
        if (this._ringArea) this._ringArea.queue_repaint();
    }
    _onRepaint() {
        const cr = this._ringArea.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const thickness = Math.max(2, this._settings.ringThickness ?? 10);
        const baseColor = _hexToRgba(this._settings.circleBaseColor ?? "#FFFFFF26");
        const ringColor = _hexToRgba(this._settings.ringColor ?? "#33D17AFF");
        const cx = RING_SIZE / 2;
        const cy = RING_SIZE / 2;
        const radius = (RING_SIZE - thickness) / 2 - 2;
        const startAngle = -Math.PI / 2;
        const fraction = Math.max(0, Math.min(1, this._fraction));
        const endAngle = startAngle + fraction * 2 * Math.PI;
        cr.setLineWidth(thickness);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();
        if (fraction > 0) {
            cr.setSourceRGBA(ringColor.r, ringColor.g, ringColor.b, ringColor.a);
            cr.arc(cx, cy, radius, startAngle, endAngle);
            cr.stroke();
        }
        cr.$dispose();
    }
}
