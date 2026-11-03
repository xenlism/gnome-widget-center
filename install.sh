#!/usr/bin/env bash
# Install (or update) GNOME Widget Center for the current user.
#
#   1) From a cloned/extracted copy of this repo:   bash install.sh
#   2) One-liner:
#        curl -fsSL https://raw.githubusercontent.com/xenlism/gnome-widget-center/main/install.sh | bash
#   3) git clone, then run the script from inside the clone.
#
# Override GWC_REPO_URL / GWC_BRANCH to install from a fork or another branch.
set -euo pipefail

REPO_URL="${GWC_REPO_URL:-https://github.com/xenlism/gnome-widget-center.git}"
REPO_BRANCH="${GWC_BRANCH:-main}"
REPO_TARBALL_URL="https://github.com/xenlism/gnome-widget-center/archive/refs/heads/${REPO_BRANCH}.tar.gz"
EXT_DIRNAME="gnome-widget-center@xenlism.github.io"

die() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

tmp_dir=""
cleanup() {
    if [ -n "$tmp_dir" ]; then
        rm -rf -- "$tmp_dir"
    fi
}
trap cleanup EXIT

# Print the extension directory found under $1 (the one holding metadata.json).
# Tries the expected folder name first, then searches a few levels down so a
# repo layout change does not break the installer.
find_extension_dir() {
    local root="$1" m=""
    if [ -f "$root/$EXT_DIRNAME/metadata.json" ]; then
        printf '%s\n' "$root/$EXT_DIRNAME"
        return 0
    fi
    m="$(find "$root" -maxdepth 4 -type f -name metadata.json -path '*@*/metadata.json' 2>/dev/null | head -n 1 || true)"
    if [ -n "$m" ]; then
        dirname -- "$m"
        return 0
    fi
    return 1
}

# Use the on-disk copy when the script sits inside a clone / extracted archive.
# When piped from curl/wget BASH_SOURCE is empty, so we fetch a fresh copy.
script_dir=""
if [ -n "${BASH_SOURCE:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fi

extension_dir=""
if [ -n "$script_dir" ]; then
    extension_dir="$(find_extension_dir "$script_dir" || true)"
fi

if [ -z "$extension_dir" ]; then
    printf 'Fetching GNOME Widget Center (%s) from %s...\n' "$REPO_BRANCH" "$REPO_URL"
    tmp_dir="$(mktemp -d)"
    source_root=""

    if command -v git >/dev/null 2>&1; then
        # GIT_TERMINAL_PROMPT=0: never hang asking for credentials (e.g. when piped).
        if GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch "$REPO_BRANCH" -- "$REPO_URL" "$tmp_dir/repo"; then
            source_root="$tmp_dir/repo"
        else
            printf 'git clone failed (see message above), falling back to a direct download...\n' >&2
            rm -rf -- "$tmp_dir/repo"
        fi
    fi

    if [ -z "$source_root" ]; then
        command -v tar >/dev/null 2>&1 || die "tar is required to unpack the downloaded archive"
        archive="$tmp_dir/gnome-widget-center.tar.gz"
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL -o "$archive" "$REPO_TARBALL_URL" || die "download failed: $REPO_TARBALL_URL (check GWC_BRANCH and your network)"
        elif command -v wget >/dev/null 2>&1; then
            wget -qO "$archive" "$REPO_TARBALL_URL" || die "download failed: $REPO_TARBALL_URL (check GWC_BRANCH and your network)"
        else
            die "git, curl, or wget is required to install remotely"
        fi
        mkdir -p "$tmp_dir/repo"
        tar -xzf "$archive" -C "$tmp_dir/repo" --strip-components=1 || die "failed to extract archive"
        source_root="$tmp_dir/repo"
    fi

    extension_dir="$(find_extension_dir "$source_root" || true)"
    [ -n "$extension_dir" ] || die "could not find the extension (metadata.json) inside the downloaded repository"
fi

metadata="$extension_dir/metadata.json"
[ -f "$metadata" ] || die "metadata.json was not found in $extension_dir"

# grep -o works whether metadata.json is pretty-printed or minified on one line.
uuid="$(grep -o '"uuid"[[:space:]]*:[[:space:]]*"[^"]*"' "$metadata" | head -n 1 | sed -E 's/.*:[[:space:]]*"([^"]*)"$/\1/' || true)"
case "$uuid" in
    ''|*[!A-Za-z0-9@._-]*) die "metadata.json contains an unsafe or missing UUID" ;;
esac

data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
target_root="$data_home/gnome-shell/extensions"
target_dir="$target_root/$uuid"

mkdir -p "$target_root"
if [ -e "$target_dir" ]; then
    # Keep backups OUTSIDE the extensions folder: GNOME Shell scans every
    # folder there and complains when a folder name does not match its uuid.
    backup_root="$data_home/gnome-widget-center-backups"
    mkdir -p "$backup_root"
    backup_dir="$backup_root/$uuid.backup-$(date +%Y%m%d-%H%M%S)"
    mv -- "$target_dir" "$backup_dir"
    printf 'Existing installation moved to: %s\n' "$backup_dir"
fi

mkdir -p "$target_dir"
cp -a "$extension_dir/." "$target_dir/"

# Compile whatever schema files ship with the extension (any file name).
if [ -d "$target_dir/schemas" ] && compgen -G "$target_dir/schemas/*.gschema.xml" >/dev/null; then
    command -v glib-compile-schemas >/dev/null 2>&1 || die "glib-compile-schemas is required (package: libglib2.0-bin / glib2)"
    glib-compile-schemas "$target_dir/schemas"
fi

printf 'Installed %s to %s\n' "$uuid" "$target_dir"
if command -v gnome-extensions >/dev/null 2>&1; then
    if gnome-extensions enable "$uuid" 2>/dev/null; then
        printf 'Extension enabled.\n'
    else
        printf 'Installed, but GNOME Shell has not picked it up yet. Log out and back in, then run: gnome-extensions enable %s\n' "$uuid" >&2
    fi
else
    printf 'Installed. Enable it in GNOME Extensions after signing in to GNOME Shell.\n'
fi

printf 'On Wayland, log out and back in if the extension does not appear immediately.\n'
