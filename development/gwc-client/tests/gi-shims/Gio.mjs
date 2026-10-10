import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
class Cancellable { constructor() { this.c = false; } cancel() { this.c = true; } is_cancelled() { return this.c; } }
class InputStream {}
class File {
    constructor(p) { this.p = p; }
    static new_for_path(p) { return new File(p); }
    query_exists() { return existsSync(this.p); }
    load_contents_async(_c, cb) { queueMicrotask(() => cb(this, { r: readFileSync(this.p) })); }
    load_contents_finish(res) { return [true, res.r]; }
    replace_contents_async(bytes, _e, _b, _f, _c, cb) {                       // like GIO: write temp, then rename
        queueMicrotask(() => { try { const t = this.p + ".tmp"; writeFileSync(t, bytes); renameSync(t, this.p); cb(this, { ok: true }); } catch (e) { cb(this, { err: e }); } });
    }
    replace_contents_finish(res) { if (res.err) throw res.err; return true; }
    get_child(n) { return new File(this.p + "/" + n); }
    delete() { unlinkSync(this.p); }
    enumerate_children() { throw new Error("shim: no directory enumeration"); }
}
export default { Cancellable, InputStream, File, FileCreateFlags: { REPLACE_DESTINATION: 1 }, _promisify() {} };
