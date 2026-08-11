export const SNAP_DISTANCE = 16;

export class SnapManager {
    constructor(layoutEngine, options = {}) {
        this._layout = layoutEngine;
        this._enabled = options.enabled ?? true;
        this._distance = Number.isFinite(options.distance) ? options.distance : SNAP_DISTANCE;
        this._gridSnapEnabled = options.gridSnapEnabled ?? false;
        this._gridSize = Number.isFinite(options.gridSize) && options.gridSize > 0 ? options.gridSize : 16;
    }
    setEnabled(enabled) {
        this._enabled = !!enabled;
    }
    setDistance(distance) {
        if (Number.isFinite(distance) && distance >= 0) this._distance = distance;
    }
    setGridSnapEnabled(enabled) {
        this._gridSnapEnabled = !!enabled;
    }
    setGridSize(size) {
        if (Number.isFinite(size) && size > 0) this._gridSize = size;
    }
    computeSnap(dragged, others, monitorBounds) {
        const spacing = this._layout.spacing;
        const margin = this._layout.edgeMargin;
        if (!this._enabled) {
            let x = dragged.x;
            let y = dragged.y;
            if (this._gridSnapEnabled) ({x: x, y: y} = this._applyGridSnap(x, y, margin));
            const maxX = Math.max(margin, monitorBounds.width - dragged.width - margin);
            const maxY = Math.max(margin, monitorBounds.height - dragged.height - margin);
            return {
                x: Math.min(Math.max(x, margin), maxX),
                y: Math.min(Math.max(y, margin), maxY),
                guides: []
            };
        }
        let snappedX = dragged.x;
        let snappedY = dragged.y;
        const guides = [];
        let bestDeltaX = this._distance;
        let bestDeltaY = this._distance;
        const screenEdgesX = [ {
            val: margin,
            line: 0
        }, {
            val: monitorBounds.width - margin - dragged.width,
            line: monitorBounds.width
        } ];
        for (const edge of screenEdgesX) {
            const delta = Math.abs(dragged.x - edge.val);
            if (delta < bestDeltaX) {
                bestDeltaX = delta;
                snappedX = edge.val;
                guides.push({
                    orientation: "vertical",
                    x: edge.val,
                    y: 0,
                    height: monitorBounds.height
                });
            }
        }
        for (const other of others) {
            const xCandidates = [ {
                offset: dragged.x - other.x,
                newX: other.x,
                lineX: other.x
            }, {
                offset: dragged.x + dragged.width - (other.x + other.width),
                newX: other.x + other.width - dragged.width,
                lineX: other.x + other.width
            }, {
                offset: dragged.x + dragged.width + spacing - other.x,
                newX: other.x - dragged.width - spacing,
                lineX: other.x - spacing
            }, {
                offset: dragged.x - (other.x + other.width + spacing),
                newX: other.x + other.width + spacing,
                lineX: other.x + other.width + spacing
            } ];
            for (const cand of xCandidates) {
                const delta = Math.abs(cand.offset);
                if (delta < bestDeltaX) {
                    bestDeltaX = delta;
                    snappedX = cand.newX;
                    guides.length = 0;
                    guides.push({
                        orientation: "vertical",
                        x: cand.lineX,
                        y: Math.min(dragged.y, other.y),
                        height: Math.max(dragged.height, other.height)
                    });
                }
            }
            const yCandidates = [ {
                offset: dragged.y - other.y,
                newY: other.y,
                lineY: other.y
            }, {
                offset: dragged.y + dragged.height - (other.y + other.height),
                newY: other.y + other.height - dragged.height,
                lineY: other.y + other.height
            }, {
                offset: dragged.y + dragged.height + spacing - other.y,
                newY: other.y - dragged.height - spacing,
                lineY: other.y - spacing
            }, {
                offset: dragged.y - (other.y + other.height + spacing),
                newY: other.y + other.height + spacing,
                lineY: other.y + other.height + spacing
            } ];
            for (const cand of yCandidates) {
                const delta = Math.abs(cand.offset);
                if (delta < bestDeltaY) {
                    bestDeltaY = delta;
                    snappedY = cand.newY;
                    guides.push({
                        orientation: "horizontal",
                        y: cand.lineY,
                        x: Math.min(dragged.x, other.x),
                        width: Math.max(dragged.width, other.width)
                    });
                }
            }
        }
        if (this._gridSnapEnabled) ({x: snappedX, y: snappedY} = this._applyGridSnap(snappedX, snappedY, margin));
        const maxX = Math.max(margin, monitorBounds.width - dragged.width - margin);
        const maxY = Math.max(margin, monitorBounds.height - dragged.height - margin);
        snappedX = Math.min(Math.max(snappedX, margin), maxX);
        snappedY = Math.min(Math.max(snappedY, margin), maxY);
        return {
            x: snappedX,
            y: snappedY,
            guides: guides
        };
    }
    _applyGridSnap(x, y, margin) {
        const size = this._gridSize;
        return {
            x: margin + Math.round((x - margin) / size) * size,
            y: margin + Math.round((y - margin) / size) * size
        };
    }
    destroy() {}
}