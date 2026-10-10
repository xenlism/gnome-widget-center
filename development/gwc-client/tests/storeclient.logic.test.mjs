// LOGIC test of lib/store/storeClient.js in Node with FAKE gi:// modules (tests/gi-shims) and a fake network.
// It proves the control flow (what is requested, cached, verified, refused). It does NOT prove that the real GLib/Gio/Soup
// calls behave as the shims assume - that still needs a run on a real GNOME session (see P0-CHANGES.md).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const storeDir = process.env.GWC_STORE_DIR ? resolve(process.cwd(), process.env.GWC_STORE_DIR) : resolve(here, "../../gwc-store");
const mainLib = process.env.GWC_MAIN_LIB ?? resolve(here, "host-stubs");   // stubs unless pointed at the real extension lib/

// ---- mirror tree: our lib + the two host files it imports (fsUtils, apiVersion) so relative imports resolve
const root = mkdtempSync(join(tmpdir(), "gwcmirror-"));
cpSync(join(here, "../lib"), join(root, "lib"), { recursive: true });
for (const f of ["fsUtils.js", "apiVersion.js"]) cpSync(join(mainLib, f), join(root, "lib", f));
writeFileSync(join(root, "package.json"), '{"type":"module"}');
register(pathToFileURL(join(here, "gi-shims/loader.mjs")).href);

const fxDir = mkdtempSync(join(tmpdir(), "gwcfx2-"));
execFileSync("python3", [join(storeDir, "tests/make_client_fixtures.py"), fxDir], { stdio: "pipe" });
const FX = JSON.parse(readFileSync(join(fxDir, "fixtures.json"), "utf8"));
const { StoreChangedError, StoreClient } = await import(pathToFileURL(join(root, "lib/store/storeClient.js")).href);

const BASE = "https://repo.test/store/";
const KEYS = [{ kid: FX.kid, pub: FX.pub }];
const sha = u8 => createHash("sha256").update(u8).digest("hex");
const HOUR = 3600e3;

// ---- fake server
let site = "good", over = new Map(), offline = false;
globalThis.__net = {
    calls: [],
    handler: async (url, hdr) => {
        if (offline) throw new Error("network down");
        const rel = url.slice(BASE.length);
        if (over.has(rel)) { const o = over.get(rel); return typeof o === "function" ? o() : o; }
        const f = join(fxDir, site, rel);
        if (!url.startsWith(BASE) || !existsSync(f)) return { status: 404 };
        const body = new Uint8Array(readFileSync(f));
        const etag = `"${sha(body)}"`;
        if (hdr["If-None-Match"] === etag) return { status: 304 };
        return { status: 200, body, etag };
    },
};
const calls = () => globalThis.__net.calls.map(u => u.slice(BASE.length));
const reset = () => { globalThis.__net.calls.length = 0; };
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;

function env(name) {
    globalThis.__cacheDir = mkdtempSync(join(tmpdir(), `gwccache-${name}-`));
    site = "good"; over = new Map(); offline = false; skew = 0; reset();
    const mk = (repo = { url: BASE, keys: KEYS }) => new StoreClient(repo, { intervalHours: 12 });
    return { mk, cache: globalThis.__cacheDir };
}
const cacheFiles = dir => { const out = []; const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name)); }; walk(dir); return out; };
const rejects = (p, re) => assert.rejects(p, e => (re.test(`${e.code ?? ""} ${e.message}`) ? true : assert.fail(`wrong error: ${e.code} ${e.message}`)));

test("request budget: first open, then 0 requests inside TTL (even for a new process)", async () => {
    const { mk } = env("budget");
    const c = mk(), r = await c.getManifest();
    assert.equal(r.manifest.seq, 10); assert.equal(r.changed, true); assert.equal(r.stale, false); assert.equal(r.expired, false);
    assert.deepEqual(calls(), ["store.json", "store.json.sig"]);
    const s = await c.getShard("themepacks-other"); assert.ok(s.items.length >= 30);
    assert.equal(calls().length, 3);
    await c.getShard("themepacks-other"); await c.getManifest();
    assert.equal(calls().length, 3, "memory hits cost nothing");
    reset();
    const c2 = mk();                                           // "new process": only the disk cache survives
    assert.equal((await c2.getManifest()).changed, false);
    assert.equal((await c2.getShard("themepacks-other")).items.length, s.items.length);
    assert.deepEqual(calls(), [], "disk cache inside TTL = 0 requests, shard re-verified from disk");
});

test("after TTL: exactly one conditional request, 304", async () => {
    const { mk } = env("ttl");
    const c = mk(); await c.getManifest(); reset(); skew = 13 * HOUR;
    const r = await mk().getManifest();
    assert.deepEqual(calls(), ["store.json"]); assert.equal(r.changed, false); assert.equal(r.stale, false);
});

