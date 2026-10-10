// openUri.js - single entry point for everything the .desktop file hands us:
//   gwc://install?repo=<https url>&w=<widget id>      (or &t=<theme pack id>)
//   file:///…/x.gwcw   file:///…/x.gwct   /plain/path
import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";

import { childIdCandidates, restoreChildWidget, userWidgetsRoot } from "../architectWidgetKit.js";
import { readBytesFileAsync, readTextFileAsync } from "../fsUtils.js";
import { CODE_WARNING, installDialog } from "./dialogText.js";
import { installGwcw, installGwct, parseGwcw, parseGwct } from "./gwcFormat.js";
import { sha256, sha512 } from "./hashes.js";
import { ID_RE, checkAuthor, checkAuthorPin, effectiveTier } from "./integrity.js";
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

async function confirm(parent, { heading, body, cover = null, extra = null, ok = "Install", danger = false }) {
    const d = new Adw.AlertDialog({ heading, body, body_use_markup: false });
    if (cover) d.set_extra_child(new Gtk.Picture({ paintable: cover, height_request: 135, content_fit: Gtk.ContentFit.CONTAIN }));
    else if (extra) d.set_extra_child(extra);
    d.add_response("cancel", "Cancel");
    d.add_response("ok", ok);
    d.set_response_appearance("ok", danger ? Adw.ResponseAppearance.DESTRUCTIVE : Adw.ResponseAppearance.SUGGESTED);
    d.set_default_response("cancel");
    return (await d.choose(parent, null)) === "ok";
}

const esc = t => GLib.markup_escape_text(String(t ?? ""), -1);

/** One row per widget to install (name, version, author); open a row for its permissions / trust details. */
function missingWidgetsList(ready, plan) {
    const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: [ "boxed-list" ] });
    for (const r of ready) {
        const row = new Adw.ExpanderRow({
            title: esc(r.item.n ?? r.id),
            subtitle: esc([ r.item.a ? `by ${r.item.a}` : null, `v${r.item.v}`, r.id ].filter(Boolean).join(" · ")),
        });
        row.add_prefix(new Gtk.Image({ icon_name: "puzzle-piece-symbolic" }));
        row.add_row(new Gtk.Label({
            label: r.dlg.body.replace(CODE_WARNING, "").trim(), wrap: true, xalign: 0, selectable: true,
            margin_top: 8, margin_bottom: 8, margin_start: 12, margin_end: 12, css_classes: [ "caption" ],
        }));
        list.append(row);
    }
    for (const c of plan) {
        list.append(new Adw.ActionRow({
            title: esc(c.name ?? c.id),
            subtitle: esc(`${c.id} · child of ${c.parentId} (no new code)`),
        }));
    }
    return new Gtk.ScrolledWindow({
        child: list, hscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true,
        max_content_height: 320, min_content_width: 420,
    });
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

/** { id -> folder } of every widget on disk (bundled + user). Sync: a few dozen tiny metadata.json files. */
function installedWidgetPaths(extensionPath) {
    const map = new Map();
    for (const root of [ GLib.build_filenamev([ extensionPath, "widgets" ]), userWidgetsRoot() ]) {
        try {
            const en = Gio.File.new_for_path(root).enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null);
            for (let i = en.next_file(null); i; i = en.next_file(null)) {
                if (i.get_file_type() !== Gio.FileType.DIRECTORY) continue;
                const dir = GLib.build_filenamev([ root, i.get_name() ]);
                try {
                    const [ , bytes ] = Gio.File.new_for_path(GLib.build_filenamev([ dir, "metadata.json" ])).load_contents(null);
                    const id = JSON.parse(new TextDecoder().decode(bytes)).id;
                    if (typeof id === "string") map.set(id, dir);
                } catch (_e) { /* not a widget folder */ }
            }
        } catch (_e) { /* root does not exist yet */ }
    }
    return map;
}

/**
 * A theme pack was applied but some of its widgets are not installed. For each missing id:
 *   - a widget listed in the ENABLED repositories (the user's own list, never an unknown store) is downloaded;
 *   - a CHILD of an Architect widget (<parent>-<name>-<timestamp>, local to the machine that made the pack) is recreated from
 *     its parent's child/ template under the same id; the parent is downloaded first when it is missing too.
 * One consent dialog with the same trust information as a single install (permissions, author signature, tier), then it installs.
 * Returns { installed: [ids], children: [ids], notFound: [ids], failed: [{id, message}], cancelled }.
 */
