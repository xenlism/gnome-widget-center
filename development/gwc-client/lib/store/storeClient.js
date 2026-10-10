// storeClient.js - the only code that touches the network. All TRUST decisions live in integrity.js
// (pure, unit-tested); this file does I/O, caching and request budgeting. Request budget:
//   within TTL ............ 0 requests
//   TTL expired, no change  1 request  (store.json, If-None-Match -> 304, ~0 body bytes)
//   changed ............... 2 (store.json + store.json.sig) + 1 per shard actually opened
//   cover / package ....... 1 each, only when seen / installed, then served from disk forever
//   category shard ........ 1 each, only when that category is opened; the tiny "search" shard serves search + id lookup
//   mirrors ............... tried only when the primary fails (network error, 404, 5xx, or bytes that fail verification); content is hash-verified whichever
//                           base served it, so a mirror can be unavailable but never wrong
// No GitHub API, no raw.githubusercontent.com: Pages static files only.
//
// Chain of trust:  embedded/pinned public key -> store.json(.sig) -> shard sha256 -> item hash -> package/cover
//                  (+ widget author key -> package, see integrity.js checkAuthor / assertPackageBinding)
// Every byte that comes from the network OR from the disk cache is re-verified before it is used.
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Soup from "gi://Soup?version=3.0";

import { readBytesFileAsync, writeBytesFileAsync } from "../fsUtils.js";
import {
    COVER_REL, MAX, REL_OK, TrustError, checkCover, checkManifest, checkPackage, checkShard, describeOfferedKey,
    findRevoked, findUpdates as _findUpdates, searchEntries, visibleIn, checkPackageZip,
} from "./integrity.js";
import { OFFICIAL_KEYS, normalizeRepoUrl } from "./repoConfig.js";
import { sha256, sha512 } from "./hashes.js";

Gio._promisify(Soup.Session.prototype, "send_async", "send_finish");
Gio._promisify(Gio.InputStream.prototype, "read_bytes_async", "read_bytes_finish");

export class HttpError extends Error { constructor(status) { super(`HTTP ${status}`); this.name = "HttpError"; this.status = status; } }

/** The store was republished while the user was looking at it: what they confirmed no longer exists under that name. */
export class StoreChangedError extends Error {
    constructor(newItem) {
        super(newItem ? "The store was updated while you were installing" : "This item is no longer available in the store");
        this.name = "StoreChangedError"; this.newItem = newItem;
    }
}

const MAX_PARALLEL = 4;
const FAIL_BACKOFF_MS = 15 * 60 * 1000;
const CACHE_LIMIT = 64 * 1024 * 1024;
const CHUNK = 64 * 1024;

const enc = s => new TextEncoder().encode(s);

