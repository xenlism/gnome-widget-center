#!/usr/bin/env python3
"""Build a signed store + signed *bad* variants for the client's Node tests.  usage: make_client_fixtures.py <outdir>
Writes <outdir>/fixtures.json describing keys and variant directories."""
import base64, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
import gwc_sign
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

out = Path(sys.argv[1]); shutil.rmtree(out, ignore_errors=True); out.mkdir(parents=True)


def keypair():
    k = Ed25519PrivateKey.generate()
    return k, base64.b64encode(k.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())).decode()


priv, seed = keypair(); pub = gwc_sign.public_b64(priv)
other, _ = keypair()
cfg = json.loads((REPO / "store.config.json").read_text())
cfg["trust"] = {"signKid": "fx-a", "expiryDays": 30, "keys": [{"kid": "fx-a", "pub": pub}]}
cfgp = out / "config.json"; cfgp.write_text(json.dumps(cfg))


def build(dst, *extra):
    env = {**os.environ, "GWC_SIGNING_KEY": seed}; env.pop("GITHUB_ACTIONS", None)
    r = subprocess.run([sys.executable, str(REPO / "tools/build_store.py"), "--config", str(cfgp), "--out", str(dst), *extra],
                       env=env, capture_output=True, text=True)
    if r.returncode: sys.exit(r.stderr)


def variant(name, mutate, signer=priv, kid="fx-a"):
    d = out / name; shutil.copytree(out / "good", d)
    m = json.loads((d / "store.json").read_text()); mutate(m)
    raw = json.dumps(m, separators=(",", ":"), ensure_ascii=False).encode()
    (d / "store.json").write_bytes(raw)
    (d / "store.json.sig").write_bytes(gwc_sign.sign_manifest(signer, kid, raw))


build(out / "good", "--seq", "10", "--now", "2026-10-07T00:00:00Z")
build(out / "older", "--seq", "9", "--now", "2026-10-06T00:00:00Z")
build(out / "newer", "--seq", "11", "--now", "2026-10-07T12:00:00Z")
build(out / "expired", "--seq", "10", "--now", "2020-01-01T00:00:00Z")
variant("schema1", lambda m: m.update(schema=1))
variant("seq0", lambda m: m.update(seq=0))
variant("seq-float", lambda m: m.update(seq=1.5))
variant("expires-before-issued", lambda m: m.update(expires="2000-01-01T00:00:00Z"))
variant("shard-traversal", lambda m: m["shards"]["widgets-other"].update(p="i/../../etc/passwd"))
variant("shard-bad-sha", lambda m: m["shards"]["widgets-other"].update(sha256="zz"))
variant("shard-huge", lambda m: m["shards"]["widgets-other"].update(s=10**12))
variant("unknown-kid", lambda m: None, signer=other, kid="not-trusted")
variant("signed-by-other-key", lambda m: None, signer=other, kid="fx-a")     # right kid, wrong private key

# revoked[] variants (validly signed manifests with good / malformed revocation lists)
REV_OK = [{"kind": "widgets", "id": "a.b", "reason": "steals data"},
          {"kind": "themepacks", "id": "pack-x", "h": "a" * 32, "reason": "broken"}]
variant("revoked", lambda m: m.update(revoked=REV_OK))
for name, bad in [("revoked-badkind", [{"kind": "other", "id": "a.b", "reason": "x"}]),
                  ("revoked-badid", [{"kind": "widgets", "id": "../x", "reason": "x"}]),
                  ("revoked-badh", [{"kind": "widgets", "id": "a.b", "h": "xyz", "reason": "x"}]),
                  ("revoked-noreason", [{"kind": "widgets", "id": "a.b", "reason": ""}]),
                  ("revoked-longreason", [{"kind": "widgets", "id": "a.b", "reason": "x" * 201}]),
                  ("revoked-toomany", [{"kind": "widgets", "id": "a.b", "reason": "x"}] * 1001),
                  ("revoked-notlist", {"kind": "widgets"})]:
    variant(name, lambda m, bad=bad: m.update(revoked=bad))

# malformed (but validly signed) P2/P3 manifest fields: the client must not trust a signature to mean "well-formed"
variant("bad-mirror-http", lambda m: m.update(mirrors=["http://m.test/"]))
variant("bad-mirror-self", lambda m: m.update(mirrors=[m["base"]]))
variant("bad-author", lambda m: m.update(authors=[{"kid": "x", "name": "X", "pub": "AAAA", "ids": ["x.*"]}]))
variant("bad-policy", lambda m: m.update(policy={"authorSig": "maybe"}))
variant("bad-tier", lambda m: m.update(tier="gold"))

