import { sha256 } from "./sha256.js";

const BLOCK_SIZE = 64;

function xorPad(key, padByte) {
    const out = new Uint8Array(BLOCK_SIZE);
    for (let i = 0; i < BLOCK_SIZE; i++) out[i] = (key[i] ?? 0) ^ padByte;
    return out;
}

function concat(...arrays) {
    const total = arrays.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.length;
    }
    return out;
}

export function hmacSha256(key, message) {
    const normalizedKey = key.length > BLOCK_SIZE ? sha256(key) : key;
    const innerPad = xorPad(normalizedKey, 54);
    const outerPad = xorPad(normalizedKey, 92);
    const innerHash = sha256(concat(innerPad, message));
    return sha256(concat(outerPad, innerHash));
}