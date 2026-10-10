"""In-memory fake of the parts of GitHub that gwc_publish.py uses (REST API + device flow). Test helper only.
    python3 tests/fake_github.py [PORT]  -> prints "PORT <n>" and serves until killed (used by tests/publish_ui.test.js)
Token "good-token" is accepted; the device flow approves on the 2nd poll."""
import base64, hashlib, json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Fake:
    """state shared by the handler: repos[(owner,name)] = {private, blobs{sha:bytes}, trees{sha:[entries]}, commits{sha:{tree,parents}}, refs{name:sha}, pages}"""
    def __init__(self):
        self.user = "alice"; self.tokens = {"good-token"}; self.repos = {}; self.polls = 0; self.log = []; self.limit_once = False
        self.blob_posts = 0

    def repo(self, o, n): return self.repos.get((o, n))


class H(BaseHTTPRequestHandler):
    fake = None
    def log_message(self, *a): pass

    def _send(self, code, obj=None, headers=None):
        raw = json.dumps(obj).encode() if obj is not None else b""
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw)))
        for k, v in (headers or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(raw)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0); raw = self.rfile.read(n) if n else b""
        ctype = self.headers.get("Content-Type", "")
        if raw and "json" in ctype: return json.loads(raw)
        if raw: return {k: v[0] for k, v in __import__("urllib.parse").parse.parse_qs(raw.decode()).items()}
        return {}

    def _route(self, method):
        f, path = self.fake, self.path.split("?")[0]; body = self._body(); f.log.append((method, path))
        if path == "/login/device/code": return self._send(200, {"device_code": "DC", "user_code": "ABCD-1234", "verification_uri": "http://x/login/device", "interval": 1, "expires_in": 900})
        if path == "/login/oauth/access_token":
            f.polls += 1
            return self._send(200, {"error": "authorization_pending"} if f.polls < 2 else {"access_token": "good-token"})
        tok = (self.headers.get("Authorization") or "").replace("Bearer ", "")
        if tok not in f.tokens: return self._send(401, {"message": "Bad credentials"})
        p = path.strip("/").split("/")
        if p == ["user"]: return self._send(200, {"login": f.user})
        if p == ["user", "repos"] and method == "POST":
            r = {"private": bool(body.get("private")), "blobs": {}, "trees": {}, "commits": {}, "refs": {}, "pages": None, "init": bool(body.get("auto_init"))}
            f.repos[(f.user, body["name"])] = r
            return self._send(201, {"private": r["private"], "owner": {"login": f.user}})
        if p[0] != "repos": return self._send(404, {"message": "Not Found"})
        o, n, rest = p[1], p[2], p[3:]; r = f.repo(o, n)
        if r is None: return self._send(404, {"message": "Not Found"})
        if not rest: return self._send(200, {"private": r["private"], "owner": {"login": o}, "default_branch": "main"})
        if rest[0] == "git":
            kind = rest[1]
            if kind == "ref" and method == "GET":
                sha = r["refs"].get("/".join(rest[2:]))
                return self._send(200, {"object": {"sha": sha}}) if sha else self._send(404, {"message": "Not Found"})
            if kind == "refs" and method == "POST":
                r["refs"][body["ref"].replace("refs/", "", 1)] = body["sha"]; return self._send(201, {})
            if kind == "refs" and method == "PATCH":
                key = "/".join(rest[2:]); assert body.get("force") is False
                if key not in r["refs"]: return self._send(422, {"message": "Reference does not exist"})
                r["refs"][key] = body["sha"]; return self._send(200, {})
            if kind == "commits" and method == "GET": c = r["commits"][rest[2]]; return self._send(200, {"tree": {"sha": c["tree"]}})
            if kind == "commits" and method == "POST":
                sha = hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest(); r["commits"][sha] = body; return self._send(201, {"sha": sha})
            if kind == "trees" and method == "GET": return self._send(200, {"tree": [dict(e, type="blob") for e in r["trees"][rest[2]]], "truncated": False})
            if kind == "trees" and method == "POST":
                merged = {e["path"]: e for e in r["trees"][body["base_tree"]]} if body.get("base_tree") else {}
                for e in body["tree"]:
                    if e["sha"] is None: merged.pop(e["path"], None)
                    else:
                        assert e["sha"] in r["blobs"], "tree references a blob that was never uploaded"
                        merged[e["path"]] = e
                entries = sorted(merged.values(), key=lambda e: e["path"])
                sha = hashlib.sha1(json.dumps(entries, sort_keys=True).encode()).hexdigest(); r["trees"][sha] = entries; return self._send(201, {"sha": sha})
            if kind == "blobs" and method == "GET": return self._send(200, {"content": base64.b64encode(r["blobs"][rest[2]]).decode(), "encoding": "base64"})
            if kind == "blobs" and method == "POST":
                if f.limit_once:
                    f.limit_once = False; return self._send(403, {"message": "You have exceeded a secondary rate limit"}, {"Retry-After": "1"})
                f.blob_posts += 1
                data = base64.b64decode(body["content"]); sha = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
                r["blobs"][sha] = data; return self._send(201, {"sha": sha})
        if rest == ["pages"]:
            if method == "GET": return self._send(200, dict(r["pages"], html_url=(f"https://{o}.github.io/" if n.lower() == f"{o.lower()}.github.io" else f"https://{o}.github.io/{n}/"))) if r["pages"] else self._send(404, {"message": "Not Found"})
            if method in ("POST", "PUT"):
                r["pages"] = {"source": body["source"], "build_type": body.get("build_type", "legacy")}; return self._send(201 if method == "POST" else 204, {} if method == "POST" else None)
        return self._send(404, {"message": f"unhandled {method} {path}"})

    def do_GET(self): self._route("GET")
    def do_POST(self): self._route("POST")
    def do_PATCH(self): self._route("PATCH")
    def do_PUT(self): self._route("PUT")


def seed(fake, owner, name, files, branch="main", pages=None, private=False):
    """an existing site: repository with one commit on `branch` holding `files` {path: bytes}; pages = {"source": {...}, "build_type": ...}"""
    r = {"private": private, "blobs": {}, "trees": {}, "commits": {}, "refs": {}, "pages": pages}
    entries = []
    for path, data in files.items():
        sha = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest(); r["blobs"][sha] = data
        entries.append({"path": path, "mode": "100644", "sha": sha})
    r["trees"]["t0"] = entries; r["commits"]["c0"] = {"tree": "t0", "parents": []}; r["refs"][f"heads/{branch}"] = "c0"
    fake.repos[(owner, name)] = r
    return r


def start(port=0):
    fake = Fake(); H.fake = fake
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return fake, srv, f"http://127.0.0.1:{srv.server_address[1]}"


if __name__ == "__main__":
    fake, srv, url = start(int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 0)
    if "--seed-site" in sys.argv:        # alice already has a GitHub Pages site: alice/alice.github.io, published from main:/
        seed(fake, "alice", "alice.github.io", {"index.html": b"<h1>my site</h1>", "css/site.css": b"body{}"}, pages={"source": {"branch": "main", "path": "/"}, "build_type": "legacy"})
    print("PORT", srv.server_address[1], flush=True)
    threading.Event().wait()
