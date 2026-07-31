// products/extension/lib/layoutEngine.js
//
// Replaces gridEngine.js (2026-07-28, "เอา grid ออก" — remove the grid).
// The old GridEngine snapped every drop to a fixed 16px grid and searched
// for a free cell on that same grid. Widgets now drop at the EXACT pixel
// position the pointer releases at — nothing here rounds/snaps a
// coordinate to anything. What's left, all optional and user-configurable
// via the "Desktop" preferences category (prefs.js) + this schema's
// `prevent-widget-overlap` / `edge-margin` / `widget-spacing` keys:
//
//   1. preventOverlap (default ON) — "ห้าม widget ทับกัน". Widgets may
//      never occupy overlapping screen space. When a drop/drag position
//      would collide with another widget, findFreePosition() pushes it to
//      the nearest free spot instead — a continuous outward pixel search
//      (see findFreePosition()), NOT a grid search. When this is off, no
//      collision check happens at all and widgets can freely overlap.
//   2. edgeMargin (default 32px) — "พื้นที่จากขอบจอที่ widget วางไม่ได้".
//      No widget's rect may come closer than this to any edge of its
//      monitor. Applies unconditionally (independent of preventOverlap),
//      since it's about the screen edge, not other widgets.
//   3. spacing (default 16px) — "widget ต้องห่างกันเท่าไหร่". Minimum gap
//      kept between widgets whenever preventOverlap is on; has no effect
//      when it's off (nothing to space out if overlap itself is allowed).
//
// (A widget being actively dragged is always raised to the top of its
// siblings — see editModeDragController.js's "Bring-to-front" note in its
// button-press handler. That's a z-order concern, not geometry, so it's
// not part of this module.)
//
// Pure geometry, same as the old GridEngine: no Clutter/St imports, no
// signals, no disk access — safe to unit test standalone.

export const DEFAULT_PREVENT_OVERLAP = true;
export const DEFAULT_EDGE_MARGIN = 32;
export const DEFAULT_SPACING = 16;

export class LayoutEngine {
    /**
     * @param {object} [options]
     * @param {boolean} [options.preventOverlap=true]
     * @param {number} [options.edgeMargin=32] px kept clear from every
     *   monitor edge
     * @param {number} [options.spacing=16] px minimum gap enforced
     *   between widgets while preventOverlap is on
     */
    constructor({
        preventOverlap = DEFAULT_PREVENT_OVERLAP,
        edgeMargin = DEFAULT_EDGE_MARGIN,
        spacing = DEFAULT_SPACING,
    } = {}) {
        this._preventOverlap = !!preventOverlap;
        this._edgeMargin = Math.max(0, Number(edgeMargin) || 0);
        this._spacing = Math.max(0, Number(spacing) || 0);
    }

    /** @returns {boolean} whether collision avoidance is currently on */
    get preventOverlap() {
        return this._preventOverlap;
    }

    set preventOverlap(value) {
        this._preventOverlap = !!value;
    }

    /** @returns {number} px kept clear from every monitor edge */
    get edgeMargin() {
        return this._edgeMargin;
    }

    set edgeMargin(value) {
        this._edgeMargin = Math.max(0, Number(value) || 0);
    }

    /** @returns {number} px minimum gap enforced between widgets */
    get spacing() {
        return this._spacing;
    }

    set spacing(value) {
        this._spacing = Math.max(0, Number(value) || 0);
    }

    /**
     * @method rectsOverlap
     * @description Axis-aligned bounding-box overlap test, same boundary
     * WidgetLayer already keeps (see its doc comment: "does not know or
     * care what's inside a widget's actor").
     * @param {{x,y,width,height}} a
     * @param {{x,y,width,height}} b
     * @param {number} [padding=0] — inflates `b` by this many px on every
     *   side before testing, so the same test can also enforce `spacing`
     *   rather than just literal pixel overlap.
     * @returns {boolean}
     */
    rectsOverlap(a, b, padding = 0) {
        return a.x < b.x + b.width + padding && a.x + a.width > b.x - padding &&
               a.y < b.y + b.height + padding && a.y + a.height > b.y - padding;
    }

    /**
     * @method hasCollision
     * @description Whether a candidate rect would overlap any OTHER
     * widget's current rect, `spacing` px inclusive. Always false when
     * `preventOverlap` is off — no check is performed at all in that
     * case, by design (see file header).
     * @param {{x,y,width,height}} candidate
     * @param {Array<{id,x,y,width,height}>} others
     * @param {string} [excludeId] - a widget never collides with itself
     * @returns {boolean}
     */
    hasCollision(candidate, others, excludeId = null) {
        if (!this._preventOverlap)
            return false;
        return others.some(other =>
            other.id !== excludeId && this.rectsOverlap(candidate, other, this._spacing));
    }

