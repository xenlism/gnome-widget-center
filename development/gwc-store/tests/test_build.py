"""Tests for tools/build_store.py + verify_store.py.   Run:  python3 -m unittest discover -s tests -v"""
import json, os, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
import gwc_sign
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import base64
from verify_store import verify_dist


def new_key():
    k = Ed25519PrivateKey.generate()
    seed = base64.b64encode(k.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())).decode()
    return seed, gwc_sign.public_b64(k)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.seed, self.pub = new_key()
        self.tree = self.tmp / "repo"
        shutil.copytree(REPO, self.tree, ignore=shutil.ignore_patterns("dist", "__pycache__", ".git", "tests"))
        cfg = json.loads((self.tree / "store.config.json").read_text())
        cfg["trust"] = {"signKid": "t-a", "expiryDays": 30, "keys": [{"kid": "t-a", "pub": self.pub}]}
        (self.tree / "store.config.json").write_text(json.dumps(cfg))
        self.trusted = {"t-a": self.pub}

    def build(self, *extra, tree=None, seed=None, out="dist", env=None):
        tree = tree or self.tree
        e = {k: v for k, v in os.environ.items() if k != "GITHUB_ACTIONS"}
        e.update({"GWC_SIGNING_KEY": seed or self.seed, **(env or {})})
        return subprocess.run([sys.executable, str(tree / "tools/build_store.py"), "--out", str(self.tmp / out) if not os.path.isabs(out) else out, *extra],
                              cwd=tree, env=e, capture_output=True, text=True)


