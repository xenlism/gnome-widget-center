// sources.js - "Sources" page: pick a folder that holds widgets and/or theme packs, see what is in it, import the ones you tick.
// All parsing/validation is done by the Python backend (scan-source, import-widget, import-themepack): the same gate the build uses.
import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { tool } from "./backend.js";
import { tr } from "./i18n.js";
import { aRow } from "./rows.js";

const LAST = GLib.build_filenamev([ GLib.get_user_config_dir(), "gwc-repo-maker", "source.json" ]);
const loadLast = () => { try { return JSON.parse(new TextDecoder().decode(Gio.File.new_for_path(LAST).load_contents(null)[1])).path ?? null; } catch (_e) { return null; } };
const saveLast = path => { try { GLib.mkdir_with_parents(GLib.path_get_dirname(LAST), 0o700); Gio.File.new_for_path(LAST).replace_contents(new TextEncoder().encode(JSON.stringify({ path })), null, false, Gio.FileCreateFlags.NONE, null); } catch (_e) { /* not essential */ } };
const clear = box => { for (let c = box.get_first_child(); c; c = box.get_first_child()) box.remove(c); };
const chip = (text, css) => { const l = new Gtk.Label({ label: text, valign: Gtk.Align.CENTER }); l.add_css_class("caption-heading"); if (css) l.add_css_class(css); return l; };

