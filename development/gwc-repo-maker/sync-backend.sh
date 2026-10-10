#!/bin/sh
# Refresh the bundled backend (backend/tools) from a gwc-store checkout.  Usage: ./sync-backend.sh [path/to/gwc-store]
# The app creates new repositories from this copy and uses it for repositories that have no tools/ of their own.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
STORE="${1:-${GWC_STORE_DIR:-$HERE/../gwc-store}}"
[ -f "$STORE/tools/gwc_repo.py" ] || { echo "no gwc-store/tools at $STORE (pass the path as the first argument)" >&2; exit 1; }
rm -rf "$HERE/backend/tools"; mkdir -p "$HERE/backend"
cp -r "$STORE/tools" "$HERE/backend/tools"
find "$HERE/backend" -name __pycache__ -prune -exec rm -rf {} +
echo "backend synced from $STORE/tools"