test("newer signed manifest is accepted; older one is REFUSED (rollback) and the cache keeps serving", async () => {
    const { mk } = env("rollback");
    await mk().getManifest(); skew = 13 * HOUR; site = "newer";
    let r = await mk().getManifest();
    assert.equal(r.manifest.seq, 11); assert.equal(r.changed, true);
    skew = 26 * HOUR; site = "older";                          // attacker / stale CDN replays an old but validly signed manifest
    r = await mk().getManifest();
    assert.equal(r.stale, true); assert.equal(r.refused, true); assert.match(r.error, /backwards/);
    assert.equal(r.manifest.seq, 11, "still serving the newest verified manifest");
});

test("same seq but different bytes is refused", async () => {
    const { mk } = env("seqreuse");
    await mk().getManifest(); skew = 13 * HOUR;
    site = "shard-bad-sha";                                    // validly signed, seq 10, different content
    const r = await mk().getManifest();
    assert.equal(r.refused, true); assert.equal(r.manifest.seq, 10);
});

test("bad signature on refresh: refused, cached copy used, not 'changed'", async () => {
    const { mk } = env("badsig");
    await mk().getManifest(); skew = 13 * HOUR;
    const m = new Uint8Array(readFileSync(join(fxDir, "newer/store.json"))); m[m.length - 4] ^= 1;   // modified manifest, genuine signature
    over.set("store.json", { status: 200, body: m, etag: '"x"' });
    let r = await mk().getManifest();
    assert.equal(r.stale, true); assert.equal(r.refused, true); assert.equal(r.manifest.seq, 10); assert.match(r.error, /signature/);
    over.clear();                                                    // attacker serves a NEWER manifest signed with his own key under our kid
    over.set("store.json", { status: 200, body: new Uint8Array(readFileSync(join(fxDir, "newer/store.json"))), etag: '"y"' });
    over.set("store.json.sig", { status: 200, body: new Uint8Array(readFileSync(join(fxDir, "signed-by-other-key/store.json.sig"))) });
    skew = 26 * HOUR; r = await mk().getManifest();
    assert.equal(r.refused, true); assert.equal(r.manifest.seq, 10); assert.match(r.error, /signature/);
});

test("no cache + bad signature / wrong pinned key / no keys: hard failure (fails closed)", async () => {
    let e = env("hard1"); site = "signed-by-other-key";
    await rejects(e.mk().getManifest(), /bad-signature/);
    e = env("hard2");
    await rejects(e.mk({ url: BASE, keys: [{ kid: FX.kid, pub: FX.otherPub }] }).getManifest(), /bad-signature/);
    e = env("hard3");
    await rejects(e.mk({ url: BASE, official: true }).getManifest(), /no-keys/);          // OFFICIAL_KEYS is empty until you add yours
    await rejects(e.mk({ url: BASE }).getManifest(), /no-keys/);                          // unpinned third-party repo
});

test("offline: cached verified manifest is used (stale); with no cache it throws", async () => {
    const { mk } = env("offline");
    await mk().getManifest(); skew = 13 * HOUR; offline = true; reset();
    const r = await mk().getManifest();
    assert.equal(r.stale, true); assert.equal(r.refused, false); assert.equal(r.manifest.seq, 10);
    skew = 13 * HOUR + 60 * 1000; reset();
    await mk().getManifest(); assert.deepEqual(calls(), [], "15-minute back-off after a failure, not a retry on every open");
    const fresh = env("offline2"); offline = true;
    await rejects(fresh.mk().getManifest(), /network down/);
});

test("expired manifest is flagged for the UI", async () => {
    const { mk } = env("expired"); site = "expired";
    assert.equal((await mk().getManifest()).expired, true);
});

