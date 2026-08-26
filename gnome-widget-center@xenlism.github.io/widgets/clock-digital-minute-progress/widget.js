import Clutter from "gi://Clutter";
import St from "gi://St";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Cairo from "cairo";
import {
    SHADOW_DEFAULTS,
    hexToRgba as _hexToRgba,
    parseFontDescription as _parseFontDescription,
} from "../../lib/widgetVisualKit.js";
import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";
import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";

const FACE_SIZE = 148;
const FACE_MARGIN = 4;

function _splitFamilyAndWeight(family) {
    const isBold = /\bbold\b/i.test(family ?? "");
    const plain = (family ?? "Sans").replace(/\b(bold|italic|oblique|light|medium|regular)\b/gi, "").trim() || "Sans";
    return { family: plain, bold: isBold };
}

export default class ClockDigitalMinuteProgressWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timerId = null;
        this._pressId = null;
        this._now = { dateTime: null };
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "clock-digital-minute-progress-root"
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
        const seconds = Math.max(1, this._settings.refreshRateSeconds ?? 5);
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
        this._now.dateTime = GLib.DateTime.new_now_local();
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
            if (appInfo) appInfo.launch([], null); else this._api.logger.info(`clock-digital-minute-progress: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`clock-digital-minute-progress: failed to launch ${path}: ${e}`);
        }
    }

    _render() {
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorFallback: "#FFFFFFFF",
            cornerRadiusFallback: 28,
        });
        if (this._faceArea) this._faceArea.queue_repaint();
    }

    _setSourceHex(cr, hex, fallback) {
        const { r, g, b, a } = _hexToRgba(hex ?? fallback);
        cr.setSourceRGBA(r, g, b, a);
    }

    _drawCenteredText(cr, text, x, y) {
        const extents = cr.textExtents(text);
        cr.moveTo(x - extents.width / 2 - extents.xBearing, y - extents.height / 2 - extents.yBearing);
        cr.showText(text);
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
        const dt = this._now.dateTime ?? GLib.DateTime.new_now_local();

        if (s.showDashes ?? true) {
            const dashCount = Math.max(4, Math.round(s.dashCount ?? 60));
            const outer = radius - 2;
            const length = 9;
            const inner = outer - length;
            const currentMinute = dt.get_minute();
            cr.setLineWidth(2);
            cr.setLineCap(Cairo.LineCap.ROUND);
            for (let i = 0; i < dashCount; i++) {
                const minuteForDash = Math.floor(i * 60 / dashCount);
                const elapsed = minuteForDash <= currentMinute;
                this._setSourceHex(
                    cr,
                    elapsed ? s.dashColorElapsed : s.dashColorRemaining,
                    elapsed ? "#1A1A1AFF" : "#1A1A1A33"
                );
                const angle = i * (2 * Math.PI / dashCount);
                cr.moveTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
                cr.lineTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
                cr.stroke();
            }
        }

        const format24h = s.format24h ?? true;
        const text = format24h ? (dt.format("%H:%M") ?? "") : (dt.format("%I:%M") ?? "");
        const { family, size } = _parseFontDescription(s.digitFont ?? "Sans Bold 34", "Sans Bold", 34);
        const { family: cairoFamily, bold } = _splitFamilyAndWeight(family);
        cr.selectFontFace(cairoFamily, Cairo.FontSlant.NORMAL, bold ? Cairo.FontWeight.BOLD : Cairo.FontWeight.NORMAL);
        cr.setFontSize(size);
        this._setSourceHex(cr, s.digitColor, "#1A1A1AFF");
        this._drawCenteredText(cr, text, cx, cy);

        cr.$dispose();
    }
}
