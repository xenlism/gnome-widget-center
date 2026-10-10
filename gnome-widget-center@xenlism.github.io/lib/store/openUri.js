// openUri.js - single entry point for everything the .desktop file hands us:
//   gwc://install?repo=<https url>&w=<widget id>      (or &t=<theme pack id>)
//   file:///…/x.gwcw   file:///…/x.gwct   /plain/path
import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";

import { readBytesFileAsync, readTextFileAsync } from "../fsUtils.js";
import { CODE_WARNING, installDialog } from "./dialogText.js";
import { installGwcw, installGwct, parseGwcw, parseGwct } from "./gwcFormat.js";
import { sha256, sha512 } from "./hashes.js";
import { checkAuthor, checkAuthorPin, effectiveTier } from "./integrity.js";
import { addRepo, findRepoByUrl, loadRepoConfig, makeRepo, normalizeRepoUrl, saveRepoConfig } from "./repoConfig.js";
import { StoreChangedError, StoreClient } from "./storeClient.js";

Gio._promisify(Adw.AlertDialog.prototype, "choose", "choose_finish");

export function parseOpenArg(arg) {
    if (arg.startsWith("gwc://")) {
        const u = GLib.Uri.parse(arg, GLib.UriFlags.NONE);
        if (u.get_host() !== "install") throw new Error("Unknown gwc:// action");
        const q = GLib.Uri.parse_params(u.get_query() ?? "", -1, "&", GLib.UriParamsFlags.NONE);
        const id = q.w ?? q.t;
        if (!q.repo || !id || !/^[a-z0-9][a-z0-9._-]{1,80}$/.test(id)) throw new Error("Malformed link");
        return { type: "store", repo: normalizeRepoUrl(q.repo), kind: q.w ? "widgets" : "themepacks", id };
    }
    const path = arg.startsWith("file://") ? GLib.filename_from_uri(arg)[0] : arg;
    const ext = path.split(".").pop().toLowerCase();
    if (ext !== "gwcw" && ext !== "gwct") throw new Error("Unsupported file type");
    return { type: "file", path, kind: ext === "gwcw" ? "widgets" : "themepacks" };
}

async function confirm(parent, { heading, body, cover = null, ok = "Install", danger = false }) {
    const d = new Adw.AlertDialog({ heading, body, body_use_markup: false });
    if (cover) d.set_extra_child(new Gtk.Picture({ paintable: cover, height_request: 135, content_fit: Gtk.ContentFit.CONTAIN }));
    d.add_response("cancel", "Cancel");
    d.add_response("ok", ok);
    d.set_response_appearance("ok", danger ? Adw.ResponseAppearance.DESTRUCTIVE : Adw.ResponseAppearance.SUGGESTED);
    d.set_default_response("cancel");
    return (await d.choose(parent, null)) === "ok";
}

const toast = (parent, title) => parent?.add_toast?.(new Adw.Toast({ title }));
const texture = (u8) => { try { return Gdk.Texture.new_from_bytes(new GLib.Bytes(u8)); } catch (_e) { return null; } };

/**
 * @param deps { registry: InstallRegistry, onInstalled?: (kind,id)=>void }
 */
export async function handleOpen(parent, arg, deps) {
    try {
        const t = parseOpenArg(arg);
        if (t.type === "file") await _openFile(parent, t, deps); else await _openStoreLink(parent, t, deps);
    } catch (e) {
        logError(e, "[widget-center] open failed");
        toast(parent, `Could not open: ${e.message}`);
    }
}

const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

async function _openFile(parent, t, { registry, onInstalled }) {
    const size = Gio.File.new_for_path(t.path).query_info("standard::size", Gio.FileQueryInfoFlags.NONE, null).get_size();
    if (size > MAX_IMPORT_BYTES) throw new Error("File is too large");        // checked BEFORE it is read into memory
    const text = await readTextFileAsync(t.path);
    if (t.kind === "widgets") {
        const g = parseGwcw(text), m = g.metadata;
        let zip = null;
        if (g.version === 2) {                                   // the zip is the .gwcp named in the file, kept in the same folder
            const zf = Gio.File.new_for_path(t.path).get_parent().get_child(g.package.file);
            if (!zf.query_exists(null)) throw new Error(`This widget needs its package file ${g.package.file} in the same folder`);
            const zsize = zf.query_info("standard::size", Gio.FileQueryInfoFlags.NONE, null).get_size();
            if (zsize !== g.package.size) throw new Error(`${g.package.file} is not the package this file describes`);   // checked BEFORE it is read into memory
            zip = await readBytesFileAsync(zf.get_path());
        }
        const cover = g.cover?.base64 ? texture(GLib.base64_decode(g.cover.base64)) : null;
        const ok = await confirm(parent, { heading: `Install “${m.name}”?`, cover, danger: true,
            body: `${m.description ?? ""}\n\nVersion ${m.version} · by ${m.author ?? "unknown"} · ${m.catalog ?? "other"}\nFrom a file, not from a store.\n\n${CODE_WARNING}` });
        if (!ok) return;
        installGwcw(g, { zip });
        await registry.record("widgets", m.id, { src: "file", v: m.version });
        onInstalled?.("widgets", m.id); toast(parent, `Installed ${m.name}`);
    } else {
        const g = parseGwct(text), pm = g.packMeta ?? {};
        const cover = g.screenshot?.base64 ? texture(GLib.base64_decode(g.screenshot.base64)) : null;
        if (!await confirm(parent, { heading: `Add theme pack “${pm.name ?? pm.id}”?`, cover,
            body: `${pm.description ?? ""}\n\nBy ${pm.author ?? "unknown"} · ${g.widgets.length} widgets` })) return;
        const id = installGwct(g);
        await registry.record("themepacks", id, { src: "file" });
        onInstalled?.("themepacks", id); toast(parent, `Added ${pm.name ?? id}`);
    }
}

