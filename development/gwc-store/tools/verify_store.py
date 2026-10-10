#!/usr/bin/env python3
"""verify_store.py - verify a built store directory the way a client would (chain of trust + sanity).

  python tools/verify_store.py dist                 # keys from store.config.json "trust.keys"
  python tools/verify_store.py dist --unsigned      # dev builds only

Checks: signature, schema/seq/expiry shape, mirrors/authors/policy shape, per-category shards + search shard consistency,
perm syntax, tree digest of every widget package, author signatures, every shard sha256 + size, every item file size + hash,
every cover hash == its file name, no path escapes, no dangling or unreferenced content files.
Exit code 1 on any error. build_store.py runs this on its own output before finishing.
"""
import argparse, base64, hashlib, io, json, re, sys, zipfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import gwc_sign
import perm_scan

# size limits shared with build_store.py (which imports them) and mirrored by the client (lib/store/integrity.js, zipKit.js)
MAX_ZIP_BIG = 64 * 1024 * 1024      # version 2 packages (.gwcp), compressed
MAX_TOTAL = 16 * 1024 * 1024        # version 1 package, uncompressed
MAX_TOTAL_BIG = 128 * 1024 * 1024   # version 2 package, uncompressed
MAX_RATIO = 200                     # uncompressed / compressed, per file
MAX_META = 1024 * 1024              # a version 2 .gwcw (metadata only)

NAME = r"[A-Za-z0-9][A-Za-z0-9._-]*"
REL_OK = re.compile(rf"^(c|i|w|t)/{NAME}$")
COVER = re.compile(r"^c/([0-9a-f]{32})\.jpg$")
HEX64, HEX32 = re.compile(r"^[0-9a-f]{64}$"), re.compile(r"^[0-9a-f]{32}$")
SHARD_NAME = re.compile(r"^(search|widgets-[a-z0-9]{1,20}|themepacks-[a-z0-9]{1,20})$")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,80}$")
sha256 = lambda b: hashlib.sha256(b).hexdigest()


def _package_td(raw, it, e, label, zbytes_v2=None):
    """Open a widget package like the client does and recompute what the item claims: tree digest, id, version, entry, perm.
    Version 1: the zip is inside the .gwcw (base64). Version 2: the zip is the item's separate .gwcp (`zbytes_v2`)."""
    try:
        g = json.loads(raw)
        md, pkg = g["metadata"], g["package"]
        if g.get("version") == 2:
            if zbytes_v2 is None or pkg.get("encoding") != "zip" or "data" in pkg:
                e(f"{label}{it['id']}: version 2 .gwcw needs its .gwcp and no inline data"); return None
            if pkg.get("file") != it["z"].split("/")[-1]:
                e(f"{label}{it['id']}: .gwcw names {pkg.get('file')!r} but the listing points to {it['z']!r}"); return None
            zbytes, big = zbytes_v2, True
        else:
            if g.get("version") != 1 or zbytes_v2 is not None or pkg.get("encoding") != "zip+base64":
                e(f"{label}{it['id']}: unsupported .gwcw (version/encoding) or a .gwcp next to a version 1 file"); return None
            zbytes, big = base64.b64decode(pkg["data"], validate=True), False
        if len(zbytes) != pkg["size"] or sha256(zbytes) != pkg["sha256"]:
            e(f"{label}{it['id']}: package zip size/hash differs from its own header"); return None
        with zipfile.ZipFile(io.BytesIO(zbytes)) as z:
            infos = [i for i in z.infolist() if not i.is_dir()]
            total = sum(i.file_size for i in infos)
            if total > (MAX_TOTAL_BIG if big else MAX_TOTAL):
                e(f"{label}{it['id']}: unpacked size {total} B exceeds the client limit"); return None
            for i in infos:
                if i.compress_size and i.file_size / i.compress_size > MAX_RATIO:
                    e(f"{label}{it['id']}: {i.filename} compresses more than {MAX_RATIO}x (the client refuses it)"); return None
            if not big and len(zbytes) > 4 * 1024 * 1024:
                e(f"{label}{it['id']}: a version 1 package is larger than 4 MiB: it must be version 2"); return None
            files = [(i.filename, z.read(i)) for i in infos]
    except (ValueError, KeyError, TypeError, zipfile.BadZipFile) as ex:
        e(f"{label}{it['id']}: unreadable package ({ex})"); return None
    if md.get("id") != it["id"] or md.get("version") != it["v"] or md.get("entry") != it.get("en"):
        e(f"{label}{it['id']}: package metadata (id/version/entry) differs from the listing")
    if sorted(md.get("perm", [])) != it.get("perm"):
        e(f"{label}{it['id']}: package perm differs from the listing")
    td = gwc_sign.tree_digest(files)
    if td != it.get("td"):
        e(f"{label}{it['id']}: tree digest (td) does not match the package contents")
    return td


