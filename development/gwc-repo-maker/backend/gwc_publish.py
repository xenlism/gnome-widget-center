#!/usr/bin/env python3
"""gwc_publish.py - publish a built store (dist/) to GitHub Pages WITHOUT git, a terminal or a GitHub Actions secret.

Why this exists: the signing key never has to leave the user's computer. The app signs locally (build_store.py), then this
tool uploads the finished site to the `gh-pages` branch of a public repository through the GitHub REST API and turns on
GitHub Pages for it. Python standard library only (no `cryptography`, no `requests`).

Lives in backend/ (NOT backend/tools/) so that ./sync-backend.sh, which replaces backend/tools from gwc-store, keeps it.

Every command prints ONE JSON line ({"ok": true, ...} / {"ok": false, "error": "...", "code": "..."}), except `upload`, which
first prints progress lines starting with "# " and then the JSON line. The GitHub token is stored in <key-dir>/github.token
(mode 0600; the key dir is 0700) and is never printed.

  gwc_publish.py [--key-dir D] status                       signed in? is the device-flow client id configured?
  gwc_publish.py auth-start                                 start "Sign in with GitHub" (device flow) -> user_code + url
  gwc_publish.py auth-poll --device-code X                  one poll: {done:false,wait:N} until the user approves
  gwc_publish.py auth-token                                 token on STDIN (fallback: personal access token) -> verified, saved
  gwc_publish.py signout
  gwc_publish.py prepare --repo-name NAME                   make sure the repository exists; tells Pages URL + previous seq
  gwc_publish.py upload  --repo-name NAME --dist DIR        push dist/ to gh-pages and enable Pages
  gwc_publish.py probe --url https://host/path/                is a store already online there? {state: live|none|unreachable, seq}
  upload also accepts --cname HOST: publish under your own domain (writes the CNAME file GitHub Pages reads; DNS is yours to set)
  ... prepare/upload accept --folder F: instead, put the store in folder F of an EXISTING GitHub Pages site (repo OWNER/NAME or NAME),
      on the branch/path that site already publishes from. Other files of the site are never touched.

Environment (tests / GitHub Enterprise): GWC_GH_API (default https://api.github.com), GWC_GH_WEB (default https://github.com),
GWC_GH_CLIENT_ID (else backend/github_client_id.txt).
"""
import argparse, base64, hashlib, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
API = os.environ.get("GWC_GH_API", "https://api.github.com").rstrip("/")
WEB = os.environ.get("GWC_GH_WEB", "https://github.com").rstrip("/")
BRANCH = "gh-pages"
DEFAULT_KEY_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "gwc-repo-maker" / "keys"
NAME_RE = re.compile(r"[A-Za-z0-9._-]{1,100}")


class PubError(Exception):
    def __init__(self, msg, code="error"):
        super().__init__(msg)
        self.code = code


def die(msg, code="error"):
    raise PubError(msg, code)


def note(msg):
    print(f"# {msg}", flush=True)


# ------------------------------------------------------------------ token storage
def token_path(key_dir):
    return Path(key_dir) / "github.token"


def load_token(key_dir):
    try:
        t = token_path(key_dir).read_text("utf-8").strip()
        return t or None
    except OSError:
        return None


def save_token(key_dir, token):
    d = Path(key_dir)
    d.mkdir(parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    fd = os.open(token_path(key_dir), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token + "\n")
    os.chmod(token_path(key_dir), 0o600)


def client_id():
    cid = os.environ.get("GWC_GH_CLIENT_ID", "").strip()
    if cid:
        return cid
    try:
        return (HERE / "github_client_id.txt").read_text("utf-8").strip()
    except OSError:
        return ""


# ------------------------------------------------------------------ HTTP
def _send(req, retries=6, timeout=60):
    """-> (status, parsed json or None, headers). Waits and retries when GitHub asks us to slow down (secondary rate limit)."""
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None), r.headers
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                body = json.loads(raw) if raw else None
            except ValueError:
                body = {"message": raw.decode("utf-8", "replace")[:200]}
            msg = str((body or {}).get("message", "")).lower()
            limited = e.code == 429 or (e.code == 403 and ("rate limit" in msg or "abuse" in msg or "secondary" in msg))
            if limited and attempt < retries - 1:
                wait = int(e.headers.get("Retry-After") or 0)
                reset = e.headers.get("X-RateLimit-Reset")
                if not wait and reset and e.headers.get("X-RateLimit-Remaining") == "0":
                    wait = max(1, min(int(reset) - int(time.time()), 300))
                wait = max(wait, 20 * (attempt + 1)) if not wait else wait
                note(f"GitHub asks us to slow down - waiting {wait}s (attempt {attempt + 2}/{retries})")
                time.sleep(wait)
                continue
            return e.code, body, e.headers
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            if attempt < min(2, retries - 1):
                time.sleep(2 * (attempt + 1))
                continue
            die(f"Cannot reach GitHub ({getattr(e, 'reason', e)}). Check the internet connection and try again.", "network")
    die("GitHub kept refusing the request; try again in a few minutes.", "rate-limit")


