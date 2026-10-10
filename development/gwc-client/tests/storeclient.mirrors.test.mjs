// Mirror FAILOVER tests for lib/store/storeClient.js (P2 "mirrors"). Same harness as storeclient.logic.test.mjs: real signed
// fixtures from gwc-store, fake gi:// modules, fake network. Here the fake network has TWO hosts, each with its own behaviour,
// so we can say "primary is down", "primary answers 503", "mirror lies", "mirror is stale" and check what the client does.
//
// What this proves: the control flow (order of bases, what is remembered, what is refused, what is never cached).
// What it does NOT prove: real libsoup behaviour (timeouts, TLS errors, real redirects) - that needs a run on a real GNOME session.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const storeDir = process.env.GWC_STORE_DIR ? resolve(process.cwd(), process.env.GWC_STORE_DIR) : resolve(here, "../../gwc-store");
const mainLib = process.env.GWC_MAIN_LIB ?? resolve(here, "host-stubs");

const root = mkdtempSync(join(tmpdir(), "gwcmirror-m-"));
cpSync(join(here, "../lib"), join(root, "lib"), { recursive: true });
for (const f of [ "fsUtils.js", "apiVersion.js" ]) cpSync(join(mainLib, f), join(root, "lib", f));
writeFileSync(join(root, "package.json"), '{"type":"module"}');
register(pathToFileURL(join(here, "gi-shims/loader.mjs")).href);

const fxDir = mkdtempSync(join(tmpdir(), "gwcfx-m-"));
execFileSync("python3", [ join(storeDir, "tests/make_client_fixtures.py"), fxDir ], { stdio: "pipe" });
const FX = JSON.parse(readFileSync(join(fxDir, "fixtures.json"), "utf8"));
const { StoreClient } = await import(pathToFileURL(join(root, "lib/store/storeClient.js")).href);

const P = "https://repo.test/store/";            // primary (the repo URL the user added)
const M = "https://mirror.test/store/";          // the mirror signed into the "p3" fixture manifest
const KEYS = [ { kid: FX.kid, pub: FX.pub } ];
const sha = u8 => createHash("sha256").update(u8).digest("hex");
const HOUR = 3600e3;

// ---- fake network with one behaviour record per host
//   mode: "ok" | "down" (network error) | <number> (that HTTP status for everything)
//   site: which fixture directory this host serves     over: Map(rel -> response | () => response) wins over everything
let hosts;
const resetHosts = () => { hosts = { [P]: { mode: "ok", site: "p3", over: new Map() }, [M]: { mode: "ok", site: "p3", over: new Map() } }; };
globalThis.__net = {
    calls: [],
    handler: async (url, hdr) => {
        const base = url.startsWith(P) ? P : url.startsWith(M) ? M : null;
        if (!base) return { status: 404 };
        const h = hosts[base], rel = url.slice(base.length);
        if (h.mode === "down") throw new Error("network down");
        if (typeof h.mode === "number") return { status: h.mode };
        if (h.over.has(rel)) { const o = h.over.get(rel); return typeof o === "function" ? o() : o; }
        const f = join(fxDir, h.site, rel);
        if (!existsSync(f)) return { status: 404 };
        const body = new Uint8Array(readFileSync(f)), etag = `"${sha(body)}"`;
        if (hdr["If-None-Match"] === etag) return { status: 304 };
        return { status: 200, body, etag };
    },
};
const all = () => globalThis.__net.calls.slice();
const via = base => all().filter(u => u.startsWith(base)).map(u => u.slice(base.length));
const reset = () => { globalThis.__net.calls.length = 0; };
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;

function env(name) {
    globalThis.__cacheDir = mkdtempSync(join(tmpdir(), `gwccache-m-${name}-`));
    resetHosts(); skew = 0; reset();
    return { mk: () => new StoreClient({ url: P, keys: KEYS }, { intervalHours: 12 }), cache: globalThis.__cacheDir };
}
const cacheFiles = dir => { const out = []; const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name)); }; walk(dir); return out; };
const rejects = (p, re) => assert.rejects(p, e => (re.test(`${e.code ?? ""} ${e.message}`) ? true : assert.fail(`wrong error: ${e.code} ${e.message}`)));