export class StoreClient {
    /** @param repo { url, official?, keys?: [{kid, pub}] }  official repos use the keys embedded in the extension. */
    constructor(repo, { intervalHours = 12, channel = "stable" } = {}) {
        this.repo = repo;
        this.channel = channel === "beta" ? "beta" : "stable";
        this.mirrors = [];                  // from the VERIFIED manifest (never from the network directly)
        this._good = null;                  // base that answered last: tried first next time
        this.base = normalizeRepoUrl(repo.url);
        const uri = GLib.Uri.parse(this.base, GLib.UriFlags.NONE);
        this.host = uri.get_host(); this.scheme = uri.get_scheme();
        this.keys = repo.official ? OFFICIAL_KEYS : (repo.keys ?? []);
        this.intervalMs = intervalHours * 3600 * 1000;
        const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, this.base, -1).slice(0, 10);
        this.dir = GLib.build_filenamev([ GLib.get_user_cache_dir(), "gnome-widget-center", "store", key ]);
        this._primary = { base: this.base, host: this.host, scheme: this.scheme };
        this._session = new Soup.Session({ user_agent: "gnome-widget-center-store/2", timeout: 20 });
        this._inflight = new Map();      // dedupe identical concurrent requests
        this._slots = MAX_PARALLEL; this._queue = [];
        this._cached = null;             // last VERIFIED manifest result
        this._shardMem = new Map();      // sha256 -> verified shard
        this._coverOk = new Set();       // cover rel paths verified this session
    }

    // ---------- local cache ----------
    _p(rel) { return GLib.build_filenamev([ this.dir, ...rel.split("/") ]); }
    async _read(rel) { try { return await readBytesFileAsync(this._p(rel)); } catch (_e) { return null; } }
    async _write(rel, bytes) {
        GLib.mkdir_with_parents(GLib.path_get_dirname(this._p(rel)), 0o755);
        await writeBytesFileAsync(this._p(rel), bytes);   // GIO replace_contents: temp file + rename
    }
    async _json(rel) { const b = await this._read(rel); try { return b ? JSON.parse(new TextDecoder().decode(b)) : null; } catch (_e) { return null; } }
    async _setState(patch) {
        const st = { ...((await this._json("state.json")) ?? {}), ...patch };
        await this._write("state.json", enc(JSON.stringify(st)));
        return st;
    }

    // ---------- network (bounded) ----------
    async _acquire() { if (this._slots > 0) { this._slots--; return; } await new Promise(r => this._queue.push(r)); }
    _release() { const n = this._queue.shift(); if (n) n(); else this._slots++; }

    /** the primary base first, then the signed mirrors; whichever answered last goes to the front */
    _bases() {
        const list = [ this._primary ];
        for (const u of this.mirrors) {
            try { const p = GLib.Uri.parse(u, GLib.UriFlags.NONE); if (p.get_scheme() === "https" && p.get_host()) list.push({ base: u, host: p.get_host(), scheme: "https" }); } catch (_e) { /* bad mirror: ignore */ }
        }
        const i = list.findIndex(b => b.base === this._good);
        return i > 0 ? [ list[i], ...list.slice(0, i), ...list.slice(i + 1) ] : list;
    }

    /** GET b.base+rel. The DECODED body is read in chunks and abandoned the moment it exceeds `max` (no gzip bombs). */
    async _getFrom(b, rel, { headers = {}, max = MAX.shard } = {}) {
        const msg = Soup.Message.new("GET", b.base + rel);
        const h = msg.get_request_headers();
        for (const [ k, v ] of Object.entries(headers)) h.append(k, v);
        const cancel = new Gio.Cancellable();
        await this._acquire();
        let stream = null;
        try {
            stream = await this._session.send_async(msg, GLib.PRIORITY_DEFAULT, cancel);
            const u = msg.get_uri();                                    // after redirects: must still be THIS base's origin
            if (u.get_host() !== b.host || u.get_scheme() !== b.scheme) throw new Error("redirected to another origin");
            const status = msg.status_code, etag = msg.get_response_headers().get_one("ETag");
            if (status !== 200) return { status, bytes: new Uint8Array(0), etag };   // 304, 404, ...: no body needed
            const chunks = []; let total = 0;
            for (;;) {
                const c = await stream.read_bytes_async(CHUNK, GLib.PRIORITY_DEFAULT, cancel);
                const n = c.get_size();
                if (n === 0) break;
                total += n;
                if (total > max) { cancel.cancel(); throw new Error("response too large"); }
                chunks.push(c.toArray());
            }
            const out = new Uint8Array(total); let o = 0;
            for (const c of chunks) { out.set(c, o); o += c.length; }
            return { status, bytes: out, etag };
        } finally {
            try { stream?.close(null); } catch (_e) { /* already closed / cancelled */ }
            this._release();
        }
    }

    /**
     * GET rel from the first base that answers 200/304 AND (when `verify` is given) whose bytes pass it.
     * Non-2xx, network errors and bytes that fail `verify` all fall through to the next base: a mirror can be unavailable
     * or wrong, but it can neither poison the cache nor keep blocking a healthy primary. `_good` (the base tried first next
     * time) is only set for a base that actually delivered verified bytes. verify(bytes) returns the value placed in r.value.
     */
    async _get(rel, { verify = null, ...opts } = {}) {
        let lastResp = null, lastErr = null, trustErr = null;
        for (const b of this._bases()) {
            try {
                const r = await this._getFrom(b, rel, opts);
                if (r.status === 200 || r.status === 304) {
                    if (verify && r.status === 200) r.value = verify(r.bytes);          // throws TrustError: this base is skipped
                    this._good = b.base; return r;
                }
                lastResp = r;
            } catch (e) { if (e instanceof TrustError) trustErr ??= e; else lastErr = e; }
        }
        if (trustErr) throw trustErr;           // someone served bytes that failed verification: say that, not "HTTP 404"
        if (lastResp) return lastResp;          // e.g. 404 everywhere: the caller decides (stale manifest -> refresh + retry)
        throw lastErr;
    }

    _once(key, fn) {
        if (!this._inflight.has(key)) this._inflight.set(key, fn().finally(() => this._inflight.delete(key)));
        return this._inflight.get(key);
    }

    // ---------- manifest ----------
    _verify(manifestBytes, sigBytes, st) {
        return checkManifest({ manifestBytes, sigBytes, keys: this.keys, state: { seq: st.seq, msha: st.msha },
            now: Date.now(), sha512, sha256, official: !!this.repo.official });
    }
    _adopt(v) { this._cached = v; this.mirrors = v.manifest.mirrors ?? []; return v; }
    async _loadCached(st) {
        const [ m, s ] = [ await this._read("store.json"), await this._read("store.json.sig") ];
        if (!m || !s) return null;
        try { return this._verify(m, s, st); } catch (_e) { return null; }   // corrupt / tampered cache -> refetch
    }
    _result(v, extra) {
        return { manifest: v.manifest, tier: v.tier, expired: Date.now() > Date.parse(v.manifest.expires), stale: false, changed: false, ...extra };
    }

    /**
     * The "update database". Returns { manifest, stale, changed, expired, error? }.
     *  stale   = could not refresh (offline, or the refresh was REFUSED: bad signature / rollback) -> cached copy used
     *  expired = signed `expires` date has passed (repo not republished): browsing is fine, installs should warn
     */
    getManifest({ force = false } = {}) {
        return this._once("manifest", async () => {
            const st = (await this._json("state.json")) ?? {};
            const cached = this._cached ?? await this._loadCached(st);
            if (cached) this._adopt(cached);
            const fresh = cached && st.checkedAt && (Date.now() - st.checkedAt) < this.intervalMs;
            if (fresh && !force) return this._result(cached);
            try {
                const got = await this._fetchManifest(cached, st);
                if (got.notModified) {
                    await this._setState({ checkedAt: Date.now() });
                    return this._result(cached);
                }
                const { r, s, v } = got;
                const changed = !cached || cached.msha !== v.msha;
                if (changed) { await this._write("store.json", r.bytes); await this._write("store.json.sig", s.bytes); }
                await this._setState({ checkedAt: Date.now(), etag: r.etag ?? null, seq: v.manifest.seq, msha: v.msha, error: null });
                this._adopt(v);
                if (changed) this._gc().catch(() => {});
                return this._result(v, { changed });
            } catch (e) {
                if (!cached) throw e;                                       // nothing trustworthy to fall back on
                await this._setState({ checkedAt: Date.now() - this.intervalMs + FAIL_BACKOFF_MS, error: String(e.message) }); // retry in ~15 min
                return this._result(this._adopt(cached), { stale: true, error: e.message, refused: e instanceof TrustError });
            }
        });
    }

    /** store.json + its .sig from the SAME base (a mirror mid-sync could pair two revisions). A base that fails verification is skipped. */
    async _fetchManifest(cached, st) {
        let trustErr = null, lastErr = null;
        for (const b of this._bases()) {
            try {
                const r = await this._getFrom(b, "store.json", { max: MAX.manifest, headers: cached && st.etag ? { "If-None-Match": st.etag } : {} });
                if (r.status === 304 && cached) { this._good = b.base; return { notModified: true }; }
                if (r.status !== 200) { lastErr = new HttpError(r.status); continue; }
                const s = await this._getFrom(b, "store.json.sig", { max: MAX.sig });
                if (s.status !== 200) { lastErr = new Error(`signature file: HTTP ${s.status}`); continue; }
                const v = this._verify(r.bytes, s.bytes, st);               // throws TrustError: nothing below runs
                this._good = b.base;
                return { r, s, v };
            } catch (e) { if (e instanceof TrustError) trustErr ??= e; else lastErr = e; }
        }
        throw trustErr ?? lastErr ?? new Error("no store reachable");
    }

    /** First contact with an unknown repo: which key does it claim to sign with? (shown as a fingerprint, user decides) */
    async probeKey() {
        const r = await this._getFrom(this._primary, "store.json.sig", { max: MAX.sig });   // unknown repo: its own host only
        if (r.status !== 200) throw new HttpError(r.status);
        return describeOfferedKey(r.bytes, sha256);
    }

    /**
     * A shard by its manifest name: "widgets-clock", "themepacks-dark" or "search". Immutable by filename AND verified
     * against the signed manifest, also when read from disk.
     */
    async getShard(name, _retried = false) {
        try { return await this._getShard(name); } catch (e) {
            // 404 = our manifest is older than the server (CDN/Pages cache): refresh it once, resolve the shard path again
            if (e instanceof HttpError && e.status === 404 && !_retried) { await this.getManifest({ force: true }); return this.getShard(name, true); }
            throw e;
        }
    }

    async _getShard(name) {
        const { manifest } = await this.getManifest();
        const d = manifest.shards[name];
        if (!d) return { items: [] };
        const mem = this._shardMem.get(d.sha256);
        if (mem) return mem;
        const disk = await this._read(d.p);
        if (disk) { try { const s = checkShard(manifest, name, disk, sha256); this._shardMem.set(d.sha256, s); return s; } catch (_e) { /* bad cache: redownload */ } }
        return this._once(d.p, async () => {
            const r = await this._get(d.p, { max: d.s, verify: b => checkShard(manifest, name, b, sha256) });
            if (r.status !== 200) throw new HttpError(r.status);
            const s = r.value;                                              // verified per base, before anything is cached
            await this._write(d.p, r.bytes);
            this._shardMem.set(d.sha256, s);
            return s;
        });
    }

    /** One category of one kind: ~10 KB, fetched only when the user opens it. */
    getCategory(kind, catalog) { return this.getShard(`${kind}-${catalog}`); }

    /** All items of a kind (every category shard of it), channel-filtered. Cost: one request per category not yet cached. */
    async getAllItems(kind, { channel = this.channel } = {}) {
        const { manifest } = await this.getManifest();
        const names = Object.keys(manifest.shards).filter(n => n.startsWith(`${kind}-`)).sort();
        const shards = await Promise.all(names.map(n => this.getShard(n)));
        return shards.flatMap(sh => sh.items).filter(i => visibleIn(i, channel));
    }

    /** Search entries {id,k,n,c,t,ch?} for a query: needs only the tiny search shard, never a category shard. */
    async search(query, { kind = null, channel = this.channel } = {}) {
        return searchEntries((await this.getShard("search")).items, query, { kind: kind === "widgets" ? "w" : kind === "themepacks" ? "t" : null, channel });
    }

    /** Look one item up by id: search shard -> its category -> that single category shard. null when the store has no such id. */
    async getItem(kind, id) {
        const k = kind === "widgets" ? "w" : "t";
        const hit = (await this.getShard("search")).items.find(e => e.k === k && e.id === id);
        if (!hit) return null;
        return (await this.getShard(`${kind}-${hit.c}`)).items.find(i => i.id === id) ?? null;
    }

    /** Local file path of a verified cover (downloads once). Use Gtk.Picture.set_filename(). */
    async getCoverPath(rel) {
        if (!rel || !COVER_REL.test(rel)) return null;
        if (this._coverOk.has(rel)) return this._p(rel);
        const disk = GLib.file_test(this._p(rel), GLib.FileTest.EXISTS) ? await this._read(rel) : null;
        if (disk) { try { checkCover(rel, disk, sha256); this._coverOk.add(rel); return this._p(rel); } catch (_e) { /* bad cache: redownload */ } }
        await this._once(rel, async () => {
            const r = await this._get(rel, { max: MAX.cover, verify: b => checkCover(rel, b, sha256) });
            if (r.status !== 200) throw new HttpError(r.status);
            await this._write(rel, r.bytes);
        });
        this._coverOk.add(rel);
        return this._p(rel);
    }

    /** Download a package/pack file for an index item (from a verified shard); verifies size + hash. Returns Uint8Array. */
    async download(item, { kind = null } = {}) {
        if (!REL_OK.test(item.f)) throw new Error("bad path in index");
        return this._withRefresh(item, kind, async () => {
            const r = await this._get(item.f, { max: Math.min(item.s, MAX.package), verify: b => checkPackage(item, b, sha256) });
            if (r.status !== 200) throw new HttpError(r.status);
            return r.bytes;
        });
    }

    /** Version 2 widgets: the raw zip (.gwcp) listed next to the .gwcw (item.z / zs / zh); verifies size + hash. Returns Uint8Array. */
    async downloadPackage(item, { kind = null } = {}) {
        if (typeof item.z !== "string" || !REL_OK.test(item.z)) throw new Error("bad path in index");
        return this._withRefresh(item, kind, async () => {
            const r = await this._get(item.z, { max: Math.min(item.zs, MAX.packageBig), verify: b => checkPackageZip(item, b, sha256) });
            if (r.status !== 200) throw new HttpError(r.status);
            return r.bytes;
        });
    }

    /** Run `once`; on a 404 (the store was republished and an old file is gone) refresh the manifest and retry only if the SAME build is still listed. */
    async _withRefresh(item, kind, once) {
        try { return await once(); } catch (e) {
            if (!(e instanceof HttpError && e.status === 404) || !kind) throw e;
            await this.getManifest({ force: true });
            const now = await this.getItem(kind, item.id);
            if (now && now.h === item.h) return once();           // same build is still listed: transient, one more try
            throw new StoreChangedError(now);                     // different/removed: the user must confirm again
        }
    }

    /** Items installed FROM THIS REPO that its signed manifest withdraws (revoked[]). 0 extra requests. */
    async revocations(registry) {
        const { manifest } = await this.getManifest();
        const mine = kind => Object.fromEntries(Object.entries(registry.map(kind)).filter(([ , r ]) => {
            try { return r.src === "store" && normalizeRepoUrl(r.repo) === this.base; } catch (_e) { return false; }
        }));
        return findRevoked(manifest.revoked, { widgets: mine("widgets"), themepacks: mine("themepacks") });
    }

    /** Which installed items are outdated? Pure local compare, 0 requests. Never proposes a downgrade. */
    static findUpdates(installedMap, items) { return _findUpdates(installedMap, items); }

    /** Drop unreferenced shard files and trim covers if cache > limit. Best effort. */
    async _gc() {
        const m = this._cached?.manifest; if (!m) return;
        const keep = new Set(Object.values(m.shards).map(s => s.p));
        const dir = Gio.File.new_for_path(this._p("i"));
        try {
            const en = dir.enumerate_children("standard::name", 0, null);
            for (let i = en.next_file(null); i; i = en.next_file(null))
                if (!keep.has(`i/${i.get_name()}`)) dir.get_child(i.get_name()).delete(null);
        } catch (_e) { /* no shard dir yet */ }
        // covers are tiny; if the cache ever passes the limit, drop the oldest
        const cdir = Gio.File.new_for_path(this._p("c")); const files = []; let total = 0;
        try {
            const en = cdir.enumerate_children("standard::name,standard::size,time::access", 0, null);
            for (let i = en.next_file(null); i; i = en.next_file(null)) {
                files.push({ n: i.get_name(), s: i.get_size(), t: i.get_attribute_uint64("time::access") }); total += i.get_size();
            }
        } catch (_e) { return; }
        files.sort((a, b) => a.t - b.t);
        while (total > CACHE_LIMIT && files.length) { const f = files.shift(); cdir.get_child(f.n).delete(null); total -= f.s; }
    }
}
