// P2/P3 pure-module tests against REAL builds from gwc-store (author signatures, tree digest, mirrors/tier policy, channels, search).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { b64decode, b64encode } from "../lib/store/signature.js";
import { TrustError, assertPackageBinding, channelOf, checkAuthor, checkAuthorPin, checkManifest, checkShard, effectiveTier, findUpdates,
    idAllowed, packageMessage, searchEntries, treeDigest, visibleIn } from "../lib/store/integrity.js";
import { readZip } from "../lib/store/zipCore.js";
import { installDialog } from "../lib/store/dialogText.js";
import { describePerms } from "../lib/store/permText.js";

const here = dirname(fileURLToPath(import.meta.url));
const storeDir = process.env.GWC_STORE_DIR ? resolve(process.cwd(), process.env.GWC_STORE_DIR) : resolve(here, "../../gwc-store");
const fxDir = mkdtempSync(join(tmpdir(), "gwcfx3-"));
execFileSync("python3", [join(storeDir, "tests/make_client_fixtures.py"), fxDir], { stdio: "pipe" });
const FX = JSON.parse(readFileSync(join(fxDir, "fixtures.json"), "utf8"));

const sha256 = u => createHash("sha256").update(u).digest("hex");
const sha512 = u => new Uint8Array(createHash("sha512").update(u).digest());
const NOW = Date.parse("2026-10-08T00:00:00Z");
const KEYS = [{ kid: FX.kid, pub: FX.pub }];
const load = (d, f) => new Uint8Array(readFileSync(join(fxDir, d, f)));
const run = (d, o = {}) => checkManifest({ manifestBytes: load(d, "store.json"), sigBytes: load(d, "store.json.sig"), keys: KEYS, now: NOW, sha512, sha256, ...o });
const code = f => { try { f(); } catch (e) { assert.ok(e instanceof TrustError, `expected TrustError, got ${e}`); return e.code; } assert.fail("did not throw"); };
const codec = { inflate: (u8, max) => new Uint8Array(zlib.inflateRawSync(u8, { maxOutputLength: max ?? 64 << 20 })), deflate: u => new Uint8Array(zlib.deflateRawSync(u)) };

const P3 = run("p3").manifest;
const shard = (d, m, name) => checkShard(m, name, load(d, m.shards[name].p.replace(/^/, "")), sha256);
const item = (name, id, d = "p3", m = P3) => shard(d, m, name).items.find(i => i.id === id);
const pkgEntries = (it, d = "p3") => {
    const g = JSON.parse(new TextDecoder().decode(load(d, it.f)));
    return { md: g.metadata, entries: readZip(new Uint8Array(Buffer.from(g.package.data, "base64")), codec) };
};

test("category shards of a real P3 build verify; search shard lists everything", () => {
    assert.deepEqual(Object.keys(P3.shards).sort(), ["search", "themepacks-other", "widgets-clock", "widgets-other", "widgets-system"]);
    const s = shard("p3", P3, "search");
    assert.equal(s.items.filter(e => e.k === "w").length, 4);
    assert.equal(s.items.find(e => e.id === "bob.beta").ch, "beta");
    assert.deepEqual(P3.mirrors, ["https://mirror.test/store/"]);
});

test("a search shard cannot be passed off as a category shard, or the other way round", () => {
    const b = load("p3", P3.shards.search.p);
    assert.equal(code(() => checkShard({ shards: { "widgets-clock": { ...P3.shards.search } } }, "widgets-clock", b, sha256)), "bad-shard");
    const c = load("p3", P3.shards["widgets-clock"].p);
    assert.equal(code(() => checkShard({ shards: { search: { ...P3.shards["widgets-clock"] } } }, "search", c, sha256)), "bad-shard");
});

