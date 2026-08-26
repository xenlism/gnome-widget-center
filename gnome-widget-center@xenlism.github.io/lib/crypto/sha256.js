// Copyright (c) 2026 Nattapong Pullkhow
// SPDX-License-Identifier: GPL-3.0-or-later
//
// SHA-256 (FIPS 180-4) — original implementation for this extension.
//
// This is our own from-scratch implementation of the published FIPS 180-4
// algorithm (a public specification, not third-party source), used here so
// the extension has no runtime dependency for hashing. The `a, b, c, d, e,
// f, g, h` working-variable names below intentionally match the names used
// in the FIPS 180-4 pseudocode itself, which is why they read as short/dense
// — they are not obfuscated, just following the spec's own notation.

const ROUND_CONSTANTS = new Uint32Array([ 1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298 ]);

const INITIAL_HASH_STATE = new Uint32Array([ 1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225 ]);

function rotateRight(value, bits) {
    return value >>> bits | value << 32 - bits;
}

export function sha256(message) {
    const bitLen = message.length * 8;
    const paddedLen = Math.ceil((message.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLen);
    padded.set(message);
    padded[message.length] = 128;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLen - 4, bitLen >>> 0, false);
    const state = INITIAL_HASH_STATE.slice();
    const schedule = new Uint32Array(64);
    for (let chunkStart = 0; chunkStart < paddedLen; chunkStart += 64) {
        for (let index = 0; index < 16; index++) schedule[index] = view.getUint32(chunkStart + index * 4, false);
        for (let index = 16; index < 64; index++) {
            const s0 = rotateRight(schedule[index - 15], 7) ^ rotateRight(schedule[index - 15], 18) ^ schedule[index - 15] >>> 3;
            const s1 = rotateRight(schedule[index - 2], 17) ^ rotateRight(schedule[index - 2], 19) ^ schedule[index - 2] >>> 10;
            schedule[index] = schedule[index - 16] + s0 + schedule[index - 7] + s1 | 0;
        }
        // Working variables a..h use the FIPS 180-4 pseudocode names, see file header.
        let [a, b, c, d, e, f, g, h] = state;
        for (let index = 0; index < 64; index++) {
            const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const ch = e & f ^ ~e & g;
            const temp1 = h + s1 + ch + ROUND_CONSTANTS[index] + schedule[index] | 0;
            const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const maj = a & b ^ a & c ^ b & c;
            const temp2 = s0 + maj | 0;
            h = g;
            g = f;
            f = e;
            e = d + temp1 | 0;
            d = c;
            c = b;
            b = a;
            a = temp1 + temp2 | 0;
        }
        state[0] = state[0] + a | 0;
        state[1] = state[1] + b | 0;
        state[2] = state[2] + c | 0;
        state[3] = state[3] + d | 0;
        state[4] = state[4] + e | 0;
        state[5] = state[5] + f | 0;
        state[6] = state[6] + g | 0;
        state[7] = state[7] + h | 0;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let index = 0; index < 8; index++) outView.setUint32(index * 4, state[index], false);
    return out;
}
