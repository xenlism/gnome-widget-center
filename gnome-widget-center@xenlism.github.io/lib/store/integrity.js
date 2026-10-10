// integrity.js - ALL trust decisions of the store client, as pure functions (no gi:// imports).
// storeClient.js only does I/O and calls these; Node tests (tests/) exercise them against a real
// signed build produced by tools/build_store.py.
//
// Chain:  trusted public key --Ed25519--> store.json --sha256--> shard --h--> package / cover
import { PKG_DOMAIN, b64decode, fingerprint, parseSigFile, verifyManifestBytes, verifyPackageBytes } from "./signature.js";
import { cmpVersion } from "./semver.js";

export class TrustError extends Error {
    constructor(code, message) { super(message); this.name = "TrustError"; this.code = code; }
}

// package: a .gwcw / .gwct file.  packageBig: the raw zip (.gwcp) of a version 2 widget.  meta: a version 2 .gwcw (metadata only).
// Mirrors tools/verify_store.py (MAX_ZIP_BIG, MAX_META); unpack limits: BIG_ZIP_LIMITS in gwcFormat.js.
export const MAX = { manifest: 256 * 1024, sig: 4096, shard: 4 * 1024 * 1024, cover: 512 * 1024, package: 8 * 1024 * 1024, packageBig: 64 * 1024 * 1024, meta: 1024 * 1024 };

