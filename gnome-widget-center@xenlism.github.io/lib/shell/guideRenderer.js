import St from "gi://St";

const GUIDE_WIDTH = 1;

const DEFAULT_COLOR = "#F5A623E6";

export class GuideRenderer {
    constructor(color = DEFAULT_COLOR) {
        this._guidePool = [];
        this._parent = null;
        this._color = color;
    }
    setColor(color) {
        if (typeof color !== "string" || color.length === 0) return;
        this._color = color;
        for (const guide of this._guidePool) guide.set_style(`background-color: ${this._colorToCss(color)};`);
    }
    _colorToCss(hex) {
        const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex);
        if (!m) return hex;
        if (!m[2]) return hex;
        const r = parseInt(m[1].slice(0, 2), 16);
        const g = parseInt(m[1].slice(2, 4), 16);
        const b = parseInt(m[1].slice(4, 6), 16);
        const a = Math.round(parseInt(m[2], 16) / 255 * 1e3) / 1e3;
        return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    render(guides, parent) {
        if (!parent) return;
        if (this._parent !== parent) {
            for (const guide of this._guidePool) {
                if (guide.get_parent()) guide.get_parent().remove_child(guide);
                parent.add_child(guide);
            }
            this._parent = parent;
        }
        let i = 0;
        for (const g of guides) {
            let line = this._guidePool[i];
            if (!line) {
                line = new St.Widget({
                    style_class: "widget-edit-mode-guide-line",
                    style: `background-color: ${this._colorToCss(this._color)};`,
                    reactive: false,
                    visible: false
                });
                this._guidePool.push(line);
                parent.add_child(line);
            }
            if (g.orientation === "vertical") {
                line.set_size(GUIDE_WIDTH, g.height);
            } else {
                line.set_size(g.width, GUIDE_WIDTH);
            }
            line.set_position(g.x, g.y);
            line.visible = true;
            i++;
        }
        for (let j = i; j < this._guidePool.length; j++) {
            this._guidePool[j].visible = false;
        }
    }
    clear() {
        for (const guide of this._guidePool) {
            guide.visible = false;
        }
    }
    destroy() {
        this.clear();
        for (const guide of this._guidePool) {
            if (guide.get_parent()) {
                guide.get_parent().remove_child(guide);
            }
            guide.destroy();
        }
        this._guidePool = [];
        this._parent = null;
    }
}