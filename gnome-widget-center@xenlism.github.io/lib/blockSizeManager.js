export const BLOCK_CELL_SIZE = 16;

const DEFAULT_BLOCK_TYPE_NAME = "1x1";

const _cells = n => 12 * n - 1;

// Every "WxH" from 1x1 to 6x6 (cells = 12n - 1), plus barx1..barx4 (5 rows high).
const BLOCK_TYPES = Object.freeze(Object.fromEntries([
    ...[1, 2, 3, 4].map(w => [`barx${w}`, { cols: _cells(w), rows: 5 }]),
    ...[1, 2, 3, 4, 5, 6].flatMap(w => [1, 2, 3, 4, 5, 6].map(h => [`${w}x${h}`, { cols: _cells(w), rows: _cells(h) }]))
].map(([k, v]) => [k, Object.freeze(v)])));

export class BlockSizeManager {
    static getBlockSizeFor(metadata) {
        const declared = metadata?.["block-type"];
        if (typeof declared === "string") return BLOCK_TYPES[declared] ?? BLOCK_TYPES[DEFAULT_BLOCK_TYPE_NAME];
        return BLOCK_TYPES[DEFAULT_BLOCK_TYPE_NAME];
    }
    static applyBlockSize(metadata, actor, cellSize = BLOCK_CELL_SIZE) {
        const {cols: cols, rows: rows} = this.getBlockSizeFor(metadata);
        actor.set_size(cols * cellSize, rows * cellSize);
    }
}