import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

class Bytes { constructor(u8) { this.data = u8; } get_size() { return this.data.length; } toArray() { return this.data; } get_data() { return this.data; } }
const ALG = { 0: "md5", 1: "sha1", 2: "sha256", 3: "sha512" };
class Uri {
    constructor(u) { this.u = new URL(u); }
    static parse(s) { return new Uri(s); }
    get_host() { return this.u.hostname; } get_scheme() { return this.u.protocol.slice(0, -1); }
    get_path() { return this.u.pathname; } get_port() { return this.u.port ? Number(this.u.port) : -1; }
    get_query() { return this.u.search.slice(1) || null; } get_userinfo() { return this.u.username || null; }
}
export default {
    Bytes, Uri,
    UserDirectory: new Proxy({}, { get: (_t, k) => String(k) }),
    get_user_special_dir: () => null, get_home_dir: () => "/nonexistent-home",
    ChecksumType: { MD5: 0, SHA1: 1, SHA256: 2, SHA512: 3 },
    UriFlags: { NONE: 0 }, FileTest: { EXISTS: 1 }, PRIORITY_DEFAULT: 0,
    compute_checksum_for_bytes: (t, b) => createHash(ALG[t]).update(b.data).digest("hex"),
    compute_checksum_for_string: (t, s) => createHash(ALG[t]).update(s).digest("hex"),
    build_filenamev: parts => join(...parts),
    get_user_cache_dir: () => globalThis.__cacheDir, get_user_config_dir: () => globalThis.__cacheDir, get_user_data_dir: () => globalThis.__cacheDir,
    mkdir_with_parents: (p) => { mkdirSync(p, { recursive: true }); return 0; },
    path_get_dirname: p => dirname(p),
    file_test: (p) => existsSync(p),
    random_int: () => Math.floor(Math.random() * 2 ** 31),
    base64_decode: s => new Uint8Array(Buffer.from(s, "base64")), base64_encode: u => Buffer.from(u).toString("base64"),
};
