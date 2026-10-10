// publish.js - the "Publish to GitHub" part of the Build & publish page: sign in once, press Publish.
// No terminal, no git, no GitHub secret: the app signs locally and uploads the finished site to the `gh-pages` branch through
// GitHub's web API (backend/gwc_publish.py), then turns on GitHub Pages. The signing key never leaves this computer.
import Adw from "gi://Adw?version=1";
import Gdk from "gi://Gdk?version=4.0";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { build, ghTool, ghUpload, lastBuild, tool, verify } from "./backend.js";
import { tr } from "./i18n.js";
import { aRow } from "./rows.js";

const TOKEN_URL = "https://github.com/settings/tokens/new?scopes=public_repo&description=GWC%20Repo%20Maker";
const GH_IO = /^https:\/\/[^/]*\.github\.io\//i;        // addresses the app may rewrite for you; a custom domain is left alone

const btn = (label, cb, { css = [], icon = null } = {}) => { const b = icon ? Gtk.Button.new_from_icon_name(icon) : Gtk.Button.new_with_label(label); if (icon) b.set_tooltip_text(label); b.set_valign(Gtk.Align.CENTER); css.forEach(c => b.add_css_class(c)); b.connect("clicked", cb); return b; };
const copy = text => Gdk.Display.get_default().get_clipboard().set(text);
const openUri = (win, uri) => Gtk.show_uri(win, uri, Gdk.CURRENT_TIME);
const TARGETS = GLib.build_filenamev([ GLib.get_user_config_dir(), "gwc-repo-maker", "publish-target.json" ]);
const readTargets = () => { try { return JSON.parse(new TextDecoder().decode(Gio.File.new_for_path(TARGETS).load_contents(null)[1])); } catch (_e) { return {}; } };
/** where this repository was last published to: { mode: "repo"|"folder", repo, folder } (kept per local repository folder) */
const loadTarget = dir => readTargets()[dir] ?? {};
const saveTarget = (dir, t) => { try { GLib.mkdir_with_parents(GLib.path_get_dirname(TARGETS), 0o700); Gio.File.new_for_path(TARGETS).replace_contents(new TextEncoder().encode(JSON.stringify({ ...readTargets(), [dir]: t })), null, false, Gio.FileCreateFlags.NONE, null); } catch (_e) { /* remembering is a convenience */ } };
const clearBox = box => { for (let c = box.get_first_child(); c; c = box.get_first_child()) box.remove(c); };

/** repository name to suggest: the one already in the Public URL (https://USER.github.io/NAME/), else the store id */
export const defaultRepoName = st => { const m = /^https:\/\/[^/]+\.github\.io\/([^/]+)\//i.exec(st.config.baseUrl ?? ""); return m ? m[1] : st.config.id; };

/** "Sign in with GitHub" (device flow): shows a code, opens github.com/login/device, polls until the user approves. */
async function signIn(win, done) {
    const r = await ghTool([ "auth-start" ]);
    if (!r.ok) { win.fail(r); return; }
    copy(r.userCode); openUri(win, r.url);
    const d = new Adw.AlertDialog({ heading: tr("Sign in with GitHub", "ล็อกอินด้วย GitHub"),
        body: tr("GitHub is opening in your browser. Type this code there and press Authorize. This window continues by itself.\n(The code is already copied: just paste it.)",
            "กำลังเปิด GitHub ในเบราว์เซอร์ ใส่รหัสนี้แล้วกด Authorize หน้าต่างนี้จะไปต่อเอง\n(คัดลอกรหัสให้แล้ว วางได้เลย)") });
    const code = new Gtk.Label({ label: r.userCode, selectable: true, margin_top: 6, margin_bottom: 6 }); code.add_css_class("title-1"); code.add_css_class("monospace");
    const row = new Gtk.Box({ spacing: 6, halign: Gtk.Align.CENTER });
    row.append(btn(tr("Copy code", "คัดลอกรหัส"), () => copy(r.userCode))); row.append(btn(tr("Open GitHub again", "เปิด GitHub อีกครั้ง"), () => openUri(win, r.url)));
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 }); box.append(code); box.append(row);
    d.set_extra_child(box); d.add_response("cancel", tr("Cancel", "ยกเลิก"));
    let stop = false, timer = 0;
    const schedule = s => { timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.max(1, s), () => { timer = 0; poll(); return GLib.SOURCE_REMOVE; }); };
    const poll = async () => {
        if (stop) return;
        const p = await ghTool([ "auth-poll", "--device-code", r.deviceCode ]);
        if (stop) return;
        if (!p.ok) { d.force_close(); win.fail(p); return; }
        if (p.done) { d.force_close(); win.toast(tr(`Signed in as ${p.login}`, `ล็อกอินเป็น ${p.login} แล้ว`)); done(); return; }
        schedule(Math.max(r.interval, p.wait ?? 0));
    };
    d.connect("closed", () => { stop = true; if (timer) { GLib.source_remove(timer); timer = 0; } });
    d.present(win);
    schedule(r.interval);
}

