#!/usr/bin/env python3
"""gwc_repo.py - everything a repo maintainer does besides building: create a repo, add/import/sign widgets, manage authors,
revocations and settings, lint. Every command prints ONE JSON document ({"ok": true, ...} / {"ok": false, "error": "..."}) so the
GTK app (gwc-repo-maker) is a thin shell over this file and all logic is unit-tested in Python.

  python tools/gwc_repo.py init DIR --id my-store --name "My Store" --base-url https://me.github.io/my-store/ [--tier community] [--kid my-2026-a]
  python tools/gwc_repo.py [--repo DIR] status | lint
  python tools/gwc_repo.py new-widget --id me.clock --name Clock --author Me --catalog clock [--perm network ...]
  python tools/gwc_repo.py import-widget PATH(.gwcw|folder) [--replace]   (a version 2 .gwcw needs its .gwcp in the same folder)       python tools/gwc_repo.py import-themepack FILE.gwct
  python tools/gwc_repo.py author-keygen --kid me-1 [--key-dir D]             python tools/gwc_repo.py sign-widget ID --kid me-1 [--key-file F]
  python tools/gwc_repo.py authors add|remove ...                             python tools/gwc_repo.py revoke add|remove ...
  python tools/gwc_repo.py config KEY VALUE
  python tools/gwc_repo.py scan-source DIR                                     (what can be imported from a widgets/themepacks folder)
  python tools/gwc_repo.py list-keys                                          python tools/gwc_repo.py export-key KID DEST [--public]
  python tools/gwc_repo.py import-key FILE [--kid ID]                         (bring an existing private key file into the key folder)

Private keys never go inside the repo: they live in --key-dir (default ~/.config/gwc-repo-maker/keys, mode 0600).
"""
import argparse, base64, io, json, os, re, shutil, subprocess, sys, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_store as bs
import gwc_sign
import perm_scan
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ID_RE = bs.ID_RE
MAX_IMPORT = 16 * 1024 * 1024
CONFIG_KEYS = {"name", "baseUrl", "tier", "mirrors", "requireAuthorSig", "expiryDays", "signKid"}
DEFAULT_KEY_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "gwc-repo-maker" / "keys"


class RepoError(Exception):
    pass


def die(msg):
    raise RepoError(msg)


def call_checked(fn, *a, **kw):
    """build_store validators report problems with sys.exit(message); turn that into a RepoError."""
    try:
        return fn(*a, **kw)
    except SystemExit as e:
        raise RepoError(str(e.code))


def set_repo(path):
    bs.ROOT = Path(path).resolve()
    return bs.ROOT


def jread(p, default=None):
    try:
        return json.loads(Path(p).read_text("utf-8"))
    except FileNotFoundError:
        if default is not None:
            return default
        die(f"{Path(p).name} not found")
    except ValueError as e:
        die(f"{Path(p).name} is not valid JSON: {e}")


def jwrite(p, data):
    Path(p).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")


def new_keypair():
    k = Ed25519PrivateKey.generate()
    seed = base64.b64encode(k.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())).decode()
    return seed, gwc_sign.public_b64(k)


def save_seed(key_dir, name, seed):
    key_dir = Path(key_dir); key_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(key_dir, 0o700)
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", name):
        die("key id may only contain letters, digits . _ -")
    path = key_dir / f"{name}.key"
    if path.exists():
        die(f"a key named {name} already exists in {key_dir}")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(seed + "\n")
    return path


def load_seed(path):
    p = Path(path)
    if not p.is_file():
        die(f"key file not found: {p}")
    if p.stat().st_mode & 0o077:
        die(f"{p} is readable by other users (mode {oct(p.stat().st_mode & 0o777)}); chmod 600 it first")
    try:
        return gwc_sign.private_from_seed_b64(p.read_text())
    except ValueError as e:
        die(f"{p}: {e}")


