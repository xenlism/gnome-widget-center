import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import Gio from "gi://Gio";

import Cairo from "cairo";

import { SHADOW_DEFAULTS, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";

const STACK_SIZE = 148;

const RING_GAP = 4;

export default class CirclesClockWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timerId = null;
        this._pressId = null;
        this._fractions = {
            hh: 0,
            mm: 0,
            ss: 0
        };
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "circles-clock-root"
        });
        this._actor = this._layers.root;
        const outerBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true
        });
        this._layers.content.add_child(outerBox);
        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            width: STACK_SIZE,
            height: STACK_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        outerBox.add_child(this._stack);
        outerBox.set_style("padding: 14px;");
        this._ringArea = new St.DrawingArea({
            width: STACK_SIZE,
            height: STACK_SIZE
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
        this._timeLabel = new St.Label({
            style_class: "circles-clock-time"
        });
        textBox.add_child(this._timeLabel);
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
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
            backgroundColor: "#FFFFFF00",
            cornerRadius: 18,
            format24h: true,
            timeFont: "Sans Bold 20",
            timeColor: "#FFFFFFFF",
            circleBaseColor: "#FFFFFF26",
            colorHH: "#7A2E3DFF",
            colorMM: "#E2373DFF",
            colorSS: "#33D17AFF",
            ringThickness: 10,
            refreshRateSeconds: 1,
            launchAppPath: ""
        };
    }
    onSettingsChanged() {
        this._render();
        this._startTimer();
        this._applyClickHandler();
    }
    _startTimer() {
        this._stopTimer();
        const seconds = Math.max(1, this._settings.refreshRateSeconds ?? 1);
        this._tick();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }
    _tick() {
        const now = GLib.DateTime.new_now_local();
        const format24h = this._settings.format24h ?? true;
        const hour = now.get_hour();
        const minute = now.get_minute();
        const second = now.get_second();
        const hourSpan = format24h ? 24 : 12;
        const hourInSpan = format24h ? hour : hour % 12;
        this._fractions.hh = (hourInSpan + minute / 60) / hourSpan;
        this._fractions.mm = (minute + second / 60) / 60;
        this._fractions.ss = second / 60;
        this._timeLabel.set_text(format24h ? now.format("%H:%M:%S") ?? "" : now.format("%I:%M:%S") ?? "");
        if (this._ringArea) this._ringArea.queue_repaint();
    }
    _applyClickHandler() {
        this._removeClickHandler();
        const desktopFilePath = this._settings.launchAppPath ?? "";
        if (!desktopFilePath) {
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
            if (appInfo) appInfo.launch([], null); else this._api.logger.info(`circles-clock: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`circles-clock: failed to launch ${path}: ${e}`);
        }
    }
    _render() {
        const backgroundColor = _toCssColor(this._settings.backgroundColor, "#FFFFFF00");
        const cornerRadius = this._settings.cornerRadius ?? 18;
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorFallback: "#FFFFFF00",
            cornerRadiusFallback: 18
        }, false);
        const timeColor = _toCssColor(this._settings.timeColor, "#FFFFFFFF");
        const {family: family, size: size} = _parseFontDescription(this._settings.timeFont ?? "Sans Bold 20", "Sans Bold", 20);
        this._timeLabel.set_style(`color: ${timeColor}; font-family: ${family}; ` + `font-size: ${size}px; font-weight: bold; text-align: center;`);
        if (this._ringArea) this._ringArea.queue_repaint();
    }
    _onRepaint() {
        const cr = this._ringArea.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const thickness = Math.max(2, this._settings.ringThickness ?? 10);
        const baseColor = _hexToRgba(this._settings.circleBaseColor ?? "#FFFFFF26");
        const cx = STACK_SIZE / 2;
        const cy = STACK_SIZE / 2;
        const startAngle = -Math.PI / 2;
        const outerRadius = STACK_SIZE / 2 - thickness / 2 - 2;
        const rings = [ {
            radius: outerRadius,
            fraction: this._fractions.hh,
            color: this._settings.colorHH ?? "#7A2E3DFF"
        }, {
            radius: outerRadius - (thickness + RING_GAP),
            fraction: this._fractions.mm,
            color: this._settings.colorMM ?? "#E2373DFF"
        }, {
            radius: outerRadius - 2 * (thickness + RING_GAP),
            fraction: this._fractions.ss,
            color: this._settings.colorSS ?? "#33D17AFF"
        } ];
        cr.setLineWidth(thickness);
        cr.setLineCap(Cairo.LineCap.ROUND);
        for (const ring of rings) {
            if (ring.radius <= 0) continue;
            cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
            cr.arc(cx, cy, ring.radius, 0, 2 * Math.PI);
            cr.stroke();
            const fraction = Math.max(0, Math.min(1, ring.fraction));
            if (fraction > 0) {
                const {r: r, g: g, b: b, a: a} = _hexToRgba(ring.color);
                cr.setSourceRGBA(r, g, b, a);
                cr.arc(cx, cy, ring.radius, startAngle, startAngle + fraction * 2 * Math.PI);
                cr.stroke();
            }
        }
        cr.$dispose();
    }
}
