#!/bin/sh
# Registers .gwcw / .gwct file types and the gwc:// URL scheme for the current user.
# Usage: ./install-handlers.sh /path/to/gnome-widget-center@xenlism.github.io
set -eu
EXT_DIR="$(cd "${1:?extension dir}" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
MIME="${XDG_DATA_HOME:-$HOME/.local/share}/mime"
mkdir -p "$APPS" "$MIME/packages"

sed "s|@EXT_DIR@|$EXT_DIR|g" "$HERE/io.github.xenlism.WidgetCenterPrefs.desktop.in" \
  > "$APPS/io.github.xenlism.WidgetCenterPrefs.desktop"
cp "$HERE/io.github.xenlism.WidgetCenter-mime.xml" "$MIME/packages/"

command -v update-mime-database    >/dev/null && update-mime-database "$MIME"
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS"
for t in application/x-gwcw application/x-gwct x-scheme-handler/gwc; do
  xdg-mime default io.github.xenlism.WidgetCenterPrefs.desktop "$t"
done
echo "OK: .gwcw .gwct gwc:// -> GNOME Widget Center"