# ------------------------------------------------------------------ init
def cmd_init(a):
    dest = Path(a.dir).resolve()
    if dest.exists() and (not dest.is_dir() or any(dest.iterdir())):
        die(f"{dest} exists and is not empty")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", a.id):
        die("store id: lowercase letters, digits and '-', 2-41 chars")
    if not (1 <= len(a.name) <= 80):
        die("store name: 1-80 chars")
    if not a.base_url.startswith("https://") or not a.base_url.endswith("/") or "?" in a.base_url or "#" in a.base_url:
        die("base URL must be https://... and end with '/' (for GitHub Pages: https://USER.github.io/REPO/)")
    if a.tier not in ("official", "community"):
        die("tier must be official or community")
    tpl = HERE / "template"
    if not tpl.is_dir():
        die(f"template folder missing: {tpl}")
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copytree(HERE, dest / "tools", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copytree(tpl / "dot-github", dest / ".github")
    shutil.copytree(tpl / "site", dest / "site")
    for name in ("catalogs.json", "revoked.json", "authors.json"):
        shutil.copy(tpl / name, dest / name)
    shutil.copy(tpl / "gitignore", dest / ".gitignore")
    for d in ("widgets", "themepacks"):
        (dest / d).mkdir()
        (dest / d / ".gitkeep").write_text("")
    cfg = {"id": a.id, "name": a.name, "baseUrl": a.base_url, "mirrors": [], "tier": a.tier,
           "requireAuthorSig": a.tier == "community",
           "cover": {"width": 460, "height": 270, "format": "jpeg", "quality": 72},
           "trust": {"signKid": "", "expiryDays": 30, "keys": []}}
    res = {"dir": str(dest)}
    if a.kid:
        seed, pub = new_keypair()
        path = save_seed(a.key_dir, a.kid, seed)
        cfg["trust"].update(signKid=a.kid, keys=[{"kid": a.kid, "pub": pub}])
        res.update(kid=a.kid, pub=pub, fingerprint=gwc_sign.fingerprint(pub), keyFile=str(path))
    jwrite(dest / "store.config.json", cfg)
    (dest / "README.md").write_text(
        f"# {a.name}\n\nA GNOME Widget Center store ({a.tier}).\n\n"
        f"* Add widgets under `widgets/<id>/`, theme packs under `themepacks/`.\n"
        f"* `python3 tools/build_store.py --out dist --first-publish` (needs `GWC_SIGNING_KEY`) builds and signs the site.\n"
        f"* Push to `main`; `.github/workflows/pages.yml` publishes to GitHub Pages "
        f"(add the signing seed as the `GWC_SIGNING_KEY` secret of the `store-publish` Environment).\n"
        f"* Users add this store with its key fingerprint: `{gwc_sign.fingerprint(res['pub']) if a.kid else '(run tools/gwc_repo.py keygen)'}`.\n", "utf-8")
    if a.git and shutil.which("git"):
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=dest, check=False)
    return res


def cmd_keygen(a):
    """Repo signing key: private seed to --key-dir, public half into store.config.json."""
    root = bs.ROOT
    cfg = jread(root / "store.config.json")
    if any(k["kid"] == a.kid for k in cfg.get("trust", {}).get("keys", [])):
        die(f"key id {a.kid} is already trusted by this repo")
    seed, pub = new_keypair()
    path = save_seed(a.key_dir, a.kid, seed)
    t = cfg.setdefault("trust", {"signKid": "", "expiryDays": 30, "keys": []})
    t.setdefault("keys", []).append({"kid": a.kid, "pub": pub})
    if a.activate or not t.get("signKid"):
        t["signKid"] = a.kid
    jwrite(root / "store.config.json", cfg)
    return {"kid": a.kid, "pub": pub, "fingerprint": gwc_sign.fingerprint(pub), "keyFile": str(path), "active": t["signKid"] == a.kid}


def cmd_author_keygen(a):
    seed, pub = new_keypair()
    path = save_seed(a.key_dir, a.kid, seed)
    return {"kid": a.kid, "pub": pub, "fingerprint": gwc_sign.fingerprint(pub), "keyFile": str(path)}


# ------------------------------------------------------------------ status / lint
def widget_dirs(root):
    w = root / "widgets"
    return sorted(p for p in w.iterdir() if p.is_dir() and not p.name.startswith(".")) if w.exists() else []