/** a warm cache (verified manifest, mirror list known) + a fresh "process" on top of it. Counters are reset. */
async function warm(name) {
    const e = env(name);
    await e.mk().getManifest();                       // primary healthy: manifest + sig cached, mirror list is inside it
    const c = e.mk();                                 // "new process": only the disk cache survives
    await c.getManifest();                            // inside the TTL: loads + verifies from disk, adopts the mirror list, 0 requests
    assert.deepEqual(all().length, 2, "warm-up itself cost exactly the first manifest fetch");
    reset();
    return { ...e, c };
}
const flip = (bytes, at = 7) => { const b = new Uint8Array(bytes); b[at] ^= 0x55; return b; };   // same length, different content

// ================================================================ the happy path costs nothing extra
test("healthy primary: the mirror is never contacted (manifest, shard, search, item, package)", async () => {
    const { mk } = env("healthy");
    const c = mk();
    await c.getManifest();
    const s = await c.getShard("themepacks-other");
    await c.search("a"); await c.getItem("themepacks", s.items[0].id);
    await c.download(s.items[0]);
    assert.ok(all().length >= 5);
    assert.deepEqual(via(M), [], "no request ever reaches the mirror while the primary answers");
});

// ================================================================ cold start: mirrors are unknown until a manifest is verified
test("cold start with the primary down: fails, and does NOT ask any unsigned mirror (mirror list only comes from a verified manifest)", async () => {
    const { mk } = env("cold");
    hosts[P].mode = "down";
    await rejects(mk().getManifest(), /network down/);
    assert.deepEqual(via(M), [], "nothing is fetched from a host nobody has signed for yet");
});

// ================================================================ failover for every kind of primary failure
for (const mode of [ "down", 404, 500, 503 ]) {
    test(`primary ${mode === "down" ? "unreachable" : "HTTP " + mode}: shard comes from the mirror, verified, cached; the working base is remembered`, async () => {
        const { c, cache } = await warm(`fo-${mode}`);
        hosts[P].mode = mode;
        const s = await c.getShard("themepacks-other");
        assert.ok(s.items.length >= 30);
        const rel = c._cached.manifest.shards["themepacks-other"].p;
        assert.deepEqual(all(), [ P + rel, M + rel ], "primary first, then the mirror, exactly one try each");
        assert.ok(cacheFiles(cache).some(f => f.endsWith(rel.split("/").pop())), "verified bytes are cached");
        reset();
        await c.getShard("widgets-clock");                          // next request: the base that worked goes first
        const r2 = c._cached.manifest.shards["widgets-clock"].p;
        assert.deepEqual(all(), [ M + r2 ], "no pointless retry of the dead primary");
    });
}

test("the remembered mirror loses its place when it fails: primary (recovered) is used again", async () => {
    const { c } = await warm("flipback");
    hosts[P].mode = "down";
    await c.getShard("themepacks-other");                           // -> mirror, now remembered
    hosts[P].mode = "ok"; hosts[M].mode = "down"; reset();
    await c.getShard("widgets-clock");
    const r = c._cached.manifest.shards["widgets-clock"].p;
    assert.deepEqual(all(), [ M + r, P + r ], "mirror (remembered) tried first, fails, primary answers");
    reset();
    await c.getShard("widgets-system");
    assert.deepEqual(via(M), [], "and now the primary is the remembered one again");
});

test("package download and cover come from the mirror when the primary is down, hash-checked", async () => {
    const { c } = await warm("pkg");
    const s = await c.getShard("themepacks-other");
    const item = s.items.find(i => i.cv);
    hosts[P].mode = "down"; reset();
    const bytes = await c.download(item);
    assert.equal(bytes.length, item.s);
    assert.ok(via(M).includes(item.f));
    const p = await c.getCoverPath(item.cv);
    assert.ok(p.endsWith(".jpg")); assert.ok(via(M).includes(item.cv));
});

// ================================================================ nobody answers
test("primary AND mirror down: the error surfaces (never an empty catalogue)", async () => {
    const { c } = await warm("alldown");
    hosts[P].mode = "down"; hosts[M].mode = "down";
    await rejects(c.getShard("themepacks-other"), /network down/);
});

