"""P2 + P3 tests: category shards + search, perm scan, mirrors, channels, author signatures, community policy, gwc_repo CLI."""
import base64, io, json, os, shutil, stat, subprocess, sys, unittest, zipfile
from pathlib import Path

import test_build as tb
REPO = tb.REPO
sys.path.insert(0, str(REPO / "tools"))
import gwc_sign, perm_scan
from verify_store import verify_dist


def write_widget(tree, wid, js="export default class W { buildActor(){} }\n", perm=("none",), version="1.0.0", catalog="clock", **extra):
    d = tree / "widgets" / wid
    d.mkdir(parents=True, exist_ok=True)
    md = {"id": wid, "name": wid, "description": "d", "version": version, "author": "A", "api-version": 2, "entry": "widget.js",
          "catalog": catalog, "perm": list(perm), **extra}
    (d / "metadata.json").write_text(json.dumps(md)); (d / "widget.js").write_text(js)
    return d


class P2Base(tb.Base):
    def tool(self, *args, tree=None):
        tree = tree or self.tree
        r = subprocess.run([sys.executable, str(tree / "tools/gwc_repo.py"), "--repo", str(tree), "--key-dir", str(self.tmp / "keys"), *args],
                           capture_output=True, text=True)
        try:
            return json.loads(r.stdout)
        except ValueError:
            self.fail(f"not JSON: {r.stdout!r} {r.stderr!r}")

    def resign(self, dist, mutate, shard_name=None, shard_fn=None):
        """tamper with a built dist in a way that keeps hashes + signature valid (a compromised publisher, not a mirror)."""
        m = json.loads((dist / "store.json").read_text())
        if shard_name:
            d = m["shards"][shard_name]; f = dist / d["p"]; s = json.loads(f.read_text()); shard_fn(s)
            raw = tb.json.dumps(s, separators=(",", ":"), ensure_ascii=False).encode()
            d.update(sha256=gwc_sign.hashlib.sha256(raw).hexdigest(), s=len(raw)); f.write_bytes(raw)
        mutate(m)
        raw = json.dumps(m, separators=(",", ":"), ensure_ascii=False).encode()
        (dist / "store.json").write_bytes(raw)
        (dist / "store.json.sig").write_bytes(gwc_sign.sign_manifest(
            gwc_sign.private_from_seed_b64(self.seed), "t-a", raw))


class TestCategoryShards(P2Base):
    def test_one_shard_per_category_plus_search(self):
        write_widget(self.tree, "a.clock", catalog="clock"); write_widget(self.tree, "a.sys", catalog="system")
        r = self.build("--first-publish"); self.assertEqual(r.returncode, 0, r.stderr)
        m = json.loads((self.tmp / "dist/store.json").read_text())
        self.assertEqual(set(m["shards"]), {"widgets-clock", "widgets-system", "widgets-other", "themepacks-other", "search"})
        self.assertTrue(all(len(k) <= 32 for k in m["shards"]))
        s = json.loads((self.tmp / "dist" / m["shards"]["widgets-clock"]["p"]).read_text())
        self.assertEqual((s["kind"], s["catalog"], [i["id"] for i in s["items"]]), ("widgets", "clock", ["a.clock"]))
        se = json.loads((self.tmp / "dist" / m["shards"]["search"]["p"]).read_text())
        self.assertEqual(set(se["items"][0]), {"id", "k", "n", "c", "t"})
        self.assertEqual(sum(1 for x in se["items"] if x["k"] == "w"), 3)
        self.assertEqual(verify_dist(self.tmp / "dist", self.trusted)[0], [])

    def test_category_shard_is_small(self):
        self.assertEqual(self.build("--first-publish").returncode, 0)
        m = json.loads((self.tmp / "dist/store.json").read_text())
        self.assertLess(m["shards"]["search"]["s"], m["shards"]["themepacks-other"]["s"])

    def test_long_catalog_id_rejected(self):
        c = json.loads((self.tree / "catalogs.json").read_text()); c["widgets"].append({"id": "x" * 21, "name": {"en": "X"}})
        (self.tree / "catalogs.json").write_text(json.dumps(c))
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("shard name", r.stderr)

    def test_search_shard_must_match_catalogue(self):
        self.assertEqual(self.build("--first-publish").returncode, 0)
        d = self.tmp / "dist"
        self.resign(d, lambda m: None, "search", lambda s: s["items"].append({"id": "ghost.item", "k": "w", "n": "G", "c": "other", "t": []}))
        errs, _ = verify_dist(d, self.trusted)
        self.assertTrue(any("search shard does not match" in e for e in errs), errs)

    def test_item_in_wrong_category_shard_detected(self):
        self.assertEqual(self.build("--first-publish").returncode, 0)
        d = self.tmp / "dist"
        self.resign(d, lambda m: None, "widgets-other", lambda s: s["items"][0].update(c="clock"))
        errs, _ = verify_dist(d, self.trusted)
        self.assertTrue(any("is in shard" in e for e in errs), errs)