class TestSignedBuild(Base):
    def test_signed_build_verifies(self):
        r = self.build("--first-publish", "--now", "2026-10-07T00:00:00Z")
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        errs, info = verify_dist(self.tmp / "dist", self.trusted)
        self.assertEqual(errs, [])
        self.assertEqual(info["seq"], 1)
        m = json.loads((self.tmp / "dist/store.json").read_text())
        self.assertEqual(m["expires"], "2026-11-06T00:00:00Z")
        self.assertTrue(all(len(d["sha256"]) == 64 for d in m["shards"].values()))

    def test_deterministic(self):
        a = ["--seq", "5", "--now", "2026-10-07T00:00:00Z"]
        self.assertEqual(self.build(*a, out="d1").returncode, 0)
        self.assertEqual(self.build(*a, out="d2").returncode, 0)
        for f in ("store.json", "store.json.sig"):
            self.assertEqual((self.tmp / "d1" / f).read_bytes(), (self.tmp / "d2" / f).read_bytes())
        n1 = sorted(p.relative_to(self.tmp / "d1").as_posix() for p in (self.tmp / "d1").rglob("*") if p.is_file())
        n2 = sorted(p.relative_to(self.tmp / "d2").as_posix() for p in (self.tmp / "d2").rglob("*") if p.is_file())
        self.assertEqual(n1, n2)

    def test_wrong_key_refused(self):
        other_seed, _ = new_key()
        r = self.build("--first-publish", seed=other_seed)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("does not match", r.stderr)
        self.assertFalse((self.tmp / "dist").exists())

    def test_missing_key_refused(self):
        e = {k: v for k, v in os.environ.items() if k != "GWC_SIGNING_KEY"}
        r = subprocess.run([sys.executable, str(self.tree / "tools/build_store.py"), "--out", str(self.tmp / "dist"), "--first-publish"],
                           cwd=self.tree, env=e, capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("signing key missing", r.stderr)

    def test_unsigned_refused_in_ci(self):
        r = self.build("--unsigned", env={"GITHUB_ACTIONS": "true"})
        self.assertNotEqual(r.returncode, 0)


class TestTamper(Base):
    def setUp(self):
        super().setUp()
        self.assertEqual(self.build("--first-publish").returncode, 0)
        self.d = self.tmp / "dist"

    def test_tampered_manifest_fails_signature(self):
        p = self.d / "store.json"; p.write_bytes(p.read_bytes().replace(b'"seq":1', b'"seq":2'))
        errs, _ = verify_dist(self.d, self.trusted)
        self.assertTrue(any("signature" in e for e in errs), errs)

    def test_missing_sig_fails(self):
        (self.d / "store.json.sig").unlink()
        errs, _ = verify_dist(self.d, self.trusted)
        self.assertTrue(any("signature" in e for e in errs), errs)

    def test_wrong_trusted_key_fails(self):
        _, other = new_key()
        errs, _ = verify_dist(self.d, {"t-a": other})
        self.assertTrue(any("signature" in e for e in errs), errs)

    def test_unknown_kid_fails(self):
        errs, _ = verify_dist(self.d, {"someone-else": self.pub})
        self.assertTrue(any("unknown key id" in e for e in errs), errs)

    def test_tampered_shard_detected(self):
        f = next((self.d / "i").glob("themepacks-*.json")); f.write_bytes(f.read_bytes().replace(b"1", b"2", 1))
        errs, _ = verify_dist(self.d, self.trusted)
        self.assertTrue(any("size/hash" in e or "shard" in e for e in errs), errs)

    def test_tampered_package_detected(self):
        f = next((self.d / "t").glob("*.gwct")); b = bytearray(f.read_bytes()); b[10] ^= 1; f.write_bytes(bytes(b))
        errs, _ = verify_dist(self.d, self.trusted)
        self.assertTrue(any("mismatch" in e for e in errs), errs)

    def test_tampered_cover_detected(self):
        f = next((self.d / "c").glob("*.jpg")); b = bytearray(f.read_bytes()); b[-3] ^= 1; f.write_bytes(bytes(b))
        errs, _ = verify_dist(self.d, self.trusted)
        self.assertTrue(any("cover hash" in e for e in errs), errs)

    def test_unreferenced_file_detected(self):
        (self.d / "w" / "evil.gwcw").write_text("{}")
        errs, _ = verify_dist(self.d, self.trusted)
        self.assertTrue(any("unreferenced" in e for e in errs), errs)


class TestOutGuard(Base):
    def test_out_dot_does_not_delete_source(self):
        r = self.build(out=str(self.tree))
        self.assertNotEqual(r.returncode, 0); self.assertTrue((self.tree / "widgets").exists())
        r = self.build(out=str(self.tree / "widgets"))
        self.assertNotEqual(r.returncode, 0); self.assertTrue((self.tree / "widgets").exists())
        r = self.build(out=str(self.tree.parent))      # parent of source tree
        self.assertNotEqual(r.returncode, 0); self.assertTrue(self.tree.exists())

    def test_root_and_home_refused_without_ever_deleting(self):
        # call the guard function directly: it only validates, it never deletes, so this test is safe even if broken
        sys.path.insert(0, str(self.tree / "tools"))
        import importlib.util
        spec = importlib.util.spec_from_file_location("bs_under_test", self.tree / "tools/build_store.py")
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        for bad in (Path("/"), Path.home(), mod.ROOT, mod.ROOT.parent, mod.ROOT / "widgets", mod.ROOT / "tools"):
            with self.assertRaises(SystemExit, msg=str(bad)):
                mod.check_out_dir(bad)
        mod.check_out_dir(self.tmp / "fresh")                 # a brand-new dir is fine

    def test_foreign_nonempty_dir_refused_then_own_dir_reusable(self):
        foreign = self.tmp / "foreign"; foreign.mkdir(); (foreign / "precious.txt").write_text("x")
        r = self.build("--first-publish", out=str(foreign))
        self.assertNotEqual(r.returncode, 0); self.assertTrue((foreign / "precious.txt").exists())
        self.assertEqual(self.build("--first-publish", out="again").returncode, 0)
        self.assertEqual(self.build("--seq", "2", out="again").returncode, 0)       # marker present -> may be rebuilt


class TestSourceValidation(Base):
    def wdir(self):
        return next((self.tree / "widgets").iterdir())

    def test_hidden_file_rejected(self):
        (self.wdir() / ".env").write_text("SECRET=1")
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("hidden", r.stderr)

    def test_disallowed_extension_rejected(self):
        (self.wdir() / "payload.so").write_bytes(b"\x7fELF")
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("not allowed", r.stderr)

    def test_symlink_rejected(self):
        os.symlink("/etc/passwd", self.wdir() / "link.txt")
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("symlink", r.stderr)

    def test_case_collision_rejected(self):
        (self.wdir() / "A.js").write_text("1"); (self.wdir() / "a.js").write_text("2")
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("case", r.stderr)

    def test_bad_version_rejected(self):
        md = self.wdir() / "metadata.json"; d = json.loads(md.read_text()); d["version"] = "latest!"
        md.write_text(json.dumps(d))
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("version", r.stderr)

    def test_entry_traversal_rejected(self):
        md = self.wdir() / "metadata.json"; d = json.loads(md.read_text()); d["entry"] = "../x.js"
        md.write_text(json.dumps(d))
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0)

    def test_duplicate_themepack_id_rejected(self):
        packs = sorted((self.tree / "themepacks").glob("*.gwct"))
        d = json.loads(packs[0].read_text()); d.setdefault("packMeta", {})["id"] = "dupe-id"
        packs[0].write_text(json.dumps(d))
        d2 = json.loads(packs[1].read_text()); d2.setdefault("packMeta", {})["id"] = "dupe-id"
        packs[1].write_text(json.dumps(d2))
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("duplicate", r.stderr)


