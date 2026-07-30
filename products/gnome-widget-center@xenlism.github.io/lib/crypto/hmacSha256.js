// products/extension/lib/crypto/hmacSha256.js
//
// Standard HMAC construction (RFC 2104) over sha256.js. Used for both
// PBKDF2's pseudorandom function (pbkdf2Sha256.js) and, directly, as the
// authentication tag on `.gwcbak` backups — see backupService.js's file
// header for why an authentication tag matters here (wrong-password
// detection; AES-CTR alone has no integrity check at all).

import {sha256} from './sha256.js';

const BLOCK_SIZE = 64; // SHA-256's block size in bytes.

function xorPad(key, padByte) {
    const out = new Uint8Array(BLOCK_SIZE);
    for (let i = 0; i < BLOCK_SIZE; i++)
        out[i] = (key[i] ?? 0) ^ padByte;
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

/**
 * @param {Uint8Array} key - any length; keys longer than 64 bytes are
 *   hashed down first per RFC 2104.
 * @param {Uint8Array} message
 * @returns {Uint8Array} 32-byte MAC.
 */
export function hmacSha256(key, message) {
    const normalizedKey = key.length > BLOCK_SIZE ? sha256(key) : key;
    const innerPad = xorPad(normalizedKey, 0x36);
    const outerPad = xorPad(normalizedKey, 0x5c);
    const innerHash = sha256(concat(innerPad, message));
    return sha256(concat(outerPad, innerHash));
}
