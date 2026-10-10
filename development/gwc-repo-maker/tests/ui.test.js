// UI test under real GJS + GTK4 (run with xvfb-run): drives the Sources page and the key dialog by activating their real buttons.
//   GWC_KEY_DIR=$(mktemp -d) XDG_CONFIG_HOME=$(mktemp -d) xvfb-run -a gjs -m tests/ui.test.js
import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { BUNDLED_TOOLS, tool } from "../src/backend.js";
import { Window } from "../src/window.js";
import { readPubFile, showKeysDialog, suggestKid } from "../src/keys.js";

let fails = 0;
const ok = (c, m) => { print(`${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
const until = async (f, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (f()) return true; await sleep(100); } return false; };
function find(w, pred) { for (let c = w.get_first_child?.(); c; c = c.get_next_sibling()) { if (pred(c)) return c; const r = find(c, pred); if (r) return r; } return null; }
const button = (root, label) => find(root, w => w instanceof Gtk.Button && (w.label === label || w.tooltip_text === label));

const tmp = GLib.dir_make_tmp("gwcui-XXXXXX");
const mk = p => GLib.mkdir_with_parents(p, 0o755), wr = (p, s) => Gio.File.new_for_path(p).replace_contents(new TextEncoder().encode(s), null, false, 0, null);
mk(`${tmp}/src/ext/widgets`); mk(`${tmp}/src/ext/themepacks`);
wr(`${tmp}/src/ext/themepacks/Neon.gwct`, JSON.stringify({ format: "gwct", packMeta: { id: "neon", name: "Neon", catalog: "other" }, widgets: [ {} ] }));

const app = new Adw.Application({ application_id: "io.github.xenlism.GwcRepoMakerTest", flags: Gio.ApplicationFlags.NON_UNIQUE });
app.connect("activate", async () => {
    app.hold();                      // no window exists until the repo is initialised
    try {
        const repo = `${tmp}/repo`;
        let r = await tool(null, [ "init", repo, "--id", "t-store", "--name", "T", "--base-url", "https://x.github.io/t/", "--kid", "t-1" ], { initFrom: BUNDLED_TOOLS });
        ok(r.ok, "init repo " + (r.error ?? ""));
        // a realistic widget for the source folder: let the tool generate it in a scratch repo, then copy the folder
        await tool(null, [ "init", `${tmp}/scratch`, "--id", "scratch", "--name", "S", "--base-url", "https://x.github.io/s/", "--kid", "s-1" ], { initFrom: BUNDLED_TOOLS });
        r = await tool(`${tmp}/scratch`, [ "new-widget", "--id", "me.clock", "--name", "Clock", "--author", "Me", "--catalog", "clock" ]);
        ok(r.ok, "scratch widget " + (r.error ?? ""));
        GLib.spawn_command_line_sync(`cp -r ${tmp}/scratch/widgets/me.clock ${tmp}/src/ext/widgets/me.clock`.replace("/src/ext/widgets/me.clock", "/src/ext/widgets/"));
        const win = new Window(app, { repo: null, shots: null }); win.present();
        await win.openRepo(repo);

        // --- Sources: scan -> import selected
        win.pick = async () => `${tmp}/src`;
        win.stack.set_visible_child_name("sources");
        ok(await until(() => button(win.pages.sources, "Browse…")), "sources page has Browse…");
        button(win.pages.sources, "Browse…").emit("clicked");
        ok(await until(() => button(win.pages.sources, "Import selected")?.sensitive), "scan lists items and enables Import selected");
        ok(!!find(win.pages.sources, w => w instanceof Gtk.Label && w.label === "Clock" || (w.label ?? "") === "Clock"), "widget 'Clock' listed");
        win.alert = (h, b) => { win._report = { h, b }; };                // capture the report instead of showing it
        button(win.pages.sources, "Import selected").emit("clicked");
        ok(await until(() => win._report), "import finished with a report");
        ok(/Imported 2 \/ 2/.test(win._report.h), `report: ${win._report.h} :: ${win._report.b}`);
        const st = await tool(repo, [ "status" ]);
        ok(st.widgets.some(w => w.id === "me.clock") && st.themepacks.some(t => t.id === "neon"), "widget and theme pack are now in the repository");
        ok(await until(() => find(win.pages.sources, w => w.label === "in repository")), "page now shows them as 'in repository'");

        // --- Keys dialog: create an author key through the real button; no repo-free path needed here, repo is open
        win.form = async () => ({ kid: "ui-author", purpose: "Author key (sign my widgets)" });
        win.alert = () => {};
        const dlg = showKeysDialog(win);
        ok(await until(() => button(dlg, "Create key…")), "keys dialog opens");
        button(dlg, "Create key…").emit("clicked");
        ok(await until(() => find(dlg, w => w.title === "ui-author")), "new key shows up in the list");
        const k = await tool(null, [ "list-keys" ], { initFrom: BUNDLED_TOOLS });
        ok(k.keys.some(x => x.kid === "ui-author" && x.fingerprint), "list-keys reports it with a fingerprint");

        // --- back up the public key through the dialog's own button
        win.pick = async () => tmp;
        const row = find(dlg, w => w.title === "ui-author");
        button(row, "Save public key file…").emit("clicked");
        ok(await until(() => GLib.file_test(`${tmp}/ui-author.pub.json`, GLib.FileTest.EXISTS)), "public key file written");

        // --- real form(): Browse… fills a field from the file chooser, Generate key creates a key and fills the public key
        const origForm = Window.prototype.form;                       // the stub above replaced win.form on the instance only
        delete win.form;
        const dlgOf = () => win.formDialog;
        const entry = (root, title) => find(root, w => w instanceof Adw.EntryRow && w.title === title);
        // 1. Add author: Generate key
        let pending = win.form("Add author", "", [ { id: "kid", label: "kid", value: "gen-author" }, { id: "pub", label: "Public key (base64)",
            browse: { title: "pub", read: (p, ctx) => { const k = readPubFile(p); if (!k) return null; if (k.kid && !ctx.get("kid")) ctx.set("kid", k.kid); return k.pub; } },
            gen: { label: "Generate key", run: async ctx => { const k = await (await import("../src/keys.js")).generateAuthorKey(win, ctx.get("kid")); return k?.pub ?? null; } } } ], "Add");
        ok(await until(() => dlgOf() && button(dlgOf(), "Generate key")), "form dialog shows a 'Generate key' button");
        ok(!!button(dlgOf(), "Browse…"), "form dialog shows a 'Browse…' button");
        button(dlgOf(), "Generate key").emit("clicked");
        ok(await until(() => /^[A-Za-z0-9+/]{43}=$/.test(entry(dlgOf(), "Public key (base64)")?.text ?? "")), "Generate key fills the public key field");
        const gen = await tool(null, [ "list-keys" ], { initFrom: BUNDLED_TOOLS });
        ok(gen.keys.some(x => x.kid === "gen-author" && x.pub === entry(dlgOf(), "Public key (base64)").text), "the generated key exists in the key folder and matches the field");
        // 2. Browse… with a .pub.json file fills pub and the empty kid
        entry(dlgOf(), "kid").set_text("");
        win.pick = async () => `${tmp}/ui-author.pub.json`;
        button(dlgOf(), "Browse…").emit("clicked");
        ok(await until(() => entry(dlgOf(), "kid")?.text === "ui-author"), "Browse… of a .pub.json fills the key id");
        ok(await until(() => entry(dlgOf(), "Public key (base64)")?.text === k.keys.find(x => x.kid === "ui-author").pub), "Browse… of a .pub.json fills the public key");
        dlgOf().force_close(); ok((await pending) === null, "closing the form resolves null");
        // 3. New repository: folder field has Browse…, key id has a suggestion that is not already taken
        const sug = suggestKid("store"); ok(/^store-\d{4}-[a-z]/.test(sug) && !(await tool(null, [ "list-keys" ], { initFrom: BUNDLED_TOOLS })).keys.some(x => x.kid === sug), "suggested store key id is unused");
        win.pick = async () => tmp;
        pending = win.newRepoDialog();
        ok(await until(() => dlgOf() && button(dlgOf(), "Browse…")), "New repository dialog has Browse… for the folder");
        ok(entry(dlgOf(), "Signing key id (a new key is generated)")?.text === sug, "New repository dialog suggests a key id");
        button(dlgOf(), "Browse…").emit("clicked");
        ok(await until(() => entry(dlgOf(), "Create inside folder")?.text === tmp), "Browse… sets the parent folder");
        entry(dlgOf(), "Store name").set_text("Made By UI"); entry(dlgOf(), "Store id (a-z 0-9 -)").set_text("made-by-ui");
        win.alert = () => {};
        dlgOf().emit("response", "ok");
        ok(await until(() => GLib.file_test(`${tmp}/made-by-ui/store.config.json`, GLib.FileTest.EXISTS), 15000), "New repository is created inside the browsed folder");
        await pending;
    } catch (e) { print("EXC " + e + "\n" + e.stack); fails++; }
    GLib.spawn_command_line_sync(`rm -rf ${tmp}`);
    print(fails ? `${fails} FAILED` : "ALL OK"); app.quit();
});
app.run([]);
imports.system.exit(fails ? 1 : 0);