/** Fallback when the app has no GitHub client id (or the user prefers it): paste a personal access token. */
function tokenSignIn(win, done) {
    const d = new Adw.AlertDialog({ heading: tr("Sign in with a token", "ล็อกอินด้วยโทเคน"),
        body: tr("1. Press “Create token on GitHub”, sign in if asked, scroll down and press “Generate token”.\n2. Copy the token and paste it below.\nIt is saved only on this computer.",
            "1. กด “สร้างโทเคนบน GitHub” ล็อกอินถ้าถูกถาม เลื่อนลงแล้วกด “Generate token”\n2. คัดลอกโทเคนมาวางด้านล่าง\nเก็บไว้ในเครื่องนี้เท่านั้น") });
    const pw = new Adw.PasswordEntryRow({ title: tr("Token", "โทเคน") });
    const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE }); list.add_css_class("boxed-list"); list.append(pw);
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 });
    const link = btn(tr("Create token on GitHub", "สร้างโทเคนบน GitHub"), () => openUri(win, TOKEN_URL), { css: [ "pill" ] }); link.set_halign(Gtk.Align.CENTER);
    box.append(link); box.append(list);
    d.set_extra_child(box); d.add_response("cancel", tr("Cancel", "ยกเลิก")); d.add_response("ok", tr("Sign in", "ล็อกอิน")); d.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED); d.set_default_response("ok");
    d.choose(win, null, async (dlg, res) => {
        if (dlg.choose_finish(res) !== "ok") return;
        const t = pw.text.trim(); if (!t) return;
        const x = await ghTool([ "auth-token" ], { stdin: t });
        if (!x.ok) { win.fail(x); return; }
        win.toast(tr(`Signed in as ${x.login}`, `ล็อกอินเป็น ${x.login} แล้ว`)); done();
    });
}

/**
 * Adds the "Publish" group to `box`.
 * @param win  the main window (uses _group, alert, confirm, fail, toast, repo, _lastPublish)
 * @param st   repository status (tool "status")
 * @param ctx  { line(text): append to the log, run(fn): wrap a handler with the window's busy flag + log reset + refresh }
 *
 * Three destinations: [0] a repository of its own on GitHub (optionally under the user's own domain),
 *                     [1] a folder inside a GitHub Pages site the user already has,
 *                     [2] the user's own web host (private / intranet / any hosting): build + sign here, the user uploads dist/.
 */
