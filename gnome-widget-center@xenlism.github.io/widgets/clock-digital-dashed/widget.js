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

const FACE_SIZE = 176;
const FACE_MARGIN = 5; // proportional to the old 4px-at-148 margin, used by the circular fallback below

// Dash-ring geometry, ported 1:1 from a reference asset (clock_176x176_60dash_square_close_1_.svg,
// a 176x176 design with 60 dashes tracing a rounded-square path) rather than the
// old generic "N dashes evenly spaced on a circle" formula - a circle doesn't
// reproduce the square-with-rounded-corners look the reference actually has
// (dashes hug the corners tighter than the flat edges; a circle can't do that).
//
// Each entry is [nx, ny, rotationDeg]: nx/ny are the dash's center position as a
// fraction of the half-canvas (so ±1.0 = the canvas edge in the 176px reference
// frame), and rotationDeg is copied directly from the reference SVG's own
// per-dash `rotate()` transform - i.e. this is each dash's *actual* local
// outward-normal direction, not a recomputed approximation, which matters right
// at the corners where "pointing away from the ring's own center" and "the true
// outward normal of the rounded-square path" are not the same direction.
//
// Positions are already shifted outward from the reference file by the amount
// needed to put the (flat-edge) dashes 8px from the card edge in the 176px
// frame, per spec - the near-corner dashes in the reference path sit much
// closer to the edge than the flat-edge ones to begin with (2.6px vs ~20px),
// so that same outward shift pushes a handful of them slightly past the outer
// edge; _onRepaint() clips dash drawing to the card's own rounded-rect outline
// so that overshoot is simply cropped clean rather than floating outside the
// visible card.
const DASH_GEOMETRY = [
    [-0.55178, -0.84083, 146.73], [-0.45137, -0.84714, 151.95], [-0.34906, -0.85297, 157.74],
    [-0.24516, -0.85786, 164.05], [-0.13972, -0.86134, 170.78], [-0.03344, -0.86299, 177.78],
    [0.07305, -0.86261, 184.84], [0.17916, -0.86024, 191.76], [0.28401, -0.85618, 198.35],
    [0.38730, -0.85088, 204.48], [0.48894, -0.84482, 210.06], [0.58876, -0.83605, 215.15],
    [0.68376, -0.80079, 220.49], [0.76322, -0.73610, 226.04], [0.81770, -0.64961, 231.53],
    [0.84083, -0.55178, 236.73], [0.84714, -0.45137, 241.95], [0.85297, -0.34906, 247.74],
    [0.85786, -0.24516, 254.05], [0.86134, -0.13972, 260.78], [0.86299, -0.03344, 267.78],
    [0.86261, 0.07305, -85.16], [0.86024, 0.17916, -78.24], [0.85618, 0.28401, -71.65],
    [0.85088, 0.38730, -65.52], [0.84482, 0.48894, -59.94], [0.83605, 0.58876, -54.85],
    [0.80079, 0.68376, -49.51], [0.73610, 0.76322, -43.96], [0.64961, 0.81770, -38.47],
    [0.55178, 0.84083, -33.27], [0.45137, 0.84714, -28.05], [0.34906, 0.85297, -22.26],
    [0.24516, 0.85786, -15.95], [0.13972, 0.86134, -9.22], [0.03344, 0.86299, -2.22],
    [-0.07305, 0.86261, 4.84], [-0.17916, 0.86024, 11.76], [-0.28401, 0.85618, 18.35],
    [-0.38730, 0.85088, 24.48], [-0.48894, 0.84482, 30.06], [-0.58876, 0.83605, 35.15],
    [-0.68376, 0.80079, 40.49], [-0.76322, 0.73610, 46.04], [-0.81770, 0.64961, 51.53],
    [-0.84083, 0.55178, 56.73], [-0.84714, 0.45137, 61.95], [-0.85297, 0.34906, 67.74],
    [-0.85786, 0.24516, 74.05], [-0.86134, 0.13972, 80.78], [-0.86299, 0.03344, 87.78],
    [-0.86261, -0.07305, 94.84], [-0.86024, -0.17916, 101.76], [-0.85618, -0.28401, 108.35],
    [-0.85088, -0.38730, 114.48], [-0.84482, -0.48894, 120.06], [-0.83605, -0.58876, 125.15],
    [-0.80079, -0.68376, 130.49], [-0.73610, -0.76322, 136.04], [-0.64961, -0.81770, 141.53]
];
// Dash rect in the 176px reference frame: width 2, height 8, corner radius 1.
const DASH_REF_CANVAS = 176;
const DASH_REF_W = 2;
const DASH_REF_H = 8;
const DASH_REF_RX = 1;

