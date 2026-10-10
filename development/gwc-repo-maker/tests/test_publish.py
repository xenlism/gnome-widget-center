"""Tests for backend/gwc_publish.py against an in-memory fake GitHub (API + device flow). No network, no real account.

    python3 -m unittest discover -s tests -p 'test_publish.py'
"""
import base64, functools, hashlib, json, os, shutil, ssl, stat, subprocess, sys, tempfile, threading, unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fake_github

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "backend" / "gwc_publish.py"
TOOLS = ROOT / "backend" / "tools"


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake, cls.srv, cls.url = fake_github.start()
        cls.tmp = tempfile.TemporaryDirectory(); cls.keys = str(Path(cls.tmp.name) / "keys")
        cls.repo = Path(cls.tmp.name) / "my-store"
        cls.env = dict(os.environ, GWC_GH_API=cls.url, GWC_GH_WEB=cls.url, GWC_GH_CLIENT_ID="cid", PYTHONDONTWRITEBYTECODE="1")

    @classmethod
    def tearDownClass(cls): cls.srv.shutdown(); cls.tmp.cleanup()

    def pub(self, *args, stdin=None):
        p = subprocess.run([sys.executable, str(PUB), "--key-dir", self.keys, *args], input=stdin, capture_output=True, text=True, env=self.env)
        lines = [l for l in p.stdout.splitlines() if l.strip()]
        return json.loads(lines[-1]), [l for l in lines[:-1] if l.startswith("# ")]

    def make_repo(self, base_url, kid="store-1"):
        init = subprocess.run([sys.executable, str(TOOLS / "gwc_repo.py"), "--key-dir", self.keys, "init", str(self.repo), "--id", "my-store", "--name", "My Store",
                               "--base-url", base_url, "--tier", "official", "--kid", kid], capture_output=True, text=True, env=self.env)
        self.assertTrue(json.loads(init.stdout)["ok"], init.stdout + init.stderr)
        nw = subprocess.run([sys.executable, str(self.repo / "tools" / "gwc_repo.py"), "--repo", str(self.repo), "--key-dir", self.keys, "new-widget", "--id", "alice.hello",
                             "--name", "Hello", "--author", "Alice"], capture_output=True, text=True, env=self.env)
        self.assertTrue(json.loads(nw.stdout)["ok"], nw.stdout + nw.stderr)

    def build(self, *extra):
        p = subprocess.run([sys.executable, str(self.repo / "tools" / "build_store.py"), "--out", str(self.repo / "dist"), *extra], cwd=self.repo,
                           capture_output=True, text=True, env=dict(self.env, GWC_SIGNING_KEY=(Path(self.keys) / "store-1.key").read_text().strip()))
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)