def api(method, path, token, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gwc-repo-maker", **({"Content-Type": "application/json"} if data is not None else {})})
    st, js, _ = _send(req, timeout=timeout)
    if st == 401:
        die("GitHub rejected the saved sign-in (it may have been revoked or expired). Sign in again.", "auth")
    return st, js


def web_post(path, form):
    req = urllib.request.Request(WEB + path, data=urllib.parse.urlencode(form).encode(), method="POST",
                                 headers={"Accept": "application/json", "User-Agent": "gwc-repo-maker"})
    st, js, _ = _send(req, retries=1)
    return st, js or {}


def explain(st, js, what):
    m = (js or {}).get("message", "")
    if st == 403:
        return f"GitHub refused to {what} (403): {m}. The sign-in may lack permission - sign out and sign in again."
    if st == 422:
        return f"GitHub could not {what} (422): {m}"
    return f"GitHub could not {what} (HTTP {st}): {m}"


def need_token(key_dir):
    t = load_token(key_dir)
    if not t:
        die("Not signed in to GitHub.", "auth")
    return t


def whoami(token):
    st, js = api("GET", "/user", token)
    if st != 200 or not js or not js.get("login"):
        die(explain(st, js, "read your account"))
    return js["login"]


# ------------------------------------------------------------------ sign in
def cmd_status(a):
    login, err = None, None
    t = load_token(a.key_dir)
    if t:
        try:
            login = whoami(t)
        except PubError as e:
            err = str(e)
    return {"signedIn": bool(login), "login": login, "deviceFlow": bool(client_id()), "authError": err}


def cmd_auth_start(a):
    cid = client_id()
    if not cid:
        die("This copy of the app has no GitHub client id; use a personal access token instead.", "no-client-id")
    st, js = web_post("/login/device/code", {"client_id": cid, "scope": "public_repo"})
    if st != 200 or "device_code" not in js:
        die(f"GitHub did not start the sign-in ({js.get('error_description') or js.get('error') or st}).")
    return {"deviceCode": js["device_code"], "userCode": js["user_code"], "url": js.get("verification_uri", f"{WEB}/login/device"),
            "interval": int(js.get("interval", 5)), "expiresIn": int(js.get("expires_in", 900))}


def cmd_auth_poll(a):
    cid = client_id()
    if not cid:
        die("no client id", "no-client-id")
    st, js = web_post("/login/oauth/access_token", {"client_id": cid, "device_code": a.device_code,
                                                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})
    if js.get("access_token"):
        save_token(a.key_dir, js["access_token"])
        return {"done": True, "login": whoami(js["access_token"])}
    err = js.get("error")
    if err == "authorization_pending":
        return {"done": False, "wait": 0}
    if err == "slow_down":
        return {"done": False, "wait": int(js.get("interval", 10))}
    if err == "expired_token":
        die("The code expired before it was approved. Start again.", "expired")
    if err == "access_denied":
        die("Sign-in was cancelled on GitHub.", "denied")
    die(f"GitHub sign-in failed: {js.get('error_description') or err or st}")


def cmd_auth_token(a):
    tok = sys.stdin.read().strip()
    if not tok or len(tok) > 400 or re.search(r"\s", tok):
        die("That does not look like a GitHub token.")
    login = whoami(tok)
    save_token(a.key_dir, tok)
    return {"login": login}


def cmd_signout(a):
    try:
        token_path(a.key_dir).unlink()
    except FileNotFoundError:
        pass
    return {}


# ------------------------------------------------------------------ repository + gh-pages state
def check_name(name):
    if not NAME_RE.fullmatch(name or "") or name in (".", "..") or name.lower().endswith(".git"):
        die("Repository name: letters, digits, '.', '_' and '-' only (1-100 characters).")


def pages_url(owner, name):
    return f"https://{owner.lower()}.github.io/" if name.lower() == f"{owner.lower()}.github.io" else f"https://{owner.lower()}.github.io/{name}/"


def branch_state(token, owner, name, branch=BRANCH, prefix=""):
    """-> None when the branch does not exist, else {head, tree, files:{path relative to prefix: blob sha}, truncated, seq|None}.
    With a prefix only the files inside that folder are listed (and `files` paths are relative to it)."""
    st, js = api("GET", f"/repos/{owner}/{name}/git/ref/heads/{branch}", token)
    if st == 404 or (st == 409):                     # 409 = empty repository
        return None
    if st != 200:
        die(explain(st, js, "read the publishing branch"))
    head = js["object"]["sha"]
    st, c = api("GET", f"/repos/{owner}/{name}/git/commits/{head}", token)
    if st != 200:
        die(explain(st, c, "read the publishing branch"))
    tree = c["tree"]["sha"]
    st, t = api("GET", f"/repos/{owner}/{name}/git/trees/{tree}?recursive=1", token)
    if st != 200:
        die(explain(st, t, "read the publishing branch"))
    cut = len(prefix) + 1 if prefix else 0
    files = {e["path"][cut:]: e["sha"] for e in t.get("tree", []) if e.get("type") == "blob" and (not prefix or e["path"].startswith(prefix + "/"))}
    seq = None
    if "store.json" in files:
        st, b = api("GET", f"/repos/{owner}/{name}/git/blobs/{files['store.json']}", token)
        if st == 200:
            try:
                seq = int(json.loads(base64.b64decode(b["content"]))["seq"])
            except (ValueError, KeyError, TypeError):
                seq = None
    return {"head": head, "tree": tree, "files": files, "truncated": bool(t.get("truncated")), "seq": seq}


def check_branch_ours(state, owner, name, where=None):
    """Never wipe a branch / folder that holds something other than a store."""
    if state and state["files"] and "store.json" not in state["files"]:
        die(f"{where or f'The {BRANCH} branch of {owner}/{name}'} already contains other files. Choose a different "
            f"{'folder name' if where else 'repository name'}.", "foreign-branch")


def ensure_repo(token, owner, name):
    st, js = api("GET", f"/repos/{owner}/{name}", token)
    created = False
    if st == 404:
        note(f"creating the public repository {owner}/{name}")
        st, js = api("POST", "/user/repos", token, {"name": name, "description": "GNOME Widget Center store",
                                                     "private": False, "auto_init": True, "has_issues": True})
        if st not in (200, 201):
            die(explain(st, js, "create the repository"))
        created = True
    elif st != 200:
        die(explain(st, js, "open the repository"))
    elif js.get("owner", {}).get("login", "").lower() != owner.lower():
        die(f"The repository {name} belongs to someone else.", "foreign-repo")
    if js.get("private"):
        die("That repository is private. GitHub Pages needs a public repository on a free account - make it public or pick another name.", "private")
    return created


def cmd_prepare(a):
    token = need_token(a.key_dir)
    if a.folder is not None:                         # "" is folder mode too (and is rejected), never silently "own repository" mode
        check_name(a.repo_name.split("/")[-1])
        return prepare_folder(a, token)
    check_name(a.repo_name)
    owner = whoami(token)
    created = ensure_repo(token, owner, a.repo_name)
    state = branch_state(token, owner, a.repo_name)
    check_branch_ours(state, owner, a.repo_name)
    return {"owner": owner, "repo": a.repo_name, "pagesUrl": pages_url(owner, a.repo_name), "created": created,
            "prevSeq": state["seq"] if state else None}


# ------------------------------------------------------------------ folder inside an existing Pages site
FOLDER_SEG = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}")
OWNER_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})")


