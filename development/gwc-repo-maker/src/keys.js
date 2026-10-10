// keys.js - signing key manager. Works with or without an open repository.
// Keys are Ed25519 (the same signature family the Widget Center client verifies). They are NOT PGP/OpenPGP keys: the client has
// no OpenPGP parser, so a PGP key could not be used here. The private half is a 32-byte seed in KEY_DIR (mode 0600).
import Adw from "gi://Adw?version=1";
import Gdk from "gi://Gdk?version=4.0";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { BUNDLED_TOOLS, KEY_DIR, listKeyIds, tool } from "./backend.js";
import { tr } from "./i18n.js";
import { aRow } from "./rows.js";

const run = (win, args) => win.repo ? tool(win.repo, args) : tool(null, args, { initFrom: BUNDLED_TOOLS });
const copy = text => Gdk.Display.get_default().get_clipboard().set(text);
const iconBtn = (tip, icon, cb, css = []) => { const b = Gtk.Button.new_from_icon_name(icon); b.set_tooltip_text(tip); b.set_valign(Gtk.Align.CENTER); b.add_css_class("flat"); css.forEach(c => b.add_css_class(c)); b.connect("clicked", cb); return b; };
const clear = box => { for (let c = box.get_first_child(); c; c = box.get_first_child()) box.remove(c); };
const safeId = s => String(s || "me").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "me";

/** A key id that is not used yet: store-2026-a, store-2026-b, ... / <user>-1, <user>-2, ... */
export function suggestKid(kind) {
    const have = new Set(listKeyIds());
    if (kind === "store") {
        const y = new Date().getFullYear();
        for (const l of "abcdefghijklmnopqrstuvwxyz") if (!have.has(`store-${y}-${l}`)) return `store-${y}-${l}`;
        return `store-${y}-${GLib.random_int_range(100, 999)}`;
    }
    const base = safeId(GLib.get_user_name());
    for (let n = 1; n < 100; n++) if (!have.has(`${base}-${n}`)) return `${base}-${n}`;
    return `${base}-${GLib.random_int_range(100, 999)}`;
}

/** Read a public key from a file the user picked: our <kid>.pub.json, or a file holding just the base64 key. -> { pub, kid? } | null */
export function readPubFile(path) {
    try {
        const text = new TextDecoder().decode(Gio.File.new_for_path(path).load_contents(null)[1]).trim();
        if (text.length > 4096) return null;
        try { const j = JSON.parse(text); if (j && typeof j.pub === "string") return { pub: j.pub.trim(), kid: typeof j.kid === "string" ? j.kid : undefined }; } catch (_e) { /* not JSON */ }
        return /^[A-Za-z0-9+/]{43}=$/.test(text) ? { pub: text } : null;
    } catch (_e) { return null; }
}

/** Generate an author key (private half goes to the key folder) and return its public key. If a key with that id exists, reuse it. */
export async function generateAuthorKey(win, kid) {
    let r = await run(win, [ "author-keygen", "--kid", kid ]);
    if (r.ok) return { pub: r.pub, fingerprint: r.fingerprint, created: true };
    if (/already exists/.test(r.error ?? "")) {
        const l = await run(win, [ "list-keys" ]), k = l.ok ? l.keys.find(x => x.kid === kid && x.pub) : null;
        if (k) return { pub: k.pub, fingerprint: k.fingerprint, created: false };
    }
    win.fail(r); return null;
}

