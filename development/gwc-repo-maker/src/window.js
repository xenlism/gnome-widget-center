import Adw from "gi://Adw?version=1";
import Gdk from "gi://Gdk?version=4.0";
import GObject from "gi://GObject";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { BUNDLED_TOOLS, KEY_DIR, build, listKeyIds, tool, verify } from "./backend.js";
import { tr } from "./i18n.js";
import { aRow } from "./rows.js";
import { generateAuthorKey, readPubFile, showKeysDialog, suggestKid } from "./keys.js";
import { buildSources } from "./sources.js";
import { buildPublishGroup } from "./publish.js";

const RECENT = GLib.build_filenamev([ GLib.get_user_config_dir(), "gwc-repo-maker", "recent.json" ]);
const loadRecent = () => { try { return JSON.parse(new TextDecoder().decode(Gio.File.new_for_path(RECENT).load_contents(null)[1])); } catch (_e) { return []; } };
const saveRecent = list => { GLib.mkdir_with_parents(GLib.path_get_dirname(RECENT), 0o700); Gio.File.new_for_path(RECENT).replace_contents(new TextEncoder().encode(JSON.stringify(list.slice(0, 8))), null, false, Gio.FileCreateFlags.NONE, null); };

const clear = box => { for (let c = box.get_first_child(); c; c = box.get_first_child()) box.remove(c); };
const btn = (label, cb, { css = [], icon = null } = {}) => { const b = icon ? Gtk.Button.new_from_icon_name(icon) : Gtk.Button.new_with_label(label); if (icon) b.set_tooltip_text(label); b.set_valign(Gtk.Align.CENTER); css.forEach(c => b.add_css_class(c)); b.connect("clicked", cb); return b; };
const chip = (text, css) => { const l = new Gtk.Label({ label: text, valign: Gtk.Align.CENTER }); l.add_css_class("caption-heading"); if (css) l.add_css_class(css); return l; };
const copy = (text) => Gdk.Display.get_default().get_clipboard().set(text);