def _check_item(dist, name, kind, catalog, it, m, e, label, strict, referenced):
    iid = it.get("id")
    f2 = it.get("f", "")
    if not REL_OK.match(f2) or not HEX32.match(it.get("h", "")): e(f"{label}{iid}: bad file ref"); return
    referenced.add(f2)
    pf = dist / f2
    if not pf.exists(): e(f"{label}{iid}: file missing"); return
    pb = pf.read_bytes()
    if len(pb) != it["s"] or sha256(pb)[:32] != it["h"]: e(f"{label}{iid}: size/hash mismatch"); return
    zb = None
    if "z" in it or "zs" in it or "zh" in it:                    # version 2: the raw zip (.gwcp) travels as its own file
        z2 = it.get("z", "")
        if kind != "widgets" or not REL_OK.match(z2) or not z2.startswith("w/") or not z2.endswith(".gwcp") or not HEX32.match(it.get("zh", "")) \
                or not isinstance(it.get("zs"), int) or isinstance(it.get("zs"), bool) or not 1 <= it["zs"] <= MAX_ZIP_BIG:
            e(f"{label}{iid}: bad .gwcp ref"); return
        if len(pb) > MAX_META: e(f"{label}{iid}: version 2 .gwcw is larger than {MAX_META} B"); return
        referenced.add(z2)
        if not (dist / z2).exists(): e(f"{label}{iid}: .gwcp missing"); return
        zb = (dist / z2).read_bytes()
        if len(zb) != it["zs"] or sha256(zb)[:32] != it["zh"]: e(f"{label}{iid}: .gwcp size/hash mismatch"); return
    cv = it.get("cv")
    if cv:
        mm = COVER.match(cv)
        if not mm: e(f"{label}{iid}: bad cover path"); return
        referenced.add(cv)
        if not (dist / cv).exists(): e(f"{label}{iid}: cover missing")
        elif sha256((dist / cv).read_bytes())[:32] != mm.group(1): e(f"{label}{iid}: cover hash != name")
    if not strict:
        return
    if it.get("c") != catalog: e(f"{label}{iid}: category '{it.get('c')}' is in shard '{name}'")
    if it.get("ch", "stable") not in ("stable", "beta"): e(f"{label}{iid}: bad channel")
    if kind != "widgets":
        return
    perm, err = perm_scan.parse_perm(it.get("perm"))
    if err or perm != it.get("perm"): e(f"{label}{iid}: bad perm in listing ({err or 'not sorted'})")
    if not HEX64.match(it.get("td", "")): e(f"{label}{iid}: bad td"); return
    if not (isinstance(it.get("en"), str) and it["en"]): e(f"{label}{iid}: bad entry"); return
    td = _package_td(pb, it, e, label, zb)
    sg = it.get("sg")
    if sg is None:
        if m.get("policy", {}).get("authorSig") == "required": e(f"{label}{iid}: repo requires author signatures but this item has none")
        return
    au = next((a for a in m.get("authors", []) if a.get("kid") == sg.get("k")), None)
    if au is None: e(f"{label}{iid}: signed by unknown author key {sg.get('k')!r}"); return
    if not gwc_sign.id_allowed(au.get("ids"), iid): e(f"{label}{iid}: author {au['kid']} may not sign this id"); return
    if td and not gwc_sign.verify_package(sg.get("s", ""), au["pub"], gwc_sign.package_message(iid, it["v"], it["en"], it["perm"], td)):
        e(f"{label}{iid}: author signature invalid")


def _walk(dist, m, referenced, e, label, strict=True):
    """verify every shard / item / cover a manifest points to; add them to `referenced`.
    strict=False (the retained previous revision) checks hashes only: it may predate the current item schema."""
    catalog_items, search_items, search_seen = {}, None, False
    for name, d in m.get("shards", {}).items():
        p = d.get("p", "")
        if (strict and not SHARD_NAME.match(name)) or not re.fullmatch(rf"i/{NAME}", p) or not HEX64.match(d.get("sha256", "")):
            e(f"{label}shard {name}: bad descriptor"); continue
        f = dist / p; referenced.add(p)
        if not f.exists(): e(f"{label}shard {name}: file missing"); continue
        b = f.read_bytes()
        if len(b) != d["s"] or sha256(b) != d["sha256"]: e(f"{label}shard {name}: size/hash mismatch"); continue
        s = json.loads(b)
        if name == "search":
            search_seen, search_items = True, s["items"]
            if strict:
                for x in s["items"]:
                    if not (ID_RE.match(str(x.get("id", ""))) and x.get("k") in ("w", "t") and isinstance(x.get("n"), str)
                            and isinstance(x.get("c"), str) and isinstance(x.get("t"), list)):
                        e(f"{label}search: bad entry {x!r}")
            continue
        kind, _, catalog = name.partition("-") if strict else (s.get("kind"), "", s.get("catalog"))
        if strict and (s.get("kind") != kind or s.get("catalog") != catalog): e(f"{label}shard {name}: kind/catalog inside differ from its name"); continue
        if strict and not d["n"] == len(s["items"]): e(f"{label}shard {name}: n != item count")
        seen = set()
        for it in s["items"]:
            iid = it.get("id")
            if iid in seen: e(f"{label}{name}: duplicate id {iid}")
            seen.add(iid)
            catalog_items[(("w" if kind == "widgets" else "t"), iid)] = it
            _check_item(dist, name, kind, catalog, it, m, e, label, strict, referenced)
    if strict and "search" not in m.get("shards", {}): e(f"{label}search shard missing")
    if strict and search_seen:                         # search must describe exactly the catalogue, nothing else
        keys = {(x.get("k"), x.get("id")) for x in search_items}
        if keys != set(catalog_items): e(f"{label}search shard does not match the category shards")
        for x in search_items:
            it = catalog_items.get((x.get("k"), x.get("id")))
            if it and (it.get("n") != x.get("n") or it.get("c") != x.get("c") or it.get("ch") != x.get("ch")): e(f"{label}search entry {x.get('id')} differs from its listing")