# republished builds from modified SOURCES: one pack changed, one pack removed (for the "store changed under you" tests)
def tree_variant(name, seq, mutate, cfg_mutate=None):
    t = Path(tempfile.mkdtemp()) / "repo"
    shutil.copytree(REPO, t, ignore=shutil.ignore_patterns("dist", "__pycache__", ".git", "tests"))
    mutate(t)
    cp = cfgp
    if cfg_mutate:
        c = json.loads(cfgp.read_text()); cfg_mutate(c); cp = out / f"config-{name}.json"; cp.write_text(json.dumps(c))
    env = {**os.environ, "GWC_SIGNING_KEY": seed}; env.pop("GITHUB_ACTIONS", None)
    r = subprocess.run([sys.executable, str(t / "tools/build_store.py"), "--config", str(cp), "--out", str(out / name),
                        "--seq", str(seq), "--now", "2026-10-07T12:00:00Z"], cwd=t, env=env, capture_output=True, text=True)
    if r.returncode: sys.exit(r.stderr)

def pack_id(f):
    return json.loads(f.read_text())["packMeta"]["id"]

def change_pack(t):
    f = sorted((t / "themepacks").glob("*.gwct"))[0]
    d = json.loads(f.read_text()); d["appearance"] = {"changed": True}; f.write_text(json.dumps(d))

def remove_pack(t):
    sorted((t / "themepacks").glob("*.gwct"))[0].unlink()

first_pack = pack_id(sorted((REPO / "themepacks").glob("*.gwct"))[0])
tree_variant("changed", 12, change_pack)
tree_variant("removed", 13, remove_pack)

# ---- P2/P3: author-signed widget, beta widget, widget with network perm, mirrors, community policy
alice, alice_seed = keypair(); alice_pub = gwc_sign.public_b64(alice)

def mk_widget(t, wid, catalog, js="export default class W {}\n", perm=("none",), **extra):
    d = t / "widgets" / wid; d.mkdir(parents=True)
    (d / "metadata.json").write_text(json.dumps({"id": wid, "name": wid, "description": "d", "version": "1.2.0", "author": "Alice", "api-version": 2,
                                                  "entry": "widget.js", "catalog": catalog, "perm": list(perm), **extra}))
    (d / "widget.js").write_text(js)
    return d

def sign_widget(d):
    import build_store as bs
    md = json.loads((d / "metadata.json").read_text()); files = bs.package_files(d)
    td = gwc_sign.tree_digest(files)
    sig = gwc_sign.sign_package(alice, gwc_sign.package_message(md["id"], md["version"], md["entry"], md["perm"], td))
    (d / "signature.json").write_text(json.dumps({"alg": "ed25519", "kid": "alice-1", "sig": sig, "td": td}))

def p3_tree(t):
    (t / "authors.json").write_text(json.dumps([{"kid": "alice-1", "name": "Alice", "pub": alice_pub, "ids": ["alice.*"]}]))
    sign_widget(mk_widget(t, "alice.clock", "clock"))
    mk_widget(t, "bob.net", "system", js='import Soup from "gi://Soup";\nexport default class N {}\n', perm=("network",))
    mk_widget(t, "bob.beta", "other", channel="beta")

def p3_cfg(c): c["mirrors"] = ["https://mirror.test/store/"]

def community_tree(t):
    p3_tree(t)
    for w in ("bob.net", "bob.beta", "xenlism.github.io.my-widget"): shutil.rmtree(t / "widgets" / w)
    shutil.rmtree(t / "themepacks"); (t / "themepacks").mkdir()

tree_variant("p3", 20, p3_tree, p3_cfg)
tree_variant("p3-newer", 21, lambda t: (p3_tree(t), (t / "widgets/bob.net/widget.js").write_text('import Soup from "gi://Soup";\nexport default class N2 {}\n')), p3_cfg)
tree_variant("community", 30, community_tree, lambda c: c.update(tier="community", requireAuthorSig=True))

# version 2 package: one widget whose zip is > 4 MiB (incompressible data) => .gwcw metadata + raw .gwcp, signed like any other
def big_tree(t):
    d = mk_widget(t, "alice.big", "clock"); (d / "assets.png").write_bytes(os.urandom(5 * 1024 * 1024))
    sign_widget(d)
def big_cfg(c): pass
tree_variant("big", 40, lambda t: (p3_tree(t), big_tree(t)), p3_cfg)

g = out / "good"
fx = {"aliceKid": "alice-1", "alicePub": alice_pub, "pub": pub, "kid": "fx-a", "fingerprint": gwc_sign.fingerprint(pub),
      "otherPub": gwc_sign.public_b64(other), "firstPack": first_pack}
(out / "fixtures.json").write_text(json.dumps(fx))
print("fixtures in", out)