class TestSeq(Base):
    def test_seq_increments_from_signed_previous(self):
        self.assertEqual(self.build("--seq", "41", out="prev").returncode, 0)
        r = self.build("--prev-url", (self.tmp / "prev/store.json").as_uri(), out="next")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads((self.tmp / "next/store.json").read_text())["seq"], 42)

    def test_unsigned_or_forged_previous_refused(self):
        self.assertEqual(self.build("--seq", "7", out="prev").returncode, 0)
        (self.tmp / "prev/store.json").write_bytes((self.tmp / "prev/store.json").read_bytes().replace(b'"seq":7', b'"seq":9000'))
        r = self.build("--prev-url", (self.tmp / "prev/store.json").as_uri(), out="next")
        self.assertNotEqual(r.returncode, 0); self.assertIn("not valid/signed", r.stderr)

    def test_unreachable_previous_never_guessed(self):
        r = self.build("--prev-url", (self.tmp / "nope/store.json").as_uri(), out="next")
        self.assertNotEqual(r.returncode, 0); self.assertIn("refusing to guess", r.stderr)

    def test_no_seq_source_refused(self):
        r = self.build(); self.assertNotEqual(r.returncode, 0); self.assertIn("need one of", r.stderr)


class TestRetention(Base):
    """Pages caches store.json for minutes: files of the previous revision must stay downloadable (APT by-hash idea)."""
    def publish_a_then_change_sources(self):
        self.assertEqual(self.build("--seq", "1", out="live").returncode, 0)
        self.live = self.tmp / "live"
        self.old = json.loads((self.live / "store.json").read_text())
        wdir = next((self.tree / "widgets").iterdir())
        md = json.loads((wdir / "metadata.json").read_text()); md["version"] = "9.9.9"; (wdir / "metadata.json").write_text(json.dumps(md))
        (wdir / "extra.txt").write_text("new content")
        pack = sorted((self.tree / "themepacks").glob("*.gwct"))[0]
        d = json.loads(pack.read_text()); d["appearance"] = {"changed": True}; pack.write_text(json.dumps(d))

    def old_files(self):
        out = []
        for kind, dsc in self.old["shards"].items():
            out.append(dsc["p"])
            for it in json.loads((self.live / dsc["p"]).read_text())["items"]:
                if "f" not in it: continue                      # search shard
                out.append(it["f"]); it["cv"] and out.append(it["cv"])
        return out

    def test_previous_revision_is_retained_verified_and_signed(self):
        self.publish_a_then_change_sources()
        r = self.build("--prev-url", (self.live / "store.json").as_uri(), out="next")
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertIn("kept previous seq=1", r.stdout)
        nxt = self.tmp / "next"
        self.assertEqual(json.loads((nxt / "store.json").read_text())["seq"], 2)
        for rel in self.old_files():                                  # every file the OLD manifest points to is still there, byte-identical
            self.assertEqual((nxt / rel).read_bytes(), (self.live / rel).read_bytes(), rel)
        errs, info = verify_dist(nxt, self.trusted)
        self.assertEqual(errs, []); self.assertTrue(info["prev"])
        changed = [rel for rel in self.old_files() if not (self.tmp / "next" / rel).exists()]
        self.assertEqual(changed, [])

    def test_no_keep_prev_drops_old_files(self):
        self.publish_a_then_change_sources()
        r = self.build("--prev-url", (self.live / "store.json").as_uri(), "--no-keep-prev", out="next")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse((self.tmp / "next/prev").exists())
        gone = [rel for rel in self.old_files() if not (self.tmp / "next" / rel).exists()]
        self.assertTrue(gone, "changed widget/pack/shard files of the old revision should not be published without retention")

    def test_missing_live_file_stops_the_build(self):
        self.publish_a_then_change_sources()
        (self.live / next(r for r in self.old_files() if r.startswith("w/"))).unlink()
        r = self.build("--prev-url", (self.live / "store.json").as_uri(), out="next")
        self.assertNotEqual(r.returncode, 0); self.assertIn("retain", r.stderr); self.assertIn("dangling", r.stderr)

    def test_corrupt_live_file_is_never_republished(self):
        self.publish_a_then_change_sources()
        f = self.live / next(r for r in self.old_files() if r.startswith("t/"))
        b = bytearray(f.read_bytes()); b[7] ^= 1; f.write_bytes(bytes(b))
        r = self.build("--prev-url", (self.live / "store.json").as_uri(), out="next")
        self.assertNotEqual(r.returncode, 0); self.assertIn("does not match", r.stderr)

    def test_verify_detects_tampered_prev(self):
        self.publish_a_then_change_sources()
        self.assertEqual(self.build("--prev-url", (self.live / "store.json").as_uri(), out="next").returncode, 0)
        nxt = self.tmp / "next"
        pm = nxt / "prev/store.json"; pm.write_bytes(pm.read_bytes().replace(b'"seq":1', b'"seq":5'))
        errs, _ = verify_dist(nxt, self.trusted)
        self.assertTrue(any(e.startswith("prev:") for e in errs), errs)

    def test_explicit_seq_skips_retention(self):
        self.publish_a_then_change_sources()
        r = self.build("--prev-url", (self.live / "store.json").as_uri(), "--seq", "1", out="next")   # --seq given: no prev loaded, plain build
        self.assertEqual(r.returncode, 0)
        self.assertFalse((self.tmp / "next/prev").exists())


