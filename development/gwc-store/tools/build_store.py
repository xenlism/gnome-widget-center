#!/usr/bin/env python3
"""
build_store.py - build the static GWC Store (GitHub Pages) from source folders.

  widgets/<id>/{metadata.json,widget.js,config.json,cover.(png|jpg),...}
  themepacks/<id>.gwct            (normal exported pack; screenshot is lifted out)

Output (dist/):
  store.json + store.json.sig     the ONLY mutable files: signed manifest (seq, expires, shard sha256)
  i/<kind>-<catalog>.<h16>.json   one index shard per category (widgets-clock, themepacks-dark, ...), immutable
  i/search.<h16>.json             tiny search shard (id, kind, name, category, tags), immutable
  c/<h32>.jpg                     covers, immutable, name = first 128 bits of sha256(content)
  w/<id>.<h16>.gwcw               widget package, JSON: metadata + the zip as base64 (version 1; zip <= 4 MiB)
                                  or metadata + a reference to the zip (version 2, see below), immutable
  w/<id>.<h16>.gwcp               version 2 only: the widget folder as a RAW zip (> 4 MiB, up to 64 MiB), immutable
  t/<id>.<h16>.gwct               theme packs (screenshot stripped), immutable
  open/index.html                 https share-link -> gwc:// redirect page

Deterministic: same sources => byte-identical shards / packages / covers (stable ETags, no churn).
Only store.json(.sig) changes per publish (seq / issued / expires).

Typical use:
  CI publish : GWC_SIGNING_KEY=<seed> python tools/build_store.py --out dist --prev-url auto
  first ever : ... --first-publish
  local dev  : python tools/build_store.py --out /tmp/dist --unsigned          (seq=1, no .sig; clients reject it)
"""
import argparse, base64, datetime, hashlib, io, json, os, re, shutil, subprocess, sys, urllib.error, urllib.parse, urllib.request, zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gwc_sign
import perm_scan
from verify_store import MAX_RATIO, MAX_TOTAL, MAX_TOTAL_BIG, MAX_ZIP_BIG, verify_dist

try:
    from PIL import Image
except ImportError:
    Image = None

ROOT = Path(__file__).resolve().parent.parent
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,80}$")
ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)
SCHEMA = 2
MAX_ZIP = 4 * 1024 * 1024          # a package up to this size is inlined (base64) in its .gwcw: version 1, one file
# MAX_ZIP_BIG / MAX_TOTAL / MAX_TOTAL_BIG / MAX_RATIO come from verify_store.py (shared with the verifier; mirrored by the client)
MAX_FILES = 200                    # per widget
MAX_FILE = 16 * 1024 * 1024        # per file inside a widget
SKIP_IN_ZIP = {"metadata.json", ".gitignore", ".DS_Store"}          # silently ignored; any OTHER dotfile is an error
AUTHOR_SIG_FILE = "signature.json"      # author's package signature, top level only; never shipped inside the package
CATALOG_RE = re.compile(r"^[a-z0-9]{1,20}$")   # shard key = "<kind>-<catalog>" must fit the client's 32-char shard-name rule
CHANNELS = ("stable", "beta")
MAX_MIRRORS = 5
ALLOWED_EXT = {".js", ".json", ".css", ".svg", ".png", ".jpg", ".jpeg", ".md", ".txt"}   # allowlist, not denylist
VERSION_RE = re.compile(r"^\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$")
MARKER = ".gwc-store-build"
SOURCE_DIRS = {"widgets", "themepacks", "tools", "site", ".git", ".github"}
COVER_NAMES = ("cover.png", "cover.jpg", "cover.jpeg")   # JPEG output only: GdkPixbuf-safe, no libwebp


def jdump(o):  # compact + stable
    return json.dumps(o, ensure_ascii=False, separators=(",", ":")).encode()


def hx(b):  return hashlib.sha256(b).hexdigest()        # full sha256
def h16(b): return hx(b)[:16]                              # file names
def h32(b): return hx(b)[:32]                              # item hash + cover name (128 bit)