def check_folder(folder):
    f = (folder or "").strip().strip("/")
    segs = f.split("/") if f else []
    if not segs or not all(FOLDER_SEG.fullmatch(x) and x not in (".", "..") for x in segs):
        die("Folder name: letters, digits, '.', '_' and '-' (use / for a sub-folder). It must not start with '.' or '_': GitHub Pages ignores such folders.")
    return "/".join(segs)


def parse_repo(login, text):
    owner, _, name = text.partition("/") if "/" in text else (login, "", text)
    if not OWNER_RE.fullmatch(owner or ""):
        die("Repository: NAME or OWNER/NAME.")
    check_name(name)
    return owner, name


def pages_info(token, owner, name):
    """How the existing site is published: {branch, path, html (site root URL ending in /), workflow}."""
    st, repo = api("GET", f"/repos/{owner}/{name}", token)
    if st == 404:
        die(f"The repository {owner}/{name} was not found (or this sign-in cannot see it).", "no-repo")
    if st != 200:
        die(explain(st, repo, "open the repository"))
    if repo.get("private"):
        die("That repository is private; GitHub Pages sites on a free account are public.", "private")
    st, p = api("GET", f"/repos/{owner}/{name}/pages", token)
    if st == 404:
        die(f"GitHub Pages is not turned on for {owner}/{name}. Turn it on in the repository's Settings > Pages, or publish the store to a repository of its own.", "no-pages")
    if st != 200:
        die(explain(st, p, "read the GitHub Pages settings"))
    workflow = p.get("build_type") == "workflow"
    src = p.get("source") or {}
    branch = repo.get("default_branch") or "main" if workflow else (src.get("branch") or repo.get("default_branch") or "main")
    path = "" if workflow else (src.get("path") or "/").strip("/")
    html = (p.get("html_url") or pages_url(owner, name)).rstrip("/") + "/"
    return {"branch": branch, "path": path, "html": html, "workflow": workflow}