def lint_all(root):
    problems = []
    add = lambda target, level, msg: problems.append({"target": target, "level": level, "message": msg})
    try:
        cats = jread(root / "catalogs.json"); call_checked(bs.check_catalogs, cats)
    except RepoError as e:
        add("catalogs.json", "error", str(e)); cats = {"widgets": [], "themepacks": []}
    try:
        cfg = jread(root / "store.config.json"); call_checked(bs.check_mirrors, cfg)
        if cfg.get("tier", "official") not in ("official", "community"): die("tier must be official or community")
    except RepoError as e:
        add("store.config.json", "error", str(e)); cfg = {"tier": "official", "baseUrl": "https://x/"}
    authors = []
    try:
        authors = call_checked(bs.load_authors)
    except RepoError as e:
        add("authors.json", "error", str(e))
    try:
        call_checked(bs.load_revoked, cats)
    except RepoError as e:
        add("revoked.json", "error", str(e))
    req = bs.author_policy(cfg)
    cat_ids = {c["id"] for c in cats.get("widgets", [])}
    info = []
    for d in widget_dirs(root):
        row = {"id": d.name, "ok": True}
        try:
            v = call_checked(bs.validate_widget, d, cat_ids, authors, req)
            md = v["md"]
            row.update(name=md["name"], version=md["version"], author=md["author"], catalog=md.get("catalog", "other"),
                       channel=md.get("channel", "stable"), perm=v["perm"], signed=bool(v["sg"]), signer=(v["sg"] or {}).get("k"),
                       files=len(v["files"]))
            for w in v["warnings"]:
                add(d.name, "warning", w)
        except RepoError as e:
            row["ok"] = False
            add(d.name, "error", str(e))
        has_cover = any((d / n).exists() for n in bs.COVER_NAMES)
        row["cover"] = has_cover
        if not has_cover:
            add(d.name, "warning", "no cover image (cover.png / cover.jpg)")
        info.append(row)
    packs = []
    tdir = root / "themepacks"
    seen = set()
    for f in sorted(tdir.glob("*.gwct")) if tdir.exists() else []:
        row = {"file": f.name, "ok": True}
        try:
            if f.stat().st_size > MAX_IMPORT: die("file too large")
            dd = json.loads(f.read_text("utf-8"))
            if dd.get("format") != "gwct": die("not a gwct")
            pm = dd.get("packMeta", {}); pid = pm.get("id") or f.stem.lower()
            if not ID_RE.match(pid): die("bad pack id")
            if pid in seen: die(f"duplicate pack id {pid}")
            seen.add(pid)
            if not isinstance(dd.get("widgets"), list): die("'widgets' must be a list")
            if pm.get("catalog", "other") not in {c["id"] for c in cats.get("themepacks", [])}: die(f"unknown catalog {pm.get('catalog')!r}")
            row.update(id=pid, name=pm.get("name", pid), widgets=len(dd["widgets"]), cover=bool(dd.get("screenshot")))
        except (RepoError, ValueError) as e:
            row["ok"] = False; add(f.name, "error", str(e))
        packs.append(row)
    return problems, info, packs, cfg, cats, authors


def cmd_lint(a):
    problems, *_ = lint_all(bs.ROOT)
    return {"errors": sum(p["level"] == "error" for p in problems), "warnings": sum(p["level"] == "warning" for p in problems), "problems": problems}


def cmd_status(a):
    root = bs.ROOT
    if not (root / "store.config.json").is_file():
        die(f"{root} is not a GWC store repo (no store.config.json)")
    problems, widgets, packs, cfg, cats, authors = lint_all(root)
    trust = cfg.get("trust", {})
    keys = [{"kid": k.get("kid"), "pub": k.get("pub"), "fingerprint": gwc_sign.fingerprint(k["pub"]) if k.get("pub") else "",
             "active": k.get("kid") == trust.get("signKid"), "privateKey": (Path(a.key_dir) / f"{k.get('kid')}.key").is_file()} for k in trust.get("keys", [])]
    return {"dir": str(root),
            "config": {"id": cfg.get("id"), "name": cfg.get("name"), "baseUrl": cfg.get("baseUrl"), "tier": cfg.get("tier", "official"),
                       "mirrors": cfg.get("mirrors", []), "requireAuthorSig": bs.author_policy(cfg),
                       "expiryDays": trust.get("expiryDays", 30), "signKid": trust.get("signKid", "")},
            "keys": keys, "widgets": widgets, "themepacks": packs, "authors": authors,
            "revoked": jread(root / "revoked.json", []), "catalogs": cats,
            "errors": sum(p["level"] == "error" for p in problems), "warnings": sum(p["level"] == "warning" for p in problems),
            "problems": problems, "hasTools": (root / "tools" / "build_store.py").is_file()}


# ------------------------------------------------------------------ widgets
WIDGET_JS = '''import St from "gi://St";
import Clutter from "gi://Clutter";
import {createLayeredCard, applyLayeredCardStyle} from "../../lib/shell/cardLayers.js";
import {configJsonDefaults} from "../../lib/widgetConfigDefaults.js";

export default class Widget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
    }

    buildActor() {
        this._layers = createLayeredCard({contentStyleClass: "%(prefix)s-root"});
        this._actor = this._layers.root;
        this._label = new St.Label({
            style_class: "%(prefix)s-label",
            text: this._settings.labelText ?? "%(name)s",
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._layers.content.add_child(this._label);
        this._render();
        return this._actor;
    }

    enable() { this._render(); }
    disable() {}
    onSettingsChanged() { this._render(); }

    _render() {
        if (!this._actor) return;
        applyLayeredCardStyle(this._layers, this._settings);
        this._label.set_text(this._settings.labelText ?? "%(name)s");
    }

    getDefaultSettings() {
        return {...configJsonDefaults(import.meta.url)};
    }
}
'''
CONFIG_JSON = {"version": "1.0", "tabs": [{"id": "general", "label": "%s", "description": "", "icon": "preferences-system-symbolic",
    "groups": [{"id": "content", "label": "Content", "description": "", "fields": [
        {"id": "labelText", "label": "Label text", "description": "Text shown by the widget", "dataType": "string", "fieldType": "text", "default": "%s"}]}]}]}