test("primary AND mirror 503: HttpError 503, not 'empty shard'", async () => {
    const { c } = await warm("all503");
    hosts[P].mode = 503; hosts[M].mode = 503;
    await rejects(c.getShard("themepacks-other"), /HTTP 503/);
});

test("404 on every base: one forced manifest refresh, then it fails (no loop)", async () => {
    const { c } = await warm("all404");
    const rel = c._cached.manifest.shards["themepacks-other"].p;
    hosts[P].over.set(rel, { status: 404 }); hosts[M].over.set(rel, { status: 404 });
    await rejects(c.getShard("themepacks-other"), /HTTP 404/);
    assert.equal(via(P).filter(r => r === rel).length, 2, "shard asked twice on the primary (before + after the one refresh)");
    assert.equal(via(M).filter(r => r === rel).length, 2);
    assert.ok(all().length <= 12, `bounded: ${all().length} requests`);
});

// ================================================================ the mirror may be down, never wrong
test("mirror serves a TAMPERED shard while the primary is down: refused, nothing cached", async () => {
    const { c, cache } = await warm("tamper");
    const rel = c._cached.manifest.shards["themepacks-other"].p;
    const good = new Uint8Array(readFileSync(join(fxDir, "p3", rel)));
    hosts[P].mode = "down"; hosts[M].over.set(rel, { status: 200, body: flip(good) });
    const before = cacheFiles(cache).length;
    await rejects(c.getShard("themepacks-other"), /hash|integrity/);
    assert.equal(cacheFiles(cache).length, before, "tampered bytes never reach the disk cache");
});

test("a mirror that lies must not keep blocking once the primary is back (verification failure => try the next base)", async () => {
    const { c, cache } = await warm("liar-recover");
    const rel = c._cached.manifest.shards["themepacks-other"].p;
    const good = new Uint8Array(readFileSync(join(fxDir, "p3", rel)));
    hosts[M].over.set(rel, { status: 200, body: flip(good) });
    hosts[P].mode = "down";
    await rejects(c.getShard("themepacks-other"), /hash|integrity/);   // only the lying mirror is reachable
    hosts[P].mode = "ok"; reset();
    const s = await c.getShard("themepacks-other");                    // primary healthy again
    assert.ok(s.items.length >= 30, "served from the primary, after the mirror's bad bytes were skipped");
    assert.ok(via(P).includes(rel));
    assert.ok(cacheFiles(cache).some(f => f.endsWith(rel.split("/").pop())));
});

test("a lying mirror in FRONT of a healthy primary is skipped within the same request (shard, package, cover)", async () => {
    const { c } = await warm("liar-front");
    const s = await c.getShard("themepacks-other");
    const item = s.items.find(i => i.cv);
    hosts[P].mode = "down"; await c.download(item);                    // makes the mirror the remembered base
    hosts[P].mode = "ok";
    hosts[M].over.set(item.f, { status: 200, body: flip(new Uint8Array(readFileSync(join(fxDir, "p3", item.f)))) });
    hosts[M].over.set(item.cv, { status: 200, body: flip(new Uint8Array(readFileSync(join(fxDir, "p3", item.cv))), 20) });
    reset();
    const bytes = await c.download(item);
    assert.equal(bytes.length, item.s);
    assert.deepEqual(all(), [ M + item.f, P + item.f ], "bad mirror bytes skipped, primary answered, one try each");
    assert.ok((await c.getCoverPath(item.cv)).endsWith(".jpg"));
});

test("when EVERY base serves bad bytes the integrity error is reported (not a generic network error)", async () => {
    const { c } = await warm("liar-all");
    const rel = c._cached.manifest.shards["themepacks-other"].p;
    const bad = { status: 200, body: flip(new Uint8Array(readFileSync(join(fxDir, "p3", rel)))) };
    hosts[P].over.set(rel, bad); hosts[M].over.set(rel, bad);
    await rejects(c.getShard("themepacks-other"), /hash|integrity/);
});