class PublishTest(Base):
    # tests are numbered: they share one fake GitHub and one repository, in order
    def test_01_signin_and_publish_flow(self):
        r, _ = self.pub("status"); self.assertTrue(r["ok"] and not r["signedIn"] and r["deviceFlow"])
        r, _ = self.pub("auth-start"); self.assertEqual((r["userCode"], r["interval"]), ("ABCD-1234", 1))
        r, _ = self.pub("auth-poll", "--device-code", "DC"); self.assertTrue(r["ok"] and r["done"] is False)
        r, _ = self.pub("auth-poll", "--device-code", "DC"); self.assertTrue(r["done"] and r["login"] == "alice")
        tok = Path(self.keys) / "github.token"; self.assertEqual(stat.S_IMODE(tok.stat().st_mode), 0o600); self.assertEqual(stat.S_IMODE(Path(self.keys).stat().st_mode), 0o700)
        r, _ = self.pub("status"); self.assertTrue(r["signedIn"] and r["login"] == "alice")

        init = subprocess.run([sys.executable, str(TOOLS / "gwc_repo.py"), "--key-dir", self.keys, "init", str(self.repo), "--id", "my-store", "--name", "My Store",
                               "--base-url", "https://alice.github.io/my-store/", "--tier", "official", "--kid", "store-1"], capture_output=True, text=True, env=self.env)
        self.assertTrue(json.loads(init.stdout)["ok"], init.stdout + init.stderr)
        # an EMPTY store cannot be built (build_store.py crashes in write_shards), so the app must ask for a widget first: add one here
        nw = subprocess.run([sys.executable, str(self.repo / "tools" / "gwc_repo.py"), "--repo", str(self.repo), "--key-dir", self.keys, "new-widget",
                             "--id", "alice.hello", "--name", "Hello", "--author", "Alice"], capture_output=True, text=True, env=self.env)
        self.assertTrue(json.loads(nw.stdout)["ok"], nw.stdout + nw.stderr)

        r, _ = self.pub("prepare", "--repo-name", "my-store")
        self.assertTrue(r["ok"], r); self.assertEqual((r["pagesUrl"], r["created"], r["prevSeq"]), ("https://alice.github.io/my-store/", True, None))
        self.build("--first-publish")
        r, notes = self.pub("upload", "--repo-name", "my-store", "--dist", str(self.repo / "dist"))
        self.assertTrue(r["ok"], r); self.assertEqual(r["seq"], 1); self.assertEqual(r["uploaded"], r["files"])
        repo = self.fake.repo("alice", "my-store"); tree = repo["trees"][repo["commits"][repo["refs"]["heads/gh-pages"]]["tree"]]
        names = {e["path"] for e in tree}; self.assertTrue({"store.json", "store.json.sig", ".nojekyll"} <= names, names)
        self.assertEqual(repo["pages"]["source"], {"branch": "gh-pages", "path": "/"}); self.assertNotIn("warning", r)

    def test_02_second_publish_uploads_only_changes(self):
        r, _ = self.pub("prepare", "--repo-name", "my-store"); self.assertEqual((r["created"], r["prevSeq"]), (False, 1))
        self.build("--seq", "2")
        before = self.fake.blob_posts
        r, _ = self.pub("upload", "--repo-name", "my-store", "--dist", str(self.repo / "dist"))
        self.assertTrue(r["ok"], r); self.assertEqual(r["seq"], 2)
        self.assertLessEqual(self.fake.blob_posts - before, 3, "only store.json / .sig (and at most one more) should be new")
        r, _ = self.pub("prepare", "--repo-name", "my-store"); self.assertEqual(r["prevSeq"], 2)

    def test_03_same_seq_is_refused(self):
        r, _ = self.pub("upload", "--repo-name", "my-store", "--dist", str(self.repo / "dist"))
        self.assertFalse(r["ok"]); self.assertEqual(r["code"], "stale-seq")

    def test_04_rate_limit_is_waited_out(self):
        self.build("--seq", "3"); self.fake.limit_once = True
        # change a file so there is at least one blob to upload even if the content repeats
        r, notes = self.pub("upload", "--repo-name", "my-store", "--dist", str(self.repo / "dist"))
        self.assertTrue(r["ok"], r); self.assertTrue(any("slow down" in n for n in notes), notes)

    def test_05_foreign_branch_is_never_overwritten(self):
        self.fake.repos[("alice", "other")] = {"private": False, "blobs": {}, "trees": {}, "commits": {}, "refs": {}, "pages": None}
        o = self.fake.repos[("alice", "other")]; b = b"hello"; sha = hashlib.sha1(b"blob 5\0" + b).hexdigest(); o["blobs"][sha] = b
        o["trees"]["t"] = [{"path": "README.md", "mode": "100644", "sha": sha}]; o["commits"]["c"] = {"tree": "t", "parents": []}; o["refs"]["heads/gh-pages"] = "c"
        r, _ = self.pub("prepare", "--repo-name", "other"); self.assertFalse(r["ok"]); self.assertEqual(r["code"], "foreign-branch")

    def test_06_private_repo_and_bad_names_and_bad_token(self):
        self.fake.repos[("alice", "secret")] = {"private": True, "blobs": {}, "trees": {}, "commits": {}, "refs": {}, "pages": None}
        r, _ = self.pub("prepare", "--repo-name", "secret"); self.assertEqual(r["code"], "private")
        r, _ = self.pub("prepare", "--repo-name", "bad name!"); self.assertFalse(r["ok"])
        r, _ = self.pub("auth-token", stdin="nope"); self.assertEqual(r["code"], "auth")   # rejected by GitHub, must not be saved over the good one
        r, _ = self.pub("status"); self.assertTrue(r["signedIn"])
        r, _ = self.pub("auth-token", stdin="good-token\n"); self.assertEqual(r["login"], "alice")

    def test_07_pages_switched_from_actions_to_branch(self):
        self.fake.repo("alice", "my-store")["pages"] = {"source": {"branch": "main", "path": "/"}, "build_type": "workflow"}
        self.build("--seq", "4")
        r, _ = self.pub("upload", "--repo-name", "my-store", "--dist", str(self.repo / "dist")); self.assertTrue(r["ok"], r)
        self.assertEqual(self.fake.repo("alice", "my-store")["pages"]["build_type"], "legacy")

    def test_08_signout_removes_token(self):
        r, _ = self.pub("signout"); self.assertTrue(r["ok"]); self.assertFalse((Path(self.keys) / "github.token").exists())
        r, _ = self.pub("prepare", "--repo-name", "my-store"); self.assertEqual(r["code"], "auth")