def make_cover(path, title):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return False
    W, H = 460, 270
    seed = sum(map(ord, title)) % 360
    im = Image.new("RGB", (W, H)); px = im.load()
    import colorsys
    c1 = tuple(int(x * 255) for x in colorsys.hsv_to_rgb(seed / 360, .55, .55))
    c2 = tuple(int(x * 255) for x in colorsys.hsv_to_rgb(((seed + 40) % 360) / 360, .6, .85))
    for y in range(H):
        for x in range(W):
            t = (x / W + y / H) / 2
            px[x, y] = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
    d = ImageDraw.Draw(im)
    try:
        font = ImageFont.load_default(size=34)
    except TypeError:
        font = ImageFont.load_default()
    d.text((W / 2, H / 2), title[:24], fill="white", font=font, anchor="mm")
    im.save(path, "PNG", optimize=True)
    return True


def cmd_new_widget(a):
    root = bs.ROOT
    if not ID_RE.match(a.id):
        die(f"id must match {ID_RE.pattern}")
    cats = jread(root / "catalogs.json")
    if a.catalog not in {c["id"] for c in cats["widgets"]}:
        die(f"unknown catalog {a.catalog!r}")
    perm, err = perm_scan.parse_perm(a.perm or ["none"])
    if err:
        die(err)
    if not bs.VERSION_RE.match(a.version):
        die("version must look like 1.0.0")
    d = root / "widgets" / a.id
    if d.exists():
        die(f"widgets/{a.id} already exists")
    d.mkdir(parents=True)
    prefix = re.sub(r"[^a-z0-9]+", "-", a.id.lower()).strip("-")
    md = {"id": a.id, "name": a.name, "description": a.description or a.name, "version": a.version, "author": a.author,
          "api-version": 2, "entry": "widget.js", "block-type": a.block_type, "catalog": a.catalog, "tags": [], "perm": perm}
    if a.channel != "stable":
        md["channel"] = a.channel
    jwrite(d / "metadata.json", md)
    (d / "widget.js").write_text(WIDGET_JS % {"prefix": prefix, "name": a.name.replace('"', "'")}, "utf-8")
    cj = json.loads(json.dumps(CONFIG_JSON) % (a.name.replace('"', "'"), a.name.replace('"', "'")) if False else json.dumps(CONFIG_JSON))
    cj["tabs"][0]["label"] = a.name; cj["tabs"][0]["groups"][0]["fields"][0]["default"] = a.name
    jwrite(d / "config.json", cj)
    (d / "stylesheet.css").write_text(f".{prefix}-label {{\n    padding: 12px 16px;\n    color: #ffffff;\n}}\n", "utf-8")
    cover = make_cover(d / "cover.png", a.name)
    return {"id": a.id, "dir": str(d), "cover": cover}


def _safe_member(name):
    return (name and not name.startswith("/") and "\\" not in name and "\0" not in name and "//" not in name and len(name) <= 200
            and not any(p in ("", ".", "..") for p in name.split("/")))


