// Node tests for the pure client modules, run against a REAL signed store built by gwc-store's Python tooling.
//   GWC_STORE_DIR=../gwc-store node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { b64decode, b64encode, fingerprint, hexToBytes, parseSigFile } from "../lib/store/signature.js";
import { MAX, REL_OK, TrustError, assertInstallable, checkCover, checkManifest, checkPackage, checkShard, describeOfferedKey, findRevoked, findUpdates } from "../lib/store/integrity.js";
import { cmpVersion } from "../lib/store/semver.js";

const here = dirname(fileURLToPath(import.meta.url));
const storeDir = process.env.GWC_STORE_DIR ? resolve(process.cwd(), process.env.GWC_STORE_DIR) : resolve(here, "../../gwc-store");
const fxDir = mkdtempSync(join(tmpdir(), "gwcfx-"));
execFileSync("python3", [join(storeDir, "tests/make_client_fixtures.py"), fxDir], { stdio: "pipe" });
const FX = JSON.parse(readFileSync(join(fxDir, "fixtures.json"), "utf8"));

const sha256 = u8 => createHash("sha256").update(u8).digest("hex");
const sha512 = u8 => new Uint8Array(createHash("sha512").update(u8).digest());
const NOW = Date.parse("2026-10-08T00:00:00Z");
const KEYS = [{ kid: FX.kid, pub: FX.pub }];
const load = (d, f) => new Uint8Array(readFileSync(join(fxDir, d, f)));
const run = (d, o = {}) => checkManifest({ manifestBytes: load(d, "store.json"), sigBytes: load(d, "store.json.sig"), keys: KEYS, now: NOW, sha512, sha256, ...o });
const code = f => { try { f(); } catch (e) { assert.ok(e instanceof TrustError, `expected TrustError, got ${e}`); return e.code; } assert.fail("did not throw"); };

test("good manifest verifies (Python-signed, JS-verified)", () => {
    const r = run("good");
    assert.equal(r.manifest.seq, 10); assert.equal(r.kid, FX.kid); assert.equal(r.expired, false);
    assert.equal(r.msha, sha256(load("good", "store.json")));
});

test("expired manifest is flagged, not thrown", () => assert.equal(run("expired").expired, true));

test("tampered manifest bytes -> bad-signature", () => {
    const m = load("good", "store.json"); m[m.length - 5] ^= 1;
    assert.equal(code(() => run("good", { manifestBytes: m })), "bad-signature");
});
test("one flipped signature bit -> bad-signature", () => {
    const sf = JSON.parse(new TextDecoder().decode(load("good", "store.json.sig")));
    const s = b64decode(sf.sig); s[0] ^= 1; sf.sig = b64encode(s);
    assert.equal(code(() => run("good", { sigBytes: new TextEncoder().encode(JSON.stringify(sf)) })), "bad-signature");
});
test("signed by an untrusted key id -> unknown-key", () => assert.equal(code(() => run("unknown-kid")), "unknown-key"));
test("right kid, wrong private key -> bad-signature", () => assert.equal(code(() => run("signed-by-other-key")), "bad-signature"));
test("trusted key replaced by an attacker key -> bad-signature", () =>
    assert.equal(code(() => run("good", { keys: [{ kid: FX.kid, pub: FX.otherPub }] })), "bad-signature"));
test("no keys configured -> no-keys (fails closed)", () => assert.equal(code(() => run("good", { keys: [] })), "no-keys"));
test("a pub embedded in the sig file is NEVER trusted for a configured repo", () => {
    const sf = JSON.parse(new TextDecoder().decode(load("signed-by-other-key", "store.json.sig")));
    assert.ok(sf.pub && sf.pub !== FX.pub);                       // attacker advertises its own key...
    assert.equal(code(() => run("signed-by-other-key")), "bad-signature");   // ...and it is ignored
});