test("tampered cache on disk is detected: manifest, shard, cover", async () => {
    const { mk, cache } = env("poison");
    const c = mk(); const s = await c.getShard("themepacks-other"); const cvRel = s.items.find(i => i.cv).cv; await c.getCoverPath(cvRel);
    const files = cacheFiles(cache);
    const flip = f => { const b = readFileSync(f); b[b.length - 2] ^= 1; writeFileSync(f, b); };
    const sf = files.find(f => /\/i\/themepacks-other/.test(f));          // change one hash character: still perfectly valid JSON, same length
    writeFileSync(sf, readFileSync(sf, "utf8").replace(/"h":"([0-9a-f])/, (_m, ch) => `"h":"${ch === "0" ? "1" : "0"}`));
    flip(files.find(f => f.endsWith(".jpg")));
    reset();
    const c2 = mk();
    const healed = await c2.getShard("themepacks-other");                                         // healed by re-download
    assert.deepEqual(healed.items.map(i => i.h), s.items.map(i => i.h));
    assert.equal((await c2.getCoverPath(cvRel)).endsWith(".jpg"), true);
    assert.ok(calls().some(u => u.startsWith("i/themepacks")) && calls().some(u => u.startsWith("c/")), calls().join());
    flip(files.find(f => f.endsWith("/store.json"))); skew = 13 * HOUR; reset();
    const r = await mk().getManifest();                                                     // corrupt cached manifest: ignored, refetched
    assert.equal(r.manifest.seq, 10); assert.ok(calls().includes("store.json"));
});

test("server serves a tampered shard / cover / package: rejected and never cached", async () => {
    const { mk, cache } = env("srvtamper");
    const c = mk(); await c.getManifest();
    const shardRel = (await c.getManifest()).manifest.shards["themepacks-other"].p;
    const good = new Uint8Array(readFileSync(join(fxDir, "good", shardRel))); const bad = good.slice(); bad[10] ^= 1;
    over.set(shardRel, { status: 200, body: bad });
    await rejects(c.getShard("themepacks-other"), /hash/);
    assert.ok(!cacheFiles(cache).some(f => f.includes("themepacks.")), "bad shard must not be written to the cache");
    over.clear();
    const s = await c.getShard("themepacks-other"); const item = s.items.find(i => i.cv);
    const cv = new Uint8Array(readFileSync(join(fxDir, "good", item.cv))); cv[cv.length - 3] ^= 1;
    over.set(item.cv, { status: 200, body: cv });
    await rejects(c.getCoverPath(item.cv), /hash/);
    assert.ok(!cacheFiles(cache).some(f => f.includes(item.cv.slice(2, 12))));
    const pk = new Uint8Array(readFileSync(join(fxDir, "good", item.f))); pk[3] ^= 1;
    over.set(item.f, { status: 200, body: pk });
    await rejects(c.download(item), /integrity|hash/);
    over.clear();
    assert.equal((await c.download(item)).length, item.s);
});

test("size caps: oversized manifest and a package bigger than its listed size are cut off", async () => {
    let e = env("caps1"); over.set("store.json", { status: 200, body: new Uint8Array(300 * 1024) });
    await rejects(e.mk().getManifest(), /too large/);
    e = env("caps2"); const c = e.mk(); const s = await c.getShard("themepacks-other"); const item = s.items[0];
    over.set(item.f, { status: 200, body: new Uint8Array(item.s + 70000) });
    await rejects(c.download(item), /too large/);
});

test("redirect to another host is refused", async () => {
    const { mk } = env("redir");
    over.set("store.json", { status: 200, body: new Uint8Array(10), finalUrl: "https://evil.test/store.json" });
    await rejects(mk().getManifest(), /another origin/);
    const e2 = env("redir2"); over.set("store.json", { status: 200, body: new Uint8Array(10), finalUrl: "http://repo.test/store/store.json" });
    await rejects(e2.mk().getManifest(), /another origin/);                                   // https -> http downgrade
});

test("probeKey shows the fingerprint a new repo offers (TOFU dialog input)", async () => {
    const { mk } = env("probe");
    const k = await mk({ url: BASE }).probeKey();
    assert.equal(k.kid, FX.kid); assert.equal(k.pub, FX.pub); assert.equal(k.fingerprint, FX.fingerprint);
});

test("404 on a shard is an error, not an empty catalogue", async () => {
    const { mk } = env("e404"); const c = mk(); const m = (await c.getManifest()).manifest;
    over.set(m.shards["themepacks-other"].p, { status: 404 });
    await rejects(c.getShard("themepacks-other"), /HTTP 404/);
});

test("shard 404 (our manifest is older than the server): one forced refresh, then it works", async () => {
    const { mk } = env("r404"); const c = mk(); const m = (await c.getManifest()).manifest; const rel = m.shards["themepacks-other"].p;
    over.set(rel, () => { over.delete(rel); return { status: 404 }; });          // 404 once, like a CDN that has not caught up
    reset();
    const s = await c.getShard("themepacks-other");
    assert.ok(s.items.length >= 30);
    assert.deepEqual(calls(), [rel, "store.json", rel], "shard 404 -> conditional manifest refresh -> shard again");
});

test("shard 404 that persists fails after exactly one retry (no loops)", async () => {
    const { mk } = env("r404b"); const c = mk(); const m = (await c.getManifest()).manifest; const rel = m.shards["themepacks-other"].p;
    over.set(rel, { status: 404 }); reset();
    await rejects(c.getShard("themepacks-other"), /HTTP 404/);
    assert.deepEqual(calls(), [rel, "store.json", rel]);
});

test("download 404 but the same build is still listed: one more try succeeds", async () => {
    const { mk } = env("d404a"); const c = mk(); const item = (await c.getShard("themepacks-other")).items[0];
    over.set(item.f, () => { over.delete(item.f); return { status: 404 }; });
    assert.equal((await c.download(item, { kind: "themepacks" })).length, item.s);
});

test("download 404 because the store republished: StoreChangedError carries the NEW item for re-confirmation", async () => {
    const { mk } = env("d404b"); const c = mk(); const items = (await c.getShard("themepacks-other")).items;
    const item = items.find(i => i.id === FX.firstPack); assert.ok(item);
    site = "changed"; over.set(item.f, { status: 404 });                          // server now publishes seq 12 with a modified pack
    await assert.rejects(c.download(item, { kind: "themepacks" }), e => {
        assert.ok(e instanceof StoreChangedError); assert.ok(e.newItem); assert.notEqual(e.newItem.h, item.h); assert.equal(e.newItem.id, item.id); return true; });
    assert.equal((await c.getManifest()).manifest.seq, 12, "manifest was refreshed (and verified) on the way");
});

test("download 404 because the item was removed: StoreChangedError(null)", async () => {
    const { mk } = env("d404c"); const c = mk(); const item = (await c.getShard("themepacks-other")).items.find(i => i.id === FX.firstPack);
    site = "removed"; over.set(item.f, { status: 404 });
    await assert.rejects(c.download(item, { kind: "themepacks" }), e => e instanceof StoreChangedError && e.newItem === null && /no longer available/.test(e.message));
});

test("download 404 without a kind just fails (no hidden refresh)", async () => {
    const { mk } = env("d404d"); const c = mk(); const item = (await c.getShard("themepacks-other")).items[0];
    over.set(item.f, { status: 404 }); reset();
    await rejects(c.download(item), /HTTP 404/); assert.deepEqual(calls(), [item.f]);
});

test("revocations(): only items installed from THIS repo, exact build rules, 0 extra requests", async () => {
    const { mk } = env("revoke"); site = "revoked"; const c = mk(); await c.getManifest(); reset();
    const reg = data => ({ map: k => data[k] });
    const hits = await c.revocations(reg({
        widgets: { "a.b": { src: "store", repo: BASE, h: "5".repeat(32) }, "z.z": { src: "store", repo: BASE, h: "1".repeat(32) } },
        themepacks: { "pack-x": { src: "store", repo: BASE, h: "a".repeat(32) } } }));
    assert.deepEqual(hits.map(h => `${h.kind}/${h.id}:${h.reason}`).sort(), ["themepacks/pack-x:broken", "widgets/a.b:steals data"]);
    assert.deepEqual(calls(), [], "answered from the verified, cached manifest");
    assert.deepEqual(await c.revocations(reg({ widgets: { "a.b": { src: "store", repo: "https://other.test/x/", h: "5".repeat(32) } }, themepacks: {} })), [], "same id from another repo is not ours to withdraw");
    assert.deepEqual(await c.revocations(reg({ widgets: {}, themepacks: { "pack-x": { src: "store", repo: BASE, h: "b".repeat(32) } } })), [], "a different build of pack-x is not revoked");
    assert.deepEqual(await c.revocations(reg({ widgets: { "a.b": { src: "file", repo: BASE } }, themepacks: {} })), [], "imported files are never matched");
});

// ---- version 2 packages: the raw zip (.gwcp) is its own verified download
test("version 2: .gwcw and raw zip both verified; tampered / oversized zip rejected; 404 handled like download()", async () => {
    const { mk } = env("v2dl"); site = "big";
    const c = mk(); const item = (await c.getShard("widgets-clock")).items.find(i => i.z); assert.ok(item, "fixture has a version 2 widget");
    assert.equal((await c.download(item, { kind: "widgets" })).length, item.s, "the small .gwcw");
    const z = await c.downloadPackage(item, { kind: "widgets" });
    assert.equal(z.length, item.zs); assert.equal(sha(z).slice(0, 32), item.zh);

    const bad = z.slice(); bad[bad.length >> 1] ^= 1;
    over.set(item.z, { status: 200, body: bad });
    await rejects(c.downloadPackage(item), /integrity|hash/);
    over.set(item.z, { status: 200, body: new Uint8Array(item.zs + 70000) });
    await rejects(c.downloadPackage(item), /too large|HTTP 404/);                              // this fixture lists a mirror the fake server does not serve: its 404 may be what is reported
    over.clear();

    over.set(item.z, () => { over.delete(item.z); return { status: 404 }; });                  // transient: same build still listed
    assert.equal((await c.downloadPackage(item, { kind: "widgets" })).length, item.zs);
    over.set(item.z, { status: 404 }); reset();
    await rejects(c.downloadPackage(item), /HTTP 404/);
    assert.ok(calls().includes(item.z) && !calls().includes("store.json"), "no kind: no hidden manifest refresh (a mirror may also have been asked)");
    await rejects(c.downloadPackage({ ...item, z: "../x.gwcp" }), /bad path/);
    await rejects(c.downloadPackage({ ...item, z: undefined }), /bad path/);
});
