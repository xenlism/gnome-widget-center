// lib/snapManager.js
//
// Magnetic Snapping Algorithm. 
// Computes snap positions, generates guide lines, and handles bounds clamping
// so the controller doesn't have to manage geometry directly.

// Fallback only - matches the gschema <default> for snap-distance. Real
// value comes from SettingsService via setDistance()/the constructor
// options below; this constant is just what a SnapManager built without
// a settings object (e.g. in a test) gets.
export const SNAP_DISTANCE = 16;

export class SnapManager {
    /**
     * @param {LayoutEngine} layoutEngine - Used to read spacing and edgeMargin settings
     * @param {Object} [options]
     * @param {boolean} [options.enabled=true] - master on/off for magnetic
     *   snapping (gschema key snap-enabled). When false, computeSnap()
     *   returns the dragged position unchanged (still subject to
     *   grid-snap below, and to the caller's own edge-margin clamping).
     * @param {number} [options.distance=SNAP_DISTANCE] - pull radius, px
     *   (gschema key snap-distance).
     * @param {boolean} [options.gridSnapEnabled=false] - opt-in fixed-grid
     *   rounding applied after magnetic snapping (gschema key
     *   grid-snap-enabled, 2026-08-04 - NOT the pre-2026-07-28 default
     *   grid, this is a separate, off-by-default preference).
     * @param {number} [options.gridSize=16] - grid cell size, px
     *   (gschema key grid-size). Only used while gridSnapEnabled is true.
     */
    constructor(layoutEngine, options = {}) {
        this._layout = layoutEngine;
        this._enabled = options.enabled ?? true;
        this._distance = Number.isFinite(options.distance) ? options.distance : SNAP_DISTANCE;
        this._gridSnapEnabled = options.gridSnapEnabled ?? false;
        this._gridSize = Number.isFinite(options.gridSize) && options.gridSize > 0 ? options.gridSize : 16;
    }

    /** Live setters so a Control Center change (SettingsService.onChanged)
     * can take effect on the very next drag frame, no restart needed -
     * same pattern as everything else in this codebase that reacts to
     * settings changes cross-process. */
    setEnabled(enabled) { this._enabled = !!enabled; }
    setDistance(distance) {
        if (Number.isFinite(distance) && distance >= 0)
            this._distance = distance;
    }
    setGridSnapEnabled(enabled) { this._gridSnapEnabled = !!enabled; }
    setGridSize(size) {
        if (Number.isFinite(size) && size > 0)
            this._gridSize = size;
    }

