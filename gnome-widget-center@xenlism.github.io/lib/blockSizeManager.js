// products/extension/lib/blockSizeManager.js
//
// Task 14 — Widget size, block-type system (2026-07-19 full rewrite,
// then simplified same day — see "No more min/max" below).
//
// Widgets no longer size themselves in raw pixels at all. Every widget's
// on-screen footprint is `cols x rows` cells of BLOCK_CELL_SIZE below
// (`cols * cellSize` x `rows * cellSize` px) — declared per-widget in
// its own `metadata.json` (same "widget author declares it, host never
// hard-codes a widget id" principle as the old pixel system, see
// size-constraints.md history), not computed from the actor's own
// layout at all.
//
// This sidesteps the ENTIRE previous bug class (get_size() returning
// (0, 0) pre-allocation, forcing an unwanted resize down to a minimum,
// natural-size fallbacks, etc — see size-constraints.md's "Timing"
// section for the old design's history) because block size never reads
// the actor's current size in the first place. It is set directly and
// deterministically from metadata + cellSize, every time, before the
// actor's own natural layout even gets a chance to run.
//
// No more min/max (2026-07-19): widget size is now block-only and fixed
// — a widget IS its declared `cols x rows`, full stop. There is no
// "smallest"/"largest" bound to clamp against and no way for a user to
// resize a widget at all (Edit Mode's drag, task 13, only ever changes
// POSITION — see widget-edit-mode.md's Non-goals). `size-constraints`
// (`minCols/minRows/maxCols/maxRows`) from the old v2 design is gone;
// `metadata['block-type']` is the only thing that decides a widget's
// footprint now. See size-constraints.md's History section for the full
// v1 (pixel min/max) -> v2 (block min/max) -> v3 (block, no min/max)
// story.
//
// Named block-types (2026-07-26): `metadata['block-type']` used to be a
// raw `{cols, rows}` object — which meant literally any numbers a widget
// author (or a corrupted/malicious metadata.json) typed were used almost
// as-is. A same-day earlier fix added clamping/rounding (negative,
// fractional, and absurdly large values were sanitized instead of
// crashing the grid), but the field itself could still be ANY pair of
// numbers within that range — "ใส่ขนาดตามใจ" (any size you like), just
// with guard rails instead of a fence.
//
// `block-type` is now a NAME (a string) chosen from the fixed,
// documented BLOCK_TYPES table below — not a pair of numbers at all.
// This closes the bug class structurally rather than by clamping: there
// is no numeric input to sanitize anymore, only a lookup that either
// matches a known name or falls back to DEFAULT_BLOCK_TYPE_NAME. Every
// bundled widget's metadata.json was migrated to reference one of these
// names (see development/docs/WIDGET_API.md §2 for the full list and
// what a widget author should pick for their content). Third-party
// widgets still shipping the old `{cols, rows}` object are NOT silently
// converted — see the "legacy object shape" note on getBlockSizeFor()
// below for exactly what happens to those instead.

// Px-per-cell for the cols x rows block-type table below. Used to be
// re-exported from gridEngine.js's GRID_SIZE (the same 16px unit the old
// drag-to-grid position engine snapped to) purely because both happened
// to use the same number — NOT because widget sizing was ever actually
// tied to grid-snapped positioning. Now that positioning is grid-free
// (see layoutEngine.js, 2026-07-28), this constant lives here on its own:
// widget FOOTPRINT (this file) and widget POSITION (layoutEngine.js) are
// unrelated concerns that no longer share a module.
export const BLOCK_CELL_SIZE = 16;

const DEFAULT_BLOCK_TYPE_NAME = '1x1';

/** Every valid `metadata['block-type']` value. Deliberately a small,
 * curated, documented set rather than "any string the author feels
 * like" — the whole point of moving off raw numbers was to make widget
 * sizing a closed, known set of shapes instead of an open numeric range.
 * Adding a new size means adding a new named entry here (and to
 * WIDGET_API.md §2's table) — a deliberate, reviewable change, not
 * something a widget's own metadata.json can introduce unilaterally.
 *
 * Redefined (2026-07-27) to exactly the 10 sizes requested, named
 * `<colsTier>x<rowsTier>` where cols/rows values map to tiers
 * 10=1, 21=2, 32=3, 43=4 (so "3x2" reads as "3 tier wide, 2 tier tall",
 * not literally 3x2 cells — see the exact cols/rows in this table for
 * the real cell counts). Every bundled widget's OLD block-type (the
 * previous named-preset system, or a widget that still had a raw
 * `{cols, rows}`) was remapped to whichever of these 10 sizes is
 * numerically closest (see the migration note in each widget's own
 * metadata.json history / development notes) — this table is now the
 * ONLY valid set of sizes, full stop, not an open range to clamp into
 * anymore. */
