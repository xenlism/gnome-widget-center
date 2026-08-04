// lib/guideRenderer.js
//
// Renders temporary guide lines on the screen during drag.
// Uses an Actor Pool to dynamically handle any number of guides 
// without creating/destroying St.Widgets on every motion frame.

import St from 'gi://St';

const GUIDE_WIDTH = 1;
const DEFAULT_COLOR = '#F5A623E6'; // matches the gschema guide-color default

export class GuideRenderer {
    /** @param {string} [color] - #rrggbb or #rrggbbaa (gschema key
     *   guide-color). See setColor() for changing it after construction. */
    constructor(color = DEFAULT_COLOR) {
        this._guidePool = [];
        this._parent = null;
        this._color = color;
    }

    /** Live update (SettingsService.onChanged('guide-color', ...)) -
     * applies to already-pooled lines immediately, not just ones created
     * after the call, since lines are reused across drag frames rather
     * than recreated. */
    setColor(color) {
        if (typeof color !== 'string' || color.length === 0)
            return;
        this._color = color;
        for (const guide of this._guidePool)
            guide.set_style(`background-color: ${this._colorToCss(color)};`);
    }

    /** @private '#rrggbb'/'#rrggbbaa' -> a CSS color St actually
     * understands (St doesn't parse 8-digit hex alpha on its own - same
     * fix as lib/themeService.js's hexToRgba()/lib/widgetVisualKit.js's
     * toCssColor()). Kept as a tiny local copy rather than importing
     * lib/widgetVisualKit.js here since this file is intentionally
     * St-only/dependency-free (used from the hot drag-frame path). */
    _colorToCss(hex) {
        const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex);
        if (!m)
            return hex;
        if (!m[2])
            return hex;
        const r = parseInt(m[1].slice(0, 2), 16);
        const g = parseInt(m[1].slice(2, 4), 16);
        const b = parseInt(m[1].slice(4, 6), 16);
        const a = Math.round((parseInt(m[2], 16) / 255) * 1000) / 1000;
        return `rgba(${r}, ${g}, ${b}, ${a})`;
    }

    /**
     * Renders guide lines based on snap calculations.
     * @param {Array} guides - Array of guide objects {orientation, x, y, width, height}
     * @param {St.Widget} parent - The parent actor to attach guides to
     */
    render(guides, parent) {
        if (!parent) return;

        // Attach to parent once
        if (this._parent !== parent) {
            for (const guide of this._guidePool) {
                if (guide.get_parent()) guide.get_parent().remove_child(guide);
                parent.add_child(guide);
            }
            this._parent = parent;
        }

        let i = 0;
        // Reuse or create actors for the current frame's guides
        for (const g of guides) {
            let line = this._guidePool[i];
            if (!line) {
                line = new St.Widget({
                    style_class: 'widget-edit-mode-guide-line',
                    // Belt-and-braces inline fallback for the
                    // .widget-edit-mode-guide-line rule in the root
                    // stylesheet.css - without SOME color set, a guide
                    // line with no explicit style renders as a fully
                    // transparent 1px box (positioned/sized correctly,
                    // just invisible), which is exactly what made guides
                    // silently never show up while dragging.
                    style: `background-color: ${this._colorToCss(this._color)};`,
                    reactive: false,
                    visible: false,
                });
                this._guidePool.push(line);
                // Fix 1: Use the current render parent directly.
                parent.add_child(line);
            }
            
            if (g.orientation === 'vertical') {
                line.set_size(GUIDE_WIDTH, g.height);
            } else {
                line.set_size(g.width, GUIDE_WIDTH);
            }
            line.set_position(g.x, g.y);
            line.visible = true;
            i++;
        }

        // Hide any remaining actors in the pool that aren't used this frame
        for (let j = i; j < this._guidePool.length; j++) {
            this._guidePool[j].visible = false;
        }
    }

    /**
     * Hides all guide lines without destroying them.
     */
    clear() {
        for (const guide of this._guidePool) {
            guide.visible = false;
        }
    }

    /**
     * Clean up resources safely.
     */
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