const NAME = "[A-Za-z0-9][A-Za-z0-9._-]*";                    // no leading dot: rules out "." and ".."
export const REL_OK = new RegExp(`^(c|i|w|t)/${NAME}$`);
const SHARD_REL = new RegExp(`^i/${NAME}$`);
export const COVER_REL = /^c\/([0-9a-f]{32})\.jpg$/;
export const ID_RE = /^[a-z0-9][a-z0-9._-]{1,80}$/;
const HEX64 = /^[0-9a-f]{64}$/, HEX32 = /^[0-9a-f]{32}$/;
export const SHARD_NAME = /^(search|widgets-[a-z0-9]{1,20}|themepacks-[a-z0-9]{1,20})$/;
/** PERM_RE plus the path rules the build tool enforces: no '..' segment, no '//' */
export const permOk = p => typeof p === "string" && PERM_RE.test(p) && !(p.includes("//") || p.slice(p.indexOf(":") + 1).split("/").includes("..") && p.includes(":"));
export const PERM_RE = /^(none|network|subprocess|fs-read:[A-Za-z0-9_./~$-]{1,200}|fs-write:[A-Za-z0-9_./~$-]{1,200})$/;
const MIRROR_RE = /^https:\/\/[^/?#@\s]+(\/[^?#\s]*)?\/$/;
const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ID_PATTERN = /^([a-z0-9][a-z0-9._-]{1,80}|[a-z0-9][a-z0-9._-]{0,79}\.\*)$/;
const isInt = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;
const fail = (code, msg) => { throw new TrustError(code, msg); };

/**
 * Verify a downloaded manifest + signature.
 * @param o.keys   [{kid, pub(base64)}]  keys this repo is trusted to sign with
 * @param o.state  { seq?:number, msha?:string }  highest seq seen so far + sha256 of that manifest
 * @param o.now    ms since epoch
 * @returns { manifest, kid, msha, expired }
 */
export function checkManifest({ manifestBytes, sigBytes, keys, state = {}, now, sha512, sha256, official = false }) {
    if (!keys?.length) fail("no-keys", "No trusted signing key is configured for this store");
    if (manifestBytes.length > MAX.manifest) fail("too-large", "store.json is too large");
    let sf;
    try { sf = parseSigFile(sigBytes); } catch (e) { fail("bad-sig-file", e.message); }
    const key = keys.find(k => k.kid === sf.kid);
    if (!key) fail("unknown-key", `Store is signed with an unknown key (${sf.kid})`);
    let pub;
    try { pub = b64decode(key.pub); } catch (_e) { fail("bad-key", "Configured public key is invalid"); }
    if (pub.length !== 32) fail("bad-key", "Configured public key is invalid");
    if (!verifyManifestBytes(manifestBytes, sf.sig, pub, sha512)) fail("bad-signature", "Store signature is invalid");

    let m;
    try { m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)); } catch (_e) { fail("bad-manifest", "store.json is not valid JSON"); }
    if (!m || m.schema !== 2) fail("schema", "Unsupported store schema (signed schema 2 required)");
    if (typeof m.id !== "string" || typeof m.name !== "string") fail("bad-manifest", "store.json: id/name missing");
    if (!isInt(m.seq, 1, Number.MAX_SAFE_INTEGER)) fail("bad-manifest", "store.json: bad seq");
    const issued = Date.parse(m.issued), expires = Date.parse(m.expires);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) fail("bad-manifest", "store.json: bad issued/expires");
    if (!m.shards || typeof m.shards !== "object" || Array.isArray(m.shards)) fail("bad-manifest", "store.json: shards missing");
    for (const [name, d] of Object.entries(m.shards)) {
        if (!SHARD_NAME.test(name) || typeof d?.p !== "string" || !SHARD_REL.test(d.p) || !HEX64.test(d.sha256 ?? "")
            || !isInt(d.s, 1, MAX.shard) || !isInt(d.n, 0, 1e6)) fail("bad-manifest", `store.json: bad shard '${name}'`);
    }
    if (m.tier !== "official" && m.tier !== "community") fail("bad-manifest", "store.json: bad tier");
    // the embedded (official) keys may only ever vouch for an OFFICIAL store; anything else signed with them is a mix-up or an attack
    if (official && m.tier !== "official") fail("tier", "This store is not marked official but was signed with an official key");
    if (m.mirrors !== undefined) {
        if (!Array.isArray(m.mirrors) || m.mirrors.length > 5 || m.mirrors.some(u => typeof u !== "string" || !MIRROR_RE.test(u) || u === m.base))
            fail("bad-manifest", "store.json: bad mirrors");
    }
    if (m.authors !== undefined) {
        if (!Array.isArray(m.authors) || m.authors.length > 500) fail("bad-manifest", "store.json: bad authors list");
        for (const a of m.authors) {
            let ok = false;
            try { ok = a && KID_RE.test(a.kid ?? "") && typeof a.name === "string" && a.name.length >= 1 && a.name.length <= 80 && b64decode(a.pub).length === 32
                && Array.isArray(a.ids) && a.ids.length >= 1 && a.ids.length <= 50 && a.ids.every(i => typeof i === "string" && ID_PATTERN.test(i)); } catch (_e) { ok = false; }
            if (!ok) fail("bad-manifest", "store.json: malformed author entry");
        }
    }
    if (m.policy !== undefined && m.policy?.authorSig !== "required" && m.policy?.authorSig !== "optional") fail("bad-manifest", "store.json: bad policy");
    if (m.revoked !== undefined) {
        if (!Array.isArray(m.revoked) || m.revoked.length > 1000) fail("bad-manifest", "store.json: bad revoked list");
        for (const e of m.revoked) {
            const ok = e && (e.kind === "widgets" || e.kind === "themepacks") && ID_RE.test(e.id ?? "")
                && (e.h === undefined || HEX32.test(e.h)) && typeof e.reason === "string" && e.reason.length >= 1 && e.reason.length <= 200;
            if (!ok) fail("bad-manifest", "store.json: malformed revoked entry");
        }
    }

    const msha = sha256(manifestBytes);
    if (typeof state.seq === "number") {
        if (m.seq < state.seq) fail("rollback", `Store went backwards (seq ${m.seq} < ${state.seq}) - refusing`);
        if (m.seq === state.seq && state.msha && state.msha !== msha) fail("seq-reuse", "Store changed without a new seq - refusing");
    }
    return { manifest: m, kid: sf.kid, msha, expired: now > expires, tier: official ? m.tier : "community" };
}

/** Public key offered by a (not yet trusted) repo, for the "trust this store?" dialog. */
export function describeOfferedKey(sigBytes, sha256) {
    const sf = parseSigFile(sigBytes);
    if (!sf.pub) fail("no-pub", "This store does not publish a public key");
    return { kid: sf.kid, pub: sf.pubB64, fingerprint: fingerprint(sf.pub, sha256) };
}