class FolderTest(Base):
    """store in a folder of an EXISTING GitHub Pages site (the rest of the site must stay untouched)"""
    SITE = {"index.html": b"<h1>my site</h1>", "css/site.css": b"body{}", "about/index.html": b"about"}

    def setUp(self):
        self.pub("auth-token", stdin="good-token\n")
        if not self.repo.exists():
            init = subprocess.run([sys.executable, str(TOOLS / "gwc_repo.py"), "--key-dir", self.keys, "init", str(self.repo), "--id", "my-store", "--name", "My Store",
                                   "--base-url", "https://alice.github.io/alice.github.io/gwc/", "--tier", "official", "--kid", "store-1"], capture_output=True, text=True, env=self.env)
            self.assertTrue(json.loads(init.stdout)["ok"], init.stdout)
            nw = subprocess.run([sys.executable, str(self.repo / "tools" / "gwc_repo.py"), "--repo", str(self.repo), "--key-dir", self.keys, "new-widget", "--id", "alice.hello",
                                 "--name", "Hello", "--author", "Alice"], capture_output=True, text=True, env=self.env)
            self.assertTrue(json.loads(nw.stdout)["ok"], nw.stdout)

    def paths(self, name, branch="main"):
        r = self.fake.repo("alice", name); c = r["commits"][r["refs"][f"heads/{branch}"]]
        return {e["path"]: e["sha"] for e in r["trees"][c["tree"]]}, r

    def test_01_publish_into_folder_leaves_site_alone(self):
        fake_github.seed(self.fake, "alice", "alice.github.io", self.SITE, pages={"source": {"branch": "main", "path": "/"}, "build_type": "legacy"})
        before, repo = self.paths("alice.github.io")
        r, _ = self.pub("prepare", "--repo-name", "alice.github.io", "--folder", "gwc")
        self.assertTrue(r["ok"], r); self.assertEqual((r["pagesUrl"], r["prevSeq"], r["created"], r["folder"]), ("https://alice.github.io/gwc/", None, False, "gwc"))
        self.build("--first-publish")
        r, notes = self.pub("upload", "--repo-name", "alice.github.io", "--folder", "gwc", "--dist", str(self.repo / "dist"))
        self.assertTrue(r["ok"], r); self.assertEqual((r["url"], r["seq"], r["branch"]), ("https://alice.github.io/gwc/", 1, "main"))
        after, repo = self.paths("alice.github.io")
        for k, v in before.items(): self.assertEqual(after.get(k), v, f"site file {k} must be untouched")
        self.assertIn("gwc/store.json", after); self.assertIn("gwc/store.json.sig", after)
        self.assertNotIn(".nojekyll", after, "no .nojekyll at the site root: that would change how the existing site is built")
        self.assertEqual(repo["pages"]["source"], {"branch": "main", "path": "/"}, "Pages settings of the existing site are not touched")
        self.assertFalse(any(m == "POST" and p.endswith("/pages") or m == "PUT" and p.endswith("/pages") for m, p in self.fake.log if "alice.github.io" in p))

    def test_02_second_publish_changes_only_the_folder_and_removes_stale_files(self):
        before, repo = self.paths("alice.github.io")
        stale = [p for p in before if p.startswith("gwc/w/")][0]                        # pretend the previous build had one more file
        repo["blobs"]["zz"] = b"x"; repo["trees"]["t-stale"] = repo["trees"][repo["commits"][repo["refs"]["heads/main"]]["tree"]] + [{"path": "gwc/old/gone.json", "mode": "100644", "sha": "zz"}]
        repo["commits"]["c-stale"] = {"tree": "t-stale", "parents": []}; repo["refs"]["heads/main"] = "c-stale"
        r, _ = self.pub("prepare", "--repo-name", "alice.github.io", "--folder", "gwc"); self.assertEqual(r["prevSeq"], 1)
        self.build("--seq", "2")
        r, _ = self.pub("upload", "--repo-name", "alice.github.io", "--folder", "gwc", "--dist", str(self.repo / "dist")); self.assertTrue(r["ok"], r); self.assertEqual(r["seq"], 2)
        after, _ = self.paths("alice.github.io")
        self.assertNotIn("gwc/old/gone.json", after, "files of the folder that are not in the new build are removed")
        for k in self.SITE: self.assertIn(k, after)
        r, _ = self.pub("upload", "--repo-name", "alice.github.io", "--folder", "gwc", "--dist", str(self.repo / "dist")); self.assertEqual(r["code"], "stale-seq")

    def test_03_foreign_folder_is_never_overwritten(self):
        r, _ = self.pub("prepare", "--repo-name", "alice.github.io", "--folder", "css"); self.assertFalse(r["ok"]); self.assertEqual(r["code"], "foreign-branch")
        self.assertIn("css/", r["error"])

    def test_04_docs_source_path_and_workflow_site_and_errors(self):
        fake_github.seed(self.fake, "alice", "docs-site", {"docs/index.html": b"hi", "README.md": b"r"}, pages={"source": {"branch": "main", "path": "/docs"}, "build_type": "legacy"})
        r, _ = self.pub("prepare", "--repo-name", "docs-site", "--folder", "store/v1"); self.assertTrue(r["ok"], r)
        self.assertEqual((r["pagesUrl"], r["folder"]), ("https://alice.github.io/docs-site/store/v1/", "docs/store/v1"))
        self.build("--first-publish")
        r, _ = self.pub("upload", "--repo-name", "docs-site", "--folder", "store/v1", "--dist", str(self.repo / "dist")); self.assertTrue(r["ok"], r)
        after, _ = self.paths("docs-site"); self.assertIn("docs/store/v1/store.json", after); self.assertNotIn("store/v1/store.json", after); self.assertIn("README.md", after)
        fake_github.seed(self.fake, "alice", "actions-site", {"index.html": b"x"}, pages={"source": {"branch": "main", "path": "/"}, "build_type": "workflow"})
        r, _ = self.pub("prepare", "--repo-name", "actions-site", "--folder", "gwc"); self.assertTrue(r["ok"] and "workflow" in r["warning"], r)
        fake_github.seed(self.fake, "alice", "no-pages", {"index.html": b"x"})
        r, _ = self.pub("prepare", "--repo-name", "no-pages", "--folder", "gwc"); self.assertEqual(r["code"], "no-pages")
        r, _ = self.pub("prepare", "--repo-name", "missing-repo", "--folder", "gwc"); self.assertEqual(r["code"], "no-repo")
        for bad in ("_private", ".hidden", "../x", "a b", ""):
            r, _ = self.pub("prepare", "--repo-name", "alice.github.io", "--folder", bad); self.assertFalse(r["ok"], bad)
        r, _ = self.pub("prepare", "--repo-name", "bob/whatever", "--folder", "gwc"); self.assertFalse(r["ok"])


