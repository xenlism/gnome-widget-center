// gwcFormat.js - .gwcw (widget) and .gwct (theme pack) read / build / install.
//
// .gwcw = JSON, key order fixed so a human (or `head -c 2000`) sees the readable part first:
//   { "format":"gwcw", "version":1,
//     "metadata": { ...exact metadata.json incl. "catalog"... },        <- readable, NOT zipped
//     "cover":    { "mimeType":"image/jpeg", "base64":"..." },          <- readable, NOT zipped (omitted in store files)
//     "package":  { "encoding":"zip+base64","size","sha256","files":[...],"data":"<base64 of zip>" } }
// metadata.json and cover.* are NOT inside the zip: the installer writes them from the plain fields.
//
// version 2 (package > 4 MiB, up to 64 MiB): the same JSON, but the zip is a SEPARATE raw file, the .gwcp, next to it:
//     "package":  { "encoding":"zip","file":"<name>.gwcp","size","sha256","files":[...] }       <- no "data"
// A store lists both (item.f = .gwcw, item.z = .gwcp, each with size + hash in the signed index). Install needs the zip: installGwcw(g, { zip }).
import Gio from "gi://Gio";
import GLib from "gi://GLib";

import { checkApiVersion } from "../apiVersion.js";
import { ID_RE as _ID_RE, MAX, assertInstallable, assertPackageBinding } from "./integrity.js";
import { readZip, writeZip } from "./zipKit.js";

const ID_RE = _ID_RE;
const MAX_FILE_TEXT = 16 * 1024 * 1024;     // a .gwcw/.gwct we are willing to parse at all
const GWCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.gwcp$/;
/** unpack limits for a version 2 package (version 1 keeps DEFAULT_LIMITS: 16 MiB unpacked). Mirrors tools/verify_store.py. */
export const BIG_ZIP_LIMITS = { maxEntries: 500, maxTotal: 128 * 1024 * 1024, maxFile: 16 * 1024 * 1024, maxRatio: 200 };
const COVER_NAMES = [ "cover.png", "cover.jpg", "cover.jpeg" ];
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };
export const widgetsRoot = () => GLib.build_filenamev([ GLib.get_user_data_dir(), "gnome-widget-center", "widgets" ]);
export const themepacksRoot = () => GLib.build_filenamev([ GLib.get_user_config_dir(), "gnome-widget-center", "themepacks" ]);
/** Where the ONE previous version of each updated item is kept (rollback). Deliberately OUTSIDE the live roots: the Shell scans those. */
export const prevRootFor = kind => GLib.build_filenamev([ GLib.get_user_data_dir(), "gnome-widget-center", "prev", kind ]);

const sha256hex = u8 => GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, new GLib.Bytes(u8));
const b64 = u8 => GLib.base64_encode(u8);

// ---------- parse (no unzip needed to preview) ----------
export function parseGwcw(text) {
    if (text.length > MAX_FILE_TEXT) throw new Error("File is too large");
    const d = JSON.parse(text);
    if (d.format !== "gwcw" || (d.version !== 1 && d.version !== 2)) throw new Error("Not a .gwcw file this version understands (needs version 1 or 2)");
    const m = d.metadata;
    if (!m || !ID_RE.test(m.id ?? "") || !m.name || !m.entry) throw new Error("Invalid widget metadata");
    const pkg = d.package;
    if (d.version === 1) {
        if (pkg?.encoding !== "zip+base64" || typeof pkg.data !== "string") throw new Error("Invalid package");
        // sizes are checked BEFORE base64-decoding anything
        if (!Number.isSafeInteger(pkg.size) || pkg.size < 1 || pkg.size > MAX.package) throw new Error("Package size out of range");
        if (pkg.data.length > Math.ceil(pkg.size / 3) * 4 + 4) throw new Error("Package data is larger than its declared size");
    } else {                                                           // version 2: the zip is the separate .gwcp named here
        if (pkg?.encoding !== "zip" || "data" in pkg) throw new Error("Invalid package");
        if (typeof pkg.file !== "string" || !GWCP_NAME.test(pkg.file)) throw new Error("Invalid package file name");
        if (!Number.isSafeInteger(pkg.size) || pkg.size < 1 || pkg.size > MAX.packageBig) throw new Error("Package size out of range");
    }
    if (!/^[0-9a-f]{64}$/.test(pkg.sha256 ?? "")) throw new Error("Invalid package hash");
    return d;
}
export function parseGwct(text) {
    if (text.length > MAX_FILE_TEXT) throw new Error("File is too large");
    const d = JSON.parse(text);
    if (d.format !== "gwct" || !Array.isArray(d.widgets)) throw new Error("Not a .gwct file");
    return d;
}