class TestPerm(P2Base):
    def build_with(self, js, perm, **kw):
        shutil.rmtree(self.tree / "widgets"); write_widget(self.tree, "p.w", js=js, perm=perm, **kw)
        return self.build("--first-publish", out="d")

    def test_missing_or_bad_perm_rejected(self):
        for bad in (None, [], "none", ["nope"], ["none", "network"], ["fs-read:../etc"], ["network", "network"], ["fs-read:a b"]):
            shutil.rmtree(self.tree / "widgets", ignore_errors=True); d = write_widget(self.tree, "p.w")
            md = json.loads((d / "metadata.json").read_text())
            md.pop("perm") if bad is None else md.update(perm=bad)
            (d / "metadata.json").write_text(json.dumps(md))
            r = self.build("--first-publish", out="d"); self.assertNotEqual(r.returncode, 0, bad); self.assertIn("perm", r.stderr, bad)

    def test_undeclared_network_use_fails(self):
        r = self.build_with('import Soup from "gi://Soup";\nexport default class W {}', ["none"])
        self.assertNotEqual(r.returncode, 0); self.assertIn("needs 'network'", r.stderr)

    def test_declared_permission_passes_and_is_listed(self):
        r = self.build_with('import Soup from "gi://Soup";\nexport default class W {}', ["network"])
        self.assertEqual(r.returncode, 0, r.stderr)
        m = json.loads((self.tmp / "d/store.json").read_text())
        it = json.loads((self.tmp / "d" / m["shards"]["widgets-clock"]["p"]).read_text())["items"][0]
        self.assertEqual(it["perm"], ["network"])

    def test_subprocess_and_fs_detected(self):
        for js, cls in (('GLib.spawn_command_line_async("x")', "subprocess"), ("new Gio.Subprocess({})", "subprocess"),
                        ("Gio.File.new_for_path(p).load_contents(null)", "fs-read"), ("f.replace_contents(a,b,c,d,e)", "fs-write")):
            r = self.build_with(js, ["none"]); self.assertNotEqual(r.returncode, 0, js); self.assertIn(cls, r.stderr, js)

    def test_write_permission_covers_read(self):
        r = self.build_with("Gio.File.new_for_path(p).replace_contents(a,b,c,d,e)", ["fs-write:~/.cache/x"])
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_scan_not_fooled_by_regex_literal_with_double_slash(self):
        # a naive comment stripper would treat '//' inside the regex as a comment and hide the rest of the line
        r = perm_scan.scan([("w.js", b'const re = /https?:\\/\\//; GLib.spawn_command_line_async("x");')])
        self.assertIn("subprocess", r["needed"])

    def test_untestable_constructs_rejected(self):
        for js in ('eval("1")', 'new Function("return 1")', 'const k="Soup"; Gio[k]', 'import(name)', 'globalThis[k]()'):
            r = self.build_with(js, ["none"]); self.assertNotEqual(r.returncode, 0, js); self.assertIn("forbidden construct", r.stderr, js)

    def test_over_declaration_only_warns(self):
        r = self.build_with("export default class W {}", ["network"])
        self.assertEqual(r.returncode, 0); self.assertIn("declares 'network' but no matching code", r.stdout)