// ---------------------------------------------------------------- author signatures
test("Python-made author signature verifies in JS; listing carries the signer", () => {
    const it = item("widgets-clock", "alice.clock");
    const a = checkAuthor(it, P3, { sha512, sha256 });
    assert.equal(a.status, "verified"); assert.equal(a.signer.kid, FX.aliceKid); assert.equal(a.signer.name, "Alice");
    assert.match(a.signer.fingerprint, /^([0-9A-F]{4} ){7}[0-9A-F]{4}$/);
});

test("unsigned widget in an optional-policy store: status none (no throw)", () => {
    assert.equal(checkAuthor(item("widgets-system", "bob.net"), P3, { sha512, sha256 }).status, "none");
});

test("any field the author signed, changed in the listing -> author-signature", () => {
    const it = item("widgets-clock", "alice.clock");
    for (const mut of [{ v: "9.9.9" }, { perm: ["network"] }, { en: "other.js" }, { td: "0".repeat(64) }, { id: "alice.other" }]) {
        assert.equal(code(() => checkAuthor({ ...it, ...mut }, P3, { sha512, sha256 })), "author-signature", JSON.stringify(mut));
    }
});

test("signature bytes flipped / from another key / unknown signer / out-of-scope id", () => {
    const it = item("widgets-clock", "alice.clock");
    const s = b64decode(it.sg.s); s[5] ^= 1;
    assert.equal(code(() => checkAuthor({ ...it, sg: { ...it.sg, s: b64encode(s) } }, P3, { sha512, sha256 })), "author-signature");
    assert.equal(code(() => checkAuthor({ ...it, sg: { ...it.sg, k: "mallory" } }, P3, { sha512, sha256 })), "author-unknown");
    const narrow = { ...P3, authors: P3.authors.map(a => ({ ...a, ids: ["bob.*"] })) };
    assert.equal(code(() => checkAuthor(it, narrow, { sha512, sha256 })), "author-scope");
    const swapped = { ...P3, authors: P3.authors.map(a => ({ ...a, pub: FX.otherPub })) };       // repo owner swaps the author's key
    assert.equal(code(() => checkAuthor(it, swapped, { sha512, sha256 })), "author-signature");
});

test("a MANIFEST signature is never accepted as a package signature (domain separation)", () => {
    const it = item("widgets-clock", "alice.clock");
    const msg = packageMessage({ id: it.id, version: it.v, entry: it.en, perm: it.perm, td: it.td });
    assert.notEqual(new TextDecoder().decode(msg.slice(0, 12)), "GWC-STORE-V2");
});

test("required policy: unsigned listing is refused", () => {
    const C = run("community").manifest;
    assert.equal(C.policy.authorSig, "required"); assert.equal(C.tier, "community");
    const it = item("widgets-clock", "alice.clock", "community", C);
    assert.equal(checkAuthor(it, C, { sha512, sha256 }).status, "verified");
    const { sg: _x, ...unsigned } = it;
    assert.equal(code(() => checkAuthor(unsigned, C, { sha512, sha256 })), "author-required");
});

test("idAllowed matches the Python rules", () => {
    assert.ok(idAllowed(["alice.*"], "alice.clock")); assert.ok(idAllowed(["alice.clock"], "alice.clock"));
    for (const [p, id] of [["alice.*", "alicex.clock"], ["alice.*", "alice"], ["*", "alice.clock"], ["*.clock", "alice.clock"], [".*", ".x"]]) assert.ok(!idAllowed([p], id), `${p} ${id}`);
    assert.ok(!idAllowed([], "x.y")); assert.ok(!idAllowed(undefined, "x.y"));
});

// ---------------------------------------------------------------- tree digest / binding (cross-language)
test("treeDigest in JS equals the td Python put in the listing (real zips, every widget)", () => {
    for (const [name, id] of [["widgets-clock", "alice.clock"], ["widgets-system", "bob.net"], ["widgets-other", "bob.beta"]]) {
        const it = item(name, id); const { entries } = pkgEntries(it);
        assert.equal(treeDigest(entries, sha256), it.td, id);
    }
});

