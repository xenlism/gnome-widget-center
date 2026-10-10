// signature.js - Ed25519 verification of the store manifest. PURE JS (no gi:// imports) so it runs
// in GJS and in Node tests. SHA-512 / SHA-256 are injected by the caller.
//
// Signed message = DOMAIN || raw bytes of store.json   (domain separation: the key can never be
// tricked into "signing" some other kind of file that happens to be valid for this check).
import * as ed from "../vendor/noble-ed25519.js";

export const DOMAIN = new TextEncoder().encode("GWC-STORE-V2\0");
export const PKG_DOMAIN = new TextEncoder().encode("GWC-PKG-V1\0");      // author signatures over ONE package (never valid as a manifest signature)

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Strict standard base64 (with padding). Throws on anything else. */
export function b64decode(s) {
    if (typeof s !== "string" || s.length === 0 || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s))
        throw new Error("invalid base64");
    const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
    const out = new Uint8Array((s.length / 4) * 3 - pad);
    let o = 0;
    for (let i = 0; i < s.length; i += 4) {
        const n = [0, 1, 2, 3].map(k => (s[i + k] === "=" ? 0 : B64.indexOf(s[i + k])));
        const v = (n[0] << 18) | (n[1] << 12) | (n[2] << 6) | n[3];
        if (o < out.length) out[o++] = (v >> 16) & 255;
        if (o < out.length) out[o++] = (v >> 8) & 255;
        if (o < out.length) out[o++] = v & 255;
    }
    return out;
}

export function b64encode(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 3) {
        const v = (u8[i] << 16) | ((u8[i + 1] ?? 0) << 8) | (u8[i + 2] ?? 0);
        s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + (i + 1 < u8.length ? B64[(v >> 6) & 63] : "=") + (i + 2 < u8.length ? B64[v & 63] : "=");
    }
    return s;
}

export function hexToBytes(h) {
    if (typeof h !== "string" || h.length % 2 || !/^[0-9a-f]*$/i.test(h)) throw new Error("invalid hex");
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
}

/** Human-comparable key fingerprint: first 128 bits of sha256(pub), 8 groups of 4 hex chars. */
export function fingerprint(pubBytes, sha256hex) {
    return sha256hex(pubBytes).slice(0, 32).toUpperCase().replace(/(.{4})(?=.)/g, "$1 ");
}

/** Parse + sanity check a store.json.sig document. Returns { kid, sig:Uint8Array, pub:Uint8Array|null, pubB64 }. */
export function parseSigFile(bytes) {
    let d;
    try { d = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (_e) { throw new Error("malformed signature file"); }
    if (!d || d.alg !== "ed25519" || typeof d.kid !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(d.kid))
        throw new Error("unsupported signature file");
    const sig = b64decode(d.sig);
    if (sig.length !== 64) throw new Error("bad signature length");
    let pub = null;
    if (d.pub !== undefined) { pub = b64decode(d.pub); if (pub.length !== 32) throw new Error("bad public key length"); }
    return { kid: d.kid, sig, pub, pubB64: pub ? d.pub : null };
}

/** @returns boolean. Never throws for a bad signature (returns false). */
export function verifyManifestBytes(manifestBytes, sig, pub, sha512) {
    const msg = new Uint8Array(DOMAIN.length + manifestBytes.length);
    msg.set(DOMAIN, 0); msg.set(manifestBytes, DOMAIN.length);
    ed.hashes.sha512 = sha512;
    try { return ed.verify(sig, msg, pub, { zip215: false }) === true; } catch (_e) { return false; }
}

/** @returns boolean. Author signature over packageMessage(); never throws. */
export function verifyPackageBytes(message, sig, pub, sha512) {
    ed.hashes.sha512 = sha512;
    try { return ed.verify(sig, message, pub, { zip215: false }) === true; } catch (_e) { return false; }
}
