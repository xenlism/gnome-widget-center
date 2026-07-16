// products/extension/lib/gridEngine.js
//
// Task 14 — Grid Engine. Pure-geometry module: NO Clutter/St imports, no
// signals, no disk access. It only answers questions about coordinates —
// "where does this snap to?", "does this rect collide with anything?",
// "where's the nearest free spot?" — so it can be unit-tested without a
// running GNOME Shell (see development/architecture/tests/), and so
// EditModeDragController (task 13) can call it synchronously on every
// pointer-motion frame without any of it touching the layer or storage
// itself. Task 13 owns turning these answers into actual actor moves +
// StorageService writes.
//
// 16px is the grid unit per development/architecture/specs/ui/grid-engine.md
// (matches the spacing already used for widget default sizes in
// development/docs/WIDGET_API.md's metadata.json example — 220×140,
// 40×40 default position — both multiples of the same unit as a
// starting convention, though nothing here enforces widget sizes be
// grid-aligned, only their drop *position*).

export const GRID_SIZE = 16;

export class GridEngine {
    /**
     * @param {number} [cellSize=GRID_SIZE]
     */
    constructor(cellSize = GRID_SIZE) {
        this._cellSize = cellSize;
    }

    /** @returns {number} the grid unit in pixels this engine snaps to */
    get cellSize() {
        return this._cellSize;
    }

    /**
     * @method snap
     * @description Rounds a raw coordinate to the nearest grid line.
     * @param {number} value
     * @returns {number}
     */
    snap(value) {
        return Math.round(value / this._cellSize) * this._cellSize;
    }

    /**
     * @method snapPoint
     * @param {number} x
     * @param {number} y
     * @returns {{x:number,y:number}}
     */
    snapPoint(x, y) {
        return {x: this.snap(x), y: this.snap(y)};
    }

    /**
     * @method rectsOverlap
     * @description Axis-aligned bounding-box overlap test. Widgets are
     * treated as opaque rectangles for collision purposes — task 13/14
     * don't need to know anything about what's actually drawn inside a
     * widget's actor, same boundary WidgetLayer already keeps (see its
     * doc comment: "does not know or care what's inside a widget's
     * actor").
     * @param {{x:number,y:number,width:number,height:number}} a
     * @param {{x:number,y:number,width:number,height:number}} b
     * @returns {boolean}
     */
    rectsOverlap(a, b) {
        return a.x < b.x + b.width && a.x + a.width > b.x &&
               a.y < b.y + b.height && a.y + a.height > b.y;
    }

    /**
     * @method hasCollision
     * @description Whether a candidate rect would overlap any OTHER
     * widget's current rect. `others` is the caller's job to assemble
     * (typically: every other widget currently placed on the same
     * monitor) — this module never reads WidgetLayer/StorageService
     * itself, see file header.
     * @param {{x:number,y:number,width:number,height:number}} candidate
     * @param {Array<{id:string,x:number,y:number,width:number,height:number}>} others
     * @param {string} [excludeId] - a widget never collides with its own
     *   previous rect while being dragged
     * @returns {boolean}
     */
    hasCollision(candidate, others, excludeId = null) {
        return others.some(other =>
            other.id !== excludeId && this.rectsOverlap(candidate, other));
    }

