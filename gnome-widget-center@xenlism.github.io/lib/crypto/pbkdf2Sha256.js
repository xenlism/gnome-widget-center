import { hmacSha256 } from "./hmacSha256.js";

const HASH_LEN = 32;

function xorInto(target, source) {
    for (let i = 0; i < target.length; i++) target[i] ^= source[i];
}

function u32be(n) {
    return new Uint8Array([ n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255 ]);
}

export function pbkdf2Sha256(password, salt, iterations, keyLenBytes) {
    const blockCount = Math.ceil(keyLenBytes / HASH_LEN);
    const output = new Uint8Array(blockCount * HASH_LEN);
    for (let blockIndex = 1; blockIndex <= blockCount; blockIndex++) {
        const saltAndIndex = new Uint8Array(salt.length + 4);
        saltAndIndex.set(salt);
        saltAndIndex.set(u32be(blockIndex), salt.length);
        let u = hmacSha256(password, saltAndIndex);
        const t = u.slice();
        for (let i = 1; i < iterations; i++) {
            u = hmacSha256(password, u);
            xorInto(t, u);
        }
        output.set(t, (blockIndex - 1) * HASH_LEN);
    }
    return output.slice(0, keyLenBytes);
}