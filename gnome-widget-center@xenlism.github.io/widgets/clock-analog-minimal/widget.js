import Clutter from "gi://Clutter";
import St from "gi://St";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Cairo from "cairo";
import {
    SHADOW_DEFAULTS,
    hexToRgba as _hexToRgba,
} from "../../lib/widgetVisualKit.js";
import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";
import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";

const FACE_SIZE = 148;
const FACE_MARGIN = 4;

export default class ClockAnalogMinimalWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timerId = null;
        this._pressId = null;
        this._now = { hour: 0, minute: 0, second: 0 };
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "clock-analog-minimal-root"
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
            layout_manager: new Clutter.BinLayout(),
            width: FACE_SIZE,
            height: FACE_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        outerBox.add_child(this._stack);

        this._faceArea = new St.DrawingArea({
            width: FACE_SIZE,
            height: FACE_SIZE
        });
        this._stack.add_child(this._faceArea);
        this._repaintId = this._faceArea.connect("repaint", () => this._onRepaint());

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
        if (this._repaintId !== null && this._faceArea) {
            this._faceArea.disconnect(this._repaintId);
            this._repaintId = null;
        }
        this._removeClickHandler();
    }

    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
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
        this._now.hour = now.get_hour();
        this._now.minute = now.get_minute();
        this._now.second = now.get_second();
        this._now.dateTime = now;
        if (this._faceArea) this._faceArea.queue_repaint();
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
            if (appInfo) appInfo.launch([], null); else this._api.logger.info(`clock-analog-minimal: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`clock-analog-minimal: failed to launch ${path}: ${e}`);
        }
    }

    _render() {
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorFallback: "#FFFFFFFF",
            cornerRadiusFallback: 24,
        });
        if (this._faceArea) this._faceArea.queue_repaint();
    }

    _setSourceHex(cr, hex, fallback) {
        const { r, g, b, a } = _hexToRgba(hex ?? fallback);
        cr.setSourceRGBA(r, g, b, a);
    }

    _onRepaint() {
        const cr = this._faceArea.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const s = this._settings;
        const cx = FACE_SIZE / 2;
        const cy = FACE_SIZE / 2;
        const radius = FACE_SIZE / 2 - FACE_MARGIN;

        this._setSourceHex(cr, s.faceColor, "#FFFFFFFF");
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.fill();

        const showMinuteTicks = s.showMinuteTicks ?? true;
        for (let i = 0; i < 60; i++) {
            const isHourTick = i % 5 === 0;
            if (!isHourTick && !showMinuteTicks) continue;
            const angle = i * (2 * Math.PI / 60) - Math.PI / 2;
            const outer = radius - 3;
            const length = isHourTick ? 10 : 5;
            const inner = outer - length;
            cr.setLineWidth(isHourTick ? 2.4 : 1.1);
            this._setSourceHex(cr, s.tickColor, "#1A1A1AFF");
            cr.moveTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
            cr.lineTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
            cr.stroke();
        }

        const hourInSpan = this._now.hour % 12;
        const hourAngle = ((hourInSpan + this._now.minute / 60) / 12) * 2 * Math.PI - Math.PI / 2;
        const minuteAngle = ((this._now.minute + this._now.second / 60) / 60) * 2 * Math.PI - Math.PI / 2;
        const secondAngle = (this._now.second / 60) * 2 * Math.PI - Math.PI / 2;

        this._drawHand(cr, cx, cy, hourAngle, radius * 0.5, 4.2, s.hourHandColor, "#1A1A1AFF");
        this._drawHand(cr, cx, cy, minuteAngle, radius * 0.72, 3, s.minuteHandColor, "#1A1A1AFF");
        if (s.showSecondHand ?? true) {
            this._drawHand(cr, cx, cy, secondAngle, radius * 0.8, 1.4, s.secondHandColor, "#D81F26FF");
        }

        this._setSourceHex(cr, s.hourHandColor, "#1A1A1AFF");
        cr.arc(cx, cy, 3, 0, 2 * Math.PI);
        cr.fill();

        cr.$dispose();
    }

    _drawHand(cr, cx, cy, angle, length, width, color, fallback) {
        cr.setLineWidth(width);
        cr.setLineCap(Cairo.LineCap.ROUND);
        this._setSourceHex(cr, color, fallback);
        cr.moveTo(cx, cy);
        cr.lineTo(cx + Math.cos(angle) * length, cy + Math.sin(angle) * length);
        cr.stroke();
    }
}
