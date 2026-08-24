export const GRID_SIZE = 16;

export class GridEngine {
    constructor(cellSize = GRID_SIZE) {
        this._cellSize = cellSize;
    }
    get cellSize() {
        return this._cellSize;
    }
    snap(value) {
        return Math.round(value / this._cellSize) * this._cellSize;
    }
    snapPoint(x, y) {
        return {
            x: this.snap(x),
            y: this.snap(y)
        };
    }
    rectsOverlap(a, b) {
        return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    }
    hasCollision(candidate, others, excludeId = null) {
        return others.some(other => other.id !== excludeId && this.rectsOverlap(candidate, other));
    }
    findNearestFreeCell(x, y, width, height, monitorBounds, others, excludeId = null, maxRings = 24) {
        const origin = this.snapPoint(x, y);
        const tryCell = (cx, cy) => {
            const clamped = this._clampToBounds(cx, cy, width, height, monitorBounds);
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
                const found = tryCell(origin.x + dx * this._cellSize, origin.y + dy * this._cellSize);
                if (found) return {
                    ...found,
                    collided: false
                };
            }
        }
        const clamped = this._clampToBounds(origin.x, origin.y, width, height, monitorBounds);
        return {
            x: clamped.x,
            y: clamped.y,
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
    _clampToBounds(x, y, width, height, bounds) {
        const maxX = Math.max(bounds.width - width, 0);
        const maxY = Math.max(bounds.height - height, 0);
        return {
            x: Math.min(Math.max(x, 0), maxX),
            y: Math.min(Math.max(y, 0), maxY)
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