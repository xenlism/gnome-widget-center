// products/extension/lib/blockSizeManager.js
//
// Task 14 — Widget size, block-type system (2026-07-19 full rewrite).
//
// Widgets no longer size themselves in raw pixels at all. Every widget's
// on-screen footprint is now `cols x rows` GridEngine cells
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

const DEFAULT_BLOCK_SIZE = Object.freeze({cols: 10, rows: 6});
const DEFAULT_CONSTRAINTS = Object.freeze({minCols: 4, minRows: 3, maxCols: 60, maxRows: 60});

export class BlockSizeManager {
    /**
     * @method getBlockSizeFor
     * @description Declared block size (in grid cells, not px) for one
     * widget — from `metadata['block-size']` (`{cols, rows}`) if
     * declared, else DEFAULT_BLOCK_SIZE for every widget that hasn't
     * been migrated to the block-type system yet.
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
     * @method getConstraintsFor
     * @description Min/max block span for one widget, in grid cells —
     * from `metadata['size-constraints']`
     * (`{minCols, minRows, maxCols, maxRows}`) if declared, merged
     * key-by-key against DEFAULT_CONSTRAINTS so a widget can declare
     * just one bound (e.g. only `maxCols`) without the rest silently
     * becoming `undefined`.
     * @param {object} metadata
     * @returns {{minCols:number, minRows:number, maxCols:number, maxRows:number}}
     */
    static getConstraintsFor(metadata) {
        const declared = metadata?.['size-constraints'];
        if (!declared || typeof declared !== 'object')
            return DEFAULT_CONSTRAINTS;

        return {
            minCols: Number.isFinite(declared.minCols) ? declared.minCols : DEFAULT_CONSTRAINTS.minCols,
            minRows: Number.isFinite(declared.minRows) ? declared.minRows : DEFAULT_CONSTRAINTS.minRows,
            maxCols: Number.isFinite(declared.maxCols) ? declared.maxCols : DEFAULT_CONSTRAINTS.maxCols,
            maxRows: Number.isFinite(declared.maxRows) ? declared.maxRows : DEFAULT_CONSTRAINTS.maxRows,
        };
    }

    /**
     * @method applyBlockSize
     * @description Sets `actor`'s pixel size directly from its declared
     * block span (clamped to its declared min/max span), multiplied by
     * `cellSize`. Deterministic and allocation-independent — never reads
     * the actor's current size.
     * @param {object} metadata - entry.metadata (must include `id` for logging)
     * @param {Clutter.Actor} actor
     * @param {number} cellSize - GridEngine.cellSize (px per grid cell)
     */
    static applyBlockSize(metadata, actor, cellSize) {
        const size = this.getBlockSizeFor(metadata);
        const rules = this.getConstraintsFor(metadata);

        const cols = Math.max(rules.minCols, Math.min(size.cols, rules.maxCols));
        const rows = Math.max(rules.minRows, Math.min(size.rows, rules.maxRows));

        actor.set_size(cols * cellSize, rows * cellSize);
    }
}
