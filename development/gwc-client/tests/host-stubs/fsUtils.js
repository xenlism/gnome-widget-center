// TEST STUB of the host extension's lib/fsUtils.js (only the four functions the store client imports).
// The real file lives in the main gnome-widget-center extension; point GWC_MAIN_LIB at its lib/ to use it instead.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export async function readBytesFileAsync(p) { return new Uint8Array(readFileSync(p)); }       // rejects when missing
export async function readTextFileAsync(p) { try { return readFileSync(p, "utf8"); } catch (_e) { return null; } }
export async function writeBytesFileAsync(p, u8) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p + ".tmp", u8); renameSync(p + ".tmp", p);                                 // like GIO replace_contents
}
export async function writeTextFileAsync(p, s) { return writeBytesFileAsync(p, new TextEncoder().encode(s)); }