class TestMirrors(P2Base):
    def cfg(self, mirrors):
        c = json.loads((self.tree / "store.config.json").read_text()); c["mirrors"] = mirrors
        (self.tree / "store.config.json").write_text(json.dumps(c))

    def test_valid_mirrors_are_signed_into_manifest(self):
        self.cfg(["https://m1.example/store/", "https://m2.example/"])
        self.assertEqual(self.build("--first-publish").returncode, 0)
        m = json.loads((self.tmp / "dist/store.json").read_text())
        self.assertEqual(m["mirrors"], ["https://m1.example/store/", "https://m2.example/"])

    def test_bad_mirrors_rejected(self):
        for bad in (["http://m.example/"], ["https://m.example"], ["https://u:p@m.example/"], ["https://m.example/?q=1"],
                    ["https://xenlism.github.io/gwc-store/"], ["https://a.example/", "https://a.example/"], [f"https://m{i}.example/" for i in range(6)], "x"):
            self.cfg(bad); r = self.build("--first-publish", out="d"); self.assertNotEqual(r.returncode, 0, bad); self.assertIn("mirror", r.stderr, bad)

    def test_verify_rejects_bad_mirror_in_manifest(self):
        self.assertEqual(self.build("--first-publish").returncode, 0)
        self.resign(self.tmp / "dist", lambda m: m.update(mirrors=["http://evil/"]))
        self.assertTrue(any("mirrors" in e for e in verify_dist(self.tmp / "dist", self.trusted)[0]))


class TestChannels(P2Base):
    def test_beta_item_flagged_everywhere(self):
        write_widget(self.tree, "b.beta", channel="beta", catalog="clock")
        self.assertEqual(self.build("--first-publish").returncode, 0)
        m = json.loads((self.tmp / "dist/store.json").read_text())
        it = json.loads((self.tmp / "dist" / m["shards"]["widgets-clock"]["p"]).read_text())["items"][0]
        self.assertEqual(it["ch"], "beta")
        se = json.loads((self.tmp / "dist" / m["shards"]["search"]["p"]).read_text())
        self.assertEqual(next(x for x in se["items"] if x["id"] == "b.beta")["ch"], "beta")
        # stable items carry no `ch` at all (keeps existing hashes unchanged)
        o = json.loads((self.tmp / "dist" / m["shards"]["widgets-other"]["p"]).read_text())["items"][0]
        self.assertNotIn("ch", o)

    def test_unknown_channel_rejected(self):
        write_widget(self.tree, "b.bad", channel="nightly")
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("channel", r.stderr)


class AuthorBase(P2Base):
    def setUp(self):
        super().setUp()
        self.keys = self.tmp / "keys"
        r = self.tool("author-keygen", "--kid", "alice-1"); self.assertTrue(r["ok"], r)
        self.alice_pub = r["pub"]
        (self.tree / "authors.json").write_text(json.dumps([{"kid": "alice-1", "name": "Alice", "pub": self.alice_pub, "ids": ["alice.*"]}]))
        self.w = write_widget(self.tree, "alice.clock")

    def sign(self, wid="alice.clock", kid="alice-1"):
        return self.tool("sign-widget", wid, "--kid", kid)


