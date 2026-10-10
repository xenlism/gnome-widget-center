// zipCore.js - pure-JS zip reader/writer (no gi:// imports, so it can be unit-tested in Node).
// The deflate codec is injected: { inflate(u8, maxOutput)->u8, deflate(u8)->u8 } (see zipKit.js for the GJS codec).
// Reader is hardened: zip-slip names, symlinks, bombs (count / size / ratio), CRC check.

export const DEFAULT_LIMITS = { maxEntries: 500, maxTotal: 16 * 1024 * 1024, maxFile: 8 * 1024 * 1024, maxRatio: 200 };

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

let _crcTable = null;
export function crc32(u8) {
    if (!_crcTable) {
        _crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            _crcTable[n] = c >>> 0;
        }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = _crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

export function isSafeEntryName(n) {
    if (!n || n.length > 200 || n.startsWith("/") || n.includes("\\") || n.includes("\0")) return false;
    if (/^[A-Za-z]:/.test(n)) return false;
    return n.split("/").every(p => p !== "" && p !== "." && p !== "..");
}

/** @returns {{name:string,data:Uint8Array}[]} */
export function readZip(u8, codec, limits = DEFAULT_LIMITS) {
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
        if (u32(u8, i) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("zip: end of central directory not found");
    const count = u16(u8, eocd + 10);
    let p = u32(u8, eocd + 16);
    if (count > limits.maxEntries) throw new Error("zip: too many entries");
    const out = [];
    let total = 0;
    const dec = new TextDecoder("utf-8", { fatal: true });
    for (let n = 0; n < count; n++) {
        if (u32(u8, p) !== 0x02014B50) throw new Error("zip: bad central directory");
        const flags = u16(u8, p + 8), method = u16(u8, p + 10), crc = u32(u8, p + 16);
        const csize = u32(u8, p + 20), usize = u32(u8, p + 24);
        const nlen = u16(u8, p + 28), elen = u16(u8, p + 30), clen = u16(u8, p + 32);
        const attr = u32(u8, p + 38) >>> 16, lho = u32(u8, p + 42);
        const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
        p += 46 + nlen + elen + clen;
        if (name.endsWith("/")) continue;                        // directory entry
        if (flags & 1) throw new Error("zip: encrypted entries not allowed");
        if (!isSafeEntryName(name)) throw new Error(`zip: unsafe entry name: ${name}`);
        if ((attr & 0o170000) === 0o120000) throw new Error(`zip: symlink not allowed: ${name}`);
        if (usize > limits.maxFile || (total += usize) > limits.maxTotal) throw new Error("zip: too large");
        if (csize > 0 && usize / csize > limits.maxRatio) throw new Error(`zip: suspicious ratio: ${name}`);
        if (u32(u8, lho) !== 0x04034B50) throw new Error("zip: bad local header");
        const start = lho + 30 + u16(u8, lho + 26) + u16(u8, lho + 28);
        const raw = u8.subarray(start, start + csize);
        const data = method === 0 ? raw.slice() : method === 8 ? codec.inflate(raw, usize) : null;   // output is capped at the DECLARED size
        if (!data) throw new Error(`zip: unsupported method ${method}`);
        if (data.length !== usize || crc32(data) !== crc) throw new Error(`zip: corrupt entry: ${name}`);
        out.push({ name, data });
    }
    return out;
}

/** @param {{name:string,data:Uint8Array}[]} entries  @returns {Uint8Array} */
export function writeZip(entries, codec) {
    const enc = new TextEncoder(), parts = [], cd = [];
    let off = 0;
    const push = a => { parts.push(a); off += a.length; };
    const hdr = (len, fn) => { const b = new Uint8Array(len); fn(new DataView(b.buffer)); return b; };
    for (const { name, data } of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!isSafeEntryName(name)) throw new Error(`zip: unsafe name: ${name}`);
        const nm = enc.encode(name), crc = crc32(data);
        let comp = codec.deflate(data), method = 8;
        if (comp.length >= data.length) { comp = data; method = 0; }
        const lho = off;
        push(hdr(30, v => { v.setUint32(0, 0x04034B50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true);
            v.setUint16(8, method, true); v.setUint16(10, 0, true); v.setUint16(12, 0x21, true);   // 1980-01-01
            v.setUint32(14, crc, true); v.setUint32(18, comp.length, true); v.setUint32(22, data.length, true);
            v.setUint16(26, nm.length, true); }));
        push(nm); push(comp);
        cd.push(hdr(46, v => { v.setUint32(0, 0x02014B50, true); v.setUint16(4, 0x031E, true); v.setUint16(6, 20, true);
            v.setUint16(8, 0x0800, true); v.setUint16(10, method, true); v.setUint16(14, 0x21, true);
            v.setUint32(16, crc, true); v.setUint32(20, comp.length, true); v.setUint32(24, data.length, true);
            v.setUint16(28, nm.length, true); v.setUint32(38, (0o100644 << 16) >>> 0, true); v.setUint32(42, lho, true); }), nm);
    }
    const cdStart = off;
    cd.forEach(push);
    push(hdr(22, v => { v.setUint32(0, 0x06054B50, true); v.setUint16(8, entries.length, true);
        v.setUint16(10, entries.length, true); v.setUint32(12, off - cdStart, true); v.setUint32(16, cdStart, true); }));
    const res = new Uint8Array(off);
    let o = 0;
    for (const a of parts) { res.set(a, o); o += a.length; }
    return res;
}