class CnameTest(Base):
    """own domain on GitHub Pages: the CNAME file is what GitHub reads"""
    def test_custom_domain(self):
        self.pub("auth-token", stdin="good-token\n"); self.make_repo("https://store.example.com/")
        r, _ = self.pub("prepare", "--repo-name", "cn-store"); self.assertTrue(r["ok"], r)
        self.build("--first-publish")
        for bad in ("foo", "x.github.io", "https://store.example.com/", "a b.com"):
            r, _ = self.pub("upload", "--repo-name", "cn-store", "--dist", str(self.repo / "dist"), "--cname", bad); self.assertFalse(r["ok"], bad)
        r, _ = self.pub("upload", "--repo-name", "cn-store", "--dist", str(self.repo / "dist"), "--cname", "Store.Example.com")
        self.assertTrue(r["ok"], r); self.assertEqual(r["url"], "https://store.example.com/"); self.assertIn("DNS", r["warning"]); self.assertIn("alice.github.io", r["warning"])
        repo = self.fake.repo("alice", "cn-store"); tree = {e["path"]: e["sha"] for e in repo["trees"][repo["commits"][repo["refs"]["heads/gh-pages"]]["tree"]]}
        self.assertEqual(repo["blobs"][tree["CNAME"]], b"store.example.com\n")
        r, _ = self.pub("upload", "--repo-name", "alice.github.io", "--folder", "gwc", "--dist", str(self.repo / "dist"), "--cname", "store.example.com")
        self.assertFalse(r["ok"], "a folder of an existing site cannot get its own domain")