export function showKeysDialog(win) {
    const dlg = new Adw.Dialog({ title: tr("Signing keys", "กุญแจเซ็น"), content_width: 600, content_height: 620 });
    const tv = new Adw.ToolbarView(), hb = new Adw.HeaderBar();
    const create = Gtk.Button.new_with_label(tr("Create key…", "สร้างกุญแจ…")); create.add_css_class("suggested-action");
    const imp = Gtk.Button.new_with_label(tr("Import…", "นำเข้า…")); imp.set_tooltip_text(tr("Browse for an existing private key file", "เลือกไฟล์กุญแจส่วนตัวที่มีอยู่แล้ว"));
    hb.pack_start(create); hb.pack_start(imp); tv.add_top_bar(hb);
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 12, margin_bottom: 18, margin_start: 18, margin_end: 18 });
    tv.set_content(new Gtk.ScrolledWindow({ child: box, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER })); dlg.set_child(tv);

    const note = new Gtk.Label({ wrap: true, xalign: 0, use_markup: false, label: tr(
        "These are Ed25519 signing keys, not PGP/OpenPGP keys: Widget Center verifies Ed25519 signatures only. The private key never leaves this computer; share only the public key or its fingerprint.",
        "กุญแจเหล่านี้เป็นกุญแจเซ็นแบบ Ed25519 ไม่ใช่กุญแจ PGP/OpenPGP เพราะ Widget Center ตรวจเฉพาะลายเซ็น Ed25519 กุญแจส่วนตัวอยู่ในเครื่องนี้เท่านั้น แชร์ได้เฉพาะกุญแจสาธารณะหรือลายนิ้วมือ") });
    note.add_css_class("dim-label");

    async function reload() {
        clear(box); box.append(note);
        const r = await run(win, [ "list-keys" ]);
        const g = new Adw.PreferencesGroup({ title: tr("Keys on this computer", "กุญแจในเครื่องนี้"), description: r.ok ? r.keyDir : "" });
        box.append(g);
        if (!r.ok) { g.add(aRow({ title: tr("Could not read the key folder", "อ่านโฟลเดอร์กุญแจไม่ได้"), subtitle: r.error })); return; }
        if (!r.keys.length) g.add(aRow({ title: tr("No keys yet", "ยังไม่มีกุญแจ"), subtitle: tr("Create one to sign widgets or a store.", "สร้างกุญแจเพื่อเซ็นวิดเจ็ตหรือคลัง") }));
        for (const k of r.keys) {
            const row = aRow({ title: k.kid, subtitle: k.problem || k.fingerprint, subtitle_selectable: !k.problem });
            if (k.problem) { row.add_prefix(new Gtk.Image({ icon_name: "dialog-warning-symbolic" })); row.set_subtitle_lines(4); }
            else {
                row.add_suffix(iconBtn(tr("Copy public key", "คัดลอกกุญแจสาธารณะ"), "edit-copy-symbolic", () => { copy(k.pub); win.toast(tr("Public key copied", "คัดลอกกุญแจสาธารณะแล้ว")); }));
                row.add_suffix(iconBtn(tr("Save public key file…", "บันทึกไฟล์กุญแจสาธารณะ…"), "document-save-symbolic", () => exportKey(win, k.kid, true)));
                row.add_suffix(iconBtn(tr("Back up private key…", "สำรองกุญแจส่วนตัว…"), "document-send-symbolic", () => exportKey(win, k.kid, false), [ "destructive-action" ]));
            }
            g.add(row);
        }
        const fr = aRow({ title: tr("Open key folder", "เปิดโฟลเดอร์กุญแจ"), subtitle: KEY_DIR, activatable: true });
        fr.add_prefix(new Gtk.Image({ icon_name: "folder-symbolic" }));
        fr.connect("activated", () => { GLib.mkdir_with_parents(KEY_DIR, 0o700); Gtk.show_uri(win, GLib.filename_to_uri(KEY_DIR, null), Gdk.CURRENT_TIME); });
        g.add(fr);
    }
    create.connect("clicked", () => createKey(win, reload));
    imp.connect("clicked", () => importKey(win, reload));
    reload();
    dlg.present(win);
    return dlg;
}

async function exportKey(win, kid, pub) {
    if (!pub) {
        const ok = await new Promise(res => {
            const d = new Adw.AlertDialog({ heading: tr("Back up the private key?", "สำรองกุญแจส่วนตัว?"), body: tr(
                "Anyone who has this file can sign as you. Save it somewhere offline or encrypted, and never put it in a repository.",
                "ใครมีไฟล์นี้จะเซ็นแทนคุณได้ เก็บไว้ในที่ออฟไลน์หรือเข้ารหัส และห้ามใส่ลงในคลัง") });
            d.add_response("cancel", tr("Cancel", "ยกเลิก")); d.add_response("ok", tr("Choose folder…", "เลือกโฟลเดอร์…")); d.set_response_appearance("ok", Adw.ResponseAppearance.DESTRUCTIVE);
            d.choose(win, null, (x, r) => res(x.choose_finish(r) === "ok"));
        });
        if (!ok) return;
    }
    const dest = await win.pick({ folder: true, title: pub ? tr("Save the public key to…", "บันทึกกุญแจสาธารณะไว้ที่…") : tr("Back up the private key to…", "สำรองกุญแจส่วนตัวไว้ที่…") });
    if (!dest) return;
    const r = await run(win, [ "export-key", kid, dest, ...(pub ? [ "--public" ] : []) ]);
    r.ok ? win.toast(`${tr("Saved", "บันทึกแล้ว")}: ${r.file}`) : win.fail(r);
}