// ================================================================ manifest refresh through a mirror
test("manifest refresh: primary down, mirror has a NEWER signed manifest -> accepted, store.json and .sig from the SAME base", async () => {
    const { c } = await warm("m-newer");
    skew = 13 * HOUR; hosts[P].mode = "down"; hosts[M].site = "p3-newer";
    const r = await c.getManifest();
    assert.equal(r.manifest.seq, 21); assert.equal(r.changed, true); assert.equal(r.stale, false);
    assert.deepEqual(via(M), [ "store.json", "store.json.sig" ]);
});

test("manifest refresh: mirror STALE (older seq) is refused as a rollback; cached copy keeps serving", async () => {
    const e = env("m-stale");
    hosts[P].site = "p3-newer"; await e.mk().getManifest();            // we have seq 21
    skew = 13 * HOUR; hosts[P].mode = "down"; hosts[M].site = "p3";    // mirror still has seq 20
    const r = await e.mk().getManifest();
    assert.equal(r.manifest.seq, 21, "cached newer manifest wins"); assert.equal(r.stale, true); assert.equal(r.refused, true);
    assert.equal(r.changed, false);
});

test("manifest refresh: mirror mid-sync (store.json of one revision + .sig of another) is refused", async () => {
    const { c } = await warm("m-midsync");
    skew = 13 * HOUR; hosts[P].mode = "down";
    hosts[M].site = "p3-newer";
    hosts[M].over.set("store.json.sig", { status: 200, body: new Uint8Array(readFileSync(join(fxDir, "p3", "store.json.sig"))) });  // sig of seq 20
    const r = await c.getManifest();
    assert.equal(r.stale, true); assert.equal(r.refused, true); assert.equal(r.manifest.seq, 20);
});

test("manifest refresh: primary 304 is enough - mirror untouched", async () => {
    const { c } = await warm("m-304");
    skew = 13 * HOUR;
    const r = await c.getManifest();
    assert.equal(r.changed, false); assert.equal(r.stale, false);
    assert.deepEqual(via(P), [ "store.json" ]); assert.deepEqual(via(M), []);
});

test("manifest refresh: primary 503 but mirror 304 (unchanged) -> fresh, not stale", async () => {
    const { c } = await warm("m-mirror304");
    skew = 13 * HOUR; hosts[P].mode = 503;
    const r = await c.getManifest();
    assert.equal(r.changed, false); assert.equal(r.stale, false);
    assert.deepEqual(via(M), [ "store.json" ]);
});

test("manifest refresh: everything down -> cached manifest, stale, retry backoff (no hammering)", async () => {
    const { c } = await warm("m-alldown");
    skew = 13 * HOUR; hosts[P].mode = "down"; hosts[M].mode = "down";
    const r = await c.getManifest();
    assert.equal(r.stale, true); assert.equal(r.manifest.seq, 20);
    reset(); skew = 13 * HOUR + 60e3;
    await c.getManifest();                                              // inside the ~15 min backoff: no new requests
    assert.deepEqual(all(), []);
});

// ================================================================ the mirror cannot redirect us elsewhere
test("mirror redirecting to another origin is refused and treated as that base failing", async () => {
    const { c } = await warm("redir");
    const rel = c._cached.manifest.shards["themepacks-other"].p;
    hosts[P].mode = "down";
    hosts[M].over.set(rel, { status: 200, body: new Uint8Array([1, 2, 3]), finalUrl: "https://evil.test/x" });
    await rejects(c.getShard("themepacks-other"), /redirected to another origin/);
});

test("mirror may redirect within ITS OWN origin (not the primary's), and is still accepted if the bytes verify", async () => {
    const { c } = await warm("redir-own");
    const rel = c._cached.manifest.shards["themepacks-other"].p;
    const good = new Uint8Array(readFileSync(join(fxDir, "p3", rel)));
    hosts[P].mode = "down";
    hosts[M].over.set(rel, { status: 200, body: good, finalUrl: M + "elsewhere/" + rel });
    assert.ok((await c.getShard("themepacks-other")).items.length >= 30);
});

// ================================================================ probeKey stays on the host the user typed
test("probeKey (first contact with an unknown repo) never uses a mirror", async () => {
    const { c } = await warm("probe");
    hosts[P].mode = "down";
    reset();
    await assert.rejects(c.probeKey());
    assert.deepEqual(via(M), []);
});