class SelfHostTest(Base):
    """'my own web host': probe tells first publish / live / unreachable; the next build keeps the previous revision (needs the live site)"""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.site = Path(cls.tmp.name) / "site"; cls.site.mkdir()
        cert, key = Path(cls.tmp.name) / "c.pem", Path(cls.tmp.name) / "k.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert), "-days", "2", "-subj", "/CN=localhost",
                        "-addext", "subjectAltName=DNS:localhost"], check=True, capture_output=True)
        class Quiet(SimpleHTTPRequestHandler):
            def log_message(self, *a, **k): pass
        handler = functools.partial(Quiet, directory=str(cls.site))
        cls.https = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key); cls.https.socket = ctx.wrap_socket(cls.https.socket, server_side=True)
        threading.Thread(target=cls.https.serve_forever, daemon=True).start()
        cls.live = f"https://localhost:{cls.https.server_address[1]}/"
        cls.env = dict(cls.env, SSL_CERT_FILE=str(cert))                          # our own CA for the test host, for probe and for build_store.py

    @classmethod
    def tearDownClass(cls): cls.https.shutdown(); super().tearDownClass()

    def upload_by_hand(self): shutil.copytree(self.repo / "dist", self.site, dirs_exist_ok=True)

    def test_01_first_publish_then_update_keeps_previous_revision(self):
        self.make_repo(self.live)
        r, _ = self.pub("probe", "--url", self.live); self.assertEqual(r["state"], "none", r)
        self.build("--first-publish"); self.upload_by_hand()
        r, _ = self.pub("probe", "--url", self.live); self.assertEqual((r["state"], r["seq"]), ("live", 1))
        self.build("--prev-url", "auto")                                          # what the app does when the probe says "live"
        self.assertEqual(json.loads((self.repo / "dist" / "store.json").read_text())["seq"], 2)
        self.assertTrue((self.repo / "dist" / "prev").is_dir(), "the previous revision is kept reachable (needs the live site)")
        self.upload_by_hand(); r, _ = self.pub("probe", "--url", self.live); self.assertEqual(r["seq"], 2)

    def test_02_unreachable_and_bad_urls(self):
        r, _ = self.pub("probe", "--url", "https://localhost:1/"); self.assertTrue(r["ok"]); self.assertEqual(r["state"], "unreachable"); self.assertIn("Cannot reach", r["error"])
        r, _ = self.pub("probe", "--url", "http://localhost:1/"); self.assertFalse(r["ok"])
        (self.site / "notes").mkdir(exist_ok=True); (self.site / "notes" / "store.json").write_text("<html>")
        r, _ = self.pub("probe", "--url", self.live + "notes/"); self.assertEqual(r["state"], "unreachable")     # answers, but is not a manifest


class BigWidgetTest(Base):
    """a widget package > 4 MiB is a version 2 package: .gwcw + a raw .gwcp, both must reach GitHub Pages"""
    def test_gwcp_is_uploaded_with_its_gwcw(self):
        self.pub("auth-token", stdin="good-token\n"); self.make_repo("https://alice.github.io/big-store/")
        (self.repo / "widgets" / "alice.hello" / "assets.png").write_bytes(os.urandom(5 * 1024 * 1024))
        self.build("--first-publish")
        gwcp = sorted((self.repo / "dist" / "w").glob("*.gwcp")); self.assertEqual(len(gwcp), 1, "built as version 2")
        r, _ = self.pub("prepare", "--repo-name", "big-store"); self.assertTrue(r["ok"], r)
        r, _ = self.pub("upload", "--repo-name", "big-store", "--dist", str(self.repo / "dist")); self.assertTrue(r["ok"], r)
        repo = self.fake.repo("alice", "big-store"); tree = {e["path"]: e["sha"] for e in repo["trees"][repo["commits"][repo["refs"]["heads/gh-pages"]]["tree"]]}
        self.assertIn(f"w/{gwcp[0].name}", tree); self.assertEqual(repo["blobs"][tree[f"w/{gwcp[0].name}"]], gwcp[0].read_bytes(), "the raw zip arrived byte for byte")
        self.assertEqual(repo["blobs"][tree[f"w/{gwcp[0].name}"]][:2], b"PK")


class UnitTest(unittest.TestCase):
    def test_blob_timeout_grows_with_size_for_big_widget_packages(self):
        sys.path.insert(0, str(ROOT / "backend")); import gwc_publish
        self.assertEqual(gwc_publish.blob_timeout(10 * 1024), 60)
        self.assertGreaterEqual(gwc_publish.blob_timeout(64 * 1024 * 1024), 2000)


if __name__ == "__main__":
    unittest.main()
