// zipKit.js - GJS binding of zipCore using Gio's zlib converters (RAW deflate). No external binaries.
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { readZip as _read, writeZip as _write } from "./zipCore.js";

export { isSafeEntryName, crc32, DEFAULT_LIMITS } from "./zipCore.js";

function convert(u8, converter, max = 64 * 1024 * 1024) {
    const src = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(u8));
    const stream = Gio.ConverterInputStream.new(src, converter);
    const chunks = [];
    let total = 0;
    for (;;) {
        const b = stream.read_bytes(65536, null);
        if (b.get_size() === 0) break;
        const a = b.toArray();
        chunks.push(a); total += a.length;
        if (total > max) throw new Error("zip: inflate output larger than declared");   // hard stop (max = declared size)
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
}

const codec = {
    inflate: (u8, max) => convert(u8, new Gio.ZlibDecompressor({ format: Gio.ZlibCompressorFormat.RAW }), max),
    deflate: u8 => convert(u8, new Gio.ZlibCompressor({ format: Gio.ZlibCompressorFormat.RAW, level: 9 })),
};

export const readZip = (u8, limits) => _read(u8, codec, limits);
export const writeZip = entries => _write(entries, codec);
