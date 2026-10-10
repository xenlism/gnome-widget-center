// shareService.js - what the "Share" button does.
//   from a store repo  -> copy an https link   (recipient's browser -> /open/ page -> gwc:// -> Widget Center)
//   anything else      -> save a .gwcw / .gwct (self-contained, includes cover)
import Gdk from "gi://Gdk";
import GObject from "gi://GObject";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";

import { writeTextFileAsync, readTextFileAsync } from "../fsUtils.js";
import { buildGwcw, widgetsRoot } from "./gwcFormat.js";
import { normalizeRepoUrl } from "./repoConfig.js";
import GLib from "gi://GLib";

Gio._promisify(Gtk.FileDialog.prototype, "save", "save_finish");

/** kind: "widgets" | "themepacks" */
export function buildShareLink(repoUrl, kind, id) {
    return `${normalizeRepoUrl(repoUrl)}open/?${kind === "widgets" ? "w" : "t"}=${encodeURIComponent(id)}`;
}

function copyText(widget, text) {
    const v = new GObject.Value();
    v.init(GObject.TYPE_STRING);
    v.set_string(text);
    widget.get_clipboard().set_content(Gdk.ContentProvider.new_for_value(v));
}

async function saveAs(parent, initialName, label, ext) {
    const filter = new Gtk.FileFilter({ name: label });
    filter.add_pattern(`*.${ext}`);
    const dlg = new Gtk.FileDialog({ title: "Share", initial_name: initialName, default_filter: filter });
    try { return (await dlg.save(parent, null)).get_path(); } catch (_e) { return null; }   // cancelled
}

/**
 * @param parent    Gtk.Window (for dialogs + clipboard)
 * @param registry  InstallRegistry
 * @param widgetId  string
 * @param widgetDir optional override (bundled widgets live outside the user dir)
 * @returns {{kind:"link",url:string}|{kind:"file",path:string}|null}
 */
export async function shareWidget(parent, registry, widgetId, widgetDir = null) {
    const m = registry.shareMode("widgets", widgetId);
    if (m.mode === "link") {
        const url = buildShareLink(m.repoUrl, "widgets", widgetId);
        copyText(parent, url);
        return { kind: "link", url };
    }
    const dir = widgetDir ?? GLib.build_filenamev([ widgetsRoot(), widgetId ]);
    const path = await saveAs(parent, `${widgetId}.gwcw`, "GNOME Widget Center widget", "gwcw");
    if (!path) return null;
    await writeTextFileAsync(path, buildGwcw(dir));          // metadata + cover stay readable, files zipped+base64
    return { kind: "file", path };
}

/** Theme packs follow the same rule. packPath = the installed .gwct on disk. */
export async function shareThemePack(parent, registry, packId, packPath) {
    const m = registry.shareMode("themepacks", packId);
    if (m.mode === "link") {
        const url = buildShareLink(m.repoUrl, "themepacks", packId);
        copyText(parent, url);
        return { kind: "link", url };
    }
    const path = await saveAs(parent, `${packId}.gwct`, "GNOME Widget Center theme pack", "gwct");
    if (!path) return null;
    await writeTextFileAsync(path, await readTextFileAsync(packPath));   // already self-contained (screenshot embedded)
    return { kind: "file", path };
}