for (const [dir, expectCode] of [["schema1", "schema"], ["seq0", "bad-manifest"], ["seq-float", "bad-manifest"],
    ["expires-before-issued", "bad-manifest"], ["shard-traversal", "bad-manifest"], ["shard-bad-sha", "bad-manifest"], ["shard-huge", "bad-manifest"]])
    test(`validly-signed but malformed manifest rejected: ${dir}`, () => assert.equal(code(() => run(dir)), expectCode));

test("rollback protection", () => {
    assert.equal(code(() => run("good", { state: { seq: 11 } })), "rollback");
    assert.equal(run("good", { state: { seq: 10, msha: sha256(load("good", "store.json")) } }).manifest.seq, 10);   // same bytes again: fine
    assert.equal(code(() => run("good", { state: { seq: 10, msha: "0".repeat(64) } })), "seq-reuse");               // same seq, different content
    assert.equal(run("good", { state: { seq: 9, msha: "0".repeat(64) } }).manifest.seq, 10);                          // newer: fine
});

test("oversized manifest refused before parsing", () =>
    assert.equal(code(() => run("good", { manifestBytes: new Uint8Array(MAX.manifest + 1) })), "too-large"));
test("garbage signature file", () => assert.equal(code(() => run("good", { sigBytes: new TextEncoder().encode("{") })), "bad-sig-file"));

// ---- shards / covers / packages from the real build
const good = JSON.parse(readFileSync(join(fxDir, "good/store.json"), "utf8"));
const read = rel => new Uint8Array(readFileSync(join(fxDir, "good", rel)));

test("real shards verify and parse", () => {
    const t = checkShard(good, "themepacks-other", read(good.shards["themepacks-other"].p), sha256);
    assert.equal(t.kind, "themepacks"); assert.ok(t.items.length >= 30);
    assert.equal(checkShard(good, "widgets-other", read(good.shards["widgets-other"].p), sha256).items.length, 1);
});
test("flipped shard byte -> hash", () => {
    const b = read(good.shards["themepacks-other"].p); b[20] ^= 1;
    assert.equal(code(() => checkShard(good, "themepacks-other", b, sha256)), "hash");
});
test("truncated / padded shard -> hash", () => {
    const b = read(good.shards["themepacks-other"].p);
    assert.equal(code(() => checkShard(good, "themepacks-other", b.slice(0, -1), sha256)), "hash");
    assert.equal(code(() => checkShard(good, "themepacks-other", new Uint8Array([...b, 32]), sha256)), "hash");
});
test("shard whose items lie (right hash, bad content) -> bad-shard", () => {
    const mk = (items, name = "widgets-clock", extra = {}) => {
        const b = new TextEncoder().encode(JSON.stringify({ schema: 2, kind: name.split("-")[0], catalog: name.split("-")[1], items, ...extra }));
        return [{ shards: { [name]: { p: "i/x.json", sha256: sha256(b), s: b.length, n: items.length } } }, b];
    };
    const ok = { id: "a.b", n: "N", v: "1.0.0", c: "clock", f: "w/a.b.0123456789abcdef.gwcw", s: 10, h: "a".repeat(32), cv: null, perm: ["none"], en: "widget.js", td: "c".repeat(64) };
    const [m0, b0] = mk([ok]); assert.equal(checkShard(m0, "widgets-clock", b0, sha256).items.length, 1);
    for (const bad of [{ ...ok, f: "w/../../x" }, { ...ok, f: "t/a.b.gwct" }, { ...ok, f: "https://evil/x" }, { ...ok, h: "short" },
        { ...ok, s: MAX.package + 1 }, { ...ok, s: 0 }, { ...ok, id: "../x" }, { ...ok, cv: "c/../x.jpg" }, { ...ok, cv: "c/" + "b".repeat(32) + ".png" },
        { ...ok, c: "system" }, { ...ok, perm: undefined }, { ...ok, perm: [] }, { ...ok, perm: ["none", "network"] }, { ...ok, perm: ["fs-read:../x"] },
        { ...ok, perm: ["rm -rf"] }, { ...ok, en: "" }, { ...ok, td: "zz" }, { ...ok, ch: "nightly" }, { ...ok, sg: { k: "a b", s: "AAAA" } }, { ...ok, sg: { k: "k", s: "AAAA" } }]) {
        const [m, b] = mk([bad]); assert.equal(code(() => checkShard(m, "widgets-clock", b, sha256)), "bad-shard", JSON.stringify(bad));
    }
    const [m, b] = mk([ok, ok]); assert.equal(code(() => checkShard(m, "widgets-clock", b, sha256)), "bad-shard");   // duplicate id
    const [m2, b2] = mk([ok], "widgets-clock", { catalog: "system" }); assert.equal(code(() => checkShard(m2, "widgets-clock", b2, sha256)), "bad-shard");   // inside != name
});