const BLOCK_TYPES = Object.freeze({
    // name: {cols, rows}
    'barx1': Object.freeze({cols: 10, rows: 5}),
    'barx2': Object.freeze({cols: 21, rows: 5}),
    'barx3': Object.freeze({cols: 32, rows: 5}),
    'barx4': Object.freeze({cols: 43, rows: 5}),
    '1x1': Object.freeze({cols: 10, rows: 10}),
    '2x1': Object.freeze({cols: 21, rows: 10}),
    '2x2': Object.freeze({cols: 21, rows: 21}),
    '3x1': Object.freeze({cols: 32, rows: 10}),
    '3x2': Object.freeze({cols: 32, rows: 21}),
    '3x3': Object.freeze({cols: 32, rows: 32}),
    '4x1': Object.freeze({cols: 43, rows: 10}),
    '4x2': Object.freeze({cols: 43, rows: 21}),
    '4x3': Object.freeze({cols: 43, rows: 32}),
    '4x4': Object.freeze({cols: 43, rows: 43}),
});

// Generous rather than tight — large enough that no real widget design
// should ever hit it (a 300-cell span is already several times wider/
// taller than any real display at BLOCK_CELL_SIZE=16px, i.e. 4800px). Kept as
// a last-line-of-defense sanity check on the BLOCK_TYPES table itself
// (and on the legacy `{cols, rows}` object shape below), not because
// named lookups need clamping on their own merits — every named preset
// above is already a known-good value.
const MIN_CELLS = 1;
const MAX_CELLS = 300;

function _sanitizeDimension(value, fallback) {
    if (!Number.isFinite(value))
        return fallback;
    const rounded = Math.round(value);
    return Math.min(MAX_CELLS, Math.max(MIN_CELLS, rounded));
}

export class BlockSizeManager {
    /**
     * @method getBlockSizeFor
     * @description Declared block size (in grid cells, not px) for one
     * widget, resolved from `metadata['block-type']`:
     *   - a recognized name (string key of BLOCK_TYPES) -> that preset.
     *   - omitted, unrecognized, or any other type -> BLOCK_TYPES[DEFAULT_BLOCK_TYPE_NAME].
     *   - the OLD `{cols, rows}` object shape (pre-2026-07-26 widgets that
     *     haven't been migrated yet) -> still honored, sanitized the same
     *     way it was the day before this change (clamped/rounded/
     *     defaulted per-field) rather than silently discarded — a
     *     widget author who hasn't updated their metadata.json yet keeps
     *     working, just without the stronger guarantee a named lookup
     *     gives. New widgets should use a name; see WIDGET_API.md §2.
     * @param {object} metadata - entry.metadata of the widget
     * @returns {{cols: number, rows: number}}
     */
    static getBlockSizeFor(metadata) {
        const declared = metadata?.['block-type'];

        if (typeof declared === 'string')
            return BLOCK_TYPES[declared] ?? BLOCK_TYPES[DEFAULT_BLOCK_TYPE_NAME];

        // Legacy object shape — see doc comment above.
        if (declared && typeof declared === 'object') {
            const fallback = BLOCK_TYPES[DEFAULT_BLOCK_TYPE_NAME];
            return {
                cols: _sanitizeDimension(declared.cols, fallback.cols),
                rows: _sanitizeDimension(declared.rows, fallback.rows),
            };
        }

        return BLOCK_TYPES[DEFAULT_BLOCK_TYPE_NAME];
    }

    /**
     * @method applyBlockSize
     * @description Sets `actor`'s pixel size directly from its declared
     * block span, multiplied by `cellSize`. Deterministic and
     * allocation-independent — never reads the actor's current size, and
     * never clamps against any PER-WIDGET min/max (there isn't one — see
     * file header's "No more min/max").
     * @param {object} metadata - entry.metadata (must include `id` for logging)
     * @param {Clutter.Actor} actor
     * @param {number} [cellSize=BLOCK_CELL_SIZE] - px per grid cell
     */
    static applyBlockSize(metadata, actor, cellSize = BLOCK_CELL_SIZE) {
        const {cols, rows} = this.getBlockSizeFor(metadata);
        actor.set_size(cols * cellSize, rows * cellSize);
    }
}