async function importKey(win, reload) {
    const f = await win.pick({ title: tr("Choose a private key file (.key)", "เลือกไฟล์กุญแจส่วนตัว (.key)") });
    if (!f) return;
    const base = GLib.path_get_basename(f).replace(/\.key$/, "");
    const v = await win.form(tr("Import a key", "นำเข้ากุญแจ"), tr("The file is copied into your key folder (mode 0600); the original is left where it is.", "ไฟล์จะถูกคัดลอกเข้าโฟลเดอร์กุญแจ (สิทธิ์ 0600) ไฟล์เดิมไม่ถูกแก้"),
        [ { id: "kid", label: tr("Key id (letters, digits . _ -)", "รหัสกุญแจ (ตัวอักษร ตัวเลข . _ -)"), value: safeId(base) } ], tr("Import", "นำเข้า"));
    if (!v || !v.kid) return;
    const r = await run(win, [ "import-key", f, "--kid", v.kid ]);
    if (!r.ok) { win.fail(r); return; }
    win.toast(`${tr("Imported", "นำเข้าแล้ว")}: ${r.kid}`); await reload();
}

async function createKey(win, reload) {
    const purposes = [ tr("Author key (sign my widgets)", "กุญแจผู้เขียน (เซ็นวิดเจ็ตของฉัน)") ];
    if (win.repo) purposes.push(tr("Store signing key (this repository)", "กุญแจเซ็นคลัง (คลังที่เปิดอยู่)"));
    const v = await win.form(tr("Create a signing key", "สร้างกุญแจเซ็น"), tr(
        "Generates an Ed25519 key pair. The private key is stored in your key folder with mode 0600.",
        "สร้างคู่กุญแจ Ed25519 กุญแจส่วนตัวเก็บในโฟลเดอร์กุญแจ สิทธิ์ 0600"), [
        { id: "kid", label: tr("Key id (letters, digits . _ -)", "รหัสกุญแจ (ตัวอักษร ตัวเลข . _ -)"), value: suggestKid("author"),
          gen: { label: tr("Suggest", "แนะนำ"), run: ctx => suggestKid(ctx.get("purpose") === purposes[1] ? "store" : "author") } },
        { id: "purpose", label: tr("Purpose", "ใช้เพื่อ"), options: purposes } ], tr("Create", "สร้าง"));
    if (!v || !v.kid) return;
    const store = v.purpose === purposes[1];
    const r = store ? await tool(win.repo, [ "keygen", "--kid", v.kid, "--activate" ]) : await run(win, [ "author-keygen", "--kid", v.kid ]);
    if (!r.ok) { win.fail(r); return; }
    copy(r.pub);
    const d = new Adw.AlertDialog({ heading: tr("Key created", "สร้างกุญแจแล้ว"), body: [
        `${tr("Fingerprint", "ลายนิ้วมือ")}: ${r.fingerprint}`, "",
        store ? tr("Added to this store's trusted keys and set as the active signing key. Commit store.config.json.", "เพิ่มเข้ากุญแจที่เชื่อถือของคลังและตั้งเป็นกุญแจเซ็นแล้ว อย่าลืม commit store.config.json")
              : tr("Send the public key below to the store maintainer so they can add you as an author.", "ส่งกุญแจสาธารณะด้านล่างให้ผู้ดูแลคลังเพื่อเพิ่มคุณเป็นผู้เขียน"),
        "", `${tr("Private key file", "ไฟล์กุญแจส่วนตัว")}: ${r.keyFile}`, tr("The public key is on your clipboard.", "คัดลอกกุญแจสาธารณะไว้ในคลิปบอร์ดแล้ว") ].join("\n") });
    const pubLbl = new Gtk.Label({ label: r.pub, selectable: true, wrap: true, wrap_mode: 2 /* WORD_CHAR */, xalign: 0 }); pubLbl.add_css_class("monospace");
    d.set_extra_child(pubLbl); d.add_response("ok", "OK"); d.present(win);
    await reload(); if (store) win.refresh();
}