class TestAuthorSignatures(AuthorBase):
    def test_signed_widget_builds_and_verifies_end_to_end(self):
        r = self.sign(); self.assertTrue(r["ok"], r); self.assertIsNone(r["note"])
        self.assertEqual(self.build("--first-publish").returncode, 0)
        m = json.loads((self.tmp / "dist/store.json").read_text())
        it = next(i for i in json.loads((self.tmp / "dist" / m["shards"]["widgets-clock"]["p"]).read_text())["items"] if i["id"] == "alice.clock")
        self.assertEqual(it["sg"]["k"], "alice-1"); self.assertEqual(len(it["td"]), 64)
        self.assertEqual([a["kid"] for a in m["authors"]], ["alice-1"])
        self.assertEqual(verify_dist(self.tmp / "dist", self.trusted)[0], [])

    def test_signature_file_is_not_shipped_inside_the_package(self):
        self.sign(); self.assertEqual(self.build("--first-publish").returncode, 0)
        m = json.loads((self.tmp / "dist/store.json").read_text())
        it = next(i for i in json.loads((self.tmp / "dist" / m["shards"]["widgets-clock"]["p"]).read_text())["items"] if i["id"] == "alice.clock")
        g = json.loads((self.tmp / "dist" / it["f"]).read_text())
        self.assertNotIn("signature.json", g["package"]["files"])

    def test_any_change_after_signing_breaks_the_build(self):
        self.sign()
        (self.w / "widget.js").write_text((self.w / "widget.js").read_text() + "// tweak\n")
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("author signature does not match", r.stderr)

    def test_version_perm_and_entry_are_covered_by_the_signature(self):
        def edit(**kw):
            md = json.loads((self.w / "metadata.json").read_text()); md.update(kw); (self.w / "metadata.json").write_text(json.dumps(md))
        (self.w / "alt.js").write_text("export default class Alt {}\n")
        for field, val in (("version", "1.0.1"), ("perm", ["network"]), ("entry", "alt.js")):
            self.sign(); edit(**{field: val})
            r = self.build("--first-publish", out="d"); self.assertNotEqual(r.returncode, 0, field); self.assertIn("author signature", r.stderr, field)
            md = json.loads((self.w / "metadata.json").read_text()); md.update(version="1.0.0", perm=["none"], entry="widget.js"); (self.w / "metadata.json").write_text(json.dumps(md))
        self.sign(); self.assertEqual(self.build("--first-publish", out="d").returncode, 0)        # restored -> valid again

    def test_unknown_signer_and_foreign_id_rejected(self):
        self.sign()
        sig = json.loads((self.w / "signature.json").read_text()); sig["kid"] = "mallory"; (self.w / "signature.json").write_text(json.dumps(sig))
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("not listed in authors.json", r.stderr)
        sig["kid"] = "alice-1"; (self.w / "signature.json").write_text(json.dumps(sig))
        a = json.loads((self.tree / "authors.json").read_text()); a[0]["ids"] = ["bob.*"]; (self.tree / "authors.json").write_text(json.dumps(a))
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("not allowed to sign this id", r.stderr)

    def test_swapped_author_key_in_authors_json_is_caught(self):
        self.sign()
        a = json.loads((self.tree / "authors.json").read_text()); a[0]["pub"] = tb.new_key()[1]; (self.tree / "authors.json").write_text(json.dumps(a))
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("author signature does not match", r.stderr)

    def test_signature_copied_to_another_widget_is_rejected(self):
        self.sign()
        evil = write_widget(self.tree, "alice.evil", js="export default class Evil {}\n")
        shutil.copy(self.w / "signature.json", evil / "signature.json")
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("author signature does not match", r.stderr)

    def test_forged_sg_in_published_item_detected_by_verify(self):
        self.sign(); self.assertEqual(self.build("--first-publish").returncode, 0)
        d = self.tmp / "dist"; sig = base64.b64encode(b"\0" * 64).decode()
        self.resign(d, lambda m: None, "widgets-clock", lambda s: [i["sg"].update(s=sig) for i in s["items"] if i["id"] == "alice.clock"])
        self.assertTrue(any("author signature invalid" in e for e in verify_dist(d, self.trusted)[0]))

    def test_td_that_lies_about_the_package_is_detected(self):
        self.sign(); self.assertEqual(self.build("--first-publish").returncode, 0)
        d = self.tmp / "dist"
        self.resign(d, lambda m: None, "widgets-clock", lambda s: [i.update(td="0" * 64) for i in s["items"] if i["id"] == "alice.clock"])
        self.assertTrue(any("tree digest" in e for e in verify_dist(d, self.trusted)[0]))

    def test_id_allowed_rules(self):
        self.assertTrue(gwc_sign.id_allowed(["alice.*"], "alice.clock"))
        self.assertTrue(gwc_sign.id_allowed(["alice.clock"], "alice.clock"))
        self.assertFalse(gwc_sign.id_allowed(["alice.*"], "alicex.clock"))
        self.assertFalse(gwc_sign.id_allowed(["alice.*"], "alice"))
        self.assertFalse(gwc_sign.id_allowed(["*"], "alice.clock"))
        self.assertFalse(gwc_sign.id_allowed(["*.clock"], "alice.clock"))
        self.assertFalse(gwc_sign.id_allowed([], "alice.clock"))

    def test_bare_star_author_rejected_in_authors_json(self):
        a = json.loads((self.tree / "authors.json").read_text()); a[0]["ids"] = ["*"]; (self.tree / "authors.json").write_text(json.dumps(a))
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("authors.json", r.stderr)