    /**
     * Computes the snapped position, clamps to monitor bounds, and generates guide lines.
     * @param {Object} dragged - {x, y, width, height} of the currently dragged widget
     * @param {Array} others - Array of other widgets on the same monitor {id, x, y, width, height}
     * @param {Object} monitorBounds - {width, height} of the current monitor
     * @returns {{x: number, y: number, guides: Array}}
     */
    computeSnap(dragged, others, monitorBounds) {
        const spacing = this._layout.spacing;
        const margin = this._layout.edgeMargin;

        // Magnetic snapping off entirely: skip straight to grid-snap (if
        // that's on) + bounds clamping, no guide lines.
        if (!this._enabled) {
            let x = dragged.x;
            let y = dragged.y;
            if (this._gridSnapEnabled)
                ({x, y} = this._applyGridSnap(x, y, margin));
            const maxX = Math.max(margin, monitorBounds.width - dragged.width - margin);
            const maxY = Math.max(margin, monitorBounds.height - dragged.height - margin);
            return {
                x: Math.min(Math.max(x, margin), maxX),
                y: Math.min(Math.max(y, margin), maxY),
                guides: [],
            };
        }

        let snappedX = dragged.x;
        let snappedY = dragged.y;
        const guides = [];

        let bestDeltaX = this._distance;
        let bestDeltaY = this._distance;

        // 1. Snap to monitor edges (respecting edgeMargin)
        const screenEdgesX = [
            { val: margin, line: 0 },                             
            { val: monitorBounds.width - margin - dragged.width, line: monitorBounds.width }
        ];
        
        for (const edge of screenEdgesX) {
            const delta = Math.abs(dragged.x - edge.val);
            if (delta < bestDeltaX) {
                bestDeltaX = delta;
                snappedX = edge.val;
                guides.push({ orientation: 'vertical', x: edge.val, y: 0, height: monitorBounds.height });
            }
        }

        // 2. Snap to other widgets (respecting widget spacing)
        for (const other of others) {
            // --- X Axis Calculations ---
            const xCandidates = [
                // Left edge aligns with Left edge
                { offset: dragged.x - other.x, newX: other.x, lineX: other.x },
                // Right edge aligns with Right edge
                { offset: (dragged.x + dragged.width) - (other.x + other.width), newX: other.x + other.width - dragged.width, lineX: other.x + other.width },
                // Right edge aligns with Left edge (+ spacing)
                { offset: (dragged.x + dragged.width + spacing) - other.x, newX: other.x - dragged.width - spacing, lineX: other.x - spacing },
                // Left edge aligns with Right edge (+ spacing)
                { offset: dragged.x - (other.x + other.width + spacing), newX: other.x + other.width + spacing, lineX: other.x + other.width + spacing },
            ];

            for (const cand of xCandidates) {
                const delta = Math.abs(cand.offset);
                if (delta < bestDeltaX) {
                    bestDeltaX = delta;
                    snappedX = cand.newX;
                    guides.length = 0; // Keep only the closest guide line
                    guides.push({ 
                        orientation: 'vertical', 
                        x: cand.lineX, 
                        y: Math.min(dragged.y, other.y), 
                        height: Math.max(dragged.height, other.height) 
                    });
                }
            }

            // --- Y Axis Calculations ---
            const yCandidates = [
                { offset: dragged.y - other.y, newY: other.y, lineY: other.y },
                { offset: (dragged.y + dragged.height) - (other.y + other.height), newY: other.y + other.height - dragged.height, lineY: other.y + other.height },
                { offset: (dragged.y + dragged.height + spacing) - other.y, newY: other.y - dragged.height - spacing, lineY: other.y - spacing },
                { offset: dragged.y - (other.y + other.height + spacing), newY: other.y + other.height + spacing, lineY: other.y + other.height + spacing },
            ];

            for (const cand of yCandidates) {
                const delta = Math.abs(cand.offset);
                if (delta < bestDeltaY) {
                    bestDeltaY = delta;
                    snappedY = cand.newY;
                    guides.push({ 
                        orientation: 'horizontal', 
                        y: cand.lineY, 
                        x: Math.min(dragged.x, other.x), 
                        width: Math.max(dragged.width, other.width) 
                    });
                }
            }
        }

        // 3. Optional fixed-grid rounding (2026-08-04, opt-in via
        // grid-snap-enabled - separate from and layered on top of the
        // magnetic snapping above, not a replacement for it). Measured
        // from edge-margin rather than 0,0 so a grid-snapped widget still
        // lines up with the screen-edge snap targets above it.
        if (this._gridSnapEnabled)
            ({x: snappedX, y: snappedY} = this._applyGridSnap(snappedX, snappedY, margin));

        // 4. Clamp to bounds internally (so the Controller doesn't have to)
        const maxX = Math.max(margin, monitorBounds.width - dragged.width - margin);
        const maxY = Math.max(margin, monitorBounds.height - dragged.height - margin);
        snappedX = Math.min(Math.max(snappedX, margin), maxX);
        snappedY = Math.min(Math.max(snappedY, margin), maxY);

        return { x: snappedX, y: snappedY, guides };
    }

    /** @private rounds (x, y) to the nearest this._gridSize multiple,
     * measured from `margin` so grid cells start at the same place the
     * edge-snap targets do rather than at the screen's literal (0,0). */
    _applyGridSnap(x, y, margin) {
        const size = this._gridSize;
        return {
            x: margin + Math.round((x - margin) / size) * size,
            y: margin + Math.round((y - margin) / size) * size,
        };
    }

    /**
     * Clean up resources (placeholder for future use).
     */
    destroy() {
        // Intentionally empty for now.
    }
}