test("real covers verify; any change fails; name must be the content hash", () => {
    const covers = readdirSync(join(fxDir, "good/c"));
    assert.ok(covers.length > 5);
    for (const f of covers) checkCover(`c/${f}`, read(`c/${f}`), sha256);
    const f = covers[0], b = read(`c/${f}`); b[b.length - 3] ^= 1;
    assert.equal(code(() => checkCover(`c/${f}`, b, sha256)), "hash");
    assert.equal(code(() => checkCover(`c/${covers[1]}`, read(`c/${f}`), sha256)), "hash");        // swapped cover
    const fake = new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x3e, 1, 2, 3]);                           // an SVG with the "right" name
    assert.equal(code(() => checkCover(`c/${sha256(fake).slice(0, 32)}.jpg`, fake, sha256)), "not-jpeg");
    assert.equal(code(() => checkCover("c/short.jpg", b, sha256)), "bad-path");
});

test("real packages verify; flipped bit fails", () => {
    const items = checkShard(good, "themepacks-other", read(good.shards["themepacks-other"].p), sha256).items;
    for (const it of items) checkPackage(it, read(it.f), sha256);
    const it = items[0], b = read(it.f); b[5] ^= 1;
    assert.equal(code(() => checkPackage(it, b, sha256)), "hash");
    assert.equal(code(() => checkPackage({ ...it, s: it.s + 1 }, read(it.f), sha256)), "hash");
});

test("path allowlist", () => {
    for (const ok of ["c/" + "a".repeat(32) + ".jpg", "i/widgets.0123.json", "w/a.b.c.gwcw", "t/x-y_z.gwct"]) assert.ok(REL_OK.test(ok), ok);
    for (const bad of ["c/..", "c/.", "i/../x", "w/.hidden", "c/a/b", "/etc/passwd", "x/y", "w/", "w/a b", "w/a%2fb", "w/a\\b", "https://x/y", "w/a\n"])
        assert.ok(!REL_OK.test(bad), JSON.stringify(bad));
});

test("assertInstallable: id/version mismatch and api-version", () => {
    const api = md => (md["api-version"] === 2 ? { ok: true } : { ok: false, reason: "api too new/old" });
    const md = { id: "a.b", version: "1.0.0", "api-version": 2 };
    assertInstallable(md, { id: "a.b", version: "1.0.0" }, api);
    assertInstallable(md, null, api);                                                // from a file: no listing to match
    assert.equal(code(() => assertInstallable(md, { id: "victim.widget", version: "1.0.0" }, api)), "id-mismatch");
    assert.equal(code(() => assertInstallable(md, { id: "a.b", version: "9.9.9" }, api)), "version-mismatch");
    assert.throws(() => assertInstallable({ ...md, "api-version": 3 }, null, api), /api too/);
});

test("findUpdates: newer / republish yes, downgrade no, files ignored", () => {
    const inst = { a: { src: "store", v: "1.2.0", h: "x" }, b: { src: "store", v: "1.2.0", h: "x" }, c: { src: "store", v: "1.2.0", h: "x" },
        d: { src: "file", v: "1.0.0", h: "x" }, e: { src: "store", v: "1.2.0", h: "same" }, f: { src: "store", h: "x" } };
    const items = [{ id: "a", v: "1.3.0", h: "y" }, { id: "b", v: "1.2.0", h: "y" }, { id: "c", v: "1.1.9", h: "y" },
        { id: "d", v: "9.0.0", h: "y" }, { id: "e", v: "1.2.0", h: "same" }, { id: "f", v: "0.1.0", h: "y" }, { id: "g", v: "1.0.0", h: "y" }];
    assert.deepEqual(findUpdates(inst, items), ["a", "b", "f"]);
});

