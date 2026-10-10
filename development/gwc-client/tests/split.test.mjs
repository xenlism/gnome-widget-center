// Version 2 widget packages (.gwcw metadata + raw .gwcp zip): the JS verifier against a REAL signed build from gwc-store.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX, TrustError, assertPackageBinding, checkAuthor, checkManifest, checkPackage, checkPackageZip, checkShard, treeDigest } from "../lib/store/integrity.js";
import { readZip } from "../lib/store/zipCore.js";

const here = dirname(fileURLToPath(import.meta.url));
const storeDir = process.env.GWC_STORE_DIR ? resolve(process.cwd(), process.env.GWC_STORE_DIR) : resolve(here, "../../gwc-store");
const fxDir = mkdtempSync(join(tmpdir(), "gwcfx-split-"));
execFileSync("python3", [join(storeDir, "tests/make_client_fixtures.py"), fxDir], { stdio: "pipe" });
const FX = JSON.parse(readFileSync(join(fxDir, "fixtures.json"), "utf8"));

const sha256 = u => createHash("sha256").update(u).digest("hex");
const sha512 = u => new Uint8Array(createHash("sha512").update(u).digest());
const load = f => new Uint8Array(readFileSync(join(fxDir, "big", f)));
const codec = { inflate: (u8, max) => new Uint8Array(zlib.inflateRawSync(u8, { maxOutputLength: max ?? 64 << 20 })), deflate: u => new Uint8Array(zlib.deflateRawSync(u)) };
const code = f => { try { f(); } catch (e) { assert.ok(e instanceof TrustError, `expected TrustError, got ${e}`); return e.code; } assert.fail("did not throw"); };

const M = checkManifest({ manifestBytes: load("store.json"), sigBytes: load("store.json.sig"), keys: [ { kid: FX.kid, pub: FX.pub } ], now: Date.parse("2026-10-08T00:00:00Z"), sha512, sha256 }).manifest;
const shardBytes = load(M.shards["widgets-clock"].p);
const shard = () => checkShard(M, "widgets-clock", shardBytes, sha256);
const big = () => shard().items.find(i => i.id === "alice.big");
/** the same shard with `mutate(item)` applied, re-hashed so only the schema check can object */
const mutated = mutate => {
    const s = JSON.parse(new TextDecoder().decode(shardBytes)); mutate(s.items.find(i => i.id === "alice.big"));
    const b = new TextEncoder().encode(JSON.stringify(s));
    return () => checkShard({ shards: { "widgets-clock": { s: b.length, sha256: sha256(b) } } }, "widgets-clock", b, sha256);
};

test("the shard of a real build with a >4 MiB widget passes the client's schema; the item carries z / zs / zh", () => {
    const it = big();
    assert.ok(it.z.startsWith("w/") && it.z.endsWith(".gwcp") && it.zs > 4 * 1024 * 1024 && /^[0-9a-f]{32}$/.test(it.zh));
    assert.ok(it.s < MAX.meta, "f/s/h describe the small .gwcw");
    assert.ok(shard().items.some(i => i.z === undefined), "the other widgets stay version 1");
});

test("a malformed z / zs / zh is refused", () => {
    assert.equal(code(mutated(i => { delete i.zh; })), "bad-shard");
    assert.equal(code(mutated(i => { delete i.zs; })), "bad-shard");
    assert.equal(code(mutated(i => { i.z = "w/x.gwcw"; })), "bad-shard");              // not a .gwcp
    assert.equal(code(mutated(i => { i.z = "t/x.gwcp"; })), "bad-shard");              // wrong folder
    assert.equal(code(mutated(i => { i.z = "w/../x.gwcp"; })), "bad-shard");
    assert.equal(code(mutated(i => { i.zs = MAX.packageBig + 1; })), "bad-shard");
    assert.equal(code(mutated(i => { i.zs = 0; })), "bad-shard");
    assert.equal(code(mutated(i => { i.zh = "zz"; })), "bad-shard");
    assert.equal(code(mutated(i => { i.s = MAX.meta + 1; })), "bad-shard");            // the .gwcw of a v2 item is metadata only
});

test("checkPackage covers the .gwcw, checkPackageZip the raw zip; a changed byte is refused", () => {
    const it = big(), g = load(it.f), z = load(it.z);
    checkPackage(it, g, sha256); checkPackageZip(it, z, sha256);
    const bad = new Uint8Array(z); bad[bad.length >> 1] ^= 1;
    assert.equal(code(() => checkPackageZip(it, bad, sha256)), "hash");
    assert.equal(code(() => checkPackageZip(it, z.slice(0, -1), sha256)), "hash");
    assert.equal(code(() => checkPackageZip({ ...it, z: undefined }, z, sha256)), "hash");
});

test("the .gwcw names the zip; the zip unpacks; the tree digest and the author signature (made in Python) match", () => {
    const it = big(), g = JSON.parse(new TextDecoder().decode(load(it.f))), z = load(it.z);
    assert.equal(g.version, 2); assert.equal(g.package.encoding, "zip"); assert.equal(g.package.data, undefined);
    assert.equal(g.package.file, it.z.split("/").pop());
    assert.equal(g.package.size, z.length); assert.equal(g.package.sha256, sha256(z));
    const entries = readZip(z, codec, { maxEntries: 500, maxTotal: 128 << 20, maxFile: 16 << 20, maxRatio: 200 });
    assert.deepEqual(entries.map(e => e.name).sort(), g.package.files.slice().sort());
    assert.equal(treeDigest(entries, sha256), it.td);
    assertPackageBinding(g.metadata, entries, it, sha256);
    assert.equal(checkAuthor(it, M, { sha512, sha256 }).status, "verified");
});

test("a v2 package of this size cannot be installed under the version 1 unpack limits only when it unpacks past them", () => {
    const z = load(big().z), tight = { maxEntries: 500, maxTotal: 1024, maxFile: 1024, maxRatio: 200 };
    assert.throws(() => readZip(z, codec, tight), /too large/);
});
