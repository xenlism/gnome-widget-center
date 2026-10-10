// Headless test of the app's backend layer under real GJS: gjs -m tests/backend.test.js   (needs python3 + cryptography)
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import { build, tool, verify, BUNDLED_TOOLS, KEY_DIR, readKey } from "../src/backend.js";

const loop = GLib.MainLoop.new(null, false);
let fails = 0;
const ok = (c, m) => { print(`${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const tmp = GLib.dir_make_tmp("gwcapp-XXXXXX");
const repo = `${tmp}/store`;

(async () => {
    ok(KEY_DIR.startsWith(tmp) || GLib.getenv("GWC_KEY_DIR"), "key dir is isolated for the test");
    let r = await tool(null, [ "init", repo, "--id", "t-store", "--name", "T", "--base-url", "https://x.github.io/t/", "--kid", "t-1" ], { initFrom: BUNDLED_TOOLS });
    ok(r.ok && r.fingerprint, "init via bundled tools");
    ok(!!readKey("t-1"), "private key saved in key dir");
    r = await tool(repo, [ "new-widget", "--id", "a.w", "--name", "W", "--author", "A", "--catalog", "clock" ]); ok(r.ok, "new-widget");
    r = await tool(repo, [ "status" ]); ok(r.ok && r.widgets.length === 1 && r.errors === 0, "status: 1 widget, 0 errors");
    r = await tool(repo, [ "new-widget", "--id", "../bad", "--name", "W", "--author", "A" ]); ok(!r.ok && /id must match/.test(r.error), "bad id rejected with a message");
    let lines = [];
    let b = await build(repo, { signed: false, onLine: l => lines.push(l) }); ok(b.code === 0 && lines.some(l => /unsigned/i.test(l) || /widgets=1/.test(l)), "preview build streams output");
    let v = await verify(repo, { signed: false, onLine: l => lines.push(l) }); ok(v.code === 0, "preview verifies");
    lines = []; b = await build(repo, { signed: true, firstPublish: true, onLine: l => lines.push(l) }); ok(b.code === 0, "signed build with the key from the key dir");
    v = await verify(repo, { signed: true, onLine: l => lines.push(l) }); ok(v.code === 0, "signed build verifies against store.config.json");
    r = await tool(repo, [ "authors", "add", "--kid", "x", "--name", "X", "--pub", "AAAA", "--ids", "*" ]); ok(!r.ok, "invalid author rejected");
    // import-key: bring an existing private key file into the key folder
    r = await tool(null, [ "author-keygen", "--kid", "src-1" ], { initFrom: BUNDLED_TOOLS });
    GLib.mkdir_with_parents(`${tmp}/export`, 0o755);
    const ex = await tool(null, [ "export-key", "src-1", `${tmp}/export` ], { initFrom: BUNDLED_TOOLS }); ok(ex.ok, "export-key (backup of a private key)");
    r = await tool(null, [ "import-key", `${tmp}/export/src-1.key`, "--kid", "restored" ], { initFrom: BUNDLED_TOOLS });
    ok(r.ok && r.kid === "restored" && !!readKey("restored") && readKey("restored") === readKey("src-1"), "import-key copies the key under a new id");
    r = await tool(null, [ "import-key", `${tmp}/export/src-1.key`, "--kid", "restored" ], { initFrom: BUNDLED_TOOLS }); ok(!r.ok && /already exists/.test(r.error), "import-key never overwrites");
    GLib.file_set_contents(`${tmp}/junk.txt`, "not a key");
    r = await tool(null, [ "import-key", `${tmp}/junk.txt`, "--kid", "junk" ], { initFrom: BUNDLED_TOOLS }); ok(!r.ok && /not a signing key/.test(r.error), "import-key rejects a file that is not a key");
    GLib.spawn_command_line_sync(`rm -rf ${tmp}`);
    print(fails ? `${fails} FAILED` : "ALL OK"); loop.quit();
})().catch(e => { print("EXC " + e + "\n" + e.stack); fails++; loop.quit(); });
loop.run();
imports.system.exit(fails ? 1 : 0);
