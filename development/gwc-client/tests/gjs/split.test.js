// Real-GJS test of version 2 widget packages: parse + install of a .gwcw whose zip is a separate raw .gwcp, with the REAL gwcFormat.js.
// Run: sh tests/gjs/run.sh   (or: gjs -m tests/gjs/split.test.js from a copy of lib/, see run.sh)
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import { installGwcw, parseGwcw } from "../../lib/store/gwcFormat.js";

let fails = 0; const ok = (c, m) => { print(`${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const tmp = GLib.dir_make_tmp("gwcsplit-XXXXXX"), root = `${tmp}/widgets`, prevRoot = `${tmp}/prev`;
const sh = c => GLib.spawn_command_line_sync(c);
const put = (p, text) => Gio.File.new_for_path(p).replace_contents(new TextEncoder().encode(text), null, false, 0, null);
const bytes = p => Gio.File.new_for_path(p).load_contents(null)[1];
const read = p => { try { return new TextDecoder().decode(bytes(p)); } catch (_e) { return null; } };
const size = p => { try { return Gio.File.new_for_path(p).query_info("standard::size", 0, null).get_size(); } catch (_e) { return -1; } };
const throws = (f, re) => { try { f(); } catch (e) { return re.test(String(e.message ?? e)); } return false; };

// fixtures, built with python's zipfile the way gwc-store does
put(`${tmp}/mk.py`, `import sys, os, io, json, zipfile, hashlib
d = sys.argv[1]
def pkg(name, files, version):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        for n, data in files: z.writestr(n, data)
    zb = b.getvalue()
    open(f"{d}/{name}.gwcp", "wb").write(zb)
    md = {"id": "t.big", "name": "Big", "description": "d", "version": version, "author": "a", "api-version": 2, "entry": "widget.js"}
    pk = {"encoding": "zip", "file": f"{name}.gwcp", "size": len(zb), "sha256": hashlib.sha256(zb).hexdigest(), "files": [n for n, _ in files]}
    open(f"{d}/{name}.gwcw", "w").write(json.dumps({"format": "gwcw", "version": 2, "metadata": md, "package": pk}))
    return md, zb
block = os.urandom(20 * 1024)
pkg("big", [("widget.js", "BIG"), ("data.bin", os.urandom(9 * 1024 * 1024))], "1.0.0")                                   # 9 MiB zip: over the 8 MiB version 1 cap
md, zb = pkg("wide", [("widget.js", "WIDE"), ("a.txt", block * 450), ("b.txt", block * 450)], "1.0.1")                # ~18 MiB unpacked, zip small
import base64                                                                                                          # the SAME zip as a version 1 file
open(f"{d}/wide-as-v1.gwcw", "w").write(json.dumps({"format": "gwcw", "version": 1, "metadata": md, "package": {"encoding": "zip+base64", "size": len(zb), "sha256": hashlib.sha256(zb).hexdigest(), "files": [], "data": base64.b64encode(zb).decode()}}))
`);
sh(`python3 ${tmp}/mk.py ${tmp}`);

try {
    const g = parseGwcw(read(`${tmp}/big.gwcw`)), zip = bytes(`${tmp}/big.gwcp`);
    ok(g.version === 2 && g.package.file === "big.gwcp" && zip.length > 8 * 1024 * 1024, `parse: version 2 names its zip, which is ${(zip.length / 1048576).toFixed(1)} MiB (> the 8 MiB a version 1 file may hold)`);
    installGwcw(g, { root, prevRoot, zip });
    ok(read(`${root}/t.big/widget.js`) === "BIG" && size(`${root}/t.big/data.bin`) === 9 * 1024 * 1024 && !!read(`${root}/t.big/metadata.json`), "install: files + the 9 MiB asset unpacked, metadata.json written from the plain fields");

    ok(throws(() => installGwcw(g, { root, prevRoot }), /big\.gwcp is needed/), "install without the zip is refused, naming the file");
    const bad = new Uint8Array(zip); bad[bad.length >> 1] ^= 1;
    ok(throws(() => installGwcw(g, { root, prevRoot, zip: bad }), /integrity/), "install with a changed zip is refused");
    ok(throws(() => installGwcw(g, { root, prevRoot, zip: zip.slice(0, 100) }), /integrity/), "install with a truncated zip is refused");
    ok(read(`${root}/t.big/widget.js`) === "BIG", "a refused install leaves the installed widget untouched");

    const w = parseGwcw(read(`${tmp}/wide.gwcw`));
    installGwcw(w, { root, prevRoot, zip: bytes(`${tmp}/wide.gwcp`) });
    ok(read(`${root}/t.big/widget.js`) === "WIDE" && size(`${root}/t.big/a.txt`) === 9216000, "version 2 unpacks ~18 MiB (limit 128 MiB)");
    ok(throws(() => installGwcw(parseGwcw(read(`${tmp}/wide-as-v1.gwcw`)), { root, prevRoot }), /too large/), "the SAME zip as a version 1 file is still refused (16 MiB unpack limit)");
    ok(throws(() => installGwcw(parseGwcw(read(`${tmp}/wide-as-v1.gwcw`)), { root, prevRoot, zip: bytes(`${tmp}/wide.gwcp`) }), /carries its own/), "a version 1 file does not take a separate zip");

    const v2 = JSON.parse(read(`${tmp}/big.gwcw`)), withPkg = patch => JSON.stringify({ ...v2, package: { ...v2.package, ...patch } });
    ok(throws(() => parseGwcw(withPkg({ data: "AAAA" })), /Invalid package/), "parse: a version 2 file with inline data is refused");
    ok(throws(() => parseGwcw(withPkg({ file: "../x.gwcp" })), /file name/), "parse: path in the package file name is refused");
    ok(throws(() => parseGwcw(withPkg({ file: "x.gwcw" })), /file name/), "parse: the package file must end in .gwcp");
    ok(throws(() => parseGwcw(withPkg({ file: ".hidden.gwcp" })), /file name/), "parse: no leading dot");
    ok(throws(() => parseGwcw(withPkg({ size: 65 * 1024 * 1024 })), /size out of range/), "parse: more than 64 MiB is refused");
    ok(throws(() => parseGwcw(withPkg({ sha256: "zz" })), /hash/), "parse: bad sha256 is refused");
    ok(throws(() => parseGwcw(JSON.stringify({ ...v2, version: 3 })), /version 1 or 2/), "parse: version 3 says what it understands");
} catch (e) { print("EXC " + e + "\n" + e.stack); fails++; }
sh(`rm -rf ${tmp}`); print(fails ? `${fails} FAILED` : "ALL OK"); imports.system.exit(fails ? 1 : 0);