def check_out_dir(dist):
    """Refuse to rmtree anything that could be the source tree, a parent of it, $HOME or /."""
    d = dist.resolve()
    inside_src = ROOT in d.parents and d.relative_to(ROOT).parts[0] in SOURCE_DIRS
    if d == Path(d.anchor) or d == Path.home().resolve() or d == ROOT or d in ROOT.parents or inside_src:
        sys.exit(f"refusing --out {dist}: it is (or contains) the source tree / home / filesystem root")
    if d.exists():
        if not d.is_dir():
            sys.exit(f"--out {dist} exists and is not a directory")
        if any(d.iterdir()) and not (d / MARKER).exists():
            sys.exit(f"refusing to delete non-empty {dist}: it was not created by build_store.py (no {MARKER})")
    return d


def last_date(path):
    """git last-commit date (YYYY-MM-DD) of a path, fallback to mtime."""
    try:
        out = subprocess.run(["git", "log", "-1", "--format=%cs", "--", str(path)],
                             cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
        if out:
            return out
    except Exception:
        pass
    return datetime.date.fromtimestamp(Path(path).stat().st_mtime).isoformat()


def make_cover(src_bytes, cfg, dist):
    """center-crop to W x H, encode, write c/<h32>.<ext>; return relative path."""
    if Image is None:
        sys.exit("Pillow is required to build covers: pip install pillow")
    W, H = cfg["width"], cfg["height"]
    im = Image.open(io.BytesIO(src_bytes)).convert("RGB")
    r = max(W / im.width, H / im.height)
    im = im.resize((max(W, round(im.width * r)), max(H, round(im.height * r))), Image.LANCZOS)
    l, t = (im.width - W) // 2, (im.height - H) // 2
    im = im.crop((l, t, l + W, t + H))
    if cfg["format"] != "jpeg":
        sys.exit("store.config.json: cover.format must be 'jpeg' (WebP is intentionally unsupported)")
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=cfg["quality"], optimize=True, progressive=True)
    ext = "jpg"
    data = buf.getvalue()
    rel = f"c/{h32(data)}.{ext}"
    p = dist / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return rel


def package_files(folder):
    """Every file that ships in a widget package: [(relative posix path, bytes)] sorted. Same rules for zip and signature."""
    out, lower = [], set()
    for p in sorted(folder.rglob("*")):
        rel = p.relative_to(folder).as_posix()
        if p.is_symlink():
            sys.exit(f"{folder.name}: symlink not allowed: {rel}")
        if p.is_dir():
            if p.name.startswith(".") and p.name not in SKIP_IN_ZIP:
                sys.exit(f"{folder.name}: hidden directory not allowed: {rel}")
            continue
        parts = rel.split("/")
        if any(part in SKIP_IN_ZIP for part in parts) or rel in COVER_NAMES or rel == AUTHOR_SIG_FILE:
            continue
        if any(part.startswith(".") for part in parts):
            sys.exit(f"{folder.name}: hidden file not allowed (remove it, it would be published): {rel}")
        if p.suffix.lower() not in ALLOWED_EXT:
            sys.exit(f"{folder.name}: file type not allowed: {rel} (allowed: {', '.join(sorted(ALLOWED_EXT))})")
        if rel.lower() in lower:
            sys.exit(f"{folder.name}: names differ only by case: {rel}")
        lower.add(rel.lower())
        if p.stat().st_size > MAX_FILE:
            sys.exit(f"{folder.name}: file too large: {rel}")
        if len(out) >= MAX_FILES:
            sys.exit(f"{folder.name}: more than {MAX_FILES} files")
        out.append((rel, p.read_bytes()))
    return out


