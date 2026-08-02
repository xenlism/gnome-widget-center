// lib/snapManager.js
//
// Magnetic Snapping Algorithm. 
// Computes snap positions, generates guide lines, and handles bounds clamping
// so the controller doesn't have to manage geometry directly.

export const SNAP_DISTANCE = 16; // pixels to trigger magnetic pull

export class SnapManager {
    /**
     * @param {LayoutEngine} layoutEngine - Used to read spacing and edgeMargin settings
     */
    constructor(layoutEngine) {
        this._layout = layoutEngine;
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

        let snappedX = dragged.x;
        let snappedY = dragged.y;
        const guides = [];

        let bestDeltaX = SNAP_DISTANCE;
        let bestDeltaY = SNAP_DISTANCE;

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
                guides.push({ orientation: 'vertical', x: edge.line, y: 0, height: monitorBounds.height });
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

        // 3. Clamp to bounds internally (so the Controller doesn't have to)
        const maxX = Math.max(margin, monitorBounds.width - dragged.width - margin);
        const maxY = Math.max(margin, monitorBounds.height - dragged.height - margin);
        snappedX = Math.min(Math.max(snappedX, margin), maxX);
        snappedY = Math.min(Math.max(snappedY, margin), maxY);

        return { x: snappedX, y: snappedY, guides };
    }

    /**
     * Clean up resources (placeholder for future use).
     */
    destroy() {
        // Intentionally empty for now.
    }
}