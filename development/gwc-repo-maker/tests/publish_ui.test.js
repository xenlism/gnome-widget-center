// End-to-end UI test of "Publish to GitHub" under real GJS + GTK4 against a FAKE GitHub (tests/fake_github.py): no network, no account.
// Drives the real buttons: Sign in with GitHub (device flow) -> Publish -> build, sign, verify, upload, enable Pages.
//   xvfb-run -a gjs -m tests/publish_ui.test.js
import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";

let fails = 0;
const ok = (c, m) => { print(`${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
const until = async (f, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (f()) return true; await sleep(100); } return false; };
function find(w, pred) { for (let c = w.get_first_child?.(); c; c = c.get_next_sibling()) { if (pred(c)) return c; const r = find(c, pred); if (r) return r; } return null; }
const button = (root, label) => find(root, w => w instanceof Gtk.Button && (w.label === label || w.tooltip_text === label));
const label = (root, text) => find(root, w => w instanceof Gtk.Label && w.label === text);

const tmp = GLib.dir_make_tmp("gwcpub-XXXXXX");
// hermetic: our own config + key folders, set BEFORE GTK starts (GLib caches the user config dir, so the repo list of an earlier run must not leak in)
for (const [ k, v ] of Object.entries({ GWC_GH_CLIENT_ID: "cid", GWC_KEY_DIR: `${tmp}/keys`, XDG_CONFIG_HOME: `${tmp}/cfg`, XDG_DATA_HOME: `${tmp}/data` })) GLib.setenv(k, v, true);
const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);

const app = new Adw.Application({ application_id: "io.github.xenlism.GwcRepoMakerPublishTest", flags: Gio.ApplicationFlags.NON_UNIQUE });
app.connect("activate", async () => {
    app.hold();
    let fake = null, site = null;
    try {
        // the backend reads its environment when it is imported, so set it first and import afterwards (dynamic import)
        const PORT = 18000 + GLib.random_int_range(0, 1500);
        fake = new Gio.Subprocess({ argv: [ "python3", `${here}/fake_github.py`, String(PORT), "--seed-site" ], flags: Gio.SubprocessFlags.NONE });
        fake.init(null);
        await sleep(1200);
        const base = `http://127.0.0.1:${PORT}`;
        // an HTTPS "own web host" with a throw-away certificate that python (probe + build_store.py) is told to trust
        const SITE_PORT = PORT + 1, siteDir = `${tmp}/site`, cert = `${tmp}/c.pem`, key = `${tmp}/k.pem`; GLib.mkdir_with_parents(siteDir, 0o755);
        GLib.spawn_command_line_sync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${key} -out ${cert} -days 2 -subj /CN=localhost -addext subjectAltName=DNS:localhost`);
        GLib.setenv("SSL_CERT_FILE", cert, true);
        site = new Gio.Subprocess({ argv: [ "python3", `${here}/https_site.py`, siteDir, String(SITE_PORT), cert, key ], flags: Gio.SubprocessFlags.NONE }); site.init(null);
        for (const [ k, v ] of Object.entries({ GWC_GH_API: base, GWC_GH_WEB: base })) GLib.setenv(k, v, true);
        const { BUNDLED_TOOLS, tool } = await import("../src/backend.js");
        const { Window } = await import("../src/window.js");
        const repo = `${tmp}/repo`;
        let r = await tool(null, [ "init", repo, "--id", "my-store", "--name", "My Store", "--base-url", "https://USER.github.io/my-store/", "--kid", "t-1" ], { initFrom: BUNDLED_TOOLS });
        ok(r.ok, "init repo " + (r.error ?? ""));
        r = await tool(repo, [ "new-widget", "--id", "me.hello", "--name", "Hello", "--author", "Me" ]); ok(r.ok, "widget added " + (r.error ?? ""));
        const win = new Window(app, {}); win.present();
        await win.openRepo(repo);
        const alerts = []; win.alert = (h, b) => alerts.push(`${h}: ${b}`);
        const pg = () => win.pages.build;
        win.stack.set_visible_child_name("build");

        // --- not signed in yet
        ok(await until(() => button(pg(), "Sign in with GitHub")), "Build page offers 'Sign in with GitHub' (client id configured)");
        ok(!!label(pg(), "Not signed in"), "account row says not signed in");
        const entry = find(pg(), w => w instanceof Adw.EntryRow && w.title.startsWith("Repository name"));
        ok(entry?.text === "my-store", `repository name suggested from the Public URL (${entry?.text})`);

        // --- device flow: the fake approves on the second poll (interval 1 s)
        button(pg(), "Sign in with GitHub").emit("clicked");
        ok(await until(() => label(pg(), "Signed in as alice"), 15000), "device flow finished: 'Signed in as alice'");
        ok(!!button(pg(), "Sign out"), "Sign out is offered now");

        // --- Publish
        button(pg(), "Publish").emit("clicked");
        const text = () => win.log.buffer.get_text(win.log.buffer.get_start_iter(), win.log.buffer.get_end_iter(), false);
        ok(await until(() => /✓ Published/.test(text()) || alerts.length, 90000), "publish finished");
        ok(/created the public repository alice\/my-store/.test(text()), "repository created on GitHub");
        ok(/Public URL set to https:\/\/alice\.github\.io\/my-store\//.test(text()), "Public URL corrected to the real Pages address");
        ok(/✓ Published \(version 1\)/.test(text()), "published version 1\n" + text() + alerts.join("\n"));
        const st = await tool(repo, [ "status" ]);
        ok(st.config.baseUrl === "https://alice.github.io/my-store/", "store.config.json now holds that address");
        ok(await until(() => label(pg(), "https://alice.github.io/my-store/\nThe first time, GitHub can take 1-3 minutes before it appears.") || find(pg(), w => (w.subtitle ?? "").startsWith("https://alice.github.io/my-store/")), 5000), "result row shows the store address");
        ok(!!find(pg(), w => w.title === "Fingerprint to give to users who add your store"), "result row shows the fingerprint to hand out");
        ok(!!find(pg(), w => (w.title ?? "").startsWith("Last build: version 1")), "last build row shows the version / validity");

        // --- sign out removes the token
        ok(await until(() => button(pg(), "Sign out")), "account row is back after the page rebuilt");
        button(pg(), "Sign out").emit("clicked");
        ok(await until(() => label(pg(), "Not signed in"), 8000), "signing out returns to 'Not signed in'");
        ok(!GLib.file_test(`${tmp}/keys/github.token`, GLib.FileTest.EXISTS), "token file is gone");

        // --- a repository of its own, under the user's OWN DOMAIN
        button(pg(), "Sign in with GitHub").emit("clicked");
        ok(await until(() => label(pg(), "Signed in as alice"), 15000), "signed in again");
        const modeRow = () => find(pg(), w => w instanceof Adw.ComboRow && w.title === "Where to publish");
        const entryOf = prefix => find(pg(), w => w instanceof Adw.EntryRow && w.title.startsWith(prefix));
        ok(entryOf("Your own domain")?.get_visible(), "own-domain field is offered for 'a repository of its own'");
        entryOf("Repository name").set_text("cname-store"); entryOf("Your own domain").set_text("Store.Example.com");
        button(pg(), "Publish").emit("clicked");
        ok(await until(() => /✓ Published/.test(text()) || alerts.length, 90000), "custom-domain publish finished\n" + text() + alerts.join("\n"));
        ok(/Public URL set to https:\/\/store\.example\.com\//.test(text()), "Public URL is the custom domain");
        ok(/Point the DNS record of store\.example\.com to alice\.github\.io/.test(text()), "the app explains the DNS step");
        ok((await tool(repo, [ "status" ])).config.baseUrl === "https://store.example.com/", "store.config.json holds the custom address");

        // --- the same store into a FOLDER of the site alice already has (alice/alice.github.io)
        ok(await until(() => modeRow()), "mode row is back after the rebuild");
        ok(modeRow()?.selected === 0, "defaults to 'a repository of its own'");
        ok(!find(pg(), w => w instanceof Adw.EntryRow && w.title.startsWith("Folder in the site"))?.get_visible(), "folder field is hidden in that mode");
        modeRow().set_selected(1);
        const repoEntry = () => find(pg(), w => w instanceof Adw.EntryRow && w.title.startsWith("Existing GitHub Pages repository"));
        ok(await until(() => repoEntry()?.text === "alice.github.io"), `site repository suggested from the account (${repoEntry()?.text})`);
        const folderEntry = find(pg(), w => w instanceof Adw.EntryRow && w.title.startsWith("Folder in the site"));
        ok(folderEntry.get_visible() && folderEntry.text === "my-store", "folder field appears, suggested from the store id");
        folderEntry.set_text("gwc");
        button(pg(), "Publish").emit("clicked");
        ok(await until(() => /✓ Published/.test(text()) || alerts.length, 90000), "folder publish finished\n" + text() + alerts.join("\n"));
        ok(/Only the folder gwc\/ of alice\/alice\.github\.io was changed/.test(text()), "the app says only that folder was changed");
        const st2 = await tool(repo, [ "status" ]);
        ok(st2.config.baseUrl === "https://alice.github.io/gwc/", `Public URL is now the folder address (${st2.config.baseUrl})`);
        ok(await until(() => modeRow()?.selected === 1), "the choice is remembered after the page rebuilds");
        ok(await until(() => repoEntry()?.text === "alice.github.io" && find(pg(), w => w instanceof Adw.EntryRow && w.title.startsWith("Folder in the site"))?.text === "gwc"), "repository and folder are remembered");

        // --- MY OWN WEB HOST (private / intranet / any hosting): no GitHub at all
        modeRow().set_selected(2);
        ok(await until(() => entryOf("Public address of the store")?.get_visible()), "own-host mode shows the address field");
        ok(!entryOf("Existing GitHub Pages repository")?.get_visible() && !find(pg(), w => w.title === "GitHub account")?.get_visible(), "GitHub fields are hidden in that mode");
        const hostUrl = `https://localhost:${PORT + 1}/`;
        entryOf("Public address of the store").set_text("https://localhost:1/");                      // nothing there: must stop BEFORE changing anything
        button(pg(), "Publish").emit("clicked");
        ok(await until(() => alerts.some(a => /Cannot check what is online/.test(a)), 30000), "unreachable address is reported, nothing built");
        ok((await tool(repo, [ "status" ])).config.baseUrl === "https://alice.github.io/gwc/", "an unreachable address does not change the repository");
        entryOf("Public address of the store").set_text(hostUrl);
        let asked = null; win.confirm = async (h, b) => { asked = `${h}\n${b}`; return true; };
        button(pg(), "Publish").emit("clicked");
        ok(await until(() => /✓ Ready \(version 1\)/.test(text()) || alerts.length > 1, 90000) && /✓ Ready \(version 1\)/.test(text()), "own-host build finished\n" + text() + alerts.join("\n"));
        ok(/FIRST version/.test(asked ?? ""), "it asks before treating the build as the first version");
        ok(await until(() => find(pg(), w => (w.title ?? "").startsWith("Upload the contents of this folder"))), "result row tells where the files to upload are");
        ok(GLib.file_test(`${repo}/dist/store.json.sig`, GLib.FileTest.EXISTS), "signed files are in dist/");
        GLib.spawn_command_line_sync(`cp -r ${repo}/dist/. ${siteDir}/`);                              // the user uploads them
        asked = null; button(pg(), "Publish").emit("clicked");
        ok(await until(() => /✓ Ready \(version 2\)/.test(text()) || alerts.length > 2, 90000) && /✓ Ready \(version 2\)/.test(text()), "next publish continues from the live version\n" + text());
        ok(/version 1\) is online there/.test(text()) && asked === null, "found the live store and did not ask again");
        ok(GLib.file_test(`${repo}/dist/prev`, GLib.FileTest.IS_DIR), "previous revision kept reachable");
    } catch (e) { print("EXC " + e + "\n" + e.stack); fails++; }
    fake?.force_exit(); site?.force_exit();
    GLib.spawn_command_line_sync(`rm -rf ${tmp}`);
    print(fails ? `${fails} FAILED` : "ALL OK"); app.quit();
});
app.run([]);
imports.system.exit(fails ? 1 : 0);