test("semver", () => {
    const L = [["1.0.0", "1.0.1", -1], ["1.10.0", "1.9.0", 1], ["1.0", "1.0.0", 0], ["1.0.0-beta", "1.0.0", -1], ["1.0.0-beta.2", "1.0.0-beta.10", -1],
        ["1.0.0-1", "1.0.0-a", -1], ["2", "1.99.99", 1], ["1.0.0+build", "1.0.0", 0]];
    for (const [a, b, e] of L) assert.equal(cmpVersion(a, b), e, `${a} vs ${b}`);
    assert.equal(cmpVersion("latest", "1.0.0"), null);
});

test("base64 / hex helpers match Node's", () => {
    for (const n of [1, 2, 3, 4, 31, 32, 33, 64, 255]) {
        const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
        assert.equal(b64encode(b), Buffer.from(b).toString("base64"));
        assert.deepEqual([...b64decode(Buffer.from(b).toString("base64"))], [...b]);
    }
    for (const bad of ["", "abc", "ab=c", "a===", "ab cd", "ab-_", "====", "ab\ncd"]) assert.throws(() => b64decode(bad), /base64/, JSON.stringify(bad));
    assert.deepEqual([...hexToBytes("00ff10")], [0, 255, 16]);
    assert.throws(() => hexToBytes("0g"));
});

test("fingerprint + offered-key description match Python's", () => {
    const sig = load("good", "store.json.sig");
    const d = describeOfferedKey(sig, sha256);
    assert.equal(d.kid, FX.kid); assert.equal(d.pub, FX.pub); assert.equal(d.fingerprint, FX.fingerprint);
    assert.equal(parseSigFile(sig).sig.length, 64);
    const noPub = JSON.parse(new TextDecoder().decode(sig)); delete noPub.pub;
    assert.equal(code(() => describeOfferedKey(new TextEncoder().encode(JSON.stringify(noPub)), sha256)), "no-pub");
});

test("revoked[]: valid list accepted, every malformed shape rejected (even when validly signed)", () => {
    const r = run("revoked");
    assert.equal(r.manifest.revoked.length, 2);
    for (const bad of ["revoked-badkind", "revoked-badid", "revoked-badh", "revoked-noreason", "revoked-longreason", "revoked-toomany", "revoked-notlist"])
        assert.equal(code(() => run(bad)), "bad-manifest", bad);
});

test("findRevoked: exact build vs whole id, repo filtering is the caller's job, files/unknown ignored, deduped", () => {
    const rev = [{ kind: "widgets", id: "a.b", reason: "all builds" }, { kind: "widgets", id: "c.d", h: "1".repeat(32), reason: "one build" },
        { kind: "themepacks", id: "p-x", reason: "pack" }, { kind: "widgets", id: "a.b", h: "2".repeat(32), reason: "dup id" },
        { kind: "widgets", id: "e.f", reason: "file import" }, { kind: "widgets", id: "g.h", reason: "not installed" }];
    const inst = { widgets: { "a.b": { src: "store", h: "9".repeat(32) }, "c.d": { src: "store", h: "1".repeat(32) }, "e.f": { src: "file" } },
        themepacks: { "p-x": { src: "store", h: "3".repeat(32) } } };
    assert.deepEqual(findRevoked(rev, inst).map(x => `${x.kind}/${x.id}`).sort(), ["themepacks/p-x", "widgets/a.b", "widgets/c.d"]);
    inst.widgets["c.d"].h = "8".repeat(32);                                   // a DIFFERENT build of c.d is installed: not affected
    assert.deepEqual(findRevoked(rev, inst).map(x => x.id).sort(), ["a.b", "p-x"]);
    assert.deepEqual(findRevoked(undefined, inst), []);
    assert.deepEqual(findRevoked(rev, {}), []);
});