export function buildSources(win, box) {
    const S = win._src ??= { path: loadLast(), scan: null, sel: new Set(), replace: false, busy: false };
    const keyOf = (kind, it) => `${kind}:${it.path}`;

    async function scan(path) {
        S.busy = true; render();
        const r = await tool(win.repo, [ "scan-source", path ]);
        S.busy = false;
        if (!r.ok) { S.scan = null; S.sel = new Set(); render(); win.fail(r); return; }
        S.path = path; saveLast(path); S.scan = r; S.sel = new Set();
        for (const w of r.widgets) if (w.valid && !w.inRepo) S.sel.add(keyOf("w", w));
        for (const t of r.themepacks) if (t.valid && !t.inRepo) S.sel.add(keyOf("t", t));
        render();
    }

    async function browse() {
        const p = await win.pick({ folder: true, title: tr("Choose the folder with your widgets / theme packs", "เลือกโฟลเดอร์ที่มีวิดเจ็ต / ชุดธีม") });
        if (p) scan(p);
    }

    async function doImport() {
        const items = [ ...S.scan.widgets.map(i => [ "w", i ]), ...S.scan.themepacks.map(i => [ "t", i ]) ].filter(([ k, i ]) => S.sel.has(keyOf(k, i)));
        if (!items.length) return;
        S.busy = true; render();
        const lines = []; let ok = 0;
        for (const [ kind, it ] of items) {
            if (it.inRepo && !S.replace) { lines.push(`– ${it.id}: ${tr("skipped (already in the repository)", "ข้าม (มีในคลังแล้ว)")}`); continue; }
            const r = await tool(win.repo, [ kind === "w" ? "import-widget" : "import-themepack", it.path, ...(S.replace ? [ "--replace" ] : []) ]);
            if (r.ok) { ok++; lines.push(`✓ ${r.id}${r.version ? " v" + r.version : ""}${r.warnings?.length ? "  (" + r.warnings.join("; ") + ")" : ""}`); }
            else lines.push(`✗ ${it.id}: ${r.error}`);
        }
        const again = await tool(win.repo, [ "scan-source", S.path ]);
        if (again.ok) S.scan = again;
        S.sel = new Set(); S.busy = false;
        await win.refresh();                      // re-renders every page, this one included
        win.alert(`${tr("Imported", "นำเข้าแล้ว")} ${ok} / ${items.length}`, lines.join("\n"));
    }

    function section(title, desc, kind, list) {
        const g = new Adw.PreferencesGroup({ title: `${title} (${list.length})`, description: desc });
        box.append(g);
        if (!list.length) { g.add(aRow({ title: tr("Nothing found", "ไม่พบรายการ") })); return; }
        for (const it of list) {
            const key = keyOf(kind, it);
            const sub = kind === "w" ? [ it.id, it.version ? `v${it.version}` : "", it.perm ? `perm: ${it.perm}` : "" ] : [ it.id, `${it.widgets} widgets`, it.file ];
            const row = aRow({ title: it.name, subtitle: sub.filter(Boolean).join(" · ") });
            const cb = new Gtk.CheckButton({ active: S.sel.has(key), sensitive: it.valid && !S.busy, valign: Gtk.Align.CENTER });
            cb.connect("toggled", () => { cb.active ? S.sel.add(key) : S.sel.delete(key); countLbl.label = countText(); importBtn.sensitive = S.sel.size > 0 && !S.busy; });
            row.add_prefix(cb); row.set_activatable_widget(cb);
            row.add_suffix(!it.valid ? chip(tr("invalid id", "รหัสไม่ถูกต้อง"), "error") : it.inRepo ? chip(tr("in repository", "มีในคลังแล้ว"), "warning") : chip(tr("new", "ใหม่"), "success"));
            g.add(row);
        }
    }

    const countText = () => `${S.sel.size} ${tr("selected", "ที่เลือก")}`;
    let countLbl, importBtn;

    function render() {
        clear(box);
        const g = new Adw.PreferencesGroup({ title: tr("Source folder", "โฟลเดอร์ต้นทาง"), description: tr(
            "Pick your extension folder (the one that contains widgets/ and themepacks/), or a widgets/ or themepacks/ folder itself. Nothing is changed until you press Import.",
            "เลือกโฟลเดอร์ extension (ที่มี widgets/ และ themepacks/) หรือโฟลเดอร์ widgets/ หรือ themepacks/ โดยตรง จะไม่มีอะไรเปลี่ยนจนกว่าจะกดนำเข้า") });
        box.append(g);
        const row = aRow({ title: tr("Folder", "โฟลเดอร์"), subtitle: S.path ?? tr("Nothing chosen yet", "ยังไม่ได้เลือก"), subtitle_selectable: true });
        if (S.busy) row.add_suffix(new Gtk.Spinner({ spinning: true, valign: Gtk.Align.CENTER }));
        const rescan = Gtk.Button.new_from_icon_name("view-refresh-symbolic"); rescan.set_tooltip_text(tr("Scan again", "สแกนอีกครั้ง")); rescan.set_valign(Gtk.Align.CENTER); rescan.add_css_class("flat");
        rescan.sensitive = !!S.path && !S.busy; rescan.connect("clicked", () => scan(S.path));
        const br = Gtk.Button.new_with_label(tr("Browse…", "เลือก…")); br.set_valign(Gtk.Align.CENTER); br.sensitive = !S.busy; br.connect("clicked", browse);
        row.add_suffix(rescan); row.add_suffix(br); g.add(row);
        if (!S.scan) {
            if (S.path && !S.busy) g.add(aRow({ title: tr("Press the refresh button to scan this folder", "กดปุ่มรีเฟรชเพื่อสแกนโฟลเดอร์นี้") }));
            return;
        }
        if (S.scan.widgetsDir) g.add(aRow({ title: tr("Widgets found in", "พบวิดเจ็ตใน"), subtitle: S.scan.widgetsDir, subtitle_selectable: true }));
        if (S.scan.themepacksDir) g.add(aRow({ title: tr("Theme packs found in", "พบชุดธีมใน"), subtitle: S.scan.themepacksDir, subtitle_selectable: true }));
        if (!S.scan.widgetsDir && !S.scan.themepacksDir) g.add(aRow({ title: tr("No widgets or theme packs here", "ไม่พบวิดเจ็ตหรือชุดธีมในโฟลเดอร์นี้"), subtitle: tr("Look for a folder with widgets/<id>/metadata.json or themepacks/*.gwct", "มองหาโฟลเดอร์ที่มี widgets/<id>/metadata.json หรือ themepacks/*.gwct") }));
        section(tr("Widgets", "วิดเจ็ต"), "", "w", S.scan.widgets);
        section(tr("Theme packs", "ชุดธีม"), "", "t", S.scan.themepacks);

        const ag = new Adw.PreferencesGroup(); box.append(ag);
        const rep = new Adw.SwitchRow({ title: tr("Replace items already in the repository", "แทนที่รายการที่มีในคลังแล้ว"), subtitle: tr("Off: items already in the repository are skipped.", "ปิด: รายการที่มีในคลังแล้วจะถูกข้าม"), active: S.replace });
        rep.connect("notify::active", () => { S.replace = rep.active; }); ag.add(rep);
        const bar = new Gtk.Box({ spacing: 8, halign: Gtk.Align.END });
        countLbl = new Gtk.Label({ label: countText(), valign: Gtk.Align.CENTER }); countLbl.add_css_class("dim-label"); bar.append(countLbl);
        const all = Gtk.Button.new_with_label(tr("Select new", "เลือกที่ใหม่")); all.connect("clicked", () => { S.sel = new Set(); for (const w of S.scan.widgets) if (w.valid && !w.inRepo) S.sel.add(keyOf("w", w)); for (const t of S.scan.themepacks) if (t.valid && !t.inRepo) S.sel.add(keyOf("t", t)); render(); });
        const none = Gtk.Button.new_with_label(tr("Select none", "ไม่เลือกเลย")); none.connect("clicked", () => { S.sel = new Set(); render(); });
        importBtn = Gtk.Button.new_with_label(tr("Import selected", "นำเข้าที่เลือก")); importBtn.add_css_class("suggested-action"); importBtn.add_css_class("pill");
        importBtn.sensitive = S.sel.size > 0 && !S.busy; importBtn.connect("clicked", doImport);
        bar.append(all); bar.append(none); bar.append(importBtn); box.append(bar);
    }
    render();
    if (S.path && !S.scan && !S.busy && !win._autoScanned) { win._autoScanned = true; scan(S.path); }     // remembered folder: scan once per session
}