class TestCommunityPolicy(AuthorBase):
    def community(self):
        c = json.loads((self.tree / "store.config.json").read_text()); c["tier"] = "community"; c.pop("requireAuthorSig", None)
        (self.tree / "store.config.json").write_text(json.dumps(c))

    def test_community_requires_author_signatures_by_default(self):
        self.community(); shutil.rmtree(self.tree / "widgets" / "xenlism.github.io.my-widget")
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("requires an author signature", r.stderr)
        self.sign(); r = self.build("--first-publish", out="d2"); self.assertEqual(r.returncode, 0, r.stderr)
        m = json.loads((self.tmp / "d2/store.json").read_text())
        self.assertEqual((m["tier"], m["policy"]["authorSig"]), ("community", "required"))

    def test_verify_flags_unsigned_item_in_required_repo(self):
        self.assertEqual(self.build("--first-publish").returncode, 0)
        self.resign(self.tmp / "dist", lambda m: m.update(policy={"authorSig": "required"}))
        self.assertTrue(any("requires author signatures" in e for e in verify_dist(self.tmp / "dist", self.trusted)[0]))

    def test_official_repo_may_opt_in_explicitly(self):
        c = json.loads((self.tree / "store.config.json").read_text()); c["requireAuthorSig"] = True; (self.tree / "store.config.json").write_text(json.dumps(c))
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0)

    def test_bad_tier_rejected(self):
        c = json.loads((self.tree / "store.config.json").read_text()); c["tier"] = "gold"; (self.tree / "store.config.json").write_text(json.dumps(c))
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("tier", r.stderr)


