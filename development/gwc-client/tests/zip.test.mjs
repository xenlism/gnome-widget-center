import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZip, writeZip, isSafeEntryName, DEFAULT_LIMITS } from "../lib/store/zipCore.js";

const calls = [];
const codec = {
    inflate: (u8, max) => { calls.push(max); return new Uint8Array(zlib.inflateRawSync(u8, { maxOutputLength: max ?? 64 << 20 })); },
    deflate: u8 => new Uint8Array(zlib.deflateRawSync(u8, { level: 9 })),
};
const enc = s => new TextEncoder().encode(s);
const pyZip = code => { const f = join(mkdtempSync(join(tmpdir(), "z-")), "t.zip");
    execFileSync("python3", ["-c", `import zipfile,stat\nz=zipfile.ZipFile(${JSON.stringify(f)},'w',zipfile.ZIP_DEFLATED)\n${code}\nz.close()`]);
    return new Uint8Array(readFileSync(f)); };

test("roundtrip, and Python's zipfile can read what we write", () => {
    const z = writeZip([{ name: "widget.js", data: enc("x".repeat(500)) }, { name: "a/b.css", data: enc("body{}") }], codec);
    assert.deepEqual(readZip(z, codec).map(e => e.name).sort(), ["a/b.css", "widget.js"]);
    const f = join(mkdtempSync(join(tmpdir(), "z-")), "o.zip"); writeFileSync(f, z);
    const out = execFileSync("python3", ["-c", `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(sorted(z.namelist()))`, f]).toString();
    assert.match(out, /a\/b\.css.*widget\.js/);
});

test("inflate is told the DECLARED size as its output cap", () => {
    calls.length = 0;
    readZip(writeZip([{ name: "widget.js", data: enc("y".repeat(1000)) }], codec), codec);
    assert.deepEqual(calls, [1000]);
});

test("entry that inflates beyond its declared size is stopped by the cap", () => {
    const z = writeZip([{ name: "widget.js", data: enc("z".repeat(5000)) }], codec);
    const dv = new DataView(z.buffer, z.byteOffset);
    for (let i = 0; i < z.length - 4; i++) if (dv.getUint32(i, true) === 0x02014B50) dv.setUint32(i + 24, 100, true);   // lie in central dir: usize=100
    assert.throws(() => readZip(z, codec), /RangeError|ERR_BUFFER_TOO_LARGE|too large|Cannot create a Buffer|exceed/i);
});

test("zip-slip / absolute / drive names rejected", () => {
    for (const n of ["../evil.js", "a/../../evil.js", "/etc/passwd", "a\\b.js", "C:evil", "a//b", "./a", "", "a/"])
        assert.equal(isSafeEntryName(n), false, JSON.stringify(n));
    assert.equal(isSafeEntryName("a/b.js"), true);
    assert.throws(() => readZip(pyZip("z.writestr('../evil.js','x')"), codec), /unsafe entry name/);
    assert.throws(() => readZip(pyZip("z.writestr('/abs.js','x')"), codec), /unsafe entry name/);
});

test("symlink entry rejected", () => {
    const z = pyZip("i=zipfile.ZipInfo('link.js'); i.external_attr=(stat.S_IFLNK|0o777)<<16; z.writestr(i,'/etc/passwd')");
    assert.throws(() => readZip(z, codec), /symlink/);
});

test("compression bomb rejected by ratio / size limits", () => {
    const z = pyZip("z.writestr('widget.js','0'*5_000_000)");
    assert.throws(() => readZip(z, codec), /ratio|too large/);
    const many = pyZip("for i in range(600): z.writestr(f'f{i}.js','x')");
    assert.throws(() => readZip(many, codec), /too many entries/);
});

test("corrupt data fails CRC", () => {
    const z = writeZip([{ name: "widget.js", data: enc("hello world, hello world, hello world") }], codec);
    z[40] ^= 0xFF;                                                // inside the local data
    assert.throws(() => readZip(z, codec));
});