def folder_target(a, token):
    """shared by prepare/upload in folder mode -> (owner, name, folder, info, target dir inside the repo, state)"""
    login = whoami(token)
    owner, name = parse_repo(login, a.repo_name)
    folder = check_folder(a.folder)
    info = pages_info(token, owner, name)
    target = "/".join(x for x in (info["path"], folder) if x)
    state = branch_state(token, owner, name, info["branch"], target)
    if state is None:
        die(f"The branch {info['branch']} of {owner}/{name} does not exist or is empty.", "no-branch")
    if state["truncated"]:
        die(f"{owner}/{name} is too large to update safely from here.", "too-large")
    check_branch_ours(state, owner, name, where=f"The folder {target}/ of {owner}/{name}")
    warn = None
    if info["workflow"]:
        warn = (f"{owner}/{name} is published by a GitHub Actions workflow. The files are committed to {info['branch']}/{target}/, "
                f"but they only go online if that workflow publishes this folder (with a framework it often has to be inside its public/ folder).")
    return owner, name, folder, info, target, state, warn


def prepare_folder(a, token):
    owner, name, folder, info, target, state, warn = folder_target(a, token)
    res = {"owner": owner, "repo": name, "pagesUrl": info["html"] + folder + "/", "created": False,
           "prevSeq": state["seq"], "branch": info["branch"], "folder": target}
    if warn:
        res["warning"] = warn
    return res