    /**
     * @method clampToBounds
     * @description Clamps a rect's origin so the whole rect stays inside
     * the monitor, `edgeMargin` px clear of every side — falling back to
     * a plain 0-margin clamp when the monitor/widget combo is too small
     * to honor the margin at all, same "still return something reachable
     * rather than nothing" philosophy the old GridEngine used for
     * oversized widgets.
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @param {{width,height}} bounds
     * @returns {{x,y}}
     */
    clampToBounds(x, y, width, height, bounds) {
        return {
            x: this._clampAxis(x, width, bounds.width),
            y: this._clampAxis(y, height, bounds.height),
        };
    }

    /** @private one axis of clampToBounds() — kept separate so both x/y
     * share the exact same "not enough room to honor the margin" fallback
     * rather than risking the two axes drifting apart. */
    _clampAxis(pos, size, boundSize) {
        const margin = this._edgeMargin;
        const idealMin = margin;
        const idealMax = boundSize - size - margin;

        if (idealMax >= idealMin)
            return Math.min(Math.max(pos, idealMin), idealMax);

        // Not enough room to keep the widget margin px from BOTH edges —
        // fall back to a plain 0-margin clamp so it still stays reachable
        // on-screen (same accepted limitation as the old GridEngine had
        // for widgets larger than the monitor itself).
        const fallbackMax = Math.max(boundSize - size, 0);
        return Math.min(Math.max(pos, 0), fallbackMax);
    }

    /**
     * @method findFreePosition
     * @description Replaces GridEngine.findNearestFreeCell() for both the
     * live placeholder feedback during a drag and the actual drop target
     * — but the search happens in continuous pixel space, not grid cells:
     * a widget lands exactly where it's dropped whenever nothing's in the
     * way and/or preventOverlap is off. Only when preventOverlap is on
     * AND the requested spot collides does this search outward, ring by
     * ring, in `step`-px increments (deliberately NOT tied to
     * edgeMargin/spacing — just the search's own resolution) until a free,
     * in-bounds spot is found. Bounded (`maxRings`) rather than unbounded,
     * same reasoning as the old grid version: a monitor with genuinely no
     * free spot left must still return *something* rather than loop
     * forever — it falls back to the clamped-but-colliding original spot
     * (the caller still performs the drop; it just won't look perfectly
     * separated).
     * @param {number} x - raw desired x
     * @param {number} y - raw desired y
     * @param {number} width
     * @param {number} height
     * @param {{width,height}} monitorBounds
     * @param {Array<{id,x,y,width,height}>} others
     * @param {string} [excludeId]
     * @param {number} [step=8] px per search ring
     * @param {number} [maxRings=48] 48 rings x 8px = ~384px search radius
     *   in every direction — same generous budget (in absolute px) the
     *   old grid version had at 24 rings x 16px.
     * @returns {{x, y, collided}} collided is true only in the
     *   pathological "gave up" case described above.
     */
    findFreePosition(x, y, width, height, monitorBounds, others, excludeId = null, step = 8, maxRings = 48) {
        const origin = this.clampToBounds(x, y, width, height, monitorBounds);

        if (!this._preventOverlap)
            return {x: origin.x, y: origin.y, collided: false};

        const tryCell = (cx, cy) => {
            const clamped = this.clampToBounds(cx, cy, width, height, monitorBounds);
            const rect = {x: clamped.x, y: clamped.y, width, height};
            if (this.hasCollision(rect, others, excludeId))
                return null;
            return rect;
        };

        // Ring 0 is just the clamped point itself.
        const straightAway = tryCell(origin.x, origin.y);
        if (straightAway)
            return {...straightAway, collided: false};

        for (let ring = 1; ring <= maxRings; ring++) {
            for (const {dx, dy} of this._ringOffsets(ring)) {
                const found = tryCell(origin.x + dx * step, origin.y + dy * step);
                if (found)
                    return {...found, collided: false};
            }
        }

        // Gave up — see doc comment above. Still clamped so the widget at
        // least stays reachable on-screen.
        return {x: origin.x, y: origin.y, collided: true};
    }

    /** @private every integer offset forming the square ring at Chebyshev
     * distance `ring` from the origin, walked in a stable clockwise order
     * so results are deterministic (useful for tests). Multiplied by
     * `step` px by the caller — this only yields the ring shape. */
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

    /**
     * @method getAlignmentGuides
     * @description Snap-guides: while dragging, highlight when the moving
     * rect's edges line up with another widget's edges so the user can
     * eyeball consistent margins between widgets, the way GIMP/Inkscape
     * smart guides work. Unrelated to the grid removal above — these are
     * guides between widget edges, never a snap to any fixed grid.
     * Returns at most one vertical + one horizontal guide — the closest
     * match within `threshold` px — rather than every possible alignment.
     * @param {{x,y,width,height}} candidate
     * @param {Array<{id,x,y,width,height}>} others
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
