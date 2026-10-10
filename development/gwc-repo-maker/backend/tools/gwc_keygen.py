#!/usr/bin/env python3
"""Generate an Ed25519 store signing key.

  python tools/gwc_keygen.py --kid gwc-2026-a [--out signing-key.b64]

Prints the PUBLIC key (put it in store.config.json "trust.keys" AND in the client's official key list) and
either writes the private seed to --out (mode 0600) or prints it once. The private seed must NEVER be
committed: store it as the GWC_SIGNING_KEY secret of a protected GitHub Environment (or on an offline machine).
"""
import argparse, base64, os, sys
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
sys.path.insert(0, os.path.dirname(__file__))
import gwc_sign


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kid", required=True)
    ap.add_argument("--out")
    a = ap.parse_args()
    priv = Ed25519PrivateKey.generate()
    seed = base64.b64encode(priv.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                               serialization.NoEncryption())).decode()
    pub = gwc_sign.public_b64(priv)
    print(f'public key (commit this):\n  {{ "kid": "{a.kid}", "pub": "{pub}" }}\nfingerprint: {gwc_sign.fingerprint(pub)}')
    if a.out:
        fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(seed + "\n")
        print(f"private seed written to {a.out} (0600). Keep it out of git.")
    else:
        print(f"private seed (shown once, store as secret GWC_SIGNING_KEY):\n  {seed}")


if __name__ == "__main__":
    main()
