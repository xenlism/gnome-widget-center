// Fake network. Tests set globalThis.__net = { calls: [], handler: async (url, reqHeaders) => ({ status, body, etag?, finalUrl? }) }.
import GLib from "./GLib.mjs";
class Stream {
    constructor(body, cancel) { this.body = body; this.o = 0; this.cancel = cancel; this.closed = false; }
    async read_bytes_async(n, _p, cancel) {
        if (cancel?.is_cancelled()) throw new Error("Operation was cancelled");
        const chunk = this.body.slice(this.o, this.o + n); this.o += chunk.length;
        return new GLib.Bytes(chunk);
    }
    close() { this.closed = true; return true; }
}
class Message {
    constructor(method, url) { this.method = method; this.url = url; this.req = {}; this.resp = {}; this.status_code = 0; }
    static new(m, u) { return new Message(m, u); }
    get_request_headers() { return { append: (k, v) => { this.req[k] = v; } }; }
    get_response_headers() { return { get_one: n => this.resp[n] ?? null }; }
    get_uri() { return GLib.Uri.parse(this.finalUrl ?? this.url); }
}
class Session {
    constructor(o) { this.o = o; }
    async send_async(msg, _p, cancel) {
        const net = globalThis.__net; net.calls.push(msg.url);
        const r = await net.handler(msg.url, msg.req);                      // may throw = offline
        msg.status_code = r.status; msg.finalUrl = r.finalUrl; if (r.etag) msg.resp.ETag = r.etag;
        return new Stream(r.body ?? new Uint8Array(0), cancel);
    }
}
export default { Session, Message };