def _check_manifest_shape(m, e):
    if m.get("tier") not in ("official", "community"): e("bad tier")
    mir = m.get("mirrors", [])
    if not isinstance(mir, list) or len(mir) > 5 or any(not (isinstance(u, str) and re.match(r"^https://[^/?#@\s]+(/[^?#\s]*)?/$", u)) for u in mir):
        e("mirrors: must be at most 5 https URLs ending with '/'")
    if m.get("base") in mir: e("mirrors: contains the base URL")
    au = m.get("authors", [])
    if not isinstance(au, list) or len(au) > 500: e("authors: bad list"); return
    for a in au:
        try:
            ok = len(base64.b64decode(a["pub"], validate=True)) == 32 and re.match(r"^[A-Za-z0-9._-]{1,64}$", a["kid"]) and a["ids"] and len(a["ids"]) <= 50
        except (KeyError, TypeError, ValueError):
            ok = False
        if not ok: e(f"authors: bad entry {a!r}")
    if m.get("policy", {}).get("authorSig") not in ("required", "optional"): e("policy.authorSig must be required|optional")


def _check_revoked(m, e):
    r = m.get("revoked", [])
    if not isinstance(r, list) or len(r) > 1000: e("revoked: must be a list of <= 1000 entries"); return
    for x in r:
        ok = (isinstance(x, dict) and x.get("kind") in ("widgets", "themepacks") and re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,80}", str(x.get("id", "")))
              and ("h" not in x or HEX32.match(str(x["h"]))) and isinstance(x.get("reason"), str) and 1 <= len(x["reason"]) <= 200)
        if not ok: e(f"revoked: bad entry {x!r}")


def verify_dist(dist: Path, trusted: dict, unsigned=False):
    """returns (errors:list[str], info:dict)"""
    err = []
    e = err.append
    sp = dist / "store.json"
    if not sp.exists():
        return ["store.json missing"], {}
    raw = sp.read_bytes()
    if not unsigned:
        try:
            gwc_sign.verify_manifest(raw, (dist / "store.json.sig").read_bytes(), trusted)
        except (ValueError, OSError) as ex:
            e(f"signature: {ex}")
    m = json.loads(raw)
    if m.get("schema") != 2: e("schema != 2")
    if not (isinstance(m.get("seq"), int) and m["seq"] >= 1): e("bad seq")
    if not (isinstance(m.get("issued"), str) and isinstance(m.get("expires"), str) and m["expires"] > m["issued"]): e("bad issued/expires")
    _check_revoked(m, e)
    _check_manifest_shape(m, e)
    referenced = {"store.json", "store.json.sig"}
    _walk(dist, m, referenced, e, "")
    # one retained previous revision (see build_store.retain_previous): signed, older, and fully present
    pdir = dist / "prev"
    if pdir.exists():
        referenced |= {"prev/store.json", "prev/store.json.sig"}
        try:
            praw = (pdir / "store.json").read_bytes()
            if not unsigned:
                gwc_sign.verify_manifest(praw, (pdir / "store.json.sig").read_bytes(), trusted)
            pm = json.loads(praw)
            if not (isinstance(pm.get("seq"), int) and pm["seq"] < m.get("seq", 0)): e("prev: seq must be lower than the current seq")
            _walk(dist, pm, referenced, e, "prev: ", strict=False)
        except (ValueError, OSError, KeyError) as ex:
            e(f"prev: {ex}")
    for p in dist.rglob("*"):
        rel = p.relative_to(dist).as_posix()
        if p.is_file() and re.match(r"^(c|i|w|t|prev)/", rel) and rel not in referenced:
            e(f"unreferenced file: {rel}")
    return err, {"seq": m.get("seq"), "expires": m.get("expires"), "prev": bool(pdir.exists())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dist")
    ap.add_argument("--config", default=str(Path(__file__).resolve().parent.parent / "store.config.json"))
    ap.add_argument("--unsigned", action="store_true")
    a = ap.parse_args()
    cfg = json.loads(Path(a.config).read_text("utf-8"))
    trusted = {k["kid"]: k["pub"] for k in cfg.get("trust", {}).get("keys", [])}
    errs, info = verify_dist(Path(a.dist), trusted, a.unsigned)
    for x in errs: print("ERROR:", x)
    print("OK" if not errs else f"{len(errs)} error(s)", info)
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main()