class TestRevoked(Base):
    def write(self, data):
        (self.tree / "revoked.json").write_text(json.dumps(data))

    def test_valid_list_is_signed_into_manifest_sorted(self):
        self.write([{"kind": "widgets", "id": "zeta.bad", "reason": "steals data"},
                    {"kind": "themepacks", "id": "alpha-pack", "h": "a" * 32, "reason": "broken"}])
        self.assertEqual(self.build("--first-publish").returncode, 0)
        m = json.loads((self.tmp / "dist/store.json").read_text())
        self.assertEqual([e["id"] for e in m["revoked"]], ["alpha-pack", "zeta.bad"])
        self.assertEqual(verify_dist(self.tmp / "dist", self.trusted)[0], [])

    def test_bad_entries_rejected(self):
        bad = [{"kind": "other", "id": "ab", "reason": "x"}, {"kind": "widgets", "id": "../x", "reason": "x"},
               {"kind": "widgets", "id": "ok.id", "h": "short", "reason": "x"}, {"kind": "widgets", "id": "ok.id"},
               {"kind": "widgets", "id": "ok.id", "reason": "x" * 201}, {"kind": "widgets", "id": "ok.id", "reason": "x", "extra": 1},
               "string"]
        for e in bad:
            self.write([e]); r = self.build("--first-publish", out="d")
            self.assertNotEqual(r.returncode, 0, e); self.assertIn("revoked.json", r.stderr)
        self.write([{"kind": "widgets", "id": "dup.id", "reason": "x"}] * 2)
        r = self.build("--first-publish", out="d"); self.assertNotEqual(r.returncode, 0); self.assertIn("duplicate", r.stderr)

    def test_missing_file_means_empty_list(self):
        (self.tree / "revoked.json").unlink()
        self.assertEqual(self.build("--first-publish").returncode, 0)
        self.assertEqual(json.loads((self.tmp / "dist/store.json").read_text())["revoked"], [])


if __name__ == "__main__":
    unittest.main()
