// lib/colorWheel.js
//
// A native St/Clutter/Cairo HSL color wheel, drawn entirely in-process
// (no GTK) - see this repo's "Handover: Widget Overlay Color Picker" doc
// for why: GTK widgets/dialogs (Gtk.ColorDialogButton etc.) can't be
// hosted inside the GNOME Shell process, so anywhere the Widget Center
// Overlay (lib/widgetCenterOverlay.js / lib/widgetCenterOverlayPreferences.js)
// needs an actual color-picking UI instead of a plain hex text field, this
// is that picker. Same St.DrawingArea + Cairo 'repaint' convention every
// circles-* widget already uses (see e.g. widgets/circles-battery/widget.js)
// rather than driving a raw Clutter.Canvas by hand.
//
// Emits 'color-picked' with a '#RRGGBB' hex string on click - full hue
// ring at 100% saturation/50% lightness, same as a standard HSL wheel.
// No saturation/lightness control (see this file's own "Future" section
// in the handover doc - alpha slider, recent colors, eyedropper, gradient,
// and theme presets are all explicitly left for later so this stays a
// small, fast, always-in-memory widget).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Cairo from 'cairo';

export const ColorWheel = GObject.registerClass({
    Signals: {'color-picked': {param_types: [GObject.TYPE_STRING]}},
}, class ColorWheel extends St.Widget {
    _init(size = 220) {
        super._init({
            width: size,
            height: size,
            reactive: true,
        });

        this._size = size;

        this._canvas = new St.DrawingArea({width: size, height: size});
        this._canvas.connect('repaint', area => this._onRepaint(area));
        this.add_child(this._canvas);

        this.connect('button-press-event', (actor, event) => this._onButtonPress(event));
        this.connect('destroy', () => this._onDestroy());
    }

    /** @private Cairo paints straight into the DrawingArea's own context -
     * no manual Clutter.Canvas plumbing needed, matching every other
     * ring/gauge widget in this codebase. */
    _onRepaint(area) {
        const cr = area.get_context();

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const cx = this._size / 2;
        const cy = this._size / 2;
        const radius = this._size / 2;

        for (let i = 0; i < 360; i++) {
            const start = i * Math.PI / 180;
            const end = (i + 1) * Math.PI / 180;
            const {r, g, b} = this._hslToRgb(i / 360, 1, 0.5);

            cr.setSourceRGB(r, g, b);
            cr.moveTo(cx, cy);
            cr.arc(cx, cy, radius, start, end);
            cr.closePath();
            cr.fill();
        }

        cr.$dispose();
    }

    /** @private Converts the event's stage-space coordinates into this
     * actor's own local space via transform_stage_point() - event
     * coordinates are always in stage space, and this actor may be
     * positioned/scaled anywhere inside the overlay. */
    _onButtonPress(event) {
        const [stageX, stageY] = event.get_coords();
        const [ok, localX, localY] = this.transform_stage_point(stageX, stageY);
        if (!ok)
            return Clutter.EVENT_STOP;

        const dx = localX - this._size / 2;
        const dy = localY - this._size / 2;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // click outside the circle - ignore
        if (distance > this._size / 2)
            return Clutter.EVENT_STOP;

        const angle = Math.atan2(dy, dx);
        const hue = (angle * 180 / Math.PI + 360) % 360;
        const hex = this._hslToHex(hue, 100, 50);

        this.emit('color-picked', hex);
        return Clutter.EVENT_STOP;
    }

    /** @private h/s/l each 0-1; returns {r, g, b} each 0-1. */
    _hslToRgb(h, s, l) {
        let r, g, b;

        if (s === 0) {
            r = g = b = l;
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };

            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;

            r = hue2rgb(p, q, h + 1 / 3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1 / 3);
        }

        return {r, g, b};
    }

    /** @private h 0-360, s/l 0-100; returns '#RRGGBB'. */
    _hslToHex(h, s, l) {
        const {r, g, b} = this._hslToRgb(h / 360, s / 100, l / 100);
        const toByte = x => Math.round(x * 255);

        return '#' + [toByte(r), toByte(g), toByte(b)]
            .map(x => x.toString(16).padStart(2, '0'))
            .join('');
    }

    /** @private nothing to explicitly tear down (St.DrawingArea/Cairo
     * context are cleaned up by GObject's own disposal), kept as a hook
     * in case a future revision adds a GLib source or file watch here. */
    _onDestroy() {
    }
});
