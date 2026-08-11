import Gio from "gi://Gio";

export function randomBytes(length) {
    const file = Gio.File.new_for_path("/dev/urandom");
    const stream = file.read(null);
    try {
        const bytes = stream.read_bytes(length, null);
        const data = bytes.get_data();
        if (!data || data.length !== length) throw new Error(`randomBytes: short read from /dev/urandom (wanted ${length}, got ${data?.length ?? 0})`);
        return new Uint8Array(data);
    } finally {
        stream.close(null);
    }
}