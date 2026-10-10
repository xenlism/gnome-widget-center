"""perm_scan.py - compare the permissions a widget DECLARES (metadata.perm) with what its code visibly USES.

This is a reviewer aid, not a sandbox. GJS has no sandbox: a widget runs with the user's rights. The scan raises the cost of
the lazy/accidental case and makes the honest declaration visible in the install dialog; a determined attacker can hide
behaviour from a regex, which is why a human reviewer and the revocation list remain the real controls.

Design choices
  * raw text is scanned (comments and strings included): a false positive costs the author one edited line,
    a stripped-comment scanner can be fooled by a regex literal containing `//` and hide code behind it.
  * constructs that defeat static scanning (eval, new Function, dynamic import, Gio["X"] bracket access) are REJECTED.
  * under-declaration fails the build; over-declaration is only reported (warning).
"""
import re

CLASSES = ("network", "subprocess", "fs-read", "fs-write")
PERM_RE = re.compile(r"^(none|network|subprocess|fs-read:[A-Za-z0-9_./~$-]{1,200}|fs-write:[A-Za-z0-9_./~$-]{1,200})$")

# (permission class, regex, why) - searched in every .js file of the package
RULES = [
    ("network", r"\bSoup\b", "uses Soup"),
    ("network", r"\bfetch\s*\(", "calls fetch()"),
    ("network", r"\bXMLHttpRequest\b|\bWebSocket\b", "uses XMLHttpRequest/WebSocket"),
    ("network", r"\bGio\s*\.\s*(Socket\w*|NetworkAddress|NetworkService|TcpConnection)\b", "uses Gio sockets"),
    ("subprocess", r"\bGLib\s*\.\s*spawn\w*", "uses GLib.spawn*"),
    ("subprocess", r"\bGio\s*\.\s*Subprocess\w*", "uses Gio.Subprocess"),
    ("subprocess", r"\.\s*launch(_uris|_action)?\s*\(", "launches an application"),
    ("subprocess", r"\bGio\s*\.\s*(DesktopAppInfo|AppInfo)\b", "uses Gio AppInfo"),
    ("subprocess", r"\bGtk\s*\.\s*show_uri\b|\bGio\s*\.\s*AppInfo\s*\.\s*launch_default_for_uri\b", "opens an external URI"),
    ("fs-read", r"\bGio\s*\.\s*File\b", "uses Gio.File"),
    ("fs-read", r"\bGLib\s*\.\s*(file_get_contents|file_test|dir_open|get_home_dir|build_filenamev)\b", "reads the file system via GLib"),
    ("fs-read", r"\b(load_contents|enumerate_children|query_info)\w*\s*\(", "reads files"),
    ("fs-write", r"\bGLib\s*\.\s*(file_set_contents|mkdir\w*|unlink|rmdir|rename)\b", "writes the file system via GLib"),
    ("fs-write", r"\b(replace_contents|append_to|make_directory\w*|copy_async|trash)\w*\s*\(|\.\s*(delete|move|copy)\s*\(", "writes/deletes files"),
]
_RULES = [(c, re.compile(rx), why) for c, rx, why in RULES]

# things a regex scan cannot see through: refuse them outright
REJECT = [
    (re.compile(r"\beval\s*\("), "eval() hides code from review"),
    (re.compile(r"\bnew\s+Function\b|\bFunction\s*\("), "Function constructor hides code from review"),
    (re.compile(r"\bimport\s*\(\s*[^\"'\s)]"), "dynamic import() with a computed specifier"),
    (re.compile(r"\b(Gio|GLib|Soup|imports)\s*\[\s*[^\"'\s\]]"), "computed property access on Gio/GLib/Soup/imports"),
    (re.compile(r"\bglobalThis\s*\[|\bwindow\s*\["), "computed access on globalThis"),
]


def parse_perm(perm):
    """-> (sorted list, error or None)"""
    if not isinstance(perm, list) or not perm or len(perm) > 8:
        return None, "perm must be a non-empty list (use [\"none\"] for no permissions)"
    if any(not isinstance(p, str) or not PERM_RE.match(p) for p in perm):
        return None, "perm entries must be: none | network | subprocess | fs-read:<path> | fs-write:<path>"
    if len(set(perm)) != len(perm):
        return None, "perm has duplicates"
    if "none" in perm and len(perm) > 1:
        return None, "perm: 'none' cannot be combined with other entries"
    for p in perm:
        if p.startswith("fs-") and (".." in p.split(":", 1)[1].split("/") or "//" in p):
            return None, f"perm path must not contain '..' or '//': {p}"
    return sorted(perm), None


def declared_classes(perm):
    got = {p.split(":", 1)[0] for p in perm} - {"none"}
    if "fs-write" in got:
        got.add("fs-read")           # being allowed to write includes reading
    return got


def scan(files):
    """files: iterable of (rel path, bytes). -> {'needed': {class: [why@file,...]}, 'rejected': [str]}"""
    needed, rejected = {}, []
    for rel, data in files:
        if not rel.endswith(".js"):
            continue
        text = data.decode("utf-8", "replace")
        for rx, why in REJECT:
            if rx.search(text):
                rejected.append(f"{rel}: {why}")
        for cls, rx, why in _RULES:
            if rx.search(text):
                needed.setdefault(cls, []).append(f"{why} ({rel})")
    return {"needed": needed, "rejected": rejected}


def compare(declared, report):
    """-> (errors, warnings). declared = validated perm list."""
    errs = [f"forbidden construct: {r}" for r in report["rejected"]]
    have = declared_classes(declared)
    for cls, why in sorted(report["needed"].items()):
        if cls not in have:
            errs.append(f"code needs '{cls}' but perm does not declare it - {why[0]}" + (f" (+{len(why) - 1} more)" if len(why) > 1 else ""))
    warns = [f"perm declares '{c}' but no matching code was found" for c in sorted(have - set(report["needed"]) - ({"fs-read"} if "fs-write" in have else set()))]
    return errs, warns
