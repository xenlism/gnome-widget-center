#!/bin/sh
# Per-user install: a launcher in ~/.local/bin and a desktop entry that points at this folder. Uninstall: delete both files.
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"

# Python dependencies of backend/tools: `cryptography` is required (Ed25519 keys), Pillow is optional (generated covers).
# They go into a private virtualenv (.venv inside this folder) that the app uses automatically, so system pip is not needed
# and "externally-managed-environment" errors do not apply. Nothing outside this folder is touched.
PYBIN="$(command -v python3 || true)"
[ -n "$PYBIN" ] || { echo "python3 not found: install it first (e.g. sudo apt install python3)" >&2; exit 1; }
if "$DIR/.venv/bin/python3" -c "import cryptography" >/dev/null 2>&1; then
    echo "Python dependencies already present (.venv)"; PYBIN="$DIR/.venv/bin/python3"
elif "$PYBIN" -c "import cryptography" >/dev/null 2>&1; then
    echo "Python dependencies already present (system)"
else
    echo "creating $DIR/.venv and installing Python dependencies ..."
    if rm -rf "$DIR/.venv" && "$PYBIN" -m venv "$DIR/.venv" && "$DIR/.venv/bin/python3" -m pip install -r "$DIR/backend/tools/requirements.txt"; then
        PYBIN="$DIR/.venv/bin/python3"
    else
        rm -rf "$DIR/.venv"
        echo "Could not set up a virtualenv (no network, or the venv module is missing)." >&2
        echo "Install the system packages instead, then run ./install.sh again:" >&2
        echo "  Debian/Ubuntu: sudo apt install python3-venv python3-cryptography python3-pil" >&2
        echo "  Fedora:        sudo dnf install python3-cryptography python3-pillow" >&2
        echo "  Arch:          sudo pacman -S python-cryptography python-pillow" >&2
        exit 1
    fi
fi
"$PYBIN" -c "import PIL" >/dev/null 2>&1 || echo "note: Pillow is not installed; widget covers will not be generated automatically (optional)"
BIN="${XDG_DATA_HOME:-$HOME/.local/share}/../bin"; mkdir -p "$BIN"; BIN="$(cd "$BIN" && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"; mkdir -p "$APPS"
ln -sf "$DIR/bin/gwc-repo-maker" "$BIN/gwc-repo-maker"
sed "s|^Exec=.*|Exec=$DIR/bin/gwc-repo-maker|" "$DIR/data/io.github.xenlism.GwcRepoMaker.desktop" > "$APPS/io.github.xenlism.GwcRepoMaker.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" || true
echo "installed: $BIN/gwc-repo-maker and $APPS/io.github.xenlism.GwcRepoMaker.desktop"