test("assertPackageBinding: right package passes; changed content / entry / perm are refused", () => {
    const it = item("widgets-clock", "alice.clock"); const { md, entries } = pkgEntries(it);
    assertPackageBinding(md, entries, it, sha256);
    const evil = entries.map(e => e.name === "widget.js" ? { ...e, data: new TextEncoder().encode("evil()") } : e);
    assert.equal(code(() => assertPackageBinding(md, evil, it, sha256)), "td-mismatch");
    assert.equal(code(() => assertPackageBinding(md, [...entries, { name: "extra.js", data: new Uint8Array([1]) }], it, sha256)), "td-mismatch");
    assert.equal(code(() => assertPackageBinding({ ...md, entry: "x.js" }, entries, it, sha256)), "entry-mismatch");
    assert.equal(code(() => assertPackageBinding({ ...md, perm: ["network"] }, entries, it, sha256)), "perm-mismatch");
    assertPackageBinding(md, entries, { id: "x" }, sha256);          // theme pack / old listing: nothing to bind
});

test("treeDigest is order independent and sorts non-ASCII names by UTF-8 bytes like Python", () => {
    const e = [{ name: "b.js", data: new Uint8Array([1]) }, { name: "a.js", data: new Uint8Array([2]) }, { name: "é.js", data: new Uint8Array([3]) }, { name: "z/𝒳.js", data: new Uint8Array([4]) }];
    assert.equal(treeDigest(e, sha256), treeDigest([...e].reverse(), sha256));
    const py = execFileSync("python3", ["-c", `import sys;sys.path.insert(0,${JSON.stringify(join(storeDir, "tools"))});import gwc_sign;print(gwc_sign.tree_digest([("b.js",bytes([1])),("a.js",bytes([2])),("é.js",bytes([3])),("z/𝒳.js",bytes([4]))]))`]).toString().trim();
    assert.equal(treeDigest(e, sha256), py);
});

// ---------------------------------------------------------------- author key pinning
test("author pin: new / same / changed / lost", () => {
    const v = { status: "verified", signer: { kid: "k1", fingerprint: "AAAA" } };
    assert.equal(checkAuthorPin(undefined, v), "new");
    assert.equal(checkAuthorPin({ kid: "k1", fp: "AAAA" }, v), "same");
    assert.equal(checkAuthorPin({ kid: "k2", fp: "AAAA" }, v), "changed");
    assert.equal(checkAuthorPin({ kid: "k1", fp: "BBBB" }, v), "changed");
    assert.equal(checkAuthorPin({ kid: "k1", fp: "AAAA" }, { status: "none" }), "lost");
});

// ---------------------------------------------------------------- tier / mirrors / manifest policy
test("official keys may only vouch for an OFFICIAL store; community repos never display as official", () => {
    assert.equal(run("p3", { official: true }).tier, "official");
    assert.equal(code(() => run("community", { official: true })), "tier");
    assert.equal(run("community").tier, "community");
    assert.equal(run("p3").tier, "community", "a non-official repo claiming tier=official is displayed as community");
    assert.equal(effectiveTier({ official: true }, { tier: "official" }), "official");
    assert.equal(effectiveTier({ official: false }, { tier: "official" }), "community");
    assert.equal(effectiveTier({ official: true }, { tier: "community" }), "community");
});

test("manifest mirrors/authors/policy shape is validated (signature alone is not enough)", () => {
    // re-sign is impossible in JS, so exercise the validators through the fixtures generated with bad values
    for (const v of ["bad-mirror-http", "bad-mirror-self", "bad-author", "bad-policy", "bad-tier"]) assert.equal(code(() => run(v)), "bad-manifest", v);
});