export async function handleInstallMissing(parent, ids, { registry, extensionPath, packName = null, onInstalled = null } = {}) {
    const out = { installed: [], children: [], notFound: [], failed: [], cancelled: false };
    let have = installedWidgetPaths(extensionPath);
    const wanted = [ ...new Set(ids) ].filter(id => ID_RE.test(id) && !have.has(id));
    if (!wanted.length) return out;

    // ids to look up in the stores: the wanted ones, plus every possible parent of one that may be a child
    const lookup = new Set(wanted);
    for (const id of wanted) for (const c of childIdCandidates(id)) if (!have.has(c.parentId) && ID_RE.test(c.parentId)) lookup.add(c.parentId);

    const cfg = await loadRepoConfig();
    const found = new Map();                                   // id -> { repo, client, item }
    for (const repo of cfg.repos.filter(r => r.enabled !== false && (r.official || r.keys?.length))) {
        const todo = [ ...lookup ].filter(id => !found.has(id));
        if (!todo.length) break;
        const client = new StoreClient(repo, { intervalHours: cfg.checkIntervalHours, channel: cfg.channel });
        try {
            const first = await client.getManifest();
            if (first.stale && first.refused) { logError(new Error(first.error), `[widget-center] install-missing: ${repo.name} refused`); continue; }
            for (const id of todo) {
                const item = await client.getItem("widgets", id);
                if (item) found.set(id, { repo, client, item });
            }
        } catch (e) { logError(e, `[widget-center] install-missing: repo "${repo.id}" failed`); }
    }

    // what is a child: not listed itself, but a parent of it is installed or listed
    const children = [], needed = new Set(wanted.filter(id => found.has(id)));
    for (const id of wanted) {
        if (found.has(id)) continue;
        const c = childIdCandidates(id).find(x => have.has(x.parentId) || found.has(x.parentId));
        if (c) { children.push({ id, ...c }); if (!have.has(c.parentId)) needed.add(c.parentId); }
        else out.notFound.push(id);
    }

    // everything is verified BEFORE the dialog: a bad signature / forbidden author is reported as failed, not installed
    const ready = [];
    for (const id of needed) {
        const f = found.get(id);
        try {
            const { expired, manifest, tier: manifestTier } = await f.client.getManifest();
            const tier = effectiveTier(f.repo, { tier: manifestTier });
            const author = checkAuthor(f.item, manifest, { sha512, sha256 });
            const prior = registry.get("widgets", id);
            const pin = prior?.src === "store" ? checkAuthorPin(prior.author, author) : "new";
            ready.push({ id, ...f, author, dlg: installDialog({ item: f.item, isW: true, repo: f.repo, tier, expired, manifest, author, pin }) });
        } catch (e) { out.failed.push({ id, message: e.message }); }
    }
    const okParents = new Set([ ...have.keys(), ...ready.map(r => r.id) ]);
    const plan = children.filter(c => okParents.has(c.parentId));
    for (const c of children) if (!okParents.has(c.parentId)) out.failed.push({ id: c.id, message: `Its parent widget "${c.parentId}" could not be installed` });
    if (!ready.length && !plan.length) return out;

    let body = "Open a widget to see its permissions and who signed it.";
    if (ready.length) body += `\n\n${CODE_WARNING}`;
    if (out.notFound.length) body += `\n\nNot found in your stores: ${out.notFound.join(", ")}`;
    const total = ready.length + plan.length;
    const ok = await confirm(parent, {
        heading: `Install ${total} missing widget${total === 1 ? "" : "s"}${packName ? ` for “${packName}”` : ""}?`,
        body, extra: missingWidgetsList(ready, plan), danger: ready.some(r => r.dlg.danger), ok: "Install all",
    });
    if (!ok) { out.cancelled = true; return out; }

    for (const r of ready) {
        try {
            const bytes = await r.client.download(r.item, { kind: "widgets" });
            const zip = r.item.z ? await r.client.downloadPackage(r.item, { kind: "widgets" }) : null;
            const g = parseGwcw(new TextDecoder().decode(bytes));
            if ((g.version === 2) !== Boolean(r.item.z) || (r.item.z && g.package.file !== r.item.z.split("/").pop())) throw new Error("The package does not match its listing");
            installGwcw(g, { expect: { id: r.item.id, version: r.item.v, td: r.item.td, en: r.item.en, perm: r.item.perm }, zip });
            const rec = { src: "store", repo: r.repo.url, v: r.item.v, h: r.item.h, ch: r.item.ch ?? "stable" };
            if (r.author.status === "verified") rec.author = { kid: r.author.signer.kid, fp: r.author.signer.fingerprint };
            await registry.record("widgets", r.id, rec);
            out.installed.push(r.id); onInstalled?.("widgets", r.id);
        } catch (e) { logError(e, `[widget-center] install-missing: ${r.id} failed`); out.failed.push({ id: r.id, message: e.message }); }
    }
    have = installedWidgetPaths(extensionPath);                // parents are on disk now
    for (const c of plan) {
        try {
            const parentPath = have.get(c.parentId);
            if (!parentPath) throw new Error(`Its parent widget "${c.parentId}" is not installed`);
            const made = await restoreChildWidget({ parentPath, parentId: c.parentId, childId: c.id, name: c.name });
            if (made) { out.children.push(c.id); onInstalled?.("widgets", c.id); }
        } catch (e) { logError(e, `[widget-center] install-missing: child ${c.id} failed`); out.failed.push({ id: c.id, message: e.message }); }
    }
    const bits = [ `Installed ${out.installed.length + out.children.length}` ];
    if (out.failed.length) bits.push(`${out.failed.length} failed`);
    if (out.notFound.length) bits.push(`${out.notFound.length} not found`);
    toast(parent, bits.join(" · "));
    return out;
}