/**
 * Validate a shard (category shard "widgets-clock" / "themepacks-dark", or the "search" shard) against the signed
 * manifest and return it. Everything is checked BEFORE anything is cached or shown.
 */
export function checkShard(manifest, name, bytes, sha256) {
    const d = manifest.shards[name];
    if (!d) fail("no-shard", `No such shard: ${name}`);
    if (bytes.length !== d.s || sha256(bytes) !== d.sha256) fail("hash", `Index '${name}' failed its integrity check`);
    let s;
    try { s = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (_e) { fail("bad-shard", "Index is not valid JSON"); }
    if (!s || s.schema !== 2 || !Array.isArray(s.items)) fail("bad-shard", "Unsupported index schema");
    if (name === "search") {
        if (s.kind !== "search") fail("bad-shard", "Search index has the wrong kind");
        const seen = new Set();
        for (const e of s.items) {
            const ok = e && ID_RE.test(e.id ?? "") && (e.k === "w" || e.k === "t") && typeof e.n === "string" && e.n.length <= 200
                && typeof e.c === "string" && /^[a-z0-9]{1,20}$/.test(e.c) && Array.isArray(e.t) && e.t.length <= 20 && e.t.every(x => typeof x === "string" && x.length <= 60)
                && (e.ch === undefined || e.ch === "beta") && !seen.has(e.k + e.id);
            if (!ok) fail("bad-shard", `Search index has a malformed entry (${e?.id ?? "?"})`);
            seen.add(e.k + e.id);
        }
        return s;
    }
    const dash = name.indexOf("-"), kind = name.slice(0, dash), catalog = name.slice(dash + 1);
    if (s.kind !== kind || s.catalog !== catalog) fail("bad-shard", "Index kind/category differs from its name");
    const prefix = kind === "widgets" ? "w/" : "t/";
    const seen = new Set();
    for (const i of s.items) {
        let ok = i && ID_RE.test(i.id ?? "") && !seen.has(i.id) && typeof i.n === "string" && typeof i.v === "string"
            && typeof i.f === "string" && REL_OK.test(i.f) && i.f.startsWith(prefix) && isInt(i.s, 1, MAX.package)
            && HEX32.test(i.h ?? "") && (i.cv === null || (typeof i.cv === "string" && COVER_REL.test(i.cv))) && i.c === catalog
            && (i.ch === undefined || i.ch === "beta");
        if (ok && kind === "widgets") {
            ok = Array.isArray(i.perm) && i.perm.length >= 1 && i.perm.length <= 8 && i.perm.every(permOk)
                && !(i.perm.includes("none") && i.perm.length > 1) && typeof i.en === "string" && i.en.length >= 1 && i.en.length <= 200 && HEX64.test(i.td ?? "")
                && (i.sg === undefined || (typeof i.sg?.k === "string" && KID_RE.test(i.sg.k) && typeof i.sg.s === "string" && sigLen(i.sg.s) === 64));
        }
        if (ok && (i.z !== undefined || i.zs !== undefined || i.zh !== undefined)) {        // version 2 widget: the raw zip is its own file
            ok = kind === "widgets" && typeof i.z === "string" && REL_OK.test(i.z) && i.z.startsWith("w/") && i.z.endsWith(".gwcp")
                && isInt(i.zs, 1, MAX.packageBig) && HEX32.test(i.zh ?? "") && i.s <= MAX.meta;
        }
        if (!ok) fail("bad-shard", `Index has a malformed entry (${i?.id ?? "?"})`);
        seen.add(i.id);
    }
    return s;
}

function sigLen(b64) { try { return b64decode(b64).length; } catch (_e) { return -1; } }

// ------------------------------------------------------------------ package integrity + author signatures (P3)
const utf8 = new TextEncoder();
const cmpBytes = (a, b) => { const x = utf8.encode(a), y = utf8.encode(b); const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };

/** sha256 over the sorted lines "<path>\0<sha256 hex of file>\n" - identical to gwc_sign.tree_digest in Python. entries: [{name, data}] */
export function treeDigest(entries, sha256) {
    const lines = [...entries].sort((a, b) => cmpBytes(a.name, b.name)).map(e => `${e.name}\0${sha256(e.data)}\n`).join("");
    return sha256(utf8.encode(lines));
}

/** The exact bytes an author signs: domain || id \0 version \0 entry \0 perm(sorted, ",") \0 td */
export function packageMessage({ id, version, entry, perm, td }) {
    const body = utf8.encode([ id, version, entry, [...perm].sort().join(","), td ].join("\0"));
    const out = new Uint8Array(PKG_DOMAIN.length + body.length); out.set(PKG_DOMAIN, 0); out.set(body, PKG_DOMAIN.length);
    return out;
}

/** 'prefix.*' matches ids starting with 'prefix.'; exact ids match themselves; a bare '*' never matches. */
export function idAllowed(patterns, id) {
    return (patterns ?? []).some(p => p === id || (p.endsWith(".*") && p.length > 2 && !p.slice(0, -1).includes("*") && id.startsWith(p.slice(0, -1))));
}

/**
 * Author signature of a LISTED widget (shard item), against the authors the signed manifest lists.
 * @returns { status: "none" } | { status: "verified", signer: { kid, name, fingerprint } }
 * Throws TrustError when a signature is present but invalid, or when the repo's policy requires one and it is missing.
 * NOTE this proves the listing is signed; assertPackageBinding() proves the downloaded package IS what was signed.
 */
export function checkAuthor(item, manifest, { sha512, sha256 }) {
    const sg = item.sg;
    if (!sg) {
        if (manifest.policy?.authorSig === "required") fail("author-required", `${item.id}: this store requires an author signature and the listing has none`);
        return { status: "none" };
    }
    const au = (manifest.authors ?? []).find(a => a.kid === sg.k);
    if (!au) fail("author-unknown", `${item.id}: signed by '${sg.k}', who is not listed by this store`);
    if (!idAllowed(au.ids, item.id)) fail("author-scope", `${item.id}: '${sg.k}' is not allowed to sign this id`);
    const pub = b64decode(au.pub);
    const msg = packageMessage({ id: item.id, version: item.v, entry: item.en, perm: item.perm, td: item.td });
    if (!verifyPackageBytes(msg, b64decode(sg.s), pub, sha512)) fail("author-signature", `${item.id}: author signature is invalid`);
    return { status: "verified", signer: { kid: au.kid, name: au.name, fingerprint: fingerprint(pub, sha256) } };
}

/** After unpacking: the files on disk-to-be must be exactly what the listing (and the author) described. */
export function assertPackageBinding(md, entries, item, sha256) {
    if (item.td === undefined) return;                                   // theme packs / file imports have nothing to bind to
    if (md.entry !== item.en) fail("entry-mismatch", `Package entry '${md.entry}' differs from the listing '${item.en}'`);
    const perm = (Array.isArray(md.perm) ? [...md.perm] : []).sort();
    if (perm.length !== item.perm.length || perm.some((p, i) => p !== item.perm[i])) fail("perm-mismatch", "Package permissions differ from the listing");
    if (treeDigest(entries, sha256) !== item.td) fail("td-mismatch", "Package contents differ from what the listing (and its author signature) describe");
}

/**
 * Key continuity ("pinning") for authors: compare what we recorded at install time with what the store shows now.
 * @param prev  registry record's `author` ({kid, fp}) or undefined
 * @param now   checkAuthor() result
 * @returns "new" | "same" | "changed" (different key or fingerprint) | "lost" (was signed, now unsigned - possible downgrade)
 */
export function checkAuthorPin(prev, now) {
    if (!prev) return "new";
    if (now.status !== "verified") return "lost";
    return prev.kid === now.signer.kid && prev.fp === now.signer.fingerprint ? "same" : "changed";
}

/** Trust level to DISPLAY: only the embedded-key official repo is "official"; every other repo is "community" whatever it claims. */
export function effectiveTier(repo, manifest) { return repo?.official && manifest?.tier === "official" ? "official" : "community"; }

// ------------------------------------------------------------------ channels + search (P2/P3)
export const channelOf = item => item.ch === "beta" ? "beta" : "stable";
/** "stable" users see stable items only; "beta" users see both. */
export const visibleIn = (item, channel) => channel === "beta" || channelOf(item) === "stable";

/** Search entries ({id,k,n,c,t,ch?}) by words; every word must match id / name / tags. Name-prefix matches first. */
export function searchEntries(entries, query, { channel = "stable", kind = null } = {}) {
    const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const scored = [];
    for (const e of entries) {
        if ((kind && e.k !== kind) || !visibleIn(e, channel)) continue;
        const name = e.n.toLowerCase(), hay = `${e.id.toLowerCase()} ${name} ${e.t.join(" ").toLowerCase()}`;
        if (!words.every(w => hay.includes(w))) continue;
        scored.push([ words.some(w => name.startsWith(w)) ? 0 : 1, name, e ]);
    }
    return scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(x => x[2]);
}

export function checkCover(rel, bytes, sha256) {
    const m = COVER_REL.exec(rel ?? "");
    if (!m) fail("bad-path", "Bad cover path");
    if (bytes.length === 0 || bytes.length > MAX.cover) fail("too-large", "Cover has a bad size");
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[2] !== 0xFF) fail("not-jpeg", "Cover is not a JPEG");
    if (sha256(bytes).slice(0, 32) !== m[1]) fail("hash", "Cover failed its integrity check");
}