export const Window = GObject.registerClass(class GwcWindow extends Adw.ApplicationWindow {
    constructor(app, opts) {
        super({ application: app, title: "GWC Repo Maker", default_width: 980, default_height: 720, width_request: 360, height_request: 480 });
        this.repo = null; this.st = null; this._busy = false;
        this._build();
        this.opts = opts;
        if (opts.repo) this.openRepo(opts.repo).then(() => { if (opts.shots) this._shots(opts.shots); });
    }

    // ------------------------------------------------------------------ frame
    _build() {
        this.toasts = new Adw.ToastOverlay();
        const tv = new Adw.ToolbarView();
        const hb = new Adw.HeaderBar();
        this.stack = new Adw.ViewStack();
        this.switcher = new Adw.ViewSwitcher({ stack: this.stack, policy: Adw.ViewSwitcherPolicy.WIDE });
        hb.set_title_widget(this.switcher);
        const menu = new Gio.Menu(); menu.append(tr("New repository…", "สร้างคลังใหม่…"), "win.new"); menu.append(tr("Open repository…", "เปิดคลัง…"), "win.open"); menu.append(tr("Signing keys…", "กุญแจเซ็น…"), "win.keys"); menu.append(tr("Refresh", "รีเฟรช"), "win.refresh");
        hb.pack_end(new Gtk.MenuButton({ icon_name: "open-menu-symbolic", menu_model: menu }));
        for (const [ n, f ] of [ [ "new", () => this.newRepoDialog() ], [ "open", () => this.pickRepo() ], [ "refresh", () => this.refresh() ], [ "keys", () => showKeysDialog(this) ] ]) { const a = new Gio.SimpleAction({ name: n }); a.connect("activate", f); this.add_action(a); }
        tv.add_top_bar(hb);
        this.pages = {};
        for (const [ id, title, icon ] of [ [ "overview", tr("Overview", "ภาพรวม"), "view-grid-symbolic" ], [ "widgets", tr("Widgets", "วิดเจ็ต"), "application-x-addon-symbolic" ], [ "themes", tr("Theme packs", "ชุดธีม"), "image-x-generic-symbolic" ], [ "sources", tr("Sources", "ต้นทาง"), "folder-open-symbolic" ],
            [ "trust", tr("Authors & revocations", "ผู้เขียน/เพิกถอน"), "channel-secure-symbolic" ], [ "settings", tr("Settings", "ตั้งค่า"), "emblem-system-symbolic" ], [ "build", tr("Build & publish", "สร้างและเผยแพร่"), "network-transmit-symbolic" ] ]) {
            const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 18, margin_bottom: 18, margin_start: 18, margin_end: 18 });
            const sw = new Gtk.ScrolledWindow({ child: new Adw.Clamp({ maximum_size: 760, child: box }), vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER });
            this.stack.add_titled_with_icon(sw, id, title, icon); this.pages[id] = box;
        }
        this.welcome = new Adw.StatusPage({ icon_name: "folder-publicshare-symbolic", title: tr("Make a Widget Store", "สร้างคลังวิดเจ็ตของคุณ"),
            description: tr("Create a repository you can host for free on GitHub Pages, add widgets, sign and publish.", "สร้างคลังที่โฮสต์ฟรีบน GitHub Pages ได้ เพิ่มวิดเจ็ต เซ็น และเผยแพร่") });
        this.recentBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, halign: Gtk.Align.CENTER, width_request: 420 });
        const wb = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, halign: Gtk.Align.CENTER });
        const row = new Gtk.Box({ spacing: 12, halign: Gtk.Align.CENTER });
        row.append(btn(tr("New repository", "สร้างคลังใหม่"), () => this.newRepoDialog(), { css: [ "suggested-action", "pill" ] }));
        row.append(btn(tr("Open repository", "เปิดคลัง"), () => this.pickRepo(), { css: [ "pill" ] }));
        row.append(btn(tr("Signing keys", "กุญแจเซ็น"), () => showKeysDialog(this), { css: [ "pill" ] }));
        wb.append(row); wb.append(this.recentBox); this.welcome.set_child(wb);
        this.top = new Gtk.Stack(); this.top.add_named(this.welcome, "welcome"); this.top.add_named(this.stack, "main");
        tv.set_content(this.top);
        this.bar = new Adw.ViewSwitcherBar({ stack: this.stack }); tv.add_bottom_bar(this.bar);
        this.toasts.set_child(tv); this.set_content(this.toasts);
        const bp = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse("max-width: 640px") });
        bp.add_setter(this.bar, "reveal", true); bp.add_setter(this.switcher, "visible", false); this.add_breakpoint(bp);
        this._renderRecent();
    }

    toast(msg) { this.toasts.add_toast(new Adw.Toast({ title: msg, timeout: 4 })); }
    fail(res) { this.alert(tr("That did not work", "ไม่สำเร็จ"), res.error ?? String(res)); }
    alert(heading, body) { const d = new Adw.AlertDialog({ heading, body }); d.add_response("ok", "OK"); d.present(this); }
    /** yes/no question -> Promise<boolean> */
    confirm(heading, body, okLabel) {
        return new Promise(resolve => {
            const d = new Adw.AlertDialog({ heading, body }); d.add_response("cancel", tr("Cancel", "ยกเลิก")); d.add_response("ok", okLabel); d.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED); d.set_default_response("ok");
            d.choose(this, null, (dlg, res) => resolve(dlg.choose_finish(res) === "ok"));
        });
    }

    /** modal form: fields [{id,label,value?,options?:[..],browse?,gen?}] -> {id:value} | null
     *  browse: { folder?:bool, title?, read?: path => string|{value,...others}|null }  adds a "Browse…" button that fills the field
     *  gen:    { label?, run: ctx => string|null|Promise }  adds a button (e.g. "Generate key"); ctx = { get(id), set(id, v) } */
    form(heading, body, fields, okLabel = "OK") {
        return new Promise(resolve => {
            const d = new Adw.AlertDialog({ heading, body }); d.add_response("cancel", tr("Cancel", "ยกเลิก")); d.add_response("ok", okLabel); d.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED); d.set_default_response("ok");
            const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE }); list.add_css_class("boxed-list"); const w = {}, put = {};
            const ctx = { get: id => w[id]?.(), set: (id, v) => put[id]?.(v) };
            for (const f of fields) {
                if (f.options) { const r = new Adw.ComboRow({ title: f.label, model: Gtk.StringList.new(f.options) }); w[f.id] = () => f.options[r.selected]; put[f.id] = v => { const i = f.options.indexOf(v); if (i >= 0) r.set_selected(i); }; list.append(r); }
                else {
                    const r = new Adw.EntryRow({ title: f.label, text: f.value ?? "" }); w[f.id] = () => r.text.trim(); put[f.id] = v => r.set_text(String(v ?? ""));
                    if (f.browse) r.add_suffix(btn(tr("Browse…", "เลือก…"), async () => {
                        const p = await this.pick({ folder: !!f.browse.folder, title: f.browse.title ?? f.label }); if (!p) return;
                        const v = f.browse.read ? f.browse.read(p, ctx) : p;
                        if (v === null || v === undefined) this.toast(tr("That file could not be used", "ใช้ไฟล์นี้ไม่ได้")); else r.set_text(String(v));
                    }, { css: [ "flat" ] }));
                    if (f.gen) r.add_suffix(btn(f.gen.label ?? tr("Generate", "สร้าง"), async () => { const v = await f.gen.run(ctx); if (v) r.set_text(String(v)); }, { css: [ "flat" ] }));
                    list.append(r);
                }
            }
            d.set_extra_child(list); this.formDialog = d;            // kept so tests can reach the open dialog
            d.choose(this, null, (dlg, res) => { const r = dlg.choose_finish(res); if (this.formDialog === dlg) this.formDialog = null; resolve(r === "ok" ? Object.fromEntries(Object.entries(w).map(([ k, g ]) => [ k, g() ])) : null); });
        });
    }

    pick({ folder = false, title }) {
        return new Promise(resolve => {
            const fd = new Gtk.FileDialog({ title });
            const cb = (d, r) => { try { resolve((folder ? d.select_folder_finish(r) : d.open_finish(r)).get_path()); } catch (_e) { resolve(null); } };
            folder ? fd.select_folder(this, null, cb) : fd.open(this, null, cb);
        });
    }

    // ------------------------------------------------------------------ repo lifecycle
    _renderRecent() {
        clear(this.recentBox);
        for (const p of loadRecent().filter(p => GLib.file_test(p, GLib.FileTest.IS_DIR))) {
            const r = aRow({ title: GLib.path_get_basename(p), subtitle: p, activatable: true }); r.add_prefix(new Gtk.Image({ icon_name: "folder-symbolic" }));
            r.connect("activated", () => this.openRepo(p)); const l = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE }); l.add_css_class("boxed-list"); l.append(r); this.recentBox.append(l);
        }
    }
    async pickRepo() { const p = await this.pick({ folder: true, title: tr("Choose a repository folder", "เลือกโฟลเดอร์คลัง") }); if (p) this.openRepo(p); }

    async openRepo(path) {
        const st = await tool(path, [ "status" ]);
        if (!st.ok) { this.fail(st); return; }
        this.repo = path; saveRecent([ path, ...loadRecent().filter(p => p !== path) ]); this._render(st);
        this.top.set_visible_child_name("main"); this.set_title(`${st.config.name} - GWC Repo Maker`);
    }
    async refresh() { if (!this.repo) return; const st = await tool(this.repo, [ "status" ]); if (st.ok) this._render(st); else this.fail(st); }

    async newRepoDialog() {
        const v = await this.form(tr("New repository", "สร้างคลังใหม่"), tr("A folder with the build tools, workflows and a signing key is created for you.", "จะสร้างโฟลเดอร์พร้อมเครื่องมือ workflow และกุญแจเซ็นให้"), [
            { id: "name", label: tr("Store name", "ชื่อคลัง"), value: "My Widget Store" }, { id: "id", label: tr("Store id (a-z 0-9 -)", "รหัสคลัง (a-z 0-9 -)"), value: "my-widget-store" },
            { id: "url", label: tr("Public URL (ends with /)", "URL สาธารณะ (ลงท้ายด้วย /)"), value: "https://USER.github.io/my-widget-store/" },
            { id: "tier", label: tr("Kind", "ชนิด"), options: [ "official", "community" ] },
            { id: "kid", label: tr("Signing key id (a new key is generated)", "รหัสกุญแจเซ็น (สร้างกุญแจใหม่ให้)"), value: suggestKid("store"), gen: { label: tr("Suggest", "แนะนำ"), run: () => suggestKid("store") } },
            { id: "parent", label: tr("Create inside folder", "สร้างไว้ในโฟลเดอร์"), value: GLib.get_home_dir(), browse: { folder: true, title: tr("Where should the repository folder go?", "ให้สร้างโฟลเดอร์คลังไว้ที่ไหน") } } ], tr("Create", "สร้าง"));
        if (!v) return;
        if (!v.parent || !GLib.file_test(v.parent, GLib.FileTest.IS_DIR)) { this.alert(tr("Folder not found", "ไม่พบโฟลเดอร์"), v.parent || tr("Choose where to create the repository.", "เลือกที่สร้างคลังก่อน")); return; }
        const dest = GLib.build_filenamev([ v.parent, v.id ]);
        const r = await tool(null, [ "init", dest, "--id", v.id, "--name", v.name, "--base-url", v.url, "--tier", v.tier, "--kid", v.kid, "--git" ], { initFrom: BUNDLED_TOOLS });
        if (!r.ok) { this.fail(r); return; }
        await tool(dest, [ "config", "expiryDays", "180" ]);       // no weekly CI job renews the signature when publishing from here; 30 days would expire too soon
        await this.openRepo(dest);
        this.alert(tr("Repository created", "สร้างคลังแล้ว"), tr(`Key fingerprint (give this to users who add your store):\n${r.fingerprint}\n\nThe private key is in ${r.keyFile} and never inside the repository. Back it up.`,
            `ลายนิ้วมือกุญแจ (ส่งให้ผู้ใช้ที่จะเพิ่มคลังของคุณ):\n${r.fingerprint}\n\nกุญแจส่วนตัวอยู่ที่ ${r.keyFile} ไม่อยู่ในคลัง กรุณาสำรองไว้`));
    }

    // ------------------------------------------------------------------ rendering
    _group(box, title, desc) { const g = new Adw.PreferencesGroup({ title, description: desc ?? "" }); box.append(g); return g; }
    _render(st) {
        this.st = st;
        for (const b of Object.values(this.pages)) clear(b);
        this._overview(st); this._widgets(st); this._themes(st); buildSources(this, this.pages.sources); this._trust(st); this._settings(st); this._buildPage(st);
    }

    _overview(st) {
        const box = this.pages.overview, c = st.config;
        const g = this._group(box, c.name, `${c.tier === "community" ? tr("Community store", "คลังชุมชน") : tr("Official-style store", "คลังทางการ")} · ${st.widgets.length} ${tr("widgets", "วิดเจ็ต")} · ${st.themepacks.length} ${tr("theme packs", "ชุดธีม")}`);
        const add = (t, s, extra) => { const r = aRow({ title: t, subtitle: s, subtitle_selectable: true }); if (extra) r.add_suffix(extra); g.add(r); return r; };
        add(tr("Public URL", "URL สาธารณะ"), c.baseUrl); add(tr("Folder", "โฟลเดอร์"), st.dir, btn(tr("Open folder", "เปิดโฟลเดอร์"), () => Gtk.show_uri(this, `file://${st.dir}`, Gdk.CURRENT_TIME), { icon: "folder-open-symbolic" }));
        add(tr("Mirrors", "มิเรอร์"), c.mirrors.length ? c.mirrors.join("\n") : tr("none", "ไม่มี"));
        add(tr("Author signatures", "ลายเซ็นผู้เขียน"), c.requireAuthorSig ? tr("required for every widget", "บังคับทุกวิดเจ็ต") : tr("optional", "ไม่บังคับ"));
        const kg = this._group(box, tr("Signing keys", "กุญแจเซ็นคลัง"), tr("Users pin the fingerprint when they add your store. The private key stays on this computer.", "ผู้ใช้จะปักลายนิ้วมือนี้ตอนเพิ่มคลัง กุญแจส่วนตัวอยู่ในเครื่องนี้เท่านั้น"));
        for (const k of st.keys) {
            const r = aRow({ title: `${k.kid}${k.active ? "  ✓ " + tr("active", "ใช้งาน") : ""}`, subtitle: k.fingerprint }); r.add_suffix(chip(k.privateKey ? tr("private key here", "มีกุญแจส่วนตัว") : tr("NO private key", "ไม่มีกุญแจส่วนตัว"), k.privateKey ? "success" : "error"));
            r.add_suffix(btn(tr("Copy fingerprint", "คัดลอกลายนิ้วมือ"), () => { copy(k.fingerprint); this.toast(tr("Copied", "คัดลอกแล้ว")); }, { icon: "edit-copy-symbolic" })); kg.add(r);
        }
        const genRow = aRow({ title: tr("Generate a new signing key", "สร้างกุญแจเซ็นใหม่"), activatable: true }); genRow.add_prefix(new Gtk.Image({ icon_name: "list-add-symbolic" })); kg.add(genRow);
        genRow.connect("activated", async () => {
            const v = await this.form(tr("New signing key", "กุญแจเซ็นใหม่"), tr("It becomes the active key. Add its fingerprint to your announcements; rotate keys by keeping the old one trusted for a while.", "จะตั้งเป็นกุญแจที่ใช้งาน"), [ { id: "kid", label: "Key id", value: suggestKid("store"), gen: { label: tr("Suggest", "แนะนำ"), run: () => suggestKid("store") } } ], tr("Generate", "สร้าง"));
            if (!v) return; const r = await tool(this.repo, [ "keygen", "--kid", v.kid, "--activate" ]); r.ok ? (this.toast(`${tr("Key saved to", "บันทึกกุญแจที่")} ${r.keyFile}`), this.refresh()) : this.fail(r);
        });
        const pg = this._group(box, `${tr("Checks", "ผลตรวจ")}: ${st.errors} ${tr("errors", "ข้อผิดพลาด")}, ${st.warnings} ${tr("warnings", "คำเตือน")}`, st.problems.length ? "" : tr("Everything the build checks is fine.", "ผ่านทุกการตรวจของการ build"));
        for (const p of st.problems) { const r = aRow({ title: p.target, subtitle: p.message, subtitle_lines: 6 }); r.add_prefix(new Gtk.Image({ icon_name: p.level === "error" ? "dialog-error-symbolic" : "dialog-warning-symbolic" })); pg.add(r); }
    }

    _widgets(st) {
        const box = this.pages.widgets;
        const g = this._group(box, tr("Widgets", "วิดเจ็ต"), tr("Each widget is checked with the same rules as the build: permissions are compared with what the code uses.", "ตรวจด้วยกฎเดียวกับตอน build: เทียบสิทธิ์ที่ประกาศกับสิ่งที่โค้ดใช้จริง"));
        const hdr = new Gtk.Box({ spacing: 6 });
        hdr.append(btn(tr("New widget", "วิดเจ็ตใหม่"), () => this.newWidget(), { css: [ "suggested-action" ] })); hdr.append(btn(tr("Import…", "นำเข้า…"), () => this.importWidget()));
        g.set_header_suffix(hdr);
        if (!st.widgets.length) g.add(aRow({ title: tr("No widgets yet", "ยังไม่มีวิดเจ็ต"), subtitle: tr("Create one or import a .gwcw file or a folder.", "สร้างใหม่หรือนำเข้าไฟล์ .gwcw หรือโฟลเดอร์") }));
        for (const w of st.widgets) {
            const r = aRow({ title: w.name ?? w.id, subtitle: w.ok ? `${w.id} · v${w.version} · ${w.catalog}${w.channel === "beta" ? " · beta" : ""}` : w.id });
            if (!w.ok) { r.add_prefix(new Gtk.Image({ icon_name: "dialog-error-symbolic" })); const p = st.problems.find(p => p.target === w.id && p.level === "error"); r.set_subtitle(p?.message ?? "invalid"); r.set_subtitle_lines(5); }
            else {
                for (const p of w.perm) r.add_suffix(chip(p, p === "none" ? "" : "warning"));
                r.add_suffix(chip(w.signed ? `✓ ${w.signer}` : tr("unsigned", "ยังไม่เซ็น"), w.signed ? "success" : "dim-label"));
                r.add_suffix(btn(tr("Sign as author…", "เซ็นในนามผู้เขียน…"), () => this.signWidget(w.id), { icon: "emblem-ok-symbolic" }));
            }
            g.add(r);
        }
    }

    async newWidget() {
        const cats = this.st.catalogs.widgets.map(c => c.id);
        const v = await this.form(tr("New widget", "วิดเจ็ตใหม่"), tr("Creates metadata, a starter widget.js, config and a cover.", "สร้าง metadata, widget.js เริ่มต้น, config และ cover"), [
            { id: "id", label: "id (e.g. me.clock)", value: "me.my-widget" }, { id: "name", label: tr("Name", "ชื่อ"), value: "My Widget" }, { id: "author", label: tr("Author", "ผู้เขียน"), value: GLib.get_real_name() },
            { id: "catalog", label: tr("Category", "หมวด"), options: cats }, { id: "perm", label: tr("Permissions", "สิทธิ์"), options: [ "none", "network", "subprocess", "network + subprocess" ] } ], tr("Create", "สร้าง"));
        if (!v) return;
        const perm = v.perm === "none" ? [ "none" ] : v.perm.split(" + ");
        const r = await tool(this.repo, [ "new-widget", "--id", v.id, "--name", v.name, "--author", v.author, "--catalog", v.catalog, "--perm", ...perm ]);
        r.ok ? (this.toast(tr("Widget created", "สร้างวิดเจ็ตแล้ว")), this.refresh()) : this.fail(r);
    }

    async importWidget() {
        const src = await this.pick({ title: tr("Choose a .gwcw file", "เลือกไฟล์ .gwcw") });
        if (!src) return;
        const r = await tool(this.repo, [ "import-widget", src ]);
        r.ok ? (this.toast(`${tr("Imported", "นำเข้าแล้ว")} ${r.id} v${r.version}`), this.refresh()) : this.fail(r);
    }

    async signWidget(id) {
        const keys = listKeyIds();
        const v = await this.form(`${tr("Sign", "เซ็น")} ${id}`, tr("The author key signs this exact content, version, entry file and permissions. Any later edit invalidates it.", "กุญแจผู้เขียนเซ็นเนื้อหา เวอร์ชัน ไฟล์หลัก และสิทธิ์ตามที่เป็นอยู่ แก้ภายหลังลายเซ็นจะใช้ไม่ได้"),
            [ keys.length ? { id: "kid", label: tr("Author key", "กุญแจผู้เขียน"), options: keys } : { id: "kid", label: tr("Author key id (press Generate to create one)", "รหัสกุญแจผู้เขียน (กดสร้างเพื่อทำกุญแจใหม่)"), value: suggestKid("author"),
                gen: { label: tr("Generate key", "สร้างกุญแจ"), run: async ctx => { const kid = ctx.get("kid") || suggestKid("author"); const k = await generateAuthorKey(this, kid); if (k) this.toast(`${tr("Key created", "สร้างกุญแจแล้ว")}: ${kid}`); return k ? kid : null; } } } ], tr("Sign", "เซ็น"));
        if (!v || !v.kid) return;
        const r = await tool(this.repo, [ "sign-widget", id, "--kid", v.kid ]);
        if (!r.ok) { this.fail(r); return; }
        this.toast(tr("Signed", "เซ็นแล้ว")); await this.refresh();
        if (r.note) this.alert(tr("Signed, but note:", "เซ็นแล้ว แต่โปรดทราบ:"), r.note);
    }

    _themes(st) {
        const g = this._group(this.pages.themes, tr("Theme packs", "ชุดธีม"), tr("Data-only packs (.gwct): no code, so no permissions or author signatures.", "ชุดข้อมูลล้วน (.gwct) ไม่มีโค้ด จึงไม่มีสิทธิ์/ลายเซ็นผู้เขียน"));
        g.set_header_suffix(btn(tr("Import…", "นำเข้า…"), async () => { const f = await this.pick({ title: "…gwct" }); if (!f) return; const r = await tool(this.repo, [ "import-themepack", f ]); r.ok ? (this.toast(`${tr("Imported", "นำเข้าแล้ว")} ${r.id}`), this.refresh()) : this.fail(r); }));
        if (!st.themepacks.length) g.add(aRow({ title: tr("No theme packs", "ไม่มีชุดธีม") }));
        for (const t of st.themepacks) { const r = aRow({ title: t.name ?? t.file, subtitle: t.ok ? `${t.id} · ${t.widgets} widgets` : (st.problems.find(p => p.target === t.file)?.message ?? "invalid") }); if (!t.ok) r.add_prefix(new Gtk.Image({ icon_name: "dialog-error-symbolic" })); g.add(r); }
    }

    _trust(st) {
        const box = this.pages.trust;
        const ag = this._group(box, tr("Authors", "ผู้เขียน"), tr("People whose own key may sign widgets in this store, limited to the ids listed. Reviewed like code: add authors through a pull request.", "ผู้ที่กุญแจของตนเซ็นวิดเจ็ตได้ จำกัดเฉพาะ id ที่ระบุ"));
        const hb = new Gtk.Box({ spacing: 6 });
        hb.append(btn(tr("My author key…", "กุญแจผู้เขียนของฉัน…"), async () => {
            const v = await this.form(tr("Create an author key", "สร้างกุญแจผู้เขียน"), tr("Stored in your key folder (mode 0600). Send the PUBLIC key to the store maintainer.", "เก็บในโฟลเดอร์กุญแจ ส่งเฉพาะกุญแจสาธารณะให้ผู้ดูแลคลัง"), [ { id: "kid", label: "Key id", value: suggestKid("author"), gen: { label: tr("Suggest", "แนะนำ"), run: () => suggestKid("author") } } ], tr("Create", "สร้าง"));
            if (!v) return; const r = await tool(this.repo, [ "author-keygen", "--kid", v.kid ]); if (!r.ok) return this.fail(r);
            copy(r.pub); this.alert(tr("Author key created", "สร้างกุญแจแล้ว"), `${tr("Public key (copied to clipboard):", "กุญแจสาธารณะ (คัดลอกแล้ว):")}\n${r.pub}\n\n${tr("Fingerprint", "ลายนิ้วมือ")}: ${r.fingerprint}\n${r.keyFile}`);
        }));
        hb.append(btn(tr("Add author…", "เพิ่มผู้เขียน…"), async () => {
            const v = await this.form(tr("Add author", "เพิ่มผู้เขียน"), "", [ { id: "kid", label: "kid" }, { id: "name", label: tr("Name", "ชื่อ") },
                { id: "pub", label: tr("Public key (base64)", "กุญแจสาธารณะ (base64)"),
                  browse: { title: tr("Choose a public key file (.pub.json)", "เลือกไฟล์กุญแจสาธารณะ (.pub.json)"), read: (p, ctx) => { const k = readPubFile(p); if (!k) return null; if (k.kid && !ctx.get("kid")) ctx.set("kid", k.kid); return k.pub; } },
                  gen: { label: tr("Generate key", "สร้างกุญแจ"), run: async ctx => { const kid = ctx.get("kid") || suggestKid("author"); ctx.set("kid", kid); const k = await generateAuthorKey(this, kid); if (k) this.toast(k.created ? `${tr("Key created", "สร้างกุญแจแล้ว")}: ${kid}` : `${tr("Using existing key", "ใช้กุญแจที่มีอยู่")}: ${kid}`); return k?.pub ?? null; } } },
                { id: "ids", label: tr("Allowed ids (comma: me.clock, me.*)", "id ที่อนุญาต (คั่นด้วย , เช่น me.*)") } ], tr("Add", "เพิ่ม"));
            if (!v) return; const r = await tool(this.repo, [ "authors", "add", "--kid", v.kid, "--name", v.name, "--pub", v.pub, "--ids", v.ids ]); r.ok ? this.refresh() : this.fail(r);
        }, { css: [ "suggested-action" ] }));
        ag.set_header_suffix(hb);
        if (!st.authors.length) ag.add(aRow({ title: tr("No authors", "ไม่มีผู้เขียน") }));
        for (const a of st.authors) { const r = aRow({ title: `${a.name} (${a.kid})`, subtitle: a.ids.join(", ") }); r.add_suffix(btn(tr("Remove", "ลบ"), async () => { const x = await tool(this.repo, [ "authors", "remove", "--kid", a.kid ]); x.ok ? this.refresh() : this.fail(x); }, { icon: "user-trash-symbolic" })); ag.add(r); }
        const rg = this._group(box, tr("Revocations", "การเพิกถอน"), tr("Withdraws a version (or all versions) from every user on their next check. Publish after changing.", "ถอนเวอร์ชัน (หรือทุกเวอร์ชัน) จากผู้ใช้ทุกคนในการตรวจครั้งถัดไป อย่าลืมเผยแพร่"));
        rg.set_header_suffix(btn(tr("Revoke…", "เพิกถอน…"), async () => {
            const v = await this.form(tr("Revoke", "เพิกถอน"), tr("Leave the hash empty to revoke every version.", "ไม่ใส่ hash = เพิกถอนทุกเวอร์ชัน"), [ { id: "kind", label: tr("Kind", "ชนิด"), options: [ "widgets", "themepacks" ] }, { id: "id", label: "id" }, { id: "h", label: "hash (32 hex, optional)" }, { id: "reason", label: tr("Reason", "เหตุผล") } ], tr("Revoke", "เพิกถอน"));
            if (!v) return; const a = [ "revoke", "add", "--kind", v.kind, "--id", v.id, "--reason", v.reason ]; if (v.h) a.push("--h", v.h);
            const r = await tool(this.repo, a); r.ok ? this.refresh() : this.fail(r);
        }, { css: [ "destructive-action" ] }));
        if (!st.revoked.length) rg.add(aRow({ title: tr("Nothing revoked", "ยังไม่มีการเพิกถอน") }));
        for (const e of st.revoked) { const r = aRow({ title: `${e.kind}: ${e.id}${e.h ? " @" + e.h.slice(0, 8) : ""}`, subtitle: e.reason ?? "" });
            r.add_suffix(btn(tr("Undo", "ยกเลิก"), async () => { const a = [ "revoke", "remove", "--kind", e.kind, "--id", e.id ]; if (e.h) a.push("--h", e.h); const x = await tool(this.repo, a); x.ok ? this.refresh() : this.fail(x); }, { icon: "edit-undo-symbolic" })); rg.add(r); }
    }

    _settings(st) {
        const c = st.config, g = this._group(this.pages.settings, tr("Store settings", "ตั้งค่าคลัง"), tr("Saved into store.config.json. Invalid values are rejected and nothing is changed.", "บันทึกลง store.config.json ค่าที่ไม่ถูกต้องจะถูกปฏิเสธ"));
        const name = new Adw.EntryRow({ title: tr("Name", "ชื่อ"), text: c.name }), url = new Adw.EntryRow({ title: tr("Public URL", "URL สาธารณะ"), text: c.baseUrl });
        const mir = new Adw.EntryRow({ title: tr("Mirrors (comma separated https URLs ending with /)", "มิเรอร์ (คั่นด้วย , ลงท้าย /)"), text: c.mirrors.join(", ") });
        const tier = new Adw.ComboRow({ title: tr("Kind", "ชนิด"), model: Gtk.StringList.new([ "official", "community" ]), selected: c.tier === "community" ? 1 : 0 });
        const sig = new Adw.SwitchRow({ title: tr("Require an author signature on every widget", "บังคับลายเซ็นผู้เขียนทุกวิดเจ็ต"), active: c.requireAuthorSig });
        const exp = new Adw.SpinRow({ title: tr("Signature validity (days)", "อายุลายเซ็น (วัน)"), adjustment: new Gtk.Adjustment({ lower: 1, upper: 365, step_increment: 1, value: c.expiryDays }) });
        [ name, url, mir, tier, sig, exp ].forEach(w => g.add(w));
        const save = btn(tr("Save settings", "บันทึกการตั้งค่า"), async () => {
            const want = [ [ "name", name.text, c.name ], [ "baseUrl", url.text, c.baseUrl ], [ "mirrors", mir.text.trim(), c.mirrors.join(", ") ], [ "tier", [ "official", "community" ][tier.selected], c.tier ],
                [ "requireAuthorSig", String(sig.active), String(c.requireAuthorSig) ], [ "expiryDays", String(Math.round(exp.value)), String(c.expiryDays) ] ];
            for (const [ k, v, old ] of want) { if (v === old) continue; const r = await tool(this.repo, [ "config", k, v === "" ? " " : v ]); if (!r.ok) { this.fail(r); await this.refresh(); return; } }
            this.toast(tr("Saved", "บันทึกแล้ว")); this.refresh();
        }, { css: [ "suggested-action", "pill" ] }); save.set_halign(Gtk.Align.END); this.pages.settings.append(save);
    }

    _buildPage(st) {
        const box = this.pages.build;
        const run = (fn) => async () => { if (this._busy) return; this._busy = true; this.log.buffer.set_text("", -1); try { await fn(); } finally { this._busy = false; this.refresh(); } };
        const line = t => { const b = this.log.buffer; b.insert(b.get_end_iter(), t + "\n", -1); GLib.idle_add(GLib.PRIORITY_LOW, () => { this.log.scroll_to_mark(b.get_insert(), 0, false, 0, 0); return GLib.SOURCE_REMOVE; }); };
        this.log = new Gtk.TextView({ editable: false, monospace: true, cursor_visible: false, wrap_mode: Gtk.WrapMode.WORD_CHAR, left_margin: 8, top_margin: 8, bottom_margin: 8 });

        // 1) the everyday path: sign in to GitHub once, press Publish
        buildPublishGroup(this, box, st, { line, run });
        const sw = new Gtk.ScrolledWindow({ child: this.log, min_content_height: 220, vexpand: true }); sw.add_css_class("card"); box.append(sw);

        // 2) everything the old page offered, for people who want to do it by hand or let GitHub Actions publish
        const adv = this._group(box, tr("Advanced", "ขั้นสูง"));
        const ex = new Adw.ExpanderRow({ title: tr("Preview build, manual signed build, GitHub Actions (CI)", "build ตัวอย่าง build เซ็นเอง และ GitHub Actions (CI)"), subtitle: tr("Not needed for normal publishing", "ไม่จำเป็นสำหรับการเผยแพร่ปกติ") }); adv.add(ex);
        const first = new Adw.SwitchRow({ title: tr("First publish (no previous revision to continue from)", "เผยแพร่ครั้งแรก (ยังไม่มีรุ่นก่อนหน้า)"), active: false }); ex.add_row(first);
        const row = new Gtk.Box({ spacing: 8, halign: Gtk.Align.START });
        row.append(btn(tr("Build preview", "บิลด์ตัวอย่าง"), run(async () => { const r = await build(this.repo, { signed: false, onLine: line }); line(r.code === 0 ? "✓ preview built into dist/" : `✗ failed (${r.code})`); if (r.code === 0) { const v = await verify(this.repo, { signed: false, onLine: line }); line(v.code === 0 ? "✓ verified" : "✗ verify failed"); } })));
        row.append(btn(tr("Build signed + verify", "บิลด์เซ็น + ตรวจ"), run(async () => { const r = await build(this.repo, { signed: true, firstPublish: first.active, onLine: line }); if (r.code !== 0) { line(`✗ failed (${r.code})`); return; } const v = await verify(this.repo, { signed: true, onLine: line }); line(v.code === 0 ? "✓ signed build verified (dist/)" : "✗ verify failed"); })));
        ex.add_row(aRow({ title: tr("Build into dist/", "สร้างลง dist/"), subtitle: tr("A preview build is unsigned and only for looking at the result.", "บิลด์ตัวอย่างไม่เซ็นและใช้ดูผลเท่านั้น"), child: row }));
        const steps = `git add -A && git commit -m "Update store"\ngit remote add origin git@github.com:USER/REPO.git   # first time only\ngit push -u origin main`;
        const r = aRow({ title: tr("GitHub Actions: 1. Commit and push", "GitHub Actions: 1. commit แล้ว push"), subtitle: steps, subtitle_lines: 5 }); r.add_suffix(btn(tr("Copy", "คัดลอก"), () => { copy(steps); this.toast(tr("Copied", "คัดลอกแล้ว")); }, { icon: "edit-copy-symbolic" })); ex.add_row(r);
        ex.add_row(aRow({ title: tr("2. Add the signing seed as a secret", "2. ใส่ seed เซ็นเป็น secret"), subtitle: tr(`GitHub → Settings → Environments → store-publish → secret GWC_SIGNING_KEY = contents of ${KEY_DIR}/<key>.key`, `GitHub → Settings → Environments → store-publish → secret GWC_SIGNING_KEY = เนื้อหาไฟล์ ${KEY_DIR}/<key>.key`), subtitle_lines: 4 }));
        ex.add_row(aRow({ title: tr("3. Enable Pages (source: GitHub Actions)", "3. เปิด Pages (source: GitHub Actions)"), subtitle: `${st.config.baseUrl}\n${tr("CI then builds and signs on every push and renews the signature weekly. Do not use this together with Publish above on the same repository.", "จากนั้น CI จะ build เซ็น ทุกครั้งที่ push และต่ออายุลายเซ็นทุกสัปดาห์ อย่าใช้ร่วมกับปุ่ม เผยแพร่ ด้านบนใน repository เดียวกัน")}`, subtitle_lines: 5 }));
    }

    // ------------------------------------------------------------------ test helper: PNG of every page
    _shots(dir) {
        GLib.mkdir_with_parents(dir, 0o755);
        const ids = Object.keys(this.pages); let i = 0;
        const step = () => {
            if (i >= ids.length) { this.get_application().quit(); return GLib.SOURCE_REMOVE; }
            const id = ids[i++]; this.stack.set_visible_child_name(id);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                const w = this.get_width(), h = this.get_height(), p = new Gtk.WidgetPaintable({ widget: this }), s = new Gtk.Snapshot(); p.snapshot(s, w, h);
                const tex = this.get_native().get_renderer().render_texture(s.to_node(), null); tex.save_to_png(GLib.build_filenamev([ dir, `${id}.png` ])); step(); return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        };
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, step);
    }
});
