"""Version 2 widget packages: a .gwcw (JSON metadata, references the zip) + a .gwcp (the widget folder as a RAW zip).
Small widgets (zip <= 4 MiB and <= 16 MiB unpacked) stay version 1: one .gwcw with the zip as base64.   Run: python3 -m unittest discover -s tests -v"""
import base64, hashlib, json, os, shutil, sys, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_build as tb
from test_p2p3 import P2Base, write_widget
from verify_store import verify_dist

MiB = 1024 * 1024


def big_widget(tree, wid="big.one", mib=5, version="1.0.0"):
    d = write_widget(tree, wid, version=version)
    (d / "assets.png").write_bytes(os.urandom(mib * MiB))              # incompressible: the zip really is > 4 MiB
    return d


class TestSplitPackages(P2Base):
    def items(self, dist=None):
        dist = dist or self.tmp / "dist"
        m = json.loads((dist / "store.json").read_text()); out = {}
        for d in m["shards"].values():
            for it in json.loads((dist / d["p"]).read_text())["items"]:
                if "f" in it: out[it["id"]] = it
        return out

    def test_big_widget_is_version_2_and_small_ones_are_unchanged(self):
        big_widget(self.tree)
        r = self.build("--first-publish", "--now", "2026-10-07T00:00:00Z"); self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        errs, _ = verify_dist(self.tmp / "dist", self.trusted); self.assertEqual(errs, [])
        its = self.items(); big = its["big.one"]
        self.assertTrue({"z", "zs", "zh"} <= set(big) and big["z"].endswith(".gwcp") and big["z"].startswith("w/"))
        self.assertLess(big["s"], 64 * 1024, "f/s/h describe the small .gwcw (metadata only)")
        g = json.loads((self.tmp / "dist" / big["f"]).read_bytes())
        self.assertEqual((g["format"], g["version"], g["package"]["encoding"]), ("gwcw", 2, "zip"))
        self.assertNotIn("data", g["package"]); self.assertEqual(g["package"]["file"], big["z"].split("/")[-1])
        zb = (self.tmp / "dist" / big["z"]).read_bytes()
        self.assertEqual(zb[:2], b"PK", "a RAW zip, not base64")
        self.assertEqual((len(zb), hashlib.sha256(zb).hexdigest()), (g["package"]["size"], g["package"]["sha256"]))
        self.assertEqual((big["zs"], big["zh"]), (len(zb), hashlib.sha256(zb).hexdigest()[:32]))
        self.assertGreater(len(zb), 4 * MiB)
        small = [i for i in its.values() if "z" not in i and i["f"].startswith("w/")]; self.assertTrue(small, "the repo's own widgets stay version 1")
        for it in small:
            g1 = json.loads((self.tmp / "dist" / it["f"]).read_bytes())
            self.assertEqual((g1["version"], g1["package"]["encoding"]), (1, "zip+base64"))
            self.assertEqual(hashlib.sha256(base64.b64decode(g1["package"]["data"])).hexdigest(), g1["package"]["sha256"])

    def test_deterministic(self):
        big_widget(self.tree)
        a = ["--seq", "5", "--now", "2026-10-07T00:00:00Z"]
        self.assertEqual(self.build(*a, out="d1").returncode, 0); self.assertEqual(self.build(*a, out="d2").returncode, 0)
        for rel in sorted(p.relative_to(self.tmp / "d1").as_posix() for p in (self.tmp / "d1").rglob("*") if p.is_file()):
            self.assertEqual((self.tmp / "d1" / rel).read_bytes(), (self.tmp / "d2" / rel).read_bytes(), rel)

    def test_compressible_but_over_16_mib_unpacked_is_version_2(self):
        d = write_widget(self.tree, "wide.one"); block = os.urandom(20 * 1024)
        for n in ("a.txt", "b.txt"): (d / n).write_bytes(block * (9 * MiB // len(block)))            # 2 x ~9 MiB, deflates well but < 200x
        r = self.build("--first-publish"); self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        it = self.items()["wide.one"]; self.assertIn("z", it); self.assertLess(it["zs"], 4 * MiB, "small zip, but the client would refuse > 16 MiB unpacked as version 1")
        self.assertEqual(verify_dist(self.tmp / "dist", self.trusted)[0], [])

    def test_zip_bomb_ratio_is_refused_at_build_time(self):
        d = write_widget(self.tree, "bomb.one"); (d / "zeros.txt").write_bytes(b"\0" * (3 * MiB))
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0)
        self.assertIn("zeros.txt", r.stderr); self.assertIn("zip bomb", r.stderr)

    def test_unpacked_over_128_mib_is_refused(self):
        d = write_widget(self.tree, "huge.one"); block = os.urandom(20 * 1024)
        for i in range(9): (d / f"p{i}.txt").write_bytes(block * (16 * MiB // len(block)))                # 9 x ~16 MiB > 128 MiB
        r = self.build("--first-publish"); self.assertNotEqual(r.returncode, 0); self.assertIn("unpacked", r.stderr)

    def test_tampered_gwcp_is_caught(self):
        big_widget(self.tree); self.assertEqual(self.build("--first-publish").returncode, 0)
        z = self.tmp / "dist" / self.items()["big.one"]["z"]; b = bytearray(z.read_bytes()); b[len(b) // 2] ^= 1; z.write_bytes(bytes(b))
        errs, _ = verify_dist(self.tmp / "dist", self.trusted); self.assertTrue(any(".gwcp size/hash mismatch" in e for e in errs), errs)

    def test_missing_gwcp_is_caught(self):
        big_widget(self.tree); self.assertEqual(self.build("--first-publish").returncode, 0)
        (self.tmp / "dist" / self.items()["big.one"]["z"]).unlink()
        errs, _ = verify_dist(self.tmp / "dist", self.trusted); self.assertTrue(any(".gwcp missing" in e for e in errs), errs)

    def test_unreferenced_gwcp_is_caught(self):
        big_widget(self.tree); self.assertEqual(self.build("--first-publish").returncode, 0)
        (self.tmp / "dist" / "w" / "stray.aaaaaaaaaaaaaaaa.gwcp").write_bytes(b"PK")
        errs, _ = verify_dist(self.tmp / "dist", self.trusted); self.assertTrue(any("unreferenced file" in e for e in errs), errs)

    def test_previous_revision_keeps_the_old_gwcp_reachable(self):
        d = big_widget(self.tree); self.assertEqual(self.build("--first-publish", out="live").returncode, 0)
        old = self.items(self.tmp / "live")["big.one"]["z"]
        (d / "assets.png").write_bytes(os.urandom(5 * MiB))                                            # new content => new .gwcp name
        md = json.loads((d / "metadata.json").read_text()); md["version"] = "1.0.1"; (d / "metadata.json").write_text(json.dumps(md))
        r = self.build("--prev-url", (self.tmp / "live" / "store.json").as_uri(), out="next"); self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        new = self.items(self.tmp / "next")["big.one"]["z"]; self.assertNotEqual(old, new)
        self.assertTrue((self.tmp / "next" / old).is_file(), "the previous .gwcp is copied from the live site")
        self.assertEqual(verify_dist(self.tmp / "next", self.trusted)[0], [])

    def test_import_widget_reads_version_2_next_to_its_gwcp(self):
        d = big_widget(self.tree); self.assertEqual(self.build("--first-publish").returncode, 0)
        it = self.items()["big.one"]; src = self.tmp / "dl"; src.mkdir()
        shutil.copy(self.tmp / "dist" / it["f"], src / "x.gwcw"); shutil.copy(self.tmp / "dist" / it["z"], src / it["z"].split("/")[-1])
        other = self.tmp / "other"; shutil.copytree(self.tree, other, ignore=shutil.ignore_patterns("dist", "widgets"))
        (other / "widgets").mkdir()
        r = self.tool("import-widget", str(src / "x.gwcw"), tree=other); self.assertTrue(r["ok"], r)
        self.assertEqual((other / "widgets/big.one/assets.png").read_bytes(), (d / "assets.png").read_bytes())
        (src / it["z"].split("/")[-1]).unlink()
        r = self.tool("import-widget", str(src / "x.gwcw"), "--replace", tree=other); self.assertFalse(r["ok"]); self.assertIn("must be next to", r["error"])


if __name__ == "__main__":
    unittest.main()