export function checkPackage(item, bytes, sha256) {
    if (bytes.length !== item.s || sha256(bytes).slice(0, 32) !== item.h) fail("hash", `${item.id}: integrity check failed`);
}

/** version 2: the raw zip (.gwcp) against the signed listing (z / zs / zh) */
export function checkPackageZip(item, bytes, sha256) {
    if (typeof item.z !== "string" || bytes.length !== item.zs || sha256(bytes).slice(0, 32) !== item.zh) fail("hash", `${item.id}: package file integrity check failed`);
}

/**
 * Before touching disk: the file we are about to install must be the thing the user was shown.
 * @param expect  { id, version? } from the (signed) index item; omit for "from a file"
 * @param apiCheck  metadata => {ok, reason}   (lib/apiVersion.js checkApiVersion)
 */
export function assertInstallable(md, expect, apiCheck) {
    if (expect) {
        if (md.id !== expect.id) fail("id-mismatch", `Package id '${md.id}' does not match the listing '${expect.id}'`);
        if (expect.version !== undefined && String(md.version) !== String(expect.version))
            fail("version-mismatch", `Package version '${md.version}' does not match the listing '${expect.version}'`);
    }
    if (apiCheck) { const r = apiCheck(md); if (!r.ok) throw new Error(r.reason); }
}