# ------------------------------------------------------------------ upload
def git_blob_sha(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def collect(dist, cname=None):
    out = {}
    for p in sorted(Path(dist).rglob("*")):
        if p.is_file() and not p.is_symlink():
            out[p.relative_to(dist).as_posix()] = p.read_bytes()
    out.setdefault(".nojekyll", b"")                  # serve the files exactly as they are (no Jekyll processing)
    if cname:
        out["CNAME"] = cname.encode() + b"\n"          # GitHub Pages reads the custom domain from this file in the root of the published branch
    return out


def ensure_pages(token, owner, name):
    src = {"branch": BRANCH, "path": "/"}
    st, js = api("GET", f"/repos/{owner}/{name}/pages", token)
    if st == 404:
        st, js = api("POST", f"/repos/{owner}/{name}/pages", token, {"source": src})
        if st not in (200, 201, 409):
            die(explain(st, js, "turn on GitHub Pages"))
    elif st == 200:
        cur = (js or {}).get("source") or {}
        if cur.get("branch") != BRANCH or cur.get("path") != "/" or js.get("build_type") == "workflow":
            st2, js2 = api("PUT", f"/repos/{owner}/{name}/pages", token, {"source": src, "build_type": "legacy"})
            if st2 not in (200, 204):
                die(explain(st2, js2, "switch GitHub Pages to the publishing branch"))
    else:
        die(explain(st, js, "check GitHub Pages"))
    st, js = api("GET", f"/repos/{owner}/{name}/pages", token)
    return (js or {}).get("html_url") if st == 200 else None


def blob_timeout(n):
    """seconds GitHub gets to answer one blob upload: a 64 MiB widget package is ~85 MB of JSON, which takes a while to accept"""
    return max(60, n // (25 * 1024))


def push_blobs(token, owner, name, files, shas, have):
    todo = [p for p in files if shas[p] not in have]
    note(f"{len(files)} files, {len(todo)} new or changed" + (" - the first publish uploads everything and can take a few minutes" if len(todo) > 60 else ""))
    for i, p in enumerate(todo, 1):
        st, js = api("POST", f"/repos/{owner}/{name}/git/blobs", token,
                     {"content": base64.b64encode(files[p]).decode(), "encoding": "base64"}, timeout=blob_timeout(len(files[p])))
        if st != 201 or js.get("sha") != shas[p]:
            die(explain(st, js, f"upload {p}"))
        if i == len(todo) or i % 10 == 0 or len(todo) <= 10:
            note(f"uploaded {i}/{len(todo)}")
    return todo


def read_dist(a, cname=None):
    dist = Path(a.dist)
    for need in ("store.json", "store.json.sig"):
        if not (dist / need).is_file():
            die(f"{dist} has no {need}: run the signed build first.")
    try:
        seq = int(json.loads((dist / "store.json").read_text("utf-8"))["seq"])
    except (ValueError, KeyError, TypeError):
        die("dist/store.json is not a valid manifest.")
    return collect(dist, cname), seq


def commit_to_branch(token, owner, name, branch, tree_sha, parent, message, new_branch):
    st, com = api("POST", f"/repos/{owner}/{name}/git/commits", token, {"message": message, "tree": tree_sha, "parents": [parent] if parent else []})
    if st != 201:
        die(explain(st, com, "write the commit"))
    if new_branch:
        st, ref = api("POST", f"/repos/{owner}/{name}/git/refs", token, {"ref": f"refs/heads/{branch}", "sha": com["sha"]})
    else:
        st, ref = api("PATCH", f"/repos/{owner}/{name}/git/refs/heads/{branch}", token, {"sha": com["sha"], "force": False})
        if st in (403, 422):
            die(f"GitHub refused the update of {branch} ({(ref or {}).get('message', st)}). The branch may be protected or may have changed while uploading: try again.", "branch-refused")
    if st not in (200, 201):
        die(explain(st, ref, "update the publishing branch"))


def upload_folder(a, token):
    files, new_seq = read_dist(a)
    owner, name, folder, info, target, state, warn = folder_target(a, token)
    if state["seq"] is not None and new_seq <= state["seq"]:
        die(f"{target}/ already holds store seq {state['seq']} but this build is seq {new_seq}. A previous publish is probably still "
            f"going live: wait a few minutes, then build and publish again.", "stale-seq")
    shas = {p: git_blob_sha(b) for p, b in files.items()}
    push_blobs(token, owner, name, files, shas, set(state["files"].values()))
    entries = [{"path": f"{target}/{p}", "mode": "100644", "type": "blob", "sha": shas[p]} for p in sorted(files) if state["files"].get(p) != shas[p]]
    entries += [{"path": f"{target}/{p}", "mode": "100644", "type": "blob", "sha": None} for p in sorted(state["files"]) if p not in files]
    st, tree = api("POST", f"/repos/{owner}/{name}/git/trees", token, {"base_tree": state["tree"], "tree": entries})
    if st != 201:
        die(explain(st, tree, "write the file tree"))
    commit_to_branch(token, owner, name, info["branch"], tree["sha"], state["head"], f"Publish store seq {new_seq} to {folder}/", False)
    res = {"url": info["html"] + folder + "/", "seq": new_seq, "files": len(files), "uploaded": sum(shas[p] not in set(state["files"].values()) for p in files),
           "created": False, "branch": info["branch"], "folder": target}
    if warn:
        res["warning"] = warn
    return res


def cmd_upload(a):
    check_name(a.repo_name.split("/")[-1] if a.folder is not None else a.repo_name)
    token = need_token(a.key_dir)
    if a.folder is not None:
        if a.cname:
            die("A custom domain cannot be set for a folder of an existing site: it follows that site's own address.")
        return upload_folder(a, token)
    cname = check_cname(a.cname) if a.cname else None
    files, new_seq = read_dist(a, cname)
    owner = whoami(token)
    created = ensure_repo(token, owner, a.repo_name)
    state = branch_state(token, owner, a.repo_name)
    check_branch_ours(state, owner, a.repo_name)
    if state and state["seq"] is not None and new_seq <= state["seq"]:
        die(f"The branch already holds store seq {state['seq']} but this build is seq {new_seq}. A previous publish is probably still "
            f"going live: wait a few minutes, then build and publish again.", "stale-seq")
    have = set(state["files"].values()) if state and not state["truncated"] else set()
    shas = {p: git_blob_sha(b) for p, b in files.items()}
    todo = push_blobs(token, owner, a.repo_name, files, shas, have)
    entries = [{"path": p, "mode": "100644", "type": "blob", "sha": shas[p]} for p in sorted(files)]
    st, tree = api("POST", f"/repos/{owner}/{a.repo_name}/git/trees", token, {"tree": entries})
    if st != 201:
        die(explain(st, tree, "write the file tree"))
    commit_to_branch(token, owner, a.repo_name, BRANCH, tree["sha"], state["head"] if state else None, f"Publish store seq {new_seq}", state is None)
    note("turning on GitHub Pages")
    live = ensure_pages(token, owner, a.repo_name)
    want = f"https://{cname}/" if cname else pages_url(owner, a.repo_name)
    res = {"url": want, "seq": new_seq, "files": len(files), "uploaded": len(todo), "created": created}
    if cname:
        res["warning"] = (f"Point the DNS record of {cname} to {owner.lower()}.github.io (a CNAME record) and, once GitHub has verified it, "
                          f"tick 'Enforce HTTPS' in the repository's Settings > Pages. Until then {want} will not answer.")
    elif live and live.rstrip("/") != want.rstrip("/"):
        res["warning"] = f"GitHub reports the site address as {live}, but the store was built for {want}. If you use a custom domain, set that as the Public URL in Settings and publish again."
    return res


# ------------------------------------------------------------------ own host / custom domain
HOST_RE = re.compile(r"(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")


def check_cname(host):
    h = (host or "").strip().lower()
    if not HOST_RE.fullmatch(h):
        die("Custom domain: a host name such as store.example.com (no https://, no path).")
    if h.endswith(".github.io"):
        die("That is already a github.io address: leave the custom domain empty.")
    return h


def cmd_probe(a):
    """Is a store online at --url? Never raises for network problems: the caller decides what 'unreachable' means."""
    url = a.url.rstrip("/") + "/store.json"
    if not url.startswith("https://"):
        die("The address must start with https://")
    req = urllib.request.Request(url, headers={"User-Agent": "gwc-repo-maker", "Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read(1024 * 1024)
        try:
            return {"state": "live", "seq": int(json.loads(raw)["seq"]), "url": url}
        except (ValueError, KeyError, TypeError):
            return {"state": "unreachable", "error": f"{url} answers, but it is not a store manifest."}
    except urllib.error.HTTPError as e:
        return {"state": "none", "url": url} if e.code == 404 else {"state": "unreachable", "error": f"{url} answered HTTP {e.code}."}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return {"state": "unreachable", "error": f"Cannot reach {url}: {getattr(e, 'reason', e)}"}


# ------------------------------------------------------------------ main
def main(argv=None):
    ap = argparse.ArgumentParser(description="Publish a GWC store to GitHub Pages (JSON output)")
    ap.add_argument("--key-dir", default=str(DEFAULT_KEY_DIR))
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("status"); sp.add_parser("auth-start"); sp.add_parser("auth-token"); sp.add_parser("signout")
    p = sp.add_parser("auth-poll"); p.add_argument("--device-code", required=True)
    p = sp.add_parser("probe"); p.add_argument("--url", required=True)
    p = sp.add_parser("prepare"); p.add_argument("--repo-name", required=True); p.add_argument("--folder")
    p = sp.add_parser("upload"); p.add_argument("--repo-name", required=True); p.add_argument("--dist", required=True); p.add_argument("--folder"); p.add_argument("--cname")
    a = ap.parse_args(argv)
    fn = {"status": cmd_status, "auth-start": cmd_auth_start, "auth-poll": cmd_auth_poll, "auth-token": cmd_auth_token,
          "signout": cmd_signout, "prepare": cmd_prepare, "upload": cmd_upload, "probe": cmd_probe}[a.cmd]
    try:
        print(json.dumps({"ok": True, **fn(a)}, ensure_ascii=False), flush=True)
        return 0
    except PubError as e:
        print(json.dumps({"ok": False, "error": str(e), "code": e.code}, ensure_ascii=False), flush=True)
        return 1
    except OSError as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}", "code": "os"}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
