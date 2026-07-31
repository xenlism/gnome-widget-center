// products/extension/lib/crypto/pbkdf2Sha256.js
//
// Standard PBKDF2 (RFC 8018) with HMAC-SHA256 as its PRF, used to turn a
// `.gwcbak` password + random salt into key material (backupService.js
// splits the output into an AES-256 key and a separate HMAC key — see
// that file's header for the Encrypt-then-MAC design).

import {hmacSha256} from './hmacSha256.js';

const HASH_LEN = 32; // SHA-256 output size in bytes.

function xorInto(target, source) {
    for (let i = 0; i < target.length; i++)
        target[i] ^= source[i];
}

function u32be(n) {
    return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/**
 * @param {Uint8Array} password
 * @param {Uint8Array} salt
 * @param {number} iterations - see backupService.js for the chosen count
 *   and the reasoning behind it (a deliberate cost/UI-blocking trade-off,
 *   since this runs synchronously on the prefs process's main thread).
 * @param {number} keyLenBytes - total output length; backupService.js
 *   asks for 64 (32 for AES-256 + 32 for HMAC-SHA256).
 * @returns {Uint8Array}
 */
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
