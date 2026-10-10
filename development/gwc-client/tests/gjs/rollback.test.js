// Real-GJS test of install -> update (keeps .prev) -> rollback -> rollback again, using the REAL gwcFormat.js on real files.
// Run: gjs -m tests/gjs/rollback.test.js   (host extension modules are replaced by tests/gjs/host/*)
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import { installGwcw, parseGwcw, prevInfo, rollbackWidget } from "../../lib/store/gwcFormat.js";

let fails = 0; const ok = (c, m) => { print(`${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const tmp = GLib.dir_make_tmp("gwcrb-XXXXXX"), root = `${tmp}/widgets`, prevRoot = `${tmp}/prev`;
const sh = c => GLib.spawn_command_line_sync(c);
const mk = (version, body) => {   // build a .gwcw with python's zipfile, the way gwc-store does
    const d = `${tmp}/src-${version}`; GLib.mkdir_with_parents(d, 0o755);
    Gio.File.new_for_path(`${d}/widget.js`).replace_contents(new TextEncoder().encode(body), null, false, 0, null);
    const py = `import zipfile,io,json,base64,hashlib;b=io.BytesIO();z=zipfile.ZipFile(b,'w');z.writestr('widget.js',open('${d}/widget.js').read());z.close();zb=b.getvalue()
print(json.dumps({'format':'gwcw','version':1,'metadata':{'id':'t.w','name':'W','description':'d','version':'${version}','author':'a','api-version':2,'entry':'widget.js'},'package':{'encoding':'zip+base64','size':len(zb),'sha256':hashlib.sha256(zb).hexdigest(),'files':['widget.js'],'data':base64.b64encode(zb).decode()}}))`;
    return parseGwcw(new TextDecoder().decode(sh(`python3 -c "${py.replace(/"/g, '\\"')}"`)[1]));
};
const read = p => { try { return new TextDecoder().decode(Gio.File.new_for_path(p).load_contents(null)[1]); } catch (_e) { return null; } };
const live = () => read(`${root}/t.w/widget.js`);

try {
    installGwcw(mk("1.0.0", "ONE"), { root, prevRoot }); ok(live() === "ONE" && !prevInfo("widgets", "t.w", { prevRoot }), "first install: nothing to roll back to");
    installGwcw(mk("2.0.0", "TWO"), { root, prevRoot }); ok(live() === "TWO", "update installed");
    ok(prevInfo("widgets", "t.w", { prevRoot })?.version === "1.0.0", "previous version (1.0.0) kept OUTSIDE the live root");
    ok(!GLib.file_test(`${root}/t.w.prev`, GLib.FileTest.EXISTS) && !Gio.File.new_for_path(root).enumerate_children("standard::name", 0, null).next_file(null)?.get_name().startsWith("."), "live root has no stray backup/staging dirs");
    ok(rollbackWidget("t.w", { root, prevRoot }) === "1.0.0" && live() === "ONE", "rollback restores 1.0.0");
    ok(prevInfo("widgets", "t.w", { prevRoot })?.version === "2.0.0", "rollback is symmetric: 2.0.0 is now the 'previous'");
    ok(rollbackWidget("t.w", { root, prevRoot }) === "2.0.0" && live() === "TWO", "second rollback returns to 2.0.0");
    installGwcw(mk("3.0.0", "THREE"), { root, prevRoot, keepPrev: false }); ok(live() === "THREE", "keepPrev:false still installs");
    let threw = false; try { rollbackWidget("../x", { root, prevRoot }); } catch (_e) { threw = true; } ok(threw, "rollback rejects a bad id");
    let t2 = false; try { sh(`rm -rf ${prevRoot}`); rollbackWidget("t.w", { root, prevRoot }); } catch (_e) { t2 = true; } ok(t2, "rollback with nothing kept throws, live version untouched: " + live());
} catch (e) { print("EXC " + e + "\n" + e.stack); fails++; }
sh(`rm -rf ${tmp}`); print(fails ? `${fails} FAILED` : "ALL OK"); imports.system.exit(fails ? 1 : 0);