class TestRepoCli(P2Base):
    def setUp(self):
        super().setUp()
        self.src = self.tmp / "srctree"; shutil.copytree(self.tree, self.src)        # pristine copy: gwcw fixtures are built from it
    def new_repo(self, **kw):
        dest = self.tmp / "newrepo"
        args = ["init", str(dest), "--id", kw.get("id", "my-store"), "--name", "My Store", "--base-url", kw.get("url", "https://me.github.io/my-store/"),
                "--kid", "my-2026-a", "--tier", kw.get("tier", "official")]
        r = self.tool(*args); return dest, r

    def test_init_creates_a_repo_that_builds_publishes_and_verifies(self):
        dest, r = self.new_repo(); self.assertTrue(r["ok"], r)
        key = Path(r["keyFile"]); self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(key.parent.stat().st_mode), 0o700)
        self.assertFalse(any(dest.rglob("*.key")), "private key must never be inside the repo")
        self.assertTrue((dest / ".github/workflows/pages.yml").exists() and (dest / "site/open/index.html").exists())
        w = self.tool("new-widget", "--id", "me.hello", "--name", "Hello", "--author", "Me", "--catalog", "clock", tree=dest)
        self.assertTrue(w["ok"], w)
        st = self.tool("status", tree=dest); self.assertEqual((st["errors"], len(st["widgets"])), (0, 1)); self.assertTrue(st["keys"][0]["privateKey"])
        env = {**{k: v for k, v in os.environ.items() if k != "GITHUB_ACTIONS"}, "GWC_SIGNING_KEY": key.read_text().strip()}
        b = subprocess.run([sys.executable, str(dest / "tools/build_store.py"), "--out", str(self.tmp / "out"), "--first-publish"], cwd=dest, env=env, capture_output=True, text=True)
        self.assertEqual(b.returncode, 0, b.stderr)
        v = subprocess.run([sys.executable, str(dest / "tools/verify_store.py"), str(self.tmp / "out"), "--config", str(dest / "store.config.json")], capture_output=True, text=True)
        self.assertEqual(v.returncode, 0, v.stdout)

    def test_init_refuses_nonempty_dir_and_bad_input(self):
        d = self.tmp / "busy"; d.mkdir(); (d / "x").write_text("1")
        self.assertFalse(self.tool("init", str(d), "--id", "ab", "--name", "n", "--base-url", "https://a/b/")["ok"])
        for bad in ("http://a/b/", "https://a/b", "https://a/b/?x=1"):
            self.assertFalse(self.tool("init", str(self.tmp / "z"), "--id", "ab", "--name", "n", "--base-url", bad)["ok"], bad)
        self.assertFalse(self.tool("init", str(self.tmp / "z"), "--id", "Bad ID", "--name", "n", "--base-url", "https://a/b/")["ok"])

    def test_community_init_requires_signatures_from_the_start(self):
        dest, r = self.new_repo(tier="community"); self.assertTrue(r["ok"])
        self.assertTrue(json.loads((dest / "store.config.json").read_text())["requireAuthorSig"])
        self.tool("new-widget", "--id", "me.hello", "--name", "Hello", "--author", "Me", "--catalog", "clock", tree=dest)
        st = self.tool("status", tree=dest); self.assertEqual(st["errors"], 1)          # unsigned widget in a repo that requires signatures

    def test_new_widget_scaffold_passes_lint_and_perm_scan(self):
        w = self.tool("new-widget", "--id", "t.new", "--name", "New One", "--author", "Me", "--catalog", "system", "--perm", "network"); self.assertTrue(w["ok"], w)
        self.assertEqual(self.tool("lint")["errors"], 0)
        self.assertFalse(self.tool("new-widget", "--id", "t.new", "--name", "x", "--author", "Me")["ok"])                  # exists
        self.assertFalse(self.tool("new-widget", "--id", "../x", "--name", "x", "--author", "Me")["ok"])
        self.assertFalse(self.tool("new-widget", "--id", "t.two", "--name", "x", "--author", "Me", "--catalog", "nope")["ok"])

    def make_gwcw(self, wid="imp.widget", mutate=None, members=None):
        self.assertEqual(self.build("--first-publish", out="srcdist", tree=self.src).returncode, 0)
        m = json.loads((self.tmp / "srcdist/store.json").read_text())
        it = json.loads((self.tmp / "srcdist" / m["shards"]["widgets-other"]["p"]).read_text())["items"][0]
        g = json.loads((self.tmp / "srcdist" / it["f"]).read_text())
        if members is not None:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as z:
                for n, d in members: z.writestr(n, d)
            zb = buf.getvalue(); g["package"].update(size=len(zb), sha256=gwc_sign.hashlib.sha256(zb).hexdigest(), data=base64.b64encode(zb).decode(), files=[n for n, _ in members])
        if mutate: mutate(g)
        p = self.tmp / "in.gwcw"; p.write_text(json.dumps(g)); return p, g

    def test_import_gwcw_roundtrip(self):
        p, g = self.make_gwcw()
        shutil.rmtree(self.tree / "widgets" / g["metadata"]["id"])
        r = self.tool("import-widget", str(p)); self.assertTrue(r["ok"], r)
        self.assertEqual(self.tool("lint")["errors"], 0)
        self.assertFalse(self.tool("import-widget", str(p))["ok"])                         # exists
        self.assertTrue(self.tool("import-widget", str(p), "--replace")["ok"])

    def test_import_gwcw_rejects_zip_slip_tamper_and_bad_perm(self):
        p, g = self.make_gwcw(members=[("../../evil.js", "x"), ("widget.js", "y")])
        wid = g["metadata"]["id"]; shutil.rmtree(self.tree / "widgets" / wid)
        r = self.tool("import-widget", str(p)); self.assertFalse(r["ok"]); self.assertIn("unsafe path", r["error"])
        self.assertFalse((self.tmp / "evil.js").exists() or (self.tree / "evil.js").exists())
        def tamper(g): g["package"]["sha256"] = "0" * 64
        p, _ = self.make_gwcw(mutate=tamper); r = self.tool("import-widget", str(p)); self.assertFalse(r["ok"]); self.assertIn("integrity", r["error"])
        p, _ = self.make_gwcw(members=[("widget.js", 'import Soup from "gi://Soup";')])         # code needs network, metadata says none
        r = self.tool("import-widget", str(p)); self.assertFalse(r["ok"]); self.assertIn("permission check failed", r["error"])
        self.assertFalse((self.tree / "widgets" / wid).exists(), "a rejected import must leave nothing behind")
        self.assertEqual([x.name for x in self.tree.iterdir() if x.name.startswith(".import-")], [])

    def test_import_widget_folder_is_validated_before_it_enters_the_repo(self):
        src = self.tmp / "ext"; src.mkdir(); w = write_widget(self.tmp, "ext.w", js="eval(1)"); shutil.move(str(w), str(src / "ext.w"))
        r = self.tool("import-widget", str(src / "ext.w")); self.assertFalse(r["ok"]); self.assertFalse((self.tree / "widgets" / "ext.w").exists())
        (src / "ext.w" / "widget.js").write_text("export default class W {}"); self.assertTrue(self.tool("import-widget", str(src / "ext.w"))["ok"])

    def test_import_themepack(self):
        f = next((self.tree / "themepacks").glob("*.gwct")); dest = self.tmp / "np"; dest.mkdir(); (dest / "x.gwct").write_text(f.read_text())
        shutil.rmtree(self.tree / "themepacks"); (self.tree / "themepacks").mkdir()
        r = self.tool("import-themepack", str(dest / "x.gwct")); self.assertTrue(r["ok"], r)
        self.assertFalse(self.tool("import-themepack", str(dest / "x.gwct"))["ok"])
        (dest / "bad.gwct").write_text('{"format":"nope"}'); self.assertFalse(self.tool("import-themepack", str(dest / "bad.gwct"))["ok"])

    def test_authors_and_revoke_edit_with_rollback_on_invalid(self):
        pub = tb.new_key()[1]
        self.assertTrue(self.tool("authors", "add", "--kid", "bob-1", "--name", "Bob", "--pub", pub, "--ids", "bob.*")["ok"])
        before = (self.tree / "authors.json").read_text()
        self.assertFalse(self.tool("authors", "add", "--kid", "eve", "--name", "Eve", "--pub", pub, "--ids", "*")["ok"])
        self.assertEqual((self.tree / "authors.json").read_text(), before, "invalid edit must be rolled back")
        self.assertTrue(self.tool("authors", "remove", "--kid", "bob-1")["ok"])
        self.assertTrue(self.tool("revoke", "add", "--kind", "widgets", "--id", "bad.one", "--reason", "malware")["ok"])
        before = (self.tree / "revoked.json").read_text()
        self.assertFalse(self.tool("revoke", "add", "--kind", "widgets", "--id", "../x", "--reason", "x")["ok"])
        self.assertEqual((self.tree / "revoked.json").read_text(), before)
        self.assertTrue(self.tool("revoke", "remove", "--kind", "widgets", "--id", "bad.one")["ok"])

    def test_config_validation_and_rollback(self):
        self.assertTrue(self.tool("config", "mirrors", "https://m.example/a/, https://n.example/")["ok"])
        before = (self.tree / "store.config.json").read_text()
        for k, v in (("mirrors", "http://x/"), ("tier", "gold"), ("expiryDays", "0"), ("baseUrl", "http://x/"), ("signKid", "nokey"), ("bogus", "1"), ("requireAuthorSig", "maybe")):
            self.assertFalse(self.tool("config", k, v)["ok"], k)
        self.assertEqual((self.tree / "store.config.json").read_text(), before)

    def test_sign_widget_refuses_world_readable_key(self):
        w = write_widget(self.tree, "alice.k"); self.tool("author-keygen", "--kid", "k1")
        key = self.tmp / "keys" / "k1.key"; os.chmod(key, 0o644)
        r = self.tool("sign-widget", "alice.k", "--kid", "k1"); self.assertFalse(r["ok"]); self.assertIn("readable by other users", r["error"])
        os.chmod(key, 0o600); self.assertTrue(self.tool("sign-widget", "alice.k", "--kid", "k1")["ok"])
        self.assertTrue(self.tool("sign-widget", "alice.k", "--kid", "k1")["ok"], "re-signing must work")
        self.assertFalse(self.tool("author-keygen", "--kid", "k1")["ok"], "never overwrite an existing key")

    def test_template_in_tools_matches_repo_root(self):
        t = REPO / "tools/template"
        for rel, src in (("dot-github/workflows/pages.yml", ".github/workflows/pages.yml"), ("dot-github/workflows/pr-check.yml", ".github/workflows/pr-check.yml"),
                         ("dot-github/dependabot.yml", ".github/dependabot.yml"), ("site/open/index.html", "site/open/index.html"), ("catalogs.json", "catalogs.json")):
            self.assertEqual((t / rel).read_bytes(), (REPO / src).read_bytes(), f"tools/template/{rel} is out of sync with {src}")



