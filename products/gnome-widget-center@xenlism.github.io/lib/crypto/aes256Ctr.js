// products/extension/lib/crypto/aes256Ctr.js
//
// Task 11 (theme export/backup) — AES-256 (FIPS 197) in CTR mode, used
// to encrypt the tar.gz payload inside a `.gwcbak` backup
// (backupService.js). Same reasoning as sha256.js: no `gi://` crypto
// primitive to lean on, so this is a from-scratch implementation of the
// public NIST standard, with no dependencies at all — fully testable in
// plain Node.
//
// CTR mode only ever runs the cipher in the ENCRYPT direction (the
// "keystream" is AES_encrypt(counter), then XORed with the data) — so
// there's no separate decrypt path to implement or get wrong, and
// encrypt/decrypt are the exact same function. It also needs no padding
// (works on any length, byte-for-byte), which matches "one big tar.gz
// blob" much more simply than CBC would.
//
// CTR mode gives confidentiality only, no integrity check — a wrong key
// silently produces garbage instead of an error. backupService.js pairs
// this with a separate HMAC-SHA256 tag (Encrypt-then-MAC) specifically
// to detect a wrong password / corrupted file, rather than relying on
// this module for that.

const NB = 4; // words per block (128-bit block, fixed by AES regardless of key size)
const NK = 8; // words per key (256-bit key)
const NR = 14; // rounds for AES-256

// eslint-disable-next-line array-element-newline
const S_BOX = new Uint8Array([
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

const RCON = new Uint8Array([
    0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d,
]);

function xtime(a) {
    return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff;
}

function gmul(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
        if (b & 1)
            p ^= a;
        const hiBitSet = a & 0x80;
        a = (a << 1) & 0xff;
        if (hiBitSet)
            a ^= 0x1b;
        b >>= 1;
    }
    return p & 0xff;
}

/**
 * @param {Uint8Array} key - exactly 32 bytes (AES-256).
 * @returns {Uint8Array} the expanded key schedule, `4 * NB * (NR + 1)` bytes.
 */
function expandKey(key) {
    if (key.length !== 32)
        throw new Error(`aes256Ctr: key must be 32 bytes, got ${key.length}`);

    const totalWords = NB * (NR + 1);
    const w = new Uint8Array(totalWords * 4);
    w.set(key.subarray(0, 32));

    const temp = new Uint8Array(4);
    for (let i = NK; i < totalWords; i++) {
        temp.set(w.subarray((i - 1) * 4, i * 4));

        if (i % NK === 0) {
            // RotWord + SubWord + Rcon
            const t0 = temp[0];
            temp[0] = S_BOX[temp[1]] ^ RCON[i / NK - 1];
            temp[1] = S_BOX[temp[2]];
            temp[2] = S_BOX[temp[3]];
            temp[3] = S_BOX[t0];
        } else if (i % NK === 4) {
            for (let j = 0; j < 4; j++)
                temp[j] = S_BOX[temp[j]];
        }

        for (let j = 0; j < 4; j++)
            w[i * 4 + j] = w[(i - NK) * 4 + j] ^ temp[j];
    }

    return w;
}

function addRoundKey(state, schedule, round) {
    const offset = round * 16;
    for (let i = 0; i < 16; i++)
        state[i] ^= schedule[offset + i];
}

function subBytes(state) {
    for (let i = 0; i < 16; i++)
        state[i] = S_BOX[state[i]];
}

// State bytes are column-major (state[col*4 + row], per FIPS-197).
function shiftRows(state) {
    const s = state.slice();
    for (let row = 1; row < 4; row++) {
        for (let col = 0; col < 4; col++)
            state[col * 4 + row] = s[((col + row) % 4) * 4 + row];
    }
}

function mixColumns(state) {
    for (let col = 0; col < 4; col++) {
        const a0 = state[col * 4 + 0], a1 = state[col * 4 + 1], a2 = state[col * 4 + 2], a3 = state[col * 4 + 3];
        state[col * 4 + 0] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
        state[col * 4 + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
        state[col * 4 + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
        state[col * 4 + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
    }
}

/**
 * @param {Uint8Array} block - exactly 16 bytes, encrypted in place.
 * @param {Uint8Array} schedule - from expandKey().
 */
function encryptBlock(block, schedule) {
    addRoundKey(block, schedule, 0);
    for (let round = 1; round < NR; round++) {
        subBytes(block);
        shiftRows(block);
        mixColumns(block);
        addRoundKey(block, schedule, round);
    }
    subBytes(block);
    shiftRows(block);
    addRoundKey(block, schedule, NR);
}

/** @private increments a 16-byte counter in place, big-endian, as a
 * single 128-bit integer (standard CTR mode counter semantics). */
function incrementCounter(counter) {
    for (let i = 15; i >= 0; i--) {
        counter[i] = (counter[i] + 1) & 0xff;
        if (counter[i] !== 0)
            break;
    }
}

/**
 * AES-256-CTR: XORs `data` with the AES-256 keystream derived from
 * `key`+`iv`. Symmetric — call this with the same key/iv to both encrypt
 * and decrypt.
 * @param {Uint8Array} data
 * @param {Uint8Array} key - exactly 32 bytes.
 * @param {Uint8Array} iv - exactly 16 bytes; MUST be unique per (key,
 *   message) — backupService.js generates a fresh random one for every
 *   backup, never reuses one.
 * @returns {Uint8Array}
 */
export function aes256CtrTransform(data, key, iv) {
    if (iv.length !== 16)
        throw new Error(`aes256Ctr: iv must be 16 bytes, got ${iv.length}`);

    const schedule = expandKey(key);
    const counter = iv.slice();
    const out = new Uint8Array(data.length);

    for (let offset = 0; offset < data.length; offset += 16) {
        const keystreamBlock = counter.slice();
        encryptBlock(keystreamBlock, schedule);

        const chunkLen = Math.min(16, data.length - offset);
        for (let i = 0; i < chunkLen; i++)
            out[offset + i] = data[offset + i] ^ keystreamBlock[i];

        incrementCounter(counter);
    }

    return out;
}