// ---------- install ----------
function rmrf(file) {
    if (!file.query_exists(null)) return;
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        const en = file.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        for (let i = en.next_file(null); i; i = en.next_file(null)) rmrf(file.get_child(i.get_name()));
    }
    file.delete(null);
}
function writeFile(path, u8) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    Gio.File.new_for_path(path).replace_contents(u8, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

/** The replaced version becomes the rollback copy (best effort: failing to keep it must never fail an update). */
function retainPrev(backup, prevRoot, id, keep) {
    const b = Gio.File.new_for_path(backup);
    if (!b.query_exists(null)) return;
    try {
        if (!keep) throw new Error("not kept");
        GLib.mkdir_with_parents(prevRoot, 0o755);
        const dst = Gio.File.new_for_path(GLib.build_filenamev([ prevRoot, id ]));
        rmrf(dst);
        b.move(dst, Gio.FileCopyFlags.NONE, null, null);
    } catch (_e) { rmrf(b); }
}

/** { version } of the kept previous version, or null. */
export function prevInfo(kind, id, { prevRoot = prevRootFor(kind) } = {}) {
    if (!ID_RE.test(id ?? "")) return null;
    try {
        if (kind === "widgets") {
            const f = Gio.File.new_for_path(GLib.build_filenamev([ prevRoot, id, "metadata.json" ]));
            const md = JSON.parse(new TextDecoder().decode(f.load_contents(null)[1]));
            return md.id === id ? { version: String(md.version) } : null;
        }
        const g = JSON.parse(new TextDecoder().decode(Gio.File.new_for_path(GLib.build_filenamev([ prevRoot, `${id}.gwct` ])).load_contents(null)[1]));
        return g.packMeta?.id === id || g.format === "gwct" ? { version: String(g.packMeta?.version ?? "") } : null;
    } catch (_e) { return null; }
}

/**
 * Swap the live widget with its kept previous version. The swap is symmetric: the version you rolled back FROM becomes the
 * new "previous", so a second call undoes the first. Returns the version now live. Throws when nothing was kept.
 */
export function rollbackWidget(id, { root = widgetsRoot(), prevRoot = prevRootFor("widgets") } = {}) {
    if (!ID_RE.test(id ?? "")) throw new Error("bad widget id");
    const prev = Gio.File.new_for_path(GLib.build_filenamev([ prevRoot, id ]));
    const info = prevInfo("widgets", id, { prevRoot });
    if (!info) throw new Error("There is no previous version to restore");
    const target = Gio.File.new_for_path(GLib.build_filenamev([ root, id ]));
    const swap = Gio.File.new_for_path(GLib.build_filenamev([ root, `.swap-${id}-${GLib.random_int()}` ]));
    const hadLive = target.query_exists(null);
    if (hadLive) target.move(swap, Gio.FileCopyFlags.NONE, null, null);
    try { prev.move(target, Gio.FileCopyFlags.NONE, null, null); }
    catch (e) { if (hadLive) swap.move(target, Gio.FileCopyFlags.NONE, null, null); throw e; }
    if (hadLive) { try { GLib.mkdir_with_parents(prevRoot, 0o755); swap.move(prev, Gio.FileCopyFlags.NONE, null, null); } catch (_e) { rmrf(swap); } }
    return info.version;
}

/**
 * Verify + extract into a staging dir, then swap into place. Returns widget id. Throws on any problem.
 * @param zip     version 2 only: the raw zip bytes (.gwcp)
 * @param expect  { id, version, td?, en?, perm? } from the (signed) store listing the user confirmed. When td/en/perm are present
 *                the unpacked files must hash to exactly that tree digest - the digest an author signature covers.
 *                (replaced version moves to prevRoot/<id>: one-step rollback, see rollbackWidget) The file we install MUST be that
 *                widget: a package whose own metadata.id differs could otherwise overwrite a different installed widget.
 *                Omit only for "installed from a file", which is labelled as such in the UI.
 */
export function installGwcw(gwcw, { root = widgetsRoot(), prevRoot = prevRootFor("widgets"), expect = null, keepPrev = true, zip: separateZip = null } = {}) {
    const { metadata: md, package: pkg } = gwcw;
    assertInstallable(md, expect, checkApiVersion);
    let zip, limits;
    if (gwcw.version === 2) {                                           // the raw zip comes separately (already checked against the signed listing by the caller)
        if (!(separateZip instanceof Uint8Array)) throw new Error(`The package file ${pkg.file} is needed to install this widget`);
        zip = separateZip; limits = BIG_ZIP_LIMITS;
    } else {
        if (separateZip) throw new Error("A version 1 widget carries its own package");
        zip = GLib.base64_decode(pkg.data);
    }
    if (zip.length !== pkg.size || sha256hex(zip) !== pkg.sha256) throw new Error("Package integrity check failed");
    const entries = readZip(zip, limits);
    if (!entries.some(e => e.name === md.entry)) throw new Error(`Entry file ${md.entry} missing`);
    if (entries.some(e => e.name === "metadata.json" || COVER_NAMES.includes(e.name))) throw new Error("Reserved file name in package");
    if (expect) assertPackageBinding(md, entries, expect, sha256hex);

    GLib.mkdir_with_parents(root, 0o755);
    const stage = GLib.build_filenamev([ root, `.staging-${md.id}-${GLib.random_int()}` ]);
    const target = GLib.build_filenamev([ root, md.id ]);
    const backup = `${target}.old-${GLib.random_int()}`;
    try {
        for (const e of entries) writeFile(GLib.build_filenamev([ stage, ...e.name.split("/") ]), e.data);
        writeFile(GLib.build_filenamev([ stage, "metadata.json" ]), new TextEncoder().encode(JSON.stringify(md, null, 4)));
        if (gwcw.cover?.base64) {
            const ext = Object.keys(MIME).find(k => MIME[k] === gwcw.cover.mimeType);
            if (ext) writeFile(GLib.build_filenamev([ stage, `cover.${ext}` ]), GLib.base64_decode(gwcw.cover.base64));
        }
        const t = Gio.File.new_for_path(target);
        if (t.query_exists(null)) t.move(Gio.File.new_for_path(backup), Gio.FileCopyFlags.NONE, null, null);
        try { Gio.File.new_for_path(stage).move(t, Gio.FileCopyFlags.NONE, null, null); }
        catch (e) { if (GLib.file_test(backup, GLib.FileTest.EXISTS)) Gio.File.new_for_path(backup).move(t, Gio.FileCopyFlags.NONE, null, null); throw e; }
        retainPrev(backup, prevRoot, md.id, keepPrev);
        return md.id;
    } finally { rmrf(Gio.File.new_for_path(stage)); }
}

/** Save a .gwct. coverBytes (optional, from the store cache) is put back as "screenshot" so the existing pack UI keeps working. */
export function installGwct(gwct, { coverBytes = null, coverMime = "image/jpeg", root = themepacksRoot(), prevRoot = prevRootFor("themepacks"), expect = null, keepPrev = true } = {}) {
    const id = gwct.packMeta?.id;
    if (!ID_RE.test(id ?? "")) throw new Error("Invalid pack id");
    if (expect && id !== expect.id) throw new Error(`Pack id '${id}' does not match the listing '${expect.id}'`);
    if (coverBytes && !gwct.screenshot) gwct.screenshot = { mimeType: coverMime, base64: b64(coverBytes) };
    const live = Gio.File.new_for_path(GLib.build_filenamev([ root, `${id}.gwct` ]));
    if (keepPrev && live.query_exists(null)) {                      // the replaced pack becomes the rollback copy (best effort)
        try { GLib.mkdir_with_parents(prevRoot, 0o755); live.copy(Gio.File.new_for_path(GLib.build_filenamev([ prevRoot, `${id}.gwct` ])), Gio.FileCopyFlags.OVERWRITE, null, null); }
        catch (_e) { /* no rollback copy, update still proceeds */ }
    }
    writeFile(live.get_path(), new TextEncoder().encode(JSON.stringify(gwct, null, 2)));
    return id;
}

/** Swap a theme pack with its kept previous version (symmetric, like rollbackWidget). Returns the version now live. */
export function rollbackThemepack(id, { root = themepacksRoot(), prevRoot = prevRootFor("themepacks") } = {}) {
    if (!ID_RE.test(id ?? "")) throw new Error("bad pack id");
    const info = prevInfo("themepacks", id, { prevRoot });
    if (!info) throw new Error("There is no previous version to restore");
    const prev = Gio.File.new_for_path(GLib.build_filenamev([ prevRoot, `${id}.gwct` ]));
    const live = Gio.File.new_for_path(GLib.build_filenamev([ root, `${id}.gwct` ]));
    const swap = Gio.File.new_for_path(GLib.build_filenamev([ prevRoot, `.swap-${id}-${GLib.random_int()}` ]));
    if (live.query_exists(null)) live.copy(swap, Gio.FileCopyFlags.OVERWRITE, null, null);
    GLib.mkdir_with_parents(root, 0o755);
    prev.move(live, Gio.FileCopyFlags.OVERWRITE, null, null);
    if (swap.query_exists(null)) swap.move(prev, Gio.FileCopyFlags.OVERWRITE, null, null);
    return info.version;
}

/**
 * Move an installed widget / theme pack out of the live directories into quarantine (reversible: nothing is deleted).
 * Returns the new path, or null when it was not installed. Called only after the user agreed, never automatically.
 */
export function quarantine(kind, id) {
    if (!ID_RE.test(id ?? "") || (kind !== "widgets" && kind !== "themepacks")) throw new Error("bad quarantine request");
    const src = kind === "widgets" ? GLib.build_filenamev([ widgetsRoot(), id ]) : GLib.build_filenamev([ themepacksRoot(), `${id}.gwct` ]);
    if (!GLib.file_test(src, GLib.FileTest.EXISTS)) return null;
    const qdir = GLib.build_filenamev([ GLib.get_user_data_dir(), "gnome-widget-center", "quarantine", kind ]);
    GLib.mkdir_with_parents(qdir, 0o755);
    const dst = GLib.build_filenamev([ qdir, `${id}.${Date.now()}` ]);
    Gio.File.new_for_path(src).move(Gio.File.new_for_path(dst), Gio.FileCopyFlags.NONE, null, null);
    return dst;
}

// ---------- build (Share as file) ----------
function listFiles(dirPath, rel = "", out = []) {
    const dir = Gio.File.new_for_path(GLib.build_filenamev([ dirPath, ...(rel ? rel.split("/") : []) ]));
    const en = dir.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    for (let i = en.next_file(null); i; i = en.next_file(null)) {
        const r = rel ? `${rel}/${i.get_name()}` : i.get_name();
        const t = i.get_file_type();
        if (t === Gio.FileType.DIRECTORY) listFiles(dirPath, r, out);
        else if (t === Gio.FileType.REGULAR && r !== "metadata.json" && !COVER_NAMES.includes(r)) out.push(r);   // symlinks skipped
    }
    return out;
}

export function buildGwcw(widgetDir) {
    const md = JSON.parse(new TextDecoder().decode(Gio.File.new_for_path(GLib.build_filenamev([ widgetDir, "metadata.json" ])).load_contents(null)[1]));
    const names = listFiles(widgetDir).sort();
    const zip = writeZip(names.map(n => ({ name: n,
        data: Gio.File.new_for_path(GLib.build_filenamev([ widgetDir, ...n.split("/") ])).load_contents(null)[1] })));
    const out = { format: "gwcw", version: 1, metadata: md };
    const cov = COVER_NAMES.find(n => GLib.file_test(GLib.build_filenamev([ widgetDir, n ]), GLib.FileTest.EXISTS));
    if (cov) out.cover = { mimeType: MIME[cov.split(".").pop()],
        base64: b64(Gio.File.new_for_path(GLib.build_filenamev([ widgetDir, cov ])).load_contents(null)[1]) };
    out.package = { encoding: "zip+base64", size: zip.length, sha256: sha256hex(zip), files: names, data: b64(zip) };
    return JSON.stringify(out);
}
