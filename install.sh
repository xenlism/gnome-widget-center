#!/usr/bin/env bash
# Install (or update) GNOME Widget Center for the current user.
#
# Works three ways:
#
#   1) From a cloned/extracted copy of this repo:
#        ./install.sh
#
#   2) One-liner (downloads the repo automatically):
#        curl -fsSL https://raw.githubusercontent.com/xenlism/gnome-widget-center/main/install.sh | bash
#        wget -qO- https://raw.githubusercontent.com/xenlism/gnome-widget-center/main/install.sh | bash
#
#   3) git clone yourself, then run the script from inside the clone:
#        git clone https://github.com/xenlism/gnome-widget-center.git
#        cd gnome-widget-center
#        ./install.sh
#
# Override GWC_REPO_URL / GWC_BRANCH to install from a fork or another branch.
set -euo pipefail

REPO_URL="${GWC_REPO_URL:-https://github.com/xenlism/gnome-widget-center.git}"
REPO_BRANCH="${GWC_BRANCH:-main}"
REPO_TARBALL_URL="https://github.com/xenlism/gnome-widget-center/archive/refs/heads/${REPO_BRANCH}.tar.gz"

die() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

tmp_dir=""
cleanup() {
    [ -n "$tmp_dir" ] && rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

# If this script is sitting inside a real, on-disk copy of the repo (a git
# clone or an extracted release archive), install straight from there. When
# it's piped in from curl/wget instead, BASH_SOURCE won't point at a regular
# file, so we fall through to fetching a fresh copy below.
script_dir=""
if [ -n "${BASH_SOURCE:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fi

extension_dir=""
if [ -n "$script_dir" ] && [ -f "$script_dir/gnome-widget-center@xenlism.github.io/metadata.json" ]; then
    extension_dir="$script_dir/gnome-widget-center@xenlism.github.io"
fi

if [ -z "$extension_dir" ]; then
    printf 'Fetching GNOME Widget Center (%s) from %s...\n' "$REPO_BRANCH" "$REPO_URL"
    tmp_dir="$(mktemp -d)"
    source_root=""

    if command -v git >/dev/null 2>&1; then
        if git clone --depth 1 --branch "$REPO_BRANCH" -- "$REPO_URL" "$tmp_dir/repo" 2>/dev/null; then
            source_root="$tmp_dir/repo"
        else
            printf 'git clone failed, falling back to a direct download...\n' >&2
        fi
    fi

    if [ -z "$source_root" ]; then
        command -v tar >/dev/null 2>&1 || die "tar is required to unpack the downloaded archive"
        archive="$tmp_dir/gnome-widget-center.tar.gz"
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL -o "$archive" "$REPO_TARBALL_URL" || die "download failed: $REPO_TARBALL_URL"
        elif command -v wget >/dev/null 2>&1; then
            wget -qO "$archive" "$REPO_TARBALL_URL" || die "download failed: $REPO_TARBALL_URL"
        else
            die "git, curl, or wget is required to install remotely"
        fi
        mkdir -p "$tmp_dir/repo"
        tar -xzf "$archive" -C "$tmp_dir/repo" --strip-components=1 || die "failed to extract archive"
        source_root="$tmp_dir/repo"
    fi

    extension_dir="$source_root/gnome-widget-center@xenlism.github.io"
fi

metadata="$extension_dir/metadata.json"
[ -f "$metadata" ] || die "metadata.json was not found in $extension_dir"

uuid="$(sed -nE 's/^[[:space:]]*"uuid"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$metadata" | head -n 1)"
case "$uuid" in
    ''|*[!A-Za-z0-9@._-]*) die "metadata.json contains an unsafe or missing UUID" ;;
esac

target_root="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
target_dir="$target_root/$uuid"

mkdir -p "$target_root"
if [ -e "$target_dir" ]; then
    backup_dir="$target_dir.backup-$(date +%Y%m%d-%H%M%S)"
    mv -- "$target_dir" "$backup_dir"
    printf 'Existing installation moved to: %s\n' "$backup_dir"
fi

mkdir -p "$target_dir"
cp -a "$extension_dir/." "$target_dir/"

if [ -f "$target_dir/schemas/org.gnome.shell.extensions.widget-center.gschema.xml" ]; then
    command -v glib-compile-schemas >/dev/null 2>&1 || die "glib-compile-schemas is required"
    glib-compile-schemas "$target_dir/schemas"
fi

printf 'Installed %s to %s\n' "$uuid" "$target_dir"
if command -v gnome-extensions >/dev/null 2>&1; then
    if gnome-extensions enable "$uuid"; then
        printf 'Extension enabled.\n'
    else
        printf 'Installed, but could not enable it automatically. Enable it in GNOME Extensions.\n' >&2
    fi
else
    printf 'Installed. Enable it in GNOME Extensions after signing in to GNOME Shell.\n'
fi

printf 'On Wayland, log out and back in if the extension does not appear immediately.\n'
