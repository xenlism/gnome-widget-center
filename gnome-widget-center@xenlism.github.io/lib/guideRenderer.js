// lib/guideRenderer.js
//
// Renders temporary guide lines on the screen during drag.
// Uses an Actor Pool to dynamically handle any number of guides 
// without creating/destroying St.Widgets on every motion frame.

import St from 'gi://St';

const GUIDE_WIDTH = 1;

export class GuideRenderer {
    constructor() {
        this._guidePool = [];
        this._parent = null;
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