    /**
     * @method findNearestFreeCell
     * @description Task 13's drop handler calls this with the
     * pointer-release position: snaps it to the grid, and if that spot
     * collides with another widget or falls outside the monitor bounds,
     * spirals outward one grid ring at a time until a free, in-bounds
     * cell is found. Deliberately bounded (`maxRings`) rather than
     * unbounded — a monitor completely tiled edge-to-edge with widgets
     * has no free cell at all, and this must still return *something*
     * rather than loop forever; in that pathological case it falls back
     * to the snapped-but-colliding original spot (task 13 still performs
     * the drop — the user dragged there on purpose — it just won't look
     * perfectly separated).
     * @param {number} x - raw (unsnapped) desired x
     * @param {number} y - raw (unsnapped) desired y
     * @param {number} width
     * @param {number} height
     * @param {{width:number,height:number}} monitorBounds - origin is
     *   always (0,0) here; WidgetLayer's per-monitor containers already
     *   make every widget's coordinates monitor-relative (see
     *   widgetLayer.js), so this module never needs a monitor's own x/y
     *   offset, only its size.
     * @param {Array<{id:string,x:number,y:number,width:number,height:number}>} others
     * @param {string} [excludeId]
     * @param {number} [maxRings=24] - 24 rings × 16px ≈ 384px search
     *   radius in every direction, generous for any realistic widget
     *   density before giving up
     * @returns {{x:number,y:number,collided:boolean}} collided is true
     *   only in the pathological "gave up" case described above
     */
    findNearestFreeCell(x, y, width, height, monitorBounds, others, excludeId = null, maxRings = 24) {
        const origin = this.snapPoint(x, y);

        const tryCell = (cx, cy) => {
            const clamped = this._clampToBounds(cx, cy, width, height, monitorBounds);
            const rect = {x: clamped.x, y: clamped.y, width, height};
            if (this.hasCollision(rect, others, excludeId))
                return null;
            return rect;
        };

        // Ring 0 is just the snapped point itself.
        const straightAway = tryCell(origin.x, origin.y);
        if (straightAway)
            return {...straightAway, collided: false};

        for (let ring = 1; ring <= maxRings; ring++) {
            for (const {dx, dy} of this._ringOffsets(ring)) {
                const found = tryCell(
                    origin.x + dx * this._cellSize,
                    origin.y + dy * this._cellSize);
                if (found)
                    return {...found, collided: false};
            }
        }

        // Gave up — see doc comment above. Still clamp so the widget at
        // least stays reachable on-screen, matching WidgetLayer's own
        // "clamp the origin, don't vanish past the edge" contract.
        const clamped = this._clampToBounds(origin.x, origin.y, width, height, monitorBounds);
        return {x: clamped.x, y: clamped.y, collided: true};
    }

    /** @private every integer grid offset forming the square ring at
     * Chebyshev distance `ring` from the origin, walked in a stable
     * clockwise order so results are deterministic (useful for tests). */
    *_ringOffsets(ring) {
        for (let dx = -ring; dx <= ring; dx++)
            yield {dx, dy: -ring};
        for (let dy = -ring + 1; dy <= ring; dy++)
            yield {dx: ring, dy};
        for (let dx = ring - 1; dx >= -ring; dx--)
            yield {dx, dy: ring};
        for (let dy = ring - 1; dy >= -ring + 1; dy--)
            yield {dx: -ring, dy};
    }

    /** @private clamps a rect's origin so the whole rect stays inside
     * (0,0)-(bounds.width,bounds.height) where possible. Mirrors
     * WidgetLayer._clampToMonitor()'s origin-only clamp for widgets
     * larger than the monitor itself (see its doc comment) — same
     * accepted MVP limitation, not re-litigated here. */
    _clampToBounds(x, y, width, height, bounds) {
        const maxX = Math.max(bounds.width - width, 0);
        const maxY = Math.max(bounds.height - height, 0);
        return {
            x: Math.min(Math.max(x, 0), maxX),
            y: Math.min(Math.max(y, 0), maxY),
        };
    }

    /**
     * @method getAlignmentGuides
     * @description Snap-guides feature from
     * development/architecture/specs/ui/grid-engine.md: while dragging,
     * highlight when the moving rect's edges line up with another
     * widget's edges (not just the grid) so the user can eyeball
     * consistent margins between widgets, the way GIMP/Inkscape-style
     * smart guides work. Returns at most one vertical + one horizontal
     * guide — the closest match within `threshold` px — rather than
     * every possible alignment, so the UI doesn't have to draw a
     * cluttered forest of lines for a busy desktop.
     * @param {{x:number,y:number,width:number,height:number}} candidate
     * @param {Array<{id:string,x:number,y:number,width:number,height:number}>} others
     * @param {number} [threshold=6] px
     * @returns {{vertical: number|null, horizontal: number|null}}
     */
    getAlignmentGuides(candidate, others, threshold = 6) {
        const candidateEdgesX = [candidate.x, candidate.x + candidate.width / 2, candidate.x + candidate.width];
        const candidateEdgesY = [candidate.y, candidate.y + candidate.height / 2, candidate.y + candidate.height];

        let bestVertical = null, bestVerticalDist = threshold + 1;
        let bestHorizontal = null, bestHorizontalDist = threshold + 1;

        for (const other of others) {
            const otherEdgesX = [other.x, other.x + other.width / 2, other.x + other.width];
            const otherEdgesY = [other.y, other.y + other.height / 2, other.y + other.height];

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

        return {vertical: bestVertical, horizontal: bestHorizontal};
    }
}
