import Clutter from "gi://Clutter";

import GObject from "gi://GObject";

import St from "gi://St";

import Cairo from "cairo";

export const ColorWheel = GObject.registerClass({
    Signals: {
        "color-picked": {
            param_types: [ GObject.TYPE_STRING ]
        }
    }
}, class ColorWheel extends St.Widget {
    _init(size = 220) {
        super._init({
            width: size,
            height: size,
            reactive: true
        });
        this._size = size;
        this._canvas = new St.DrawingArea({
            width: size,
            height: size
        });
        this._canvas.connect("repaint", area => this._onRepaint(area));
        this.add_child(this._canvas);
        this.connect("button-press-event", (actor, event) => this._onButtonPress(event));
        this.connect("destroy", () => this._onDestroy());
    }
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
            const {r: r, g: g, b: b} = this._hslToRgb(i / 360, 1, .5);
            cr.setSourceRGB(r, g, b);
            cr.moveTo(cx, cy);
            cr.arc(cx, cy, radius, start, end);
            cr.closePath();
            cr.fill();
        }
        cr.$dispose();
    }
    _onButtonPress(event) {
        const [stageX, stageY] = event.get_coords();
        const [ok, localX, localY] = this.transform_stage_point(stageX, stageY);
        if (!ok) return Clutter.EVENT_STOP;
        const dx = localX - this._size / 2;
        const dy = localY - this._size / 2;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > this._size / 2) return Clutter.EVENT_STOP;
        const angle = Math.atan2(dy, dx);
        const hue = (angle * 180 / Math.PI + 360) % 360;
        const hex = this._hslToHex(hue, 100, 50);
        this.emit("color-picked", hex);
        return Clutter.EVENT_STOP;
    }
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
            const q = l < .5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1 / 3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1 / 3);
        }
        return {
            r: r,
            g: g,
            b: b
        };
    }
    _hslToHex(h, s, l) {
        const {r: r, g: g, b: b} = this._hslToRgb(h / 360, s / 100, l / 100);
        const toByte = x => Math.round(x * 255);
        return "#" + [ toByte(r), toByte(g), toByte(b) ].map(x => x.toString(16).padStart(2, "0")).join("");
    }
    _onDestroy() {}
});