export function buildPublishGroup(win, box, st, { line, run }) {
    const g = win._group(box, tr("Publish", "เผยแพร่"),
        tr("Choose where the store goes, then press Publish. No terminal and no git. Your signing key stays on this computer.", "เลือกว่าจะเผยแพร่คลังที่ไหน แล้วกด เผยแพร่ ไม่ต้องใช้เทอร์มินัลหรือ git กุญแจเซ็นอยู่ในเครื่องนี้เท่านั้น"));
    const MODES = [ "repo", "folder", "host" ];

    // --- where
    // what is on screen survives the page rebuild that follows every run (a failed run must not reset the chosen destination)
    const drafts = (win._pubDraft ??= {});
    const saved = { ...loadTarget(win.repo), ...(drafts[win.repo] ?? {}) }, ownDefault = defaultRepoName(st);
    const modeRow = new Adw.ComboRow({ title: tr("Where to publish", "เผยแพร่ที่ไหน"),
        model: Gtk.StringList.new([ tr("GitHub: a repository of its own (simplest)", "GitHub: repository ของคลังเอง (ง่ายที่สุด)"), tr("GitHub: a folder in my existing Pages site", "GitHub: โฟลเดอร์ในไซต์ Pages ที่มีอยู่แล้ว"), tr("My own web host (private, intranet, any hosting)", "โฮสต์ของฉันเอง (ส่วนตัว อินทราเน็ต หรือโฮสต์ใดก็ได้)") ]) });
    modeRow.set_selected(Math.max(0, MODES.indexOf(saved.mode)));        // after the model exists (construct-property order is not guaranteed)
    g.add(modeRow);
    const mode = () => MODES[modeRow.selected];

    // --- GitHub account (modes repo / folder)
    const acct = aRow({ title: tr("GitHub account", "บัญชี GitHub"), subtitle: tr("Checking…", "กำลังตรวจ…") });
    const actions = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER }); acct.add_suffix(actions); g.add(acct);
    let login = null;
    const refreshAcct = async () => {
        const s = await ghTool([ "status" ]);
        clearBox(actions);
        if (!s.ok) { acct.set_subtitle(s.error ?? ""); return; }
        login = s.signedIn ? s.login : null;
        if (login && shown === "folder" && mode() === "folder" && !repoRow.text.trim()) repoRow.set_text(`${login}.github.io`);
        if (s.signedIn) {
            acct.set_subtitle(tr(`Signed in as ${s.login}`, `ล็อกอินเป็น ${s.login}`));
            actions.append(btn(tr("Sign out", "ออกจากระบบ"), async () => { await ghTool([ "signout" ]); win.toast(tr("Signed out on this computer", "ออกจากระบบในเครื่องนี้แล้ว")); refreshAcct(); }, { css: [ "flat" ] }));
        } else {
            acct.set_subtitle(s.authError ?? tr("Not signed in", "ยังไม่ได้ล็อกอิน"));
            if (s.deviceFlow) actions.append(btn(tr("Sign in with GitHub", "ล็อกอินด้วย GitHub"), () => signIn(win, refreshAcct), { css: [ "suggested-action" ] }));
            actions.append(btn(s.deviceFlow ? tr("Use a token…", "ใช้โทเคน…") : tr("Sign in with a token…", "ล็อกอินด้วยโทเคน…"), () => tokenSignIn(win, refreshAcct), { css: s.deviceFlow ? [ "flat" ] : [ "suggested-action" ] }));
        }
    };

    // --- fields
    // the repository field keeps its own text per destination (own repository / existing site), so switching back and forth loses nothing
    const repoText = { repo: saved.repoOwn ?? ownDefault, folder: saved.repoSite ?? "" };
    let shown = mode() === "folder" ? "folder" : "repo";
    const repoRow = new Adw.EntryRow({ title: "", text: repoText[shown] });
    const customRow = new Adw.EntryRow({ title: tr("Your own domain (optional), e.g. store.example.com", "โดเมนของคุณเอง (ไม่บังคับ) เช่น store.example.com"), text: saved.cname ?? "" });
    const folderRow = new Adw.EntryRow({ title: tr("Folder in the site (the store will be at https://…/FOLDER/)", "โฟลเดอร์ในไซต์ (คลังจะอยู่ที่ https://…/โฟลเดอร์/)"), text: saved.folder ?? st.config.id });
    const urlRow = new Adw.EntryRow({ title: tr("Public address of the store (https://…/ ending with /)", "ที่อยู่สาธารณะของคลัง (https://…/ ลงท้ายด้วย /)"), text: saved.url ?? (GH_IO.test(st.config.baseUrl ?? "") ? "" : st.config.baseUrl ?? "") });
    [ repoRow, customRow, folderRow, urlRow ].forEach(w => g.add(w));
    const siteDefault = () => login ? `${login}.github.io` : "";
    const pubRow = aRow({ title: tr("Publish", "เผยแพร่") });
    const syncMode = switched => {
        const m = mode();
        acct.set_visible(m !== "host"); repoRow.set_visible(m !== "host"); customRow.set_visible(m === "repo"); folderRow.set_visible(m === "folder"); urlRow.set_visible(m === "host");
        repoRow.set_title(m === "folder" ? tr("Existing GitHub Pages repository (NAME or OWNER/NAME)", "repository ของไซต์ GitHub Pages ที่มีอยู่ (ชื่อ หรือ เจ้าของ/ชื่อ)") : tr("Repository name (created on GitHub if it does not exist yet)", "ชื่อ repository (ถ้ายังไม่มี จะสร้างให้บน GitHub)"));
        pubRow.set_subtitle(m === "host" ? tr("Builds, signs and checks here. You then upload the files to your own host.", "สร้าง เซ็น และตรวจในเครื่องนี้ จากนั้นคุณอัปโหลดไฟล์ไปยังโฮสต์ของคุณเอง")
            : tr("Builds, signs, checks and uploads in one go, then turns on GitHub Pages where needed.", "สร้าง เซ็น ตรวจ และอัปโหลดในครั้งเดียว แล้วเปิด GitHub Pages ให้ถ้าจำเป็น"));
        if (m === "host") return;
        const now = m === "folder" ? "folder" : "repo";
        if (switched && now !== shown) { repoText[shown] = repoRow.text; shown = now; repoRow.set_text(repoText[now] || (now === "folder" ? siteDefault() : ownDefault)); }
    };
    modeRow.connect("notify::selected", () => syncMode(true)); syncMode(false);
    const snap = () => { repoText[shown] = repoRow.text; drafts[win.repo] = { mode: mode(), repoOwn: repoText.repo, repoSite: repoText.folder, folder: folderRow.text, cname: customRow.text, url: urlRow.text }; };
    modeRow.connect("notify::selected", snap); [ repoRow, customRow, folderRow, urlRow ].forEach(w => w.connect("changed", snap));
    refreshAcct();

    // --- publish
    const guard = () => {
        const key = st.keys.find(k => k.active);
        if (!st.widgets.length && !st.themepacks.length) { win.alert(tr("Nothing to publish yet", "ยังไม่มีอะไรให้เผยแพร่"), tr("Add at least one widget or theme pack first (Widgets, Theme packs or Sources page).", "เพิ่มวิดเจ็ตหรือชุดธีมอย่างน้อยหนึ่งอย่างก่อน (หน้า วิดเจ็ต ชุดธีม หรือ ต้นทาง)")); return null; }
        if (st.errors > 0) { win.alert(tr("Fix the problems first", "แก้ปัญหาก่อน"), tr(`The Overview page lists ${st.errors} error(s) that would stop the build.`, `หน้า ภาพรวม แสดงข้อผิดพลาด ${st.errors} รายการที่จะทำให้ build ไม่ผ่าน`)); return null; }
        if (!key?.privateKey) { win.alert(tr("No signing key on this computer", "ไม่มีกุญแจเซ็นในเครื่องนี้"), tr("Create or import the store's signing key first (Overview page, or menu → Signing keys).", "สร้างหรือนำเข้ากุญแจเซ็นของคลังก่อน (หน้า ภาพรวม หรือเมนู → กุญแจเซ็น)")); return null; }
        return key;
    };
    const setAddress = async (want) => {                 // the signed manifest carries the address, so it must be right BEFORE building
        if (st.config.baseUrl === want) return true;
        const c = await tool(win.repo, [ "config", "baseUrl", want ]);
        if (!c.ok) { line(`✗ ${c.error}`); win.fail(c); return false; }
        line(tr(`✓ Public URL set to ${want}`, `✓ ตั้ง URL สาธารณะเป็น ${want}`)); return true;
    };
    const buildAndVerify = async (first, step) => {
        line(step[0]);
        const seen = [], onLine = t => { seen.push(t); line(t); };
        const b = await build(win.repo, { signed: true, firstPublish: first, onLine });
        if (b.code !== 0) {
            line(tr("✗ build failed", "✗ build ไม่สำเร็จ"));
            if (seen.some(t => /returned 404/.test(t))) line(tr("The previous publish is probably not online yet. Wait 1-2 minutes and press Publish again.", "น่าจะเป็นเพราะรอบก่อนหน้ายังไม่ขึ้นออนไลน์ รอ 1-2 นาทีแล้วกด เผยแพร่ อีกครั้ง"));
            win.alert(tr("Build failed", "build ไม่สำเร็จ"), tr("The log below shows why.", "ดูเหตุผลในบันทึกด้านล่าง")); return false;
        }
        line(step[1]);
        const v = await verify(win.repo, { signed: true, onLine: line });
        if (v.code !== 0) { line(tr("✗ verification failed, nothing was uploaded", "✗ ตรวจไม่ผ่าน ยังไม่ได้อัปโหลดอะไร")); win.alert(tr("Verification failed", "ตรวจไม่ผ่าน"), tr("The log below shows why. Nothing was uploaded.", "ดูเหตุผลในบันทึกด้านล่าง ยังไม่ได้อัปโหลดอะไร")); return false; }
        return true;
    };

    const remember = m => {
        repoText[shown] = repoRow.text.trim();
        saveTarget(win.repo, { mode: m, repoOwn: repoText.repo, repoSite: repoText.folder, folder: folderRow.text.trim(), cname: customRow.text.trim(), url: urlRow.text.trim() });
    };
    const publishGithub = async (key) => {
        const m = mode(), inFolder = m === "folder", name = repoRow.text.trim(), folder = folderRow.text.trim(), repo = win.repo;
        if (!name) { win.alert(tr("Repository name is empty", "ยังไม่ได้ใส่ชื่อ repository"), ""); return; }
        if (inFolder && !folder) { win.alert(tr("Folder name is empty", "ยังไม่ได้ใส่ชื่อโฟลเดอร์"), tr("Choose the folder of your site that will hold the store, for example gwc-store.", "ใส่ชื่อโฟลเดอร์ในไซต์ที่จะเก็บคลัง เช่น gwc-store")); return; }
        let cname = null;
        const cv = customRow.text.trim();
        if (m === "repo" && cv) {
            const mm = /^(?:https:\/\/)?([A-Za-z0-9.-]+)\/?$/.exec(cv);
            if (!mm) { win.alert(tr("That is not a domain name", "นี่ไม่ใช่ชื่อโดเมน"), tr("Type only the host name, for example store.example.com", "ใส่เฉพาะชื่อโฮสต์ เช่น store.example.com")); return; }
            cname = mm[1].toLowerCase();
        }
        line(tr("1/4  Checking GitHub…", "1/4  ตรวจ GitHub…"));
        const prep = await ghTool([ "prepare", "--repo-name", name, ...(inFolder ? [ "--folder", folder ] : []) ]);
        if (!prep.ok) { line(`✗ ${prep.error}`); win.fail(prep); return; }
        if (prep.warning) line(`⚠ ${prep.warning}`);
        if (prep.created) line(tr(`✓ created the public repository ${prep.owner}/${prep.repo}`, `✓ สร้าง repository สาธารณะ ${prep.owner}/${prep.repo} แล้ว`));
        const cur = st.config.baseUrl;
        if (cname) { if (!await setAddress(`https://${cname}/`)) return; }
        else if (cur !== prep.pagesUrl) {
            if (inFolder || GH_IO.test(cur)) { if (!await setAddress(prep.pagesUrl)) return; }          // the site's own address is authoritative; a custom address is kept for a repository of its own
            else line(tr(`Keeping your custom address ${cur}`, `ใช้ที่อยู่ที่คุณตั้งไว้ ${cur}`));
        }
        if (!await buildAndVerify(prep.prevSeq === null || prep.prevSeq === undefined, [ tr("2/4  Building and signing…", "2/4  สร้างและเซ็น…"), tr("3/4  Checking the result…", "3/4  ตรวจผลลัพธ์…") ])) return;
        line(tr("4/4  Uploading to GitHub…", "4/4  อัปโหลดขึ้น GitHub…"));
        const u = await ghUpload(repo, name, { folder: inFolder ? folder : null, cname, onLine: line });
        if (!u.ok) { line(`✗ ${u.error}`); win.fail(u); return; }
        if (u.warning) line(`⚠ ${u.warning}`);
        line(tr(`✓ Published (version ${u.seq}). It is usually online within 1-3 minutes: ${u.url}`, `✓ เผยแพร่แล้ว (รุ่น ${u.seq}) ปกติขึ้นออนไลน์ใน 1-3 นาที: ${u.url}`));
        if (inFolder) line(tr(`Only the folder ${u.folder}/ of ${prep.owner}/${prep.repo} was changed. The rest of your site is untouched.`, `แก้เฉพาะโฟลเดอร์ ${u.folder}/ ของ ${prep.owner}/${prep.repo} ส่วนอื่นของไซต์ไม่ถูกแตะ`));
        remember(m);
        win._lastPublish = { repo, url: u.url, seq: u.seq, fingerprint: key.fingerprint };
    };

    const publishOwnHost = async (key) => {
        const repo = win.repo, url = urlRow.text.trim();
        if (!/^https:\/\/[^\s?#]+\/$/.test(url)) { win.alert(tr("The address must start with https:// and end with /", "ที่อยู่ต้องขึ้นต้นด้วย https:// และลงท้ายด้วย /"), tr("For example https://store.example.com/ or https://example.com/widgets/", "เช่น https://store.example.com/ หรือ https://example.com/widgets/")); return; }
        line(tr("1/3  Checking what is online at that address…", "1/3  ตรวจว่าที่อยู่นั้นมีอะไรออนไลน์อยู่…"));
        const pr = await ghTool([ "probe", "--url", url ]);
        if (!pr.ok) { line(`✗ ${pr.error}`); win.fail(pr); return; }
        let first = false;
        if (pr.state === "unreachable") {
            line(`✗ ${pr.error}`);
            win.alert(tr("Cannot check what is online", "ตรวจไม่ได้ว่ามีอะไรออนไลน์อยู่"), `${pr.error}\n\n${tr("Nothing was built. Check the address and that this computer can reach it, then try again.", "ยังไม่ได้ build อะไร ตรวจที่อยู่และว่าเครื่องนี้เข้าถึงได้ แล้วลองใหม่")}`); return;
        }
        if (pr.state === "none") {
            const yes = await win.confirm(tr("Is this the first version?", "นี่คือรุ่นแรกใช่ไหม"),
                tr(`No store is online at ${url} yet. Publish this as the FIRST version?\n\nIf a store is already online under this address (and only temporarily unavailable), answer Cancel: starting again from version 1 would make users' devices refuse your updates.`,
                    `ยังไม่มีคลังออนไลน์ที่ ${url} ให้เผยแพร่นี่เป็นรุ่นแรกใช่ไหม\n\nถ้ามีคลังออนไลน์อยู่แล้วที่ที่อยู่นี้ (แค่ใช้งานไม่ได้ชั่วคราว) ให้กด ยกเลิก เพราะการเริ่มรุ่นที่ 1 ใหม่ จะทำให้เครื่องผู้ใช้ปฏิเสธอัปเดตของคุณ`),
                tr("Yes, first version", "ใช่ รุ่นแรก"));
            if (!yes) { line(tr("Cancelled: nothing was built.", "ยกเลิก: ยังไม่ได้ build อะไร")); return; }
            first = true;
        } else line(tr(`A store (version ${pr.seq}) is online there: this build continues from it.`, `มีคลัง (รุ่น ${pr.seq}) ออนไลน์อยู่ที่นั่น build นี้จะต่อจากรุ่นนั้น`));
        if (!await setAddress(url)) return;                                   // only after the check: a wrong address must not change the repository
        if (!await buildAndVerify(first, [ tr("2/3  Building and signing…", "2/3  สร้างและเซ็น…"), tr("3/3  Checking the result…", "3/3  ตรวจผลลัพธ์…") ])) return;
        const dist = GLib.build_filenamev([ repo, "dist" ]), lb = lastBuild(repo);
        line(tr(`✓ Ready (version ${lb?.seq}). Upload EVERYTHING inside ${dist} to ${url}`, `✓ พร้อมแล้ว (รุ่น ${lb?.seq}) อัปโหลดทุกอย่างในโฟลเดอร์ ${dist} ไปที่ ${url}`));
        remember("host");
        win._lastPublish = { repo, url, seq: lb?.seq, fingerprint: key.fingerprint, ownHost: true, dist };
    };

    pubRow.add_suffix(btn(tr("Publish", "เผยแพร่"), run(async () => {
        const key = guard(); if (!key) return;
        await (mode() === "host" ? publishOwnHost(key) : publishGithub(key));
    }), { css: [ "suggested-action", "pill" ] }));
    g.add(pubRow);

    // --- what the user needs after publishing (survives the page rebuild that follows a run)
    const L = win._lastPublish?.repo === win.repo ? win._lastPublish : null, last = lastBuild(win.repo);
    if (L?.ownHost) {
        const r0 = aRow({ title: tr("Upload the contents of this folder to your web host", "อัปโหลดเนื้อหาในโฟลเดอร์นี้ไปยังโฮสต์ของคุณ"), subtitle: `${L.dist}\n${tr(`so that ${L.url}store.json answers. Include hidden files if your upload tool shows them.`, `ให้ ${L.url}store.json ตอบได้ รวมไฟล์ที่ซ่อนอยู่ถ้าเครื่องมืออัปโหลดของคุณแสดง`)}`, subtitle_selectable: true, subtitle_lines: 4 });
        r0.add_suffix(btn(tr("Open folder", "เปิดโฟลเดอร์"), () => openUri(win, `file://${L.dist}`), { icon: "folder-open-symbolic" })); r0.add_suffix(btn(tr("Copy path", "คัดลอกพาธ"), () => { copy(L.dist); win.toast(tr("Copied", "คัดลอกแล้ว")); }, { icon: "edit-copy-symbolic" })); g.add(r0);
    } else if (L) {
        const r1 = aRow({ title: tr("Your store address", "ที่อยู่คลังของคุณ"), subtitle: `${L.url}\n${tr("The first time, GitHub can take 1-3 minutes before it appears.", "ครั้งแรก GitHub อาจใช้เวลา 1-3 นาทีกว่าจะขึ้น")}`, subtitle_selectable: true, subtitle_lines: 3 });
        r1.add_suffix(btn(tr("Open", "เปิด"), () => openUri(win, L.url), { icon: "web-browser-symbolic" })); r1.add_suffix(btn(tr("Copy", "คัดลอก"), () => { copy(L.url); win.toast(tr("Copied", "คัดลอกแล้ว")); }, { icon: "edit-copy-symbolic" })); g.add(r1);
    }
    if (L) {
        const r2 = aRow({ title: tr("Fingerprint to give to users who add your store", "ลายนิ้วมือที่ต้องส่งให้ผู้ใช้ที่จะเพิ่มคลังของคุณ"), subtitle: L.fingerprint, subtitle_selectable: true });
        r2.add_suffix(btn(tr("Copy", "คัดลอก"), () => { copy(L.fingerprint); win.toast(tr("Copied", "คัดลอกแล้ว")); }, { icon: "edit-copy-symbolic" })); g.add(r2);
    }
    if (last) {
        const days = Math.floor((Date.parse(last.expires) - Date.now()) / 864e5), until = last.expires.slice(0, 10);
        g.add(aRow({ title: tr(`Last build: version ${last.seq}`, `build ล่าสุด: รุ่น ${last.seq}`),
            subtitle: days < 0 ? tr(`The signature expired on ${until}. Press Publish to renew it.`, `ลายเซ็นหมดอายุเมื่อ ${until} กด เผยแพร่ เพื่อต่ออายุ`)
                : days < 30 ? tr(`The signature is valid until ${until} (${days} days). Press Publish again before then, or users will see a notice that the store may be abandoned.`, `ลายเซ็นใช้ได้ถึง ${until} (อีก ${days} วัน) กด เผยแพร่ อีกครั้งก่อนหน้านั้น ไม่งั้นผู้ใช้จะเห็นแจ้งเตือนว่าคลังอาจถูกทิ้งร้าง`)
                    : tr(`The signature is valid until ${until}. Publishing again renews it.`, `ลายเซ็นใช้ได้ถึง ${until} เผยแพร่ซ้ำเพื่อต่ออายุ`), subtitle_lines: 3 }));
    }
    return g;
}