async function _openStoreLink(parent, t, deps, carry = null) {
    const { registry, onInstalled } = deps;
    const cfg = await loadRepoConfig();
    let repo = carry?.repo ?? findRepoByUrl(cfg, t.repo);
    let pending = carry?.pending ?? false;                   // repo not in the list yet: NOT saved until the install succeeds
    if (!repo) {                                             // third-party repo: explicit consent, never silent
        const probe = await new StoreClient({ url: t.repo }).probeKey().catch(e => { throw new Error(`Cannot read this store's key: ${e.message}`); });
        const ok = await confirm(parent, { heading: "Trust this store?", danger: true, ok: "Trust and continue",
            body: `${t.repo}\n\nThis link comes from a store that is not in your repo list. It signs its catalogue with key “${probe.kid}”:\n\n${probe.fingerprint}\n\n`
                + `Only continue if you got this fingerprint from the store's owner by another route (their website, a README you trust). ${CODE_WARNING}` });
        if (!ok) return;
        repo = makeRepo({ url: t.repo, keys: [ { kid: probe.kid, pub: probe.pub } ] });
        pending = true;
    }
    if (repo.enabled === false) throw new Error("This store is disabled in your repo list");
    if (!repo.official && !repo.keys?.length) throw new Error("This store has no pinned signing key. Remove it from your repo list and add it again.");
    const client = new StoreClient(repo, { intervalHours: cfg.checkIntervalHours, channel: cfg.channel });
    const first = await client.getManifest();
    if (first.stale && first.refused) throw new Error(`Store refused: ${first.error}`);   // bad signature / rollback: never fall through quietly
    let item = await client.getItem(t.kind, t.id);          // search shard -> ONE category shard (~10 KB), not the whole catalogue
    if (!item) {                                             // not in cached shards -> one forced refresh, then give up
        await client.getManifest({ force: true });
        item = await client.getItem(t.kind, t.id);
    }
    if (!item) throw new Error("Not found in this store");
    const { expired, manifest, tier: manifestTier } = await client.getManifest();
    const isW = t.kind === "widgets";
    const tier = effectiveTier(repo, { tier: manifestTier });
    const author = isW ? checkAuthor(item, manifest, { sha512, sha256 }) : { status: "none" };    // throws TrustError on a bad/forbidden signature
    const prior = registry.get(t.kind, t.id);
    const pin = isW && prior?.src === "store" ? checkAuthorPin(prior.author, author) : "new";
    const coverPath = item.cv ? await client.getCoverPath(item.cv).catch(() => null) : null;
    const cover = coverPath ? Gdk.Texture.new_from_filename(coverPath) : null;
    const dlg = installDialog({ item, isW, repo, tier, expired, manifest, author, pin });
    const ok = await confirm(parent, { heading: dlg.heading, cover, danger: dlg.danger, body: dlg.body });
    if (!ok) return;
    let bytes, zip = null;
    try {
        bytes = await client.download(item, { kind: t.kind });
        if (isW && item.z) zip = await client.downloadPackage(item, { kind: t.kind });     // version 2: the zip is its own file, listed next to the .gwcw
    } catch (e) {
        if (e instanceof StoreChangedError && !carry) {      // republished while the dialog was open: show the NEW version and ask again
            toast(parent, "The store was updated - please confirm again");
            return _openStoreLink(parent, t, deps, { repo, pending });
        }
        throw e;
    }
    const text = new TextDecoder().decode(bytes);
    const expect = isW ? { id: item.id, version: item.v, td: item.td, en: item.en, perm: item.perm } : { id: item.id, version: item.v };
    if (isW) {
        const g = parseGwcw(text);
        if ((g.version === 2) !== Boolean(item.z) || (item.z && g.package.file !== item.z.split("/").pop())) throw new Error("The package does not match its listing");
        installGwcw(g, { expect, zip });
    } else installGwct(parseGwct(text), { expect, coverBytes: coverPath ? await readBytesFileAsync(coverPath) : null });
    if (pending) await saveRepoConfig(addRepo(cfg, { url: repo.url, name: repo.name, keys: repo.keys }));   // only now does the repo join the list
    const rec = { src: "store", repo: repo.url, v: item.v, h: item.h, ch: item.ch ?? "stable" };
    if (author.status === "verified") rec.author = { kid: author.signer.kid, fp: author.signer.fingerprint };
    await registry.record(t.kind, t.id, rec);
    onInstalled?.(t.kind, t.id); toast(parent, `Installed ${item.n}`);
}
