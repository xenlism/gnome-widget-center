// products/extension/lib/blockSizeManager.js
//
// Task 14 — Widget size, block-type system (2026-07-19 full rewrite,
// then simplified same day — see "No more min/max" below).
//
// Widgets no longer size themselves in raw pixels at all. Every widget's
// on-screen footprint is `cols x rows` GridEngine cells
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
// `metadata['block-size']` is the only thing that decides a widget's
// footprint now. See size-constraints.md's History section for the full
// v1 (pixel min/max) -> v2 (block min/max) -> v3 (block, no min/max)
// story.

const DEFAULT_BLOCK_SIZE = Object.freeze({cols: 10, rows: 6});

export class BlockSizeManager {
    /**
     * @method getBlockSizeFor
     * @description Declared block size (in grid cells, not px) for one
     * widget — from `metadata['block-size']` (`{cols, rows}`) if
     * declared, else DEFAULT_BLOCK_SIZE for every widget that hasn't
     * declared its own.
     * @param {object} metadata - entry.metadata of the widget
     * @returns {{cols: number, rows: number}}
     */
    static getBlockSizeFor(metadata) {
        const declared = metadata?.['block-size'];
        if (!declared || !Number.isFinite(declared.cols) || !Number.isFinite(declared.rows))
            return DEFAULT_BLOCK_SIZE;

        return {cols: declared.cols, rows: declared.rows};
    }

    /**
     * @method applyBlockSize
     * @description Sets `actor`'s pixel size directly from its declared
     * block span, multiplied by `cellSize`. Deterministic and
     * allocation-independent — never reads the actor's current size, and
     * never clamps against any min/max (there isn't one — see file
     * header's "No more min/max").
     * @param {object} metadata - entry.metadata (must include `id` for logging)
     * @param {Clutter.Actor} actor
     * @param {number} cellSize - GridEngine.cellSize (px per grid cell)
     */
    static applyBlockSize(metadata, actor, cellSize) {
        const {cols, rows} = this.getBlockSizeFor(metadata);
        actor.set_size(cols * cellSize, rows * cellSize);
    }
}