/**
 * Which installed (from store) items have a newer - or republished same-version - build? Never offers a downgrade.
 * A beta build is only offered to people on the beta channel, or who already run a beta of that item.
 */
export function findUpdates(installedMap, items, { channel = "stable" } = {}) {
    return items.filter(i => {
        const r = installedMap[i.id];
        if (r?.src !== "store" || r.h === i.h) return false;
        if (!visibleIn(i, channel) && r.ch !== "beta") return false;
        const c = r.v === undefined ? 0 : cmpVersion(i.v, r.v);
        return c === null ? true : c >= 0;
    }).map(i => i.id);
}

/**
 * Which installed items does the signed `revoked` list withdraw?
 * @param installed  { widgets: {id: rec}, themepacks: {id: rec} } - ONLY records installed from this repo (caller filters)
 * An entry with `h` withdraws that exact build; without `h` it withdraws every build of the id.
 */
export function findRevoked(revoked, installed) {
    const out = new Map();
    for (const e of revoked ?? []) {
        const rec = installed?.[e.kind]?.[e.id];
        if (!rec || rec.src !== "store") continue;
        if (e.h !== undefined && rec.h !== e.h) continue;
        out.set(`${e.kind}/${e.id}`, { kind: e.kind, id: e.id, reason: e.reason });
    }
    return [...out.values()];
}
