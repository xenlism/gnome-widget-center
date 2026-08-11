export const DEFAULT_PREVENT_OVERLAP = true;

export const DEFAULT_EDGE_MARGIN = 32;

export const DEFAULT_SPACING = 16;

export class LayoutEngine {
    constructor({preventOverlap: preventOverlap = DEFAULT_PREVENT_OVERLAP, edgeMargin: edgeMargin = DEFAULT_EDGE_MARGIN, spacing: spacing = DEFAULT_SPACING} = {}) {
        this._preventOverlap = !!preventOverlap;
        this._edgeMargin = Math.max(0, Number(edgeMargin) || 0);
        this._spacing = Math.max(0, Number(spacing) || 0);
    }
    get preventOverlap() {
        return this._preventOverlap;
    }
    set preventOverlap(value) {
        this._preventOverlap = !!value;
    }
    get edgeMargin() {
        return this._edgeMargin;
    }
    set edgeMargin(value) {
        this._edgeMargin = Math.max(0, Number(value) || 0);
    }
    get spacing() {
        return this._spacing;
    }
    set spacing(value) {
        this._spacing = Math.max(0, Number(value) || 0);
    }
    rectsOverlap(a, b, padding = 0) {
        return a.x < b.x + b.width + padding && a.x + a.width > b.x - padding && a.y < b.y + b.height + padding && a.y + a.height > b.y - padding;
    }
    hasCollision(candidate, others, excludeId = null) {
        if (!this._preventOverlap) return false;
        return others.some(other => other.id !== excludeId && this.rectsOverlap(candidate, other, this._spacing));
    }
    clampToBounds(x, y, width, height, bounds) {
        return {
            x: this._clampAxis(x, width, bounds.width),
            y: this._clampAxis(y, height, bounds.height)
        };
    }
    _clampAxis(pos, size, boundSize) {
        const margin = this._edgeMargin;
        const idealMin = margin;
        const idealMax = boundSize - size - margin;
        if (idealMax >= idealMin) return Math.min(Math.max(pos, idealMin), idealMax);
        const fallbackMax = Math.max(boundSize - size, 0);
        return Math.min(Math.max(pos, 0), fallbackMax);
    }
    findFreePosition(x, y, width, height, monitorBounds, others, excludeId = null, step = 8, maxRings = 48) {
        const origin = this.clampToBounds(x, y, width, height, monitorBounds);
        if (!this._preventOverlap) return {
            x: origin.x,
            y: origin.y,
            collided: false
        };
        const tryCell = (cx, cy) => {
            const clamped = this.clampToBounds(cx, cy, width, height, monitorBounds);
            const rect = {
                x: clamped.x,
                y: clamped.y,
                width: width,
                height: height
            };
            if (this.hasCollision(rect, others, excludeId)) return null;
            return rect;
        };
        const straightAway = tryCell(origin.x, origin.y);
        if (straightAway) return {
            ...straightAway,
            collided: false
        };
        for (let ring = 1; ring <= maxRings; ring++) {
            for (const {dx: dx, dy: dy} of this._ringOffsets(ring)) {
                const found = tryCell(origin.x + dx * step, origin.y + dy * step);
                if (found) return {
                    ...found,
                    collided: false
                };
            }
        }
        return {
            x: origin.x,
            y: origin.y,
            collided: true
        };
    }
    * _ringOffsets(ring) {
        for (let dx = -ring; dx <= ring; dx++) yield {
            dx: dx,
            dy: -ring
        };
        for (let dy = -ring + 1; dy <= ring; dy++) yield {
            dx: ring,
            dy: dy
        };
        for (let dx = ring - 1; dx >= -ring; dx--) yield {
            dx: dx,
            dy: ring
        };
        for (let dy = ring - 1; dy >= -ring + 1; dy--) yield {
            dx: -ring,
            dy: dy
        };
    }
    getAlignmentGuides(candidate, others, threshold = 6) {
        const candidateEdgesX = [ candidate.x, candidate.x + candidate.width / 2, candidate.x + candidate.width ];
        const candidateEdgesY = [ candidate.y, candidate.y + candidate.height / 2, candidate.y + candidate.height ];
        let bestVertical = null, bestVerticalDist = threshold + 1;
        let bestHorizontal = null, bestHorizontalDist = threshold + 1;
        for (const other of others) {
            const otherEdgesX = [ other.x, other.x + other.width / 2, other.x + other.width ];
            const otherEdgesY = [ other.y, other.y + other.height / 2, other.y + other.height ];
            for (const ce of candidateEdgesX) {
                for (const oe of otherEdgesX) {
                    const dist = Math.abs(ce - oe);
                    if (dist <= threshold && dist < bestVerticalDist) {
                        bestVertical = oe;
                        bestVerticalDist = dist;
                    }
                }
            }
            for (const ce of candidateEdgesY) {
                for (const oe of otherEdgesY) {
                    const dist = Math.abs(ce - oe);
                    if (dist <= threshold && dist < bestHorizontalDist) {
                        bestHorizontal = oe;
                        bestHorizontalDist = dist;
                    }
                }
            }
        }
        return {
            vertical: bestVertical,
            horizontal: bestHorizontal
        };
    }
}