// Strip weight/style keywords out of a Pango-style family string so
// Cairo's toy font-face selection gets a plain family name - passing
// "Sans Bold" straight through to selectFontFace() is unreliable across
// fontconfig setups, so the weight is applied via Cairo.FontWeight
// instead of being left in the family string.
function _splitFamilyAndWeight(family) {
    const isBold = /\bbold\b/i.test(family ?? "");
    const plain = (family ?? "Sans").replace(/\b(bold|italic|oblique|light|medium|regular)\b/gi, "").trim() || "Sans";
    return { family: plain, bold: isBold };
}

// Traces a rounded-rect path (does not fill/stroke/clip - call cr.fill(),
// cr.stroke(), or cr.clip() after) with top-left corner (x,y), size w x h,
// and corner radius r. Cairo has no built-in rounded-rect primitive.
function _roundedRectPath(cr, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    cr.moveTo(x + rr, y);
    cr.lineTo(x + w - rr, y);
    cr.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
    cr.lineTo(x + w, y + h - rr);
    cr.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
    cr.lineTo(x + rr, y + h);
    cr.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
    cr.lineTo(x, y + rr);
    cr.arc(x + rr, y + rr, rr, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

export default class ClockDigitalDashedWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timerId = null;
        this._pressId = null;
        this._now = { dateTime: null };
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "clock-digital-dashed-root"
        });
        this._actor = this._layers.root;

        const outerBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true
        });
        this._layers.content.add_child(outerBox);
        // No padding here anymore - the dash ring is now drawn using the
        // reference design's own coordinates, which assume the Cairo
        // canvas spans the whole card (see FACE_SIZE above: it grew from
        // 148 to 176 - the old 14px padding - specifically so this still
        // adds up to the same overall widget footprint as before; only
        // the split between "St padding" and "Cairo canvas" moved).

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
            if (appInfo) appInfo.launch([], null); else this._api.logger.info(`clock-digital-dashed: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`clock-digital-dashed: failed to launch ${path}: ${e}`);
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

        // Dash ring - ported from a reference SVG asset rather than drawn as a
        // generic circle; see the DASH_GEOMETRY comment above for why.
        if (s.showDashes ?? true) {
            const scale = FACE_SIZE / DASH_REF_CANVAS;
            cr.save();
            // Clip to the card's own rounded-rect outline before drawing, so
            // the handful of near-corner dashes whose reference position
            // overshoots the reference canvas edge (see DASH_GEOMETRY comment)
            // get cropped cleanly against the card instead of floating past it.
            const cornerRadius = Math.max(0, Math.min(radius, (s.cornerRadius ?? 28) * scale));
            cr.newSubPath();
            _roundedRectPath(cr, cx - radius, cy - radius, radius * 2, radius * 2, cornerRadius);
            cr.clip();

            this._setSourceHex(cr, s.dashColor, "#1A1A1AFF");
            for (const [nx, ny, rotDeg] of DASH_GEOMETRY) {
                cr.save();
                cr.translate(cx + nx * (DASH_REF_CANVAS / 2) * scale, cy + ny * (DASH_REF_CANVAS / 2) * scale);
                cr.rotate(rotDeg * Math.PI / 180);
                _roundedRectPath(cr, -(DASH_REF_W * scale) / 2, -(DASH_REF_H * scale) / 2, DASH_REF_W * scale, DASH_REF_H * scale, DASH_REF_RX * scale);
                cr.fill();
                cr.restore();
            }
            cr.restore();
        }

        // Big HH:MM digital readout, centered
        const format24h = s.format24h ?? true;
        const dt = this._now.dateTime ?? GLib.DateTime.new_now_local();
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