class TestSourcesAndKeys(P2Base):
    """What the GTK app's Sources page and key dialog (Browse / Generate key) rely on."""
    def test_scan_source_finds_widgets_and_packs_and_marks_what_is_in_the_repo(self):
        ext = self.tmp / "ext"; write_widget(ext, "me.clock"); write_widget(ext, "me.other")
        (ext / "themepacks").mkdir(); (ext / "themepacks" / "Neon.gwct").write_text(json.dumps({"format": "gwct", "packMeta": {"id": "neon", "name": "Neon"}, "widgets": [{}]}))
        write_widget(self.tree, "me.clock")
        r = self.tool("scan-source", str(ext)); self.assertTrue(r["ok"], r)
        self.assertEqual({w["id"]: w["inRepo"] for w in r["widgets"]}, {"me.clock": True, "me.other": False})
        self.assertEqual([(t["id"], t["valid"]) for t in r["themepacks"]], [("neon", True)])
        self.assertFalse(self.tool("scan-source", str(self.tmp / "nope"))["ok"])

    def test_keys_generate_list_export_import(self):
        kd = self.tmp / "keys"
        g = self.tool("author-keygen", "--kid", "me-1"); self.assertTrue(g["ok"], g)
        self.assertEqual(stat.S_IMODE(Path(g["keyFile"]).stat().st_mode), 0o600)
        l = self.tool("list-keys"); self.assertEqual([(k["kid"], k["pub"]) for k in l["keys"]], [("me-1", g["pub"])])
        out = self.tmp / "out"; out.mkdir()
        pub = self.tool("export-key", "me-1", str(out), "--public"); self.assertTrue(pub["ok"], pub)
        self.assertEqual(json.loads((out / "me-1.pub.json").read_text())["pub"], g["pub"])
        self.assertFalse(self.tool("export-key", "me-1", str(out), "--public")["ok"], "never overwrite an exported file")
        bak = self.tool("export-key", "me-1", str(out)); self.assertTrue(bak["ok"], bak)
        self.assertEqual(stat.S_IMODE((out / "me-1.key").stat().st_mode), 0o600)
        # import: the backed-up file comes back under another id, with the same public key; never overwrites; junk is refused
        imp = self.tool("import-key", str(out / "me-1.key"), "--kid", "me-2"); self.assertTrue(imp["ok"], imp)
        self.assertEqual(imp["pub"], g["pub"]); self.assertEqual(stat.S_IMODE((kd / "me-2.key").stat().st_mode), 0o600)
        self.assertEqual(self.tool("import-key", str(out / "me-1.key"), "--kid", "me-2")["error"], f"a key named me-2 already exists in {kd}")
        (out / "junk.txt").write_text("hello"); self.assertIn("not a signing key", self.tool("import-key", str(out / "junk.txt"))["error"])
        self.assertFalse(self.tool("import-key", str(out / "me-1.key"), "--kid", "../x")["ok"])
        self.assertFalse(self.tool("import-key", str(out / "missing.key"))["ok"])
        shutil.copy(out / "me-1.key", out / "other.key"); os.chmod(out / "other.key", 0o644)       # a source file need not be mode 0600
        self.assertEqual(self.tool("import-key", str(out / "other.key"))["kid"], "other", "the id defaults to the file name")


class TestAppBackendInSync(unittest.TestCase):
    def test_bundled_backend_equals_tools(self):
        app = REPO.parent / "gwc-repo-maker" / "backend" / "tools"
        if not app.is_dir():
            self.skipTest("gwc-repo-maker not next to gwc-store")
        def tree(p): return {str(f.relative_to(p)): f.read_bytes() for f in p.rglob("*") if f.is_file() and "__pycache__" not in f.parts}
        self.assertEqual(tree(REPO / "tools"), tree(app), "run gwc-repo-maker/sync-backend.sh")


if __name__ == "__main__":
    unittest.main()