def zip_files(files):
    """deterministic zip (sorted, fixed timestamps, deflate-9)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel, data in files:
            zi = zipfile.ZipInfo(rel, ZIP_EPOCH)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, data, compresslevel=9)
        for zi in z.infolist():
            if zi.compress_size and zi.file_size / zi.compress_size > MAX_RATIO:
                sys.exit(f"{zi.filename}: compresses {zi.file_size // zi.compress_size}x (limit {MAX_RATIO}x): the client refuses such files as a possible zip bomb. "
                         f"Is it generated filler? Shrink or split it.")
    return buf.getvalue(), [rel for rel, _ in files]


def parse_api(v):
    """same rule as lib/apiVersion.js parseApiVersion(): 2, 2.0, "2", "2.0.0" -> major int, else None"""
    if isinstance(v, bool): return None
    if isinstance(v, (int, float)): return int(v) if v >= 0 else None
    m = re.fullmatch(r"\s*(\d+)(?:\.\d+){0,2}\s*", v) if isinstance(v, str) else None
    return int(m.group(1)) if m else None


AUTHOR_KID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
AUTHOR_ID_PATTERN = re.compile(r"^([a-z0-9][a-z0-9._-]{1,80}|[a-z0-9][a-z0-9._-]{0,79}\.\*)$")


def load_authors(root=None):
    """authors.json: [{kid, name, pub, ids:[exact id | 'prefix.*']}] -> list (sorted by kid). Signed into the manifest."""
    f = (root or ROOT) / "authors.json"
    if not f.exists():
        return []
    try:
        data = json.loads(f.read_text("utf-8"))
    except ValueError as e:
        sys.exit(f"authors.json: not valid JSON ({e})")
    if not isinstance(data, list) or len(data) > 500:
        sys.exit("authors.json must be a list of at most 500 authors")
    out, seen = [], set()
    for a in data:
        if not isinstance(a, dict) or set(a) - {"kid", "name", "pub", "ids"}:
            sys.exit(f"authors.json: bad entry {a!r} (allowed keys: kid, name, pub, ids)")
        if not AUTHOR_KID_RE.match(str(a.get("kid", ""))) or a["kid"] in seen:
            sys.exit(f"authors.json: bad or duplicate kid in {a!r}")
        seen.add(a["kid"])
        try:
            if len(base64.b64decode(a.get("pub", ""), validate=True)) != 32:
                raise ValueError
        except (ValueError, TypeError):
            sys.exit(f"authors.json: pub of {a['kid']} must be a base64 32-byte Ed25519 public key")
        if not isinstance(a.get("name"), str) or not 1 <= len(a["name"]) <= 80:
            sys.exit(f"authors.json: name (1-80 chars) required for {a['kid']}")
        ids = a.get("ids")
        if not isinstance(ids, list) or not 1 <= len(ids) <= 50 or any(not isinstance(i, str) or not AUTHOR_ID_PATTERN.match(i) for i in ids):
            sys.exit(f"authors.json: ids of {a['kid']} must be 1-50 widget ids or 'prefix.*' patterns (a bare '*' is not allowed)")
        out.append({"kid": a["kid"], "name": a["name"], "pub": a["pub"], "ids": sorted(set(ids))})
    return sorted(out, key=lambda x: x["kid"])


def author_policy(cfg):
    """True when every widget must carry a valid author signature (default: community repos)."""
    return bool(cfg.get("requireAuthorSig", cfg.get("tier", "official") == "community"))


def validate_widget(folder, cat_ids, authors=(), require_sig=False):
    """All source checks for ONE widget folder. Exits (SystemExit) with a message on the first problem.
    Returns {md, files, perm, warnings, td, sg|None}."""
    mdp = folder / "metadata.json"
    if not mdp.is_file():
        sys.exit(f"{folder.name}: metadata.json missing")
    try:
        md = json.loads(mdp.read_text("utf-8"))
    except ValueError as e:
        sys.exit(f"{folder.name}: metadata.json is not valid JSON ({e})")
    wid = md.get("id")
    if wid != folder.name or not isinstance(wid, str) or not ID_RE.match(wid):
        sys.exit(f"{folder.name}: metadata.id must equal folder name and match {ID_RE.pattern}")
    for k in ("name", "description", "version", "author", "api-version", "entry"):
        if k not in md:
            sys.exit(f"{wid}: metadata missing '{k}'")
    cat = md.get("catalog", "other")
    if cat not in cat_ids:
        sys.exit(f"{wid}: unknown catalog '{cat}'")
    if not isinstance(md["version"], str) or not VERSION_RE.match(md["version"]):
        sys.exit(f"{wid}: version must be a string like 1.2.3 (got {md['version']!r})")
    if parse_api(md["api-version"]) is None:
        sys.exit(f"{wid}: bad api-version {md['api-version']!r}")
    ent = md["entry"]
    if not isinstance(ent, str) or ent.startswith("/") or "\\" in ent or ".." in ent.split("/") or Path(ent).suffix != ".js":
        sys.exit(f"{wid}: entry must be a relative .js path inside the widget")
    if not (folder / ent).is_file():
        sys.exit(f"{wid}: entry file missing")
    if md.get("channel", "stable") not in CHANNELS:
        sys.exit(f"{wid}: channel must be one of {', '.join(CHANNELS)}")
    perm, err = perm_scan.parse_perm(md.get("perm"))
    if err:
        sys.exit(f"{wid}: {err}")
    files = package_files(folder)
    if ent not in {r for r, _ in files}:
        sys.exit(f"{wid}: entry file is not part of the package")
    errs, warns = perm_scan.compare(perm, perm_scan.scan(files))
    if errs:
        sys.exit(f"{wid}: permission check failed:\n    " + "\n    ".join(errs))
    td = gwc_sign.tree_digest(files)
    sg = None
    sigf = folder / AUTHOR_SIG_FILE
    if sigf.exists():
        try:
            d = json.loads(sigf.read_text("utf-8"))
            kid, sig = d["kid"], d["sig"]
            if d.get("alg") != "ed25519" or not isinstance(kid, str) or not isinstance(sig, str):
                raise ValueError("bad fields")
        except (ValueError, KeyError, TypeError) as e:
            sys.exit(f"{wid}: {AUTHOR_SIG_FILE} is malformed ({e})")
        au = next((a for a in authors if a["kid"] == kid), None)
        if au is None:
            sys.exit(f"{wid}: signed by '{kid}', who is not listed in authors.json")
        if not gwc_sign.id_allowed(au["ids"], wid):
            sys.exit(f"{wid}: author '{kid}' is not allowed to sign this id (authors.json ids: {', '.join(au['ids'])})")
        if not gwc_sign.verify_package(sig, au["pub"], gwc_sign.package_message(wid, md["version"], ent, perm, td)):
            sys.exit(f"{wid}: author signature does not match the package (content, version, entry or perm changed after signing?)")
        sg = {"k": kid, "s": sig}
    elif require_sig:
        sys.exit(f"{wid}: this repo requires an author signature ({AUTHOR_SIG_FILE}); sign with tools/gwc_repo.py sign-widget")
    return {"md": md, "files": files, "perm": perm, "warnings": warns, "td": td, "sg": sg}


def build_widgets(cfg, catalogs, dist, authors=(), require_sig=False):
    items, cat_ids = [], {c["id"] for c in catalogs["widgets"]}
    wdir = ROOT / "widgets"
    folders = sorted(p for p in wdir.iterdir() if p.is_dir()) if wdir.exists() else []
    for folder in folders:
        v = validate_widget(folder, cat_ids, authors, require_sig)
        md, files = v["md"], v["files"]
        wid, cat = md["id"], md.get("catalog", "other")
        for w in v["warnings"]:
            print(f"warning: {wid}: {w}")
        zbytes, names = zip_files(files)
        total = sum(len(d) for _, d in files)
        big = len(zbytes) > MAX_ZIP or total > MAX_TOTAL         # version 2: the zip travels as its own .gwcp file
        if len(zbytes) > MAX_ZIP_BIG:
            sys.exit(f"{wid}: package too large ({len(zbytes)} B compressed, limit {MAX_ZIP_BIG} B)")
        if total > MAX_TOTAL_BIG:
            sys.exit(f"{wid}: package too large when unpacked ({total} B, limit {MAX_TOTAL_BIG} B)")
        cover = next((folder / n for n in COVER_NAMES if (folder / n).exists()), None)
        cv = make_cover(cover.read_bytes(), cfg["cover"], dist) if cover else None
        (dist / "w").mkdir(parents=True, exist_ok=True)
        pkg = {"size": len(zbytes), "sha256": hashlib.sha256(zbytes).hexdigest(), "files": names}
        if big:
            zrel = f"w/{wid}.{h16(zbytes)}.gwcp"
            (dist / zrel).write_bytes(zbytes)
            gwcw = {"format": "gwcw", "version": 2, "metadata": md,
                    "package": {"encoding": "zip", "file": zrel.split("/")[-1], **pkg}}
        else:
            gwcw = {"format": "gwcw", "version": 1, "metadata": md,
                    "package": {"encoding": "zip+base64", **pkg, "data": base64.b64encode(zbytes).decode()}}
        raw = jdump(gwcw)                     # no inline cover in store-hosted files
        rel = f"w/{wid}.{h16(raw)}.gwcw"
        (dist / rel).write_bytes(raw)
        item = {"id": wid, "n": md["name"], "d": md["description"][:100], "v": md["version"],
                "a": md["author"], "c": cat, "t": md.get("tags", []),
                "bt": md.get("block-type", ""), "cv": cv, "f": rel, "s": len(raw),
                "h": h32(raw), "u": last_date(folder),
                "perm": v["perm"], "en": md["entry"], "td": v["td"]}
        if big:
            item.update({"z": zrel, "zs": len(zbytes), "zh": h32(zbytes)})     # the raw zip; f/s/h stay the (small) .gwcw
        if v["sg"]:
            item["sg"] = v["sg"]
        if md.get("channel", "stable") != "stable":
            item["ch"] = md["channel"]
        items.append(item)
    return items


def build_themepacks(cfg, catalogs, dist):
    items, cat_ids = [], {c["id"] for c in catalogs["themepacks"]}
    tdir = ROOT / "themepacks"
    seen = set()
    for f in sorted(tdir.glob("*.gwct")) if tdir.exists() else []:
        d = json.loads(f.read_text("utf-8"))
        if d.get("format") != "gwct":
            sys.exit(f"{f.name}: not a gwct")
        pm = d.get("packMeta", {})
        pid = pm.get("id") or f.stem.lower()
        if not ID_RE.match(pid):
            sys.exit(f"{f.name}: bad pack id")
        if pid in seen:
            sys.exit(f"{f.name}: duplicate theme pack id '{pid}'")
        seen.add(pid)
        if pm.get("id") and pm["id"] != f.stem.lower():
            print(f"warning: {f.name}: packMeta.id '{pm['id']}' differs from file name")
        if not isinstance(d.get("widgets"), list):
            sys.exit(f"{f.name}: 'widgets' must be a list")
        cat = pm.get("catalog", "other")
        if cat not in cat_ids:
            sys.exit(f"{pid}: unknown catalog '{cat}'")
        shot = d.pop("screenshot", None)
        cv = make_cover(base64.b64decode(shot["base64"]), cfg["cover"], dist) if shot else None
        raw = jdump(d)
        rel = f"t/{pid}.{h16(raw)}.gwct"
        (dist / "t").mkdir(parents=True, exist_ok=True)
        (dist / rel).write_bytes(raw)
        items.append({"id": pid, "n": pm.get("name", pid), "d": pm.get("description", "")[:100],
                      "v": str(pm.get("version", "1")), "a": pm.get("author", ""), "c": cat,
                      "t": pm.get("tags", []), "w": len(d.get("widgets", [])), "cv": cv, "f": rel,
                      "s": len(raw), "h": h32(raw), "u": last_date(f)})
    return items


def _put_shard(name, payload, items, dist):
    items.sort(key=lambda x: (x.get("k", ""), x["id"]))
    raw = jdump({**payload, "items": items})
    rel = f"i/{name}.{h16(raw)}.json"
    (dist / "i").mkdir(parents=True, exist_ok=True)
    (dist / rel).write_bytes(raw)
    newest = max((i.get("u", "1970-01-01") for i in items), default="1970-01-01")
    return {"p": rel, "sha256": hx(raw), "s": len(raw), "n": len(items), "u": newest}


def write_shards(widget_items, pack_items, catalogs, dist):
    """One shard per non-empty (kind, catalog) + one tiny search shard. A client opening 'Clock' downloads ~10 KB,
    not the whole index; search needs only id/name/tags, so it never pulls any category shard."""
    shards, search = {}, []
    for kind, items, prefix in (("widgets", widget_items, "w"), ("themepacks", pack_items, "t")):
        for cat in catalogs[kind]:
            sub = [i for i in items if i["c"] == cat["id"]]
            if not sub:
                continue
            shards[f"{kind}-{cat['id']}"] = _put_shard(f"{kind}-{cat['id']}", {"schema": SCHEMA, "kind": kind, "catalog": cat["id"]}, sub, dist)
        for i in items:
            e = {"id": i["id"], "k": prefix, "n": i["n"], "c": i["c"], "t": i["t"]}
            if i.get("ch"):
                e["ch"] = i["ch"]
            search.append(e)
    shards["search"] = _put_shard("search", {"schema": SCHEMA, "kind": "search"}, search, dist)
    shards["search"]["u"] = max(d["u"] for k, d in shards.items() if k != "search")      # same "last change" notion as the others
    return shards


def now_utc(arg):
    if arg:
        return datetime.datetime.fromisoformat(arg.replace("Z", "+00:00")).astimezone(datetime.timezone.utc)
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch(url, what, limit=1024 * 1024, why="refusing to guess seq"):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "gwc-store-build"}), timeout=30) as r:
            data = r.read(limit + 1)
            if len(data) > limit:
                sys.exit(f"{what} ({url}) is larger than {limit} bytes - refusing")
            return data
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        sys.exit(f"cannot fetch {what} ({url}): HTTP {e.code} - {why}")
    except Exception as e:                                     # network down etc: never guess
        sys.exit(f"cannot fetch {what} ({url}): {e} - {why}")


def load_prev(args, cfg, trusted):
    """The live (previous) manifest, signature-verified, or None. Never guesses: any doubt = stop."""
    if args.seq is not None or args.first_publish or (args.unsigned and not args.prev_url):
        return None
    url = args.prev_url
    if not url:
        sys.exit("need one of: --prev-url auto|URL, --seq N, --first-publish (or --unsigned for local dev)")
    if url == "auto":
        url = cfg["baseUrl"].rstrip("/") + "/store.json"
    raw = fetch(url, "previous store.json")
    if raw is None:
        sys.exit(f"{url} returned 404: if this really is the first publish, pass --first-publish")
    sig = fetch(url + ".sig", "previous store.json.sig")
    try:
        if sig is None:
            raise ValueError("previous store.json.sig missing")
        gwc_sign.verify_manifest(raw, sig, trusted)           # never build on an unverified live manifest
        return {"raw": raw, "sig": sig, "base": url[:-len("store.json")], "seq": int(json.loads(raw)["seq"])}
    except (ValueError, KeyError, TypeError) as e:
        sys.exit(f"previous live manifest is not valid/signed ({e}); fix it or pass --seq N explicitly")


def next_seq(args, prev):
    if args.seq is not None:
        return args.seq
    if prev:
        return prev["seq"] + 1
    return 1


def retain_previous(dist, prev, seq):
    """
    Keep ONE previous revision reachable (APT 'by-hash' idea). Pages caches store.json for ~10 min, so a client holding the
    old manifest may still ask for an old shard / package / cover that this build no longer produces. We copy those files
    from the LIVE site, verifying every one against the (already verified) previous manifest, and publish the previous
    manifest + signature under prev/ so verify_store can prove what is retained and why.
    """
    if prev["seq"] >= seq:
        sys.exit(f"new seq {seq} must exceed live seq {prev['seq']}")
    pm = json.loads(prev["raw"])
    (dist / "prev").mkdir(exist_ok=True)
    (dist / "prev" / "store.json").write_bytes(prev["raw"])
    (dist / "prev" / "store.json.sig").write_bytes(prev["sig"])
    copied = 0

    def need(rel, ok, limit, what):
        nonlocal copied
        f = dist / rel
        if f.exists():
            if not ok(f.read_bytes()):
                sys.exit(f"retain: {rel} exists in the new build with different content")
            return f.read_bytes()
        data = fetch(prev["base"] + rel, f"live {what} {rel}", limit, why="retain: refusing to publish a store with dangling references (or pass --no-keep-prev)")
        if data is None:
            sys.exit(f"retain: live store references {rel} but it is not there (404). Fix the live site or pass --no-keep-prev")
        if not ok(data):
            sys.exit(f"retain: live {rel} does not match its hash in the previous manifest - refusing to republish it")
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
        copied += 1
        return data

    for kind, d in pm["shards"].items():
        raw = need(d["p"], lambda b, d=d: len(b) == d["s"] and hx(b) == d["sha256"], 4 * 1024 * 1024, "shard")
        for it in json.loads(raw)["items"]:
            if "f" not in it:                                  # search shard: pointers only, no files of its own
                continue
            need(it["f"], lambda b, it=it: len(b) == it["s"] and h32(b) == it["h"], 8 * 1024 * 1024, "package")
            if it.get("z"):                                    # version 2: the raw zip next to its .gwcw
                need(it["z"], lambda b, it=it: len(b) == it["zs"] and h32(b) == it["zh"], MAX_ZIP_BIG, "package")
            if it.get("cv"):
                name = it["cv"].split("/")[-1].split(".")[0]
                need(it["cv"], lambda b, name=name: h32(b) == name, 512 * 1024, "cover")
    return copied


def load_revoked(cats):
    """revoked.json (optional): [{kind, id, h?, reason}] -> signed into store.json; clients flag/quarantine what matches."""
    f = ROOT / "revoked.json"
    if not f.exists():
        return []
    data = json.loads(f.read_text("utf-8"))
    if not isinstance(data, list) or len(data) > 1000:
        sys.exit("revoked.json must be a list of at most 1000 entries")
    out, seen = [], set()
    for e in data:
        if not isinstance(e, dict) or set(e) - {"kind", "id", "h", "reason"}:
            sys.exit(f"revoked.json: bad entry {e!r} (allowed keys: kind, id, h, reason)")
        if e.get("kind") not in ("widgets", "themepacks") or not ID_RE.match(str(e.get("id", ""))):
            sys.exit(f"revoked.json: bad kind/id in {e!r}")
        if "h" in e and not re.fullmatch(r"[0-9a-f]{32}", str(e["h"])):
            sys.exit(f"revoked.json: h must be 32 hex chars (the item hash) in {e!r}")
        if not isinstance(e.get("reason"), str) or not (1 <= len(e["reason"]) <= 200):
            sys.exit(f"revoked.json: reason (1-200 chars) required in {e!r}")
        key = (e["kind"], e["id"], e.get("h"))
        if key in seen:
            sys.exit(f"revoked.json: duplicate entry {e!r}")
        seen.add(key)
        out.append({k: e[k] for k in ("kind", "id", "h", "reason") if k in e})
    return sorted(out, key=lambda e: (e["kind"], e["id"], e.get("h", "")))


def check_mirrors(cfg):
    """store.config.json mirrors: https base URLs of byte-identical copies of the site. Untrusted by design: the signed hash
    chain means a mirror can only be unavailable, never wrong. Signed into the manifest so clients learn them from the repo."""
    m = cfg.get("mirrors", [])
    if not isinstance(m, list) or len(m) > MAX_MIRRORS:
        sys.exit(f"store.config.json: mirrors must be a list of at most {MAX_MIRRORS} https URLs")
    base = cfg["baseUrl"].rstrip("/") + "/"
    out = []
    for u in m:
        pu = urllib.parse.urlsplit(u) if isinstance(u, str) else None
        ok = pu and pu.scheme == "https" and pu.hostname and not pu.query and not pu.fragment and not pu.username and u.endswith("/")
        if not ok:
            sys.exit(f"store.config.json: bad mirror {u!r} (must be an https URL ending with '/', no query/fragment/credentials)")
        if u == base or u in out:
            sys.exit(f"store.config.json: mirror {u!r} duplicates the base URL or another mirror")
        out.append(u)
    return out


def check_catalogs(cats):
    for kind in ("widgets", "themepacks"):
        ids = [c.get("id") for c in cats.get(kind, [])]
        for i in ids:
            if not isinstance(i, str) or not CATALOG_RE.match(i):
                sys.exit(f"catalogs.json: {kind} catalog id {i!r} must match {CATALOG_RE.pattern} (it becomes part of the shard name)")
        if len(set(ids)) != len(ids):
            sys.exit(f"catalogs.json: duplicate catalog id in {kind}")


def main():
    ap = argparse.ArgumentParser(description="Build the static GWC Store.")
    ap.add_argument("--out", default=str(ROOT / "dist"))
    ap.add_argument("--seq", type=int, help="explicit manifest seq (must exceed the live one)")
    ap.add_argument("--prev-url", help="live store.json URL to read the previous seq from, or 'auto'")
    ap.add_argument("--first-publish", action="store_true")
    ap.add_argument("--no-keep-prev", action="store_true", help="do not retain the previous live revision under prev/")
    ap.add_argument("--unsigned", action="store_true", help="LOCAL DEV ONLY: no signature (clients refuse it)")
    ap.add_argument("--now", help="ISO time for issued/expires (tests)")
    ap.add_argument("--key-env", default="GWC_SIGNING_KEY")
    ap.add_argument("--config", default=str(ROOT / "store.config.json"))
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text("utf-8"))
    cats = json.loads((ROOT / "catalogs.json").read_text("utf-8"))
    if cfg.get("tier", "official") not in ("official", "community"):
        sys.exit("store.config.json: tier must be official or community")
    check_catalogs(cats)
    mirrors = check_mirrors(cfg)
    authors = load_authors()
    require_sig = author_policy(cfg)
    trust = cfg.get("trust", {})
    trusted = {k["kid"]: k["pub"] for k in trust.get("keys", [])}

    priv = kid = None
    if args.unsigned:
        if os.environ.get("GITHUB_ACTIONS"):
            sys.exit("--unsigned is not allowed in CI")
        print("warning: UNSIGNED dev build - clients will refuse it")
    else:
        seed = os.environ.get(args.key_env)
        if not seed:
            sys.exit(f"signing key missing: set ${args.key_env} (base64 Ed25519 seed; see tools/gwc_keygen.py) or use --unsigned for local dev")
        priv = gwc_sign.private_from_seed_b64(seed)
        if not trusted:
            sys.exit("store.config.json has no trust.keys: run tools/gwc_keygen.py and put the PUBLIC key there (and in the client)")
        kid = trust.get("signKid") or (next(iter(trusted)) if trusted else None)
        if not kid or trusted.get(kid) != gwc_sign.public_b64(priv):
            sys.exit(f"signing key does not match store.config.json trust.keys[{kid!r}] - wrong key or config")
    prev = load_prev(args, cfg, trusted)
    seq = next_seq(args, prev)

    dist = check_out_dir(Path(args.out))
    if dist.exists():
        shutil.rmtree(dist)   # publish ONLY current files (Pages site cap is 1 GB)
    dist.mkdir(parents=True)
    (dist / MARKER).write_text("generated by tools/build_store.py - safe to delete\n")

    witems = build_widgets(cfg, cats, dist, authors, require_sig)
    titems = build_themepacks(cfg, cats, dist)
    shards = write_shards(witems, titems, cats, dist)
    updated = max(s["u"] for s in shards.values())
    t0 = now_utc(args.now)
    store = {"schema": SCHEMA, "id": cfg["id"], "name": cfg["name"], "base": cfg["baseUrl"],
             "tier": cfg.get("tier", "official"), "seq": seq, "updated": updated,
             "issued": iso(t0), "expires": iso(t0 + datetime.timedelta(days=trust.get("expiryDays", 30))),
             "cover": {"w": cfg["cover"]["width"], "h": cfg["cover"]["height"], "fmt": cfg["cover"]["format"]},
             "catalogs": cats, "mirrors": mirrors, "authors": authors,
             "policy": {"authorSig": "required" if require_sig else "optional"},
             "shards": shards, "revoked": load_revoked(cats)}
    raw = jdump(store)
    (dist / "store.json").write_bytes(raw)
    if priv:
        (dist / "store.json.sig").write_bytes(gwc_sign.sign_manifest(priv, kid, raw))
    kept = retain_previous(dist, prev, seq) if prev and not args.no_keep_prev else None
    (dist / ".nojekyll").write_text("")
    if (ROOT / "site").exists():
        shutil.copytree(ROOT / "site", dist, dirs_exist_ok=True)
    for kind, items in (("widgets", witems), ("themepacks", titems)):
        miss = [i["id"] for i in items if not i["cv"]]
        if miss:
            print(f"warning: {len(miss)} {kind} without cover: {', '.join(miss[:5])}{' ...' if len(miss) > 5 else ''}")

    errs, _ = verify_dist(dist, trusted, unsigned=args.unsigned)   # self-check exactly like a client would
    if errs:
        sys.exit("self-verification FAILED:\n  " + "\n  ".join(errs))
    print(f"store seq={seq} issued={store['issued']} expires={store['expires']} "
          f"widgets={len(witems)} themepacks={len(titems)} shards={len(shards)} signed-by-author={sum(1 for i in witems if i.get('sg'))} "
          f"{'unsigned' if args.unsigned else 'signed by ' + kid}"
          + (f" | kept previous seq={prev['seq']} (+{kept} file(s) copied from live)" if kept is not None else ""))


if __name__ == "__main__":
    main()