def _extract_gwcw(path, dest_root, replace):
    p = Path(path)
    if p.stat().st_size > MAX_IMPORT:                      # the .gwcw itself; a version 2 package is checked separately (its .gwcp)
        die("file is larger than 16 MB")
    try:
        g = json.loads(p.read_text("utf-8"))
        md, pkg = g["metadata"], g["package"]
        v2 = g.get("format") == "gwcw" and g.get("version") == 2 and pkg.get("encoding") == "zip"
        if g.get("format") != "gwcw" or not (v2 or (g.get("version") == 1 and pkg.get("encoding") == "zip+base64")):
            raise ValueError("not a .gwcw file this tool understands (version 1 or 2)")
        wid = md["id"]
        if not isinstance(wid, str) or not ID_RE.match(wid):
            raise ValueError("bad widget id")
        if not isinstance(pkg["size"], int) or not 0 < pkg["size"] <= (bs.MAX_ZIP_BIG if v2 else bs.MAX_ZIP * 2):
            raise ValueError("package size out of range")
        if v2:                                              # the zip is the .gwcp named in the .gwcw, in the same folder
            name = pkg.get("file")
            if not isinstance(name, str) or name != os.path.basename(name) or not name.endswith(".gwcp"):
                raise ValueError("bad package file name")
            zp = p.with_name(name)
            if not zp.is_file():
                raise ValueError(f"the package file {name} must be next to {p.name}")
            if zp.stat().st_size != pkg["size"]:
                raise ValueError("package integrity check failed")
            zbytes = zp.read_bytes()
        else:
            if len(pkg["data"]) > (pkg["size"] // 3 + 2) * 4:
                raise ValueError("package data is larger than its declared size")
            zbytes = base64.b64decode(pkg["data"], validate=True)
        if len(zbytes) != pkg["size"] or bs.hx(zbytes) != pkg["sha256"]:
            raise ValueError("package integrity check failed")
    except (KeyError, TypeError, ValueError) as e:
        die(f"cannot import {p.name}: {e}")
    dest = dest_root / "widgets" / wid
    if dest.exists() and not replace:
        die(f"widgets/{wid} already exists (use --replace)")
    files, total = [], 0
    try:
        with zipfile.ZipFile(io.BytesIO(zbytes)) as z:
            infos = [i for i in z.infolist() if not i.is_dir()]
            if len(infos) > bs.MAX_FILES: die("more than 200 files in the package")
            limit = bs.MAX_TOTAL_BIG if v2 else bs.MAX_TOTAL
            for i in infos:
                if not _safe_member(i.filename): die(f"unsafe path in package: {i.filename!r}")
                if i.file_size > bs.MAX_FILE: die(f"file too large: {i.filename}")
                total += i.file_size
                if total > limit: die(f"package unpacks to more than {limit // (1024 * 1024)} MB")
                files.append((i.filename, z.read(i)))
    except zipfile.BadZipFile:
        die("package is not a valid zip")
    return wid, md, files, g.get("cover")


def cmd_import_widget(a):
    root = bs.ROOT
    src = Path(a.path)
    cats = {c["id"] for c in jread(root / "catalogs.json")["widgets"]}
    authors = call_checked(bs.load_authors)
    req = bs.author_policy(jread(root / "store.config.json"))
    stage = root / f".import-{os.getpid()}"
    try:
        if src.is_dir():
            md = jread(src / "metadata.json"); wid = md.get("id")
            if not isinstance(wid, str) or not ID_RE.match(wid):
                die("metadata.json has no valid id")
            shutil.copytree(src, stage / wid, symlinks=True, ignore=shutil.ignore_patterns(".git", "node_modules", "__pycache__"))
        else:
            wid, md, files, cover = _extract_gwcw(src, root, a.replace)
            (stage / wid).mkdir(parents=True)
            for rel, data in files:
                t = stage / wid / rel; t.parent.mkdir(parents=True, exist_ok=True); t.write_bytes(data)
            jwrite(stage / wid / "metadata.json", md)
            if cover and cover.get("base64"):
                ext = {"image/png": "png", "image/jpeg": "jpg"}.get(cover.get("mimeType"))
                if ext: (stage / wid / f"cover.{ext}").write_bytes(base64.b64decode(cover["base64"]))
        dest = root / "widgets" / wid
        if dest.exists() and not a.replace:
            die(f"widgets/{wid} already exists (use --replace)")
        v = call_checked(bs.validate_widget, stage / wid, cats, authors, req)    # the same gate the build uses, BEFORE it enters the repo
        if dest.exists():
            shutil.rmtree(dest)
        shutil.move(str(stage / wid), str(dest))
        return {"id": wid, "version": v["md"]["version"], "perm": v["perm"], "signed": bool(v["sg"]), "warnings": v["warnings"]}
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def cmd_import_themepack(a):
    root = bs.ROOT
    src = Path(a.path)
    if src.stat().st_size > MAX_IMPORT: die("file is larger than 16 MB")
    try:
        d = json.loads(src.read_text("utf-8"))
    except ValueError as e:
        die(f"not valid JSON: {e}")
    if d.get("format") != "gwct" or not isinstance(d.get("widgets"), list): die("not a .gwct theme pack")
    pm = d.get("packMeta", {}); pid = pm.get("id") or src.stem.lower()
    if not ID_RE.match(pid): die("bad pack id")
    cats = {c["id"] for c in jread(root / "catalogs.json")["themepacks"]}
    if pm.get("catalog", "other") not in cats: die(f"unknown catalog {pm.get('catalog')!r}")
    dest = root / "themepacks" / f"{pid}.gwct"
    if dest.exists() and not a.replace: die(f"themepacks/{dest.name} already exists (use --replace)")
    dest.parent.mkdir(exist_ok=True)
    shutil.copy(src, dest)
    return {"id": pid, "file": dest.name, "widgets": len(d["widgets"]), "cover": bool(d.get("screenshot"))}


def cmd_sign_widget(a):
    root = bs.ROOT
    d = root / "widgets" / a.id
    if not d.is_dir(): die(f"no such widget: {a.id}")
    key_file = a.key_file or str(Path(a.key_dir) / f"{a.kid}.key")
    priv = load_seed(key_file)
    cats = {c["id"] for c in jread(root / "catalogs.json")["widgets"]}
    v = call_checked(bs.validate_widget, d, cats, [], False) if not (d / bs.AUTHOR_SIG_FILE).exists() else None
    if v is None:                                   # re-signing: validate without the old signature in the way
        old = (d / bs.AUTHOR_SIG_FILE).read_bytes(); (d / bs.AUTHOR_SIG_FILE).unlink()
        try: v = call_checked(bs.validate_widget, d, cats, [], False)
        finally: (d / bs.AUTHOR_SIG_FILE).write_bytes(old)
    md = v["md"]
    msg = gwc_sign.package_message(md["id"], md["version"], md["entry"], v["perm"], v["td"])
    sig = gwc_sign.sign_package(priv, msg)
    jwrite(d / bs.AUTHOR_SIG_FILE, {"alg": "ed25519", "kid": a.kid, "sig": sig, "td": v["td"]})
    pub = gwc_sign.public_b64(priv)
    authors = bs.load_authors()
    listed = next((x for x in authors if x["kid"] == a.kid), None)
    note = None
    if listed is None: note = f"'{a.kid}' is not in authors.json yet: add it (authors add) before building"
    elif listed["pub"] != pub: note = f"authors.json lists a DIFFERENT public key for '{a.kid}'"
    elif not gwc_sign.id_allowed(listed["ids"], md["id"]): note = f"authors.json does not allow '{a.kid}' to sign {md['id']}"
    return {"id": md["id"], "version": md["version"], "kid": a.kid, "pub": pub, "td": v["td"], "note": note}


# ------------------------------------------------------------------ authors / revoked / config
def cmd_authors(a):
    f = bs.ROOT / "authors.json"
    data = jread(f, [])
    if a.action == "add":
        if not a.kid or not a.name or not a.pub or not a.ids: die("authors add needs --kid --name --pub --ids")
        if any(x["kid"] == a.kid for x in data): die(f"author {a.kid} already exists")
        data.append({"kid": a.kid, "name": a.name, "pub": a.pub, "ids": [i.strip() for i in a.ids.split(",") if i.strip()]})
    elif a.action == "remove":
        n = len(data); data = [x for x in data if x["kid"] != a.kid]
        if len(data) == n: die(f"no author {a.kid}")
    backup = f.read_bytes() if f.exists() else b"[]\n"
    jwrite(f, data)
    try:
        return {"authors": call_checked(bs.load_authors)}
    except RepoError:
        f.write_bytes(backup); raise


def cmd_revoke(a):
    f = bs.ROOT / "revoked.json"
    data = jread(f, [])
    cats = jread(bs.ROOT / "catalogs.json")
    if a.action == "add":
        e = {"kind": a.kind, "id": a.id, "reason": a.reason or ""}
        if a.h: e["h"] = a.h
        data.append(e)
    elif a.action == "remove":
        n = len(data); data = [x for x in data if not (x["kind"] == a.kind and x["id"] == a.id and x.get("h") == (a.h or None))]
        if len(data) == n: die("no such entry")
    backup = f.read_bytes() if f.exists() else b"[]\n"
    jwrite(f, data)
    try:
        out = call_checked(bs.load_revoked, cats)
    except RepoError:
        f.write_bytes(backup); raise
    return {"revoked": out}


def cmd_config(a):
    f = bs.ROOT / "store.config.json"
    cfg = jread(f)
    if a.key not in CONFIG_KEYS: die(f"unknown setting {a.key!r} (allowed: {', '.join(sorted(CONFIG_KEYS))})")
    v = a.value
    if a.key == "mirrors":
        v = [x.strip() for x in v.split(",") if x.strip()]
    elif a.key == "requireAuthorSig":
        if v.lower() not in ("true", "false"): die("requireAuthorSig must be true or false")
        v = v.lower() == "true"
    elif a.key == "expiryDays":
        if not v.isdigit() or not 1 <= int(v) <= 365: die("expiryDays must be 1-365")
        v = int(v)
    elif a.key == "tier" and v not in ("official", "community"): die("tier must be official or community")
    elif a.key == "baseUrl" and not (v.startswith("https://") and v.endswith("/")): die("baseUrl must be https://... and end with '/'")
    elif a.key == "name" and not 1 <= len(v) <= 80: die("name: 1-80 chars")
    elif a.key == "signKid" and v not in {k["kid"] for k in cfg.get("trust", {}).get("keys", [])}: die("signKid must be one of trust.keys")
    if a.key in ("expiryDays", "signKid"): cfg.setdefault("trust", {})[a.key] = v
    else: cfg[a.key] = v
    before = f.read_bytes()
    jwrite(f, cfg)
    try:
        call_checked(bs.check_mirrors, cfg)
    except RepoError:
        f.write_bytes(before); raise
    return {"key": a.key, "value": v}



# ------------------------------------------------------------------ source folder browsing + key management
MAX_SCAN = 500
MAX_META = 1024 * 1024


def _child_dirs(p):
    try:
        return sorted(c for c in Path(p).iterdir() if c.is_dir() and not c.name.startswith("."))[:MAX_SCAN]
    except OSError:
        return []


def _has_widget_children(d):
    return any((c / "metadata.json").is_file() for c in _child_dirs(d))


def _has_gwct(d):
    try:
        return any(c.is_file() and c.suffix == ".gwct" for c in Path(d).iterdir())
    except OSError:
        return False


def find_source_dirs(src):
    """Where the widget folders and the .gwct files are inside a user-picked folder. Accepts: the extension folder
    (has widgets/ and themepacks/), a folder that holds such an extension folder, a widgets folder itself, or a
    themepacks folder itself. Looks at most one level down. Returns (widgets_dir | None, themepacks_dir | None)."""
    src = Path(src).resolve()
    cands = [src] + _child_dirs(src)
    wd = td = None
    for c in cands:
        if wd is None:
            if (c / "widgets").is_dir() and _has_widget_children(c / "widgets"): wd = c / "widgets"
            elif c == src and _has_widget_children(c): wd = c
        if td is None:
            if (c / "themepacks").is_dir() and _has_gwct(c / "themepacks"): td = c / "themepacks"
            elif c == src and _has_gwct(c): td = c
    return wd, td


def _small_json(p):
    try:
        if Path(p).stat().st_size > MAX_META: return None
        d = json.loads(Path(p).read_text("utf-8"))
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


def cmd_scan_source(a):
    """List what could be imported from a source folder, and whether the repo already has it. Read-only."""
    src = Path(a.path)
    if not src.is_dir():
        die(f"not a folder: {src}")
    root = bs.ROOT
    is_repo = (root / "store.config.json").is_file()
    wd, td = find_source_dirs(src)
    have_w = {p.name for p in widget_dirs(root)} if is_repo else set()
    have_t = {p.stem for p in (root / "themepacks").glob("*.gwct")} if is_repo and (root / "themepacks").is_dir() else set()
    widgets, packs = [], []
    for d in (_child_dirs(wd) if wd else []):
        md = _small_json(d / "metadata.json")
        if md is None: continue
        wid = md.get("id") if isinstance(md.get("id"), str) else d.name
        widgets.append({"id": wid, "name": md.get("name") or wid, "version": md.get("version", ""), "path": str(d),
                        "valid": bool(ID_RE.match(wid)), "inRepo": wid in have_w, "perm": md.get("perm", "")})
    if td:
        for f in sorted(Path(td).glob("*.gwct"))[:MAX_SCAN]:
            d = _small_json(f) if f.stat().st_size <= 4 * MAX_META else None
            if d is None or d.get("format") != "gwct": 
                packs.append({"id": f.stem, "name": f.stem, "file": f.name, "path": str(f), "valid": False, "inRepo": f.stem in have_t, "widgets": 0}); continue
            pm = d.get("packMeta") if isinstance(d.get("packMeta"), dict) else {}
            pid = pm.get("id") or f.stem.lower()
            packs.append({"id": pid, "name": pm.get("name") or pid, "file": f.name, "path": str(f), "valid": bool(ID_RE.match(str(pid))),
                          "inRepo": pid in have_t, "widgets": len(d.get("widgets", [])) if isinstance(d.get("widgets"), list) else 0})
    return {"source": str(src.resolve()), "widgetsDir": str(wd) if wd else "", "themepacksDir": str(td) if td else "",
            "widgets": widgets, "themepacks": packs}


def _key_files(key_dir):
    d = Path(key_dir)
    return sorted(d.glob("*.key")) if d.is_dir() else []


def cmd_list_keys(a):
    """Every private key in the key dir (not repo specific): id, public key, fingerprint, file mode problems."""
    out = []
    for f in _key_files(a.key_dir):
        item = {"kid": f.stem, "file": str(f), "pub": "", "fingerprint": "", "problem": ""}
        try:
            item["pub"] = gwc_sign.public_b64(load_seed(f))
            item["fingerprint"] = gwc_sign.fingerprint(item["pub"])
        except RepoError as e:
            item["problem"] = str(e)
        out.append(item)
    return {"keyDir": str(a.key_dir), "keys": out}


def cmd_export_key(a):
    """Copy a private key (backup) or write its public half (--public) into DEST folder. Never overwrites."""
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", a.kid):
        die("bad key id")
    src = Path(a.key_dir) / f"{a.kid}.key"
    seed = load_seed(src)                                  # also refuses a key readable by others
    dest = Path(a.dest)
    if not dest.is_dir():
        die(f"not a folder: {dest}")
    if a.public:
        pub = gwc_sign.public_b64(seed)
        out = dest / f"{a.kid}.pub.json"
        if out.exists(): die(f"{out.name} already exists in {dest}")
        out.write_text(json.dumps({"kid": a.kid, "pub": pub, "fingerprint": gwc_sign.fingerprint(pub)}, indent=2) + "\n", "utf-8")
        return {"file": str(out), "public": True}
    out = dest / f"{a.kid}.key"
    if out.exists(): die(f"{out.name} already exists in {dest}")
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(src.read_text())
    return {"file": str(out), "public": False}


def cmd_import_key(a):
    """Copy an existing private key file (a 32-byte Ed25519 seed, base64) into the key dir. Never overwrites."""
    src = Path(a.file)
    if not src.is_file():
        die(f"not a file: {src}")
    if src.stat().st_size > 4096:
        die(f"{src.name} is too large to be a key file")
    kid = a.kid or (src.stem if src.suffix == ".key" else src.name)
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", kid):
        die("key id may only contain letters, digits . _ - (up to 64)")
    try:
        text = src.read_text("utf-8").strip()
        pub = gwc_sign.public_b64(gwc_sign.private_from_seed_b64(text))
    except (ValueError, UnicodeDecodeError):
        die(f"{src.name} is not a signing key file (expected a base64 Ed25519 seed)")
    path = save_seed(a.key_dir, kid, text)
    return {"kid": kid, "pub": pub, "fingerprint": gwc_sign.fingerprint(pub), "keyFile": str(path)}


def main(argv=None):
    ap = argparse.ArgumentParser(description="GWC repo maintenance (JSON output)")
    ap.add_argument("--repo", default=str(HERE.parent))
    ap.add_argument("--key-dir", default=str(DEFAULT_KEY_DIR))
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("init"); p.add_argument("dir"); p.add_argument("--id", required=True); p.add_argument("--name", required=True)
    p.add_argument("--base-url", required=True); p.add_argument("--tier", default="official"); p.add_argument("--kid"); p.add_argument("--git", action="store_true")
    sp.add_parser("status"); sp.add_parser("lint")
    p = sp.add_parser("keygen"); p.add_argument("--kid", required=True); p.add_argument("--activate", action="store_true")
    p = sp.add_parser("author-keygen"); p.add_argument("--kid", required=True)
    p = sp.add_parser("new-widget"); p.add_argument("--id", required=True); p.add_argument("--name", required=True); p.add_argument("--author", required=True)
    p.add_argument("--catalog", default="other"); p.add_argument("--description", default=""); p.add_argument("--version", default="1.0.0")
    p.add_argument("--perm", nargs="+"); p.add_argument("--block-type", default="1x1"); p.add_argument("--channel", default="stable", choices=bs.CHANNELS)
    p = sp.add_parser("import-widget"); p.add_argument("path"); p.add_argument("--replace", action="store_true")
    p = sp.add_parser("import-themepack"); p.add_argument("path"); p.add_argument("--replace", action="store_true")
    p = sp.add_parser("sign-widget"); p.add_argument("id"); p.add_argument("--kid", required=True); p.add_argument("--key-file")
    p = sp.add_parser("authors"); p.add_argument("action", choices=["add", "remove", "list"]); p.add_argument("--kid"); p.add_argument("--name"); p.add_argument("--pub"); p.add_argument("--ids")
    p = sp.add_parser("revoke"); p.add_argument("action", choices=["add", "remove", "list"]); p.add_argument("--kind", choices=["widgets", "themepacks"])
    p.add_argument("--id"); p.add_argument("--h"); p.add_argument("--reason")
    p = sp.add_parser("config"); p.add_argument("key"); p.add_argument("value")
    p = sp.add_parser("scan-source"); p.add_argument("path")
    sp.add_parser("list-keys")
    p = sp.add_parser("export-key"); p.add_argument("kid"); p.add_argument("dest"); p.add_argument("--public", action="store_true")
    p = sp.add_parser("import-key"); p.add_argument("file"); p.add_argument("--kid")
    a = ap.parse_args(argv)
    try:
        if a.cmd not in ("init", "list-keys", "export-key", "import-key", "author-keygen") and not (a.cmd == "scan-source" and not Path(a.repo, "store.config.json").is_file()):
            set_repo(a.repo)
        fn = {"init": cmd_init, "status": cmd_status, "lint": cmd_lint, "keygen": cmd_keygen, "author-keygen": cmd_author_keygen,
              "new-widget": cmd_new_widget, "import-widget": cmd_import_widget, "import-themepack": cmd_import_themepack,
              "sign-widget": cmd_sign_widget, "authors": cmd_authors, "revoke": cmd_revoke, "config": cmd_config,
              "scan-source": cmd_scan_source, "list-keys": cmd_list_keys, "export-key": cmd_export_key, "import-key": cmd_import_key}[a.cmd]
        res = fn(a)
        print(json.dumps({"ok": True, **res}, ensure_ascii=False))
        return 0
    except RepoError as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1
    except (OSError, ValueError) as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