// ---------------------------------------------------------------- channels + search
test("channels: stable users never see betas; beta users see both; updates respect the installed channel", () => {
    const stable = { id: "a.b", v: "1.0.0", h: "1".repeat(32) }, beta = { id: "a.b", v: "1.1.0", h: "2".repeat(32), ch: "beta" };
    assert.ok(visibleIn(stable, "stable") && !visibleIn(beta, "stable") && visibleIn(beta, "beta"));
    assert.equal(channelOf(beta), "beta"); assert.equal(channelOf(stable), "stable");
    const inst = id => ({ [id]: { src: "store", v: "1.0.0", h: "0".repeat(32) } });
    assert.deepEqual(findUpdates(inst("a.b"), [beta]), [], "stable user is not offered a beta");
    assert.deepEqual(findUpdates(inst("a.b"), [beta], { channel: "beta" }), ["a.b"]);
    assert.deepEqual(findUpdates({ "a.b": { src: "store", v: "1.0.0", h: "0".repeat(32), ch: "beta" } }, [beta]), ["a.b"], "already on the beta: keeps getting it");
    assert.deepEqual(findUpdates(inst("a.b"), [stable]), ["a.b"]);
});

test("search: every word must match id/name/tags; name-prefix first; kind + channel filters", () => {
    const e = shard("p3", P3, "search").items;
    assert.deepEqual(searchEntries(e, "alice").map(x => x.id), ["alice.clock"]);
    assert.deepEqual(searchEntries(e, "bob").map(x => x.id), ["bob.net"], "bob.beta hidden on stable");
    assert.deepEqual(searchEntries(e, "bob", { channel: "beta" }).map(x => x.id).sort(), ["bob.beta", "bob.net"]);
    assert.equal(searchEntries(e, "alice nomatch").length, 0);
    assert.ok(searchEntries(e, "", { kind: "t" }).every(x => x.k === "t"));
    const names = [{ id: "x.b", k: "w", n: "Big Clock", c: "clock", t: [] }, { id: "x.a", k: "w", n: "Clock", c: "clock", t: ["cl"] }, { id: "x.c", k: "w", n: "My cloud", c: "other", t: ["clock"] }];
    assert.deepEqual(searchEntries(names, "clock").map(x => x.id), ["x.a", "x.b", "x.c"]);
});

// ---------------------------------------------------------------- dialog text
test("install dialog tells the truth about permissions, signer, tier, beta and key changes", () => {
    const it = item("widgets-system", "bob.net"), common = { item: { ...it, d: "desc", a: "Bob" }, isW: true, repo: { name: "R" }, manifest: P3, expired: false };
    let d = installDialog({ ...common, tier: "official", author: { status: "none" }, pin: "new" });
    assert.match(d.body, /Can use the network/); assert.match(d.body, /not enforced/); assert.match(d.body, /Not signed by its author/); assert.equal(d.danger, true, "network perm -> red button even for official");
    d = installDialog({ ...common, item: { ...common.item, perm: ["none"] }, tier: "official", author: { status: "none" }, pin: "new" });
    assert.equal(d.danger, false);
    d = installDialog({ ...common, item: { ...common.item, perm: ["none"] }, tier: "community", author: { status: "none" }, pin: "new" });
    assert.equal(d.danger, true); assert.match(d.body, /community store/);
    d = installDialog({ ...common, item: { ...common.item, perm: ["none"], ch: "beta" }, tier: "official", author: { status: "verified", signer: { name: "Alice", fingerprint: "AAAA BBBB CCCC DDDD EEEE FFFF 0000 1111" } }, pin: "changed" });
    assert.match(d.body, /Signed by its author: Alice/); assert.match(d.body, /Beta release/); assert.match(d.body, /DIFFERENT/); assert.equal(d.danger, true);
    d = installDialog({ ...common, item: { ...common.item, perm: ["none"] }, tier: "official", author: { status: "none" }, pin: "lost" });
    assert.match(d.body, /NOT signed by its author/);
    assert.deepEqual(describePerms(["fs-read:~/.config/x", "weird"]), ["Can read files under ~/.config/x", "Unknown permission: weird"]);
});
