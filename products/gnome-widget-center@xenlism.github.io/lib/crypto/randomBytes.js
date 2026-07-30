// products/extension/lib/crypto/randomBytes.js
//
// The one piece of the `.gwcbak` crypto stack that DOES need `gi://` —
// generating actual random bytes needs a real entropy source, which pure
// JS has no access to at all. `/dev/urandom` is present on effectively
// every Linux system (same "almost always there" territory as `tar`),
// and reading it needs nothing beyond plain Gio file I/O — no separate
// system binary, no extra dependency check.

import Gio from 'gi://Gio';

/**
 * @param {number} length
 * @returns {Uint8Array} `length` cryptographically-random bytes.
 */
export function randomBytes(length) {
    const file = Gio.File.new_for_path('/dev/urandom');
    const stream = file.read(null);
    try {
        const bytes = stream.read_bytes(length, null);
        const data = bytes.get_data();
        if (!data || data.length !== length)
            throw new Error(`randomBytes: short read from /dev/urandom (wanted ${length}, got ${data?.length ?? 0})`);
        return new Uint8Array(data);
    } finally {
        stream.close(null);
    }
}
