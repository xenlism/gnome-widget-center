"""gwc_sign.py - Ed25519 signing/verification of store.json (must match lib/store/signature.js).

Signed message = DOMAIN || raw bytes of store.json.   store.json.sig is JSON:
  {"alg":"ed25519","kid":"<key id>","sig":"<base64 64B>","pub":"<base64 32B>"}
`pub` is informational (lets a NEW third-party repo be pinned by fingerprint, TOFU). The official repo is
verified only against keys embedded in the client, never against this field.
"""
import base64, hashlib, json
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

DOMAIN = b"GWC-STORE-V2\x00"


def private_from_seed_b64(s: str) -> Ed25519PrivateKey:
    raw = base64.b64decode(s.strip(), validate=True)
    if len(raw) != 32:
        raise ValueError("signing key must be a base64 32-byte Ed25519 seed")
    return Ed25519PrivateKey.from_private_bytes(raw)


def public_b64(priv: Ed25519PrivateKey) -> str:
    raw = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(raw).decode()


def fingerprint(pub_b64: str) -> str:
    h = hashlib.sha256(base64.b64decode(pub_b64)).hexdigest()[:32].upper()
    return " ".join(h[i:i + 4] for i in range(0, 32, 4))


def sign_manifest(priv: Ed25519PrivateKey, kid: str, manifest: bytes) -> bytes:
    sig = priv.sign(DOMAIN + manifest)
    return json.dumps({"alg": "ed25519", "kid": kid, "sig": base64.b64encode(sig).decode(),
                       "pub": public_b64(priv)}, separators=(",", ":")).encode()


def verify_manifest(manifest: bytes, sig_file: bytes, trusted: dict) -> str:
    """trusted: {kid: pub_b64}. Returns kid or raises ValueError."""
    try:
        d = json.loads(sig_file)
        if d.get("alg") != "ed25519":
            raise ValueError("unsupported alg")
        pub_b64 = trusted.get(d["kid"])
        if not pub_b64:
            raise ValueError(f"unknown key id {d['kid']!r}")
        Ed25519PublicKey.from_public_bytes(base64.b64decode(pub_b64, validate=True)).verify(
            base64.b64decode(d["sig"], validate=True), DOMAIN + manifest)
        return d["kid"]
    except InvalidSignature:
        raise ValueError("signature does not match store.json") from None
    except (KeyError, TypeError, json.JSONDecodeError) as e:
        raise ValueError(f"malformed signature file: {e}") from None


# ---------------------------------------------------------------------------------------------------------------
# Per-package AUTHOR signatures (P3). The repo key vouches for the catalogue; the author key vouches for one package,
# so a hijacked repo/mirror (or a careless reviewer) cannot ship code under an author's name.
#
# Signed message = PKG_DOMAIN || id \0 version \0 entry \0 perm(sorted, ",") \0 td
#   td = tree digest = sha256 over the sorted lines  "<path>\0<sha256 hex of file>\n"  of every file in the package
# (must match lib/store/integrity.js treeDigest / packageMessage).
# ---------------------------------------------------------------------------------------------------------------
PKG_DOMAIN = b"GWC-PKG-V1\x00"


def tree_digest(files) -> str:
    """files: iterable of (relative posix path, bytes)"""
    lines = "".join(f"{p}\0{hashlib.sha256(b).hexdigest()}\n" for p, b in sorted(files, key=lambda x: x[0]))
    return hashlib.sha256(lines.encode("utf-8")).hexdigest()


def package_message(pid: str, version: str, entry: str, perm, td: str) -> bytes:
    return PKG_DOMAIN + "\0".join([pid, version, entry, ",".join(sorted(perm)), td]).encode("utf-8")


def sign_package(priv: Ed25519PrivateKey, message: bytes) -> str:
    return base64.b64encode(priv.sign(message)).decode()


def verify_package(sig_b64: str, pub_b64: str, message: bytes) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(pub_b64, validate=True)).verify(
            base64.b64decode(sig_b64, validate=True), message)
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def id_allowed(patterns, pid: str) -> bool:
    """author `ids`: exact id, or 'prefix.*' (matches ids that start with 'prefix.'). A bare '*' is never allowed."""
    for p in patterns or []:
        if p == pid or (p.endswith(".*") and len(p) > 2 and "*" not in p[:-1] and pid.startswith(p[:-1])):
            return True
    return False
