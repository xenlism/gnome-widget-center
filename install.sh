#!/usr/bin/env bash
# Install GNOME Widget Center for the current user.
set -euo pipefail

die() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
extension_dir="$script_dir/gnome-widget-center@xenlism.github.io"
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
