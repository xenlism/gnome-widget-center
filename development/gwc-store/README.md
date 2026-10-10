# gwc-store

The **store repository** for GNOME Widget Center: widgets (`widgets/<id>/`), theme packs (`themepacks/*.gwct`), the
build/signing tools (`tools/`) and the GitHub Pages workflow (`.github/`). It is published as a static site; the
Widget Center client (`gwc-client`, `lib/store/` in the extension) downloads, verifies and installs from it.

It is a separate project from the extension (`gnome-widget-center@xenlism.github.io`) and from the GTK app that edits
a store (`gwc-repo-maker`).

## Layout
| Path | What |
| --- | --- |
| `store.config.json` | id, name, public URL, tier, mirrors, signing trust (`signKid`, `keys`) |
| `catalogs.json` | widget / theme-pack categories |
| `authors.json`, `revoked.json` | authors allowed to sign widgets; withdrawn versions |
| `widgets/`, `themepacks/` | the content |
| `tools/` | `build_store.py`, `verify_store.py`, `gwc_repo.py` (maintenance CLI, JSON output), `gwc_sign.py`, `gwc_keygen.py`, `perm_scan.py` |
| `tools/template/` | what `gwc_repo.py init` copies into a new store |
| `.github/workflows/` | `pr-check.yml` (build + verify on pull requests), `pages.yml` (sign + publish on push to `main`) |
| `tests/` | Python tests (`python3 -m unittest discover -s tests`) |

## Common tasks
```sh
pip install -r tools/requirements.txt

python3 tools/gwc_repo.py status                       # what is in the store and what is wrong with it
python3 tools/gwc_repo.py scan-source ~/my-extension   # widgets/theme packs that could be imported from a folder
python3 tools/gwc_repo.py import-widget DIR_OR.gwcw    # import (same checks as the build)
python3 tools/gwc_repo.py author-keygen --kid me-1     # author key -> ~/.config/gwc-repo-maker/keys/me-1.key
python3 tools/gwc_repo.py import-key FILE --kid me-1   # bring an existing private key file into the key folder
python3 tools/gwc_repo.py list-keys                    # keys on this computer, with fingerprints
python3 tools/gwc_repo.py sign-widget me.clock --kid me-1

python3 tools/build_store.py --out dist --unsigned     # preview build
GWC_SIGNING_KEY=<seed> python3 tools/build_store.py --out dist --first-publish
python3 tools/verify_store.py dist --config store.config.json
```
Prefer a GUI? Use **gwc-repo-maker**: it has *Browse…* buttons for folders and key files and *Generate key* buttons,
and runs exactly these tools.

## Widget package format (`.gwcw`, `.gwcp`)
A widget is published as a **`.gwcw`**: JSON with the readable `metadata` first, then the `package`. Two versions:

| | version 1 (zip up to 4 MiB, up to 16 MiB unpacked) | version 2 (zip up to 64 MiB, up to 128 MiB unpacked) |
| --- | --- | --- |
| files | one `w/<id>.<hash>.gwcw` | `w/<id>.<hash>.gwcw` + `w/<id>.<hash>.gwcp` |
| `package` | `{"encoding":"zip+base64","size","sha256","files","data":"<base64 of the zip>"}` | `{"encoding":"zip","file":"<name>.gwcp","size","sha256","files"}`, no `data` |
| `.gwcp` | none | the widget folder as a **raw zip** (no base64: ~34% smaller) |
| listing item | `f`, `s`, `h` (the `.gwcw`) | `f`, `s`, `h` (the small `.gwcw`) **plus** `z`, `zs`, `zh` (the `.gwcp`: path, size, 128-bit hash) |

`build_store.py` picks version 2 automatically when the zip is over 4 MiB **or** the widget unpacks to more than 16 MiB, so
small widgets stay byte-for-byte what they were and old clients keep working with them. Per-file limit 16 MiB, at most 200
files, no file may compress more than 200x (the client refuses such files as zip bombs, so the build refuses them first).
The extension allow-list is unchanged.

Trust chain: store signature -> shard hash -> `s`/`h` of the `.gwcw` and `zs`/`zh` of the `.gwcp` -> `sha256` inside the
`.gwcw` -> tree digest `td` of the unpacked files, which an author signature covers. A client that only knows version 1 stops at
the `.gwcw` with "Not a .gwcw v1 file" for that one widget; nothing else in the store is affected.
A version 2 `.gwcw` opened **from a file** needs its `.gwcp` in the same folder (`import-widget` and the client both look for the
name in `package.file`).

## Keys
Keys are **Ed25519** signing keys, not PGP. The private half is a 32-byte seed kept outside the repository
(`~/.config/gwc-repo-maker/keys`, mode 0600; in CI it is the `GWC_SIGNING_KEY` secret of the `store-publish` environment).
Only public keys and fingerprints go into `store.config.json` / `authors.json`.

## Keeping `gwc-repo-maker` in step
`gwc-repo-maker/backend/tools` is a copy of this repository's `tools/`. After changing `tools/` run
`gwc-repo-maker/sync-backend.sh path/to/gwc-store`; a test fails if the two drift apart (when the apps sit side by side).

License: GPL-3.0 (see `LICENSE`).
