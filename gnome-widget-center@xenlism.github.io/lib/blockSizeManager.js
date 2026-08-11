export const BLOCK_CELL_SIZE = 16;

const DEFAULT_BLOCK_TYPE_NAME = "1x1";

const BLOCK_TYPES = Object.freeze({
    barx1: Object.freeze({
        cols: 11,
        rows: 5
    }),
    barx2: Object.freeze({
        cols: 23,
        rows: 5
    }),
    barx3: Object.freeze({
        cols: 35,
        rows: 5
    }),
    barx4: Object.freeze({
        cols: 47,
        rows: 5
    }),
    "1x1": Object.freeze({
        cols: 11,
        rows: 11
    }),
    "2x1": Object.freeze({
        cols: 23,
        rows: 11
    }),
    "2x2": Object.freeze({
        cols: 23,
        rows: 23
    }),
    "3x1": Object.freeze({
        cols: 35,
        rows: 11
    }),
    "3x2": Object.freeze({
        cols: 35,
        rows: 23
    }),
    "3x3": Object.freeze({
        cols: 35,
        rows: 35
    }),
    "4x1": Object.freeze({
        cols: 47,
        rows: 11
    }),
    "4x2": Object.freeze({
        cols: 47,
        rows: 23
    }),
    "4x3": Object.freeze({
        cols: 47,
        rows: 35
    }),
    "4x4": Object.freeze({
        cols: 47,
        rows: 47
    })
});

const MIN_CELLS = 1;

const MAX_CELLS = 300;

function _sanitizeDimension(value, fallback) {
    if (!Number.isFinite(value)) return fallback;
    const rounded = Math.round(value);
    return Math.min(MAX_CELLS, Math.max(MIN_CELLS, rounded));
}

export class BlockSizeManager {
    static getBlockSizeFor(metadata) {
        const declared = metadata?.["block-type"];
        if (typeof declared === "string") return BLOCK_TYPES[declared] ?? BLOCK_TYPES[DEFAULT_BLOCK_TYPE_NAME];
        if (declared && typeof declared === "object") {
            const fallback = BLOCK_TYPES[DEFAULT_BLOCK_TYPE_NAME];
            return {
                cols: _sanitizeDimension(declared.cols, fallback.cols),
                rows: _sanitizeDimension(declared.rows, fallback.rows)
            };
        }
        return BLOCK_TYPES[DEFAULT_BLOCK_TYPE_NAME];
    }
    static applyBlockSize(metadata, actor, cellSize = BLOCK_CELL_SIZE) {
        const {cols: cols, rows: rows} = this.getBlockSizeFor(metadata);
        actor.set_size(cols * cellSize, rows * cellSize);
    }
}