#!/bin/sh
# Runs the real-GJS tests against a temp copy of lib/ with the host extension's apiVersion.js replaced by a stub.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"
mkdir -p "$T/lib" "$T/tests/gjs"
cp -rL "$HERE/../../lib/store" "$HERE/../../lib/vendor" "$T/lib/"      # -L: lib/store and lib/vendor are symlinks into the extension
cp "$HERE/../host-stubs/apiVersion.js" "$T/lib/apiVersion.js"
cp "$HERE"/*.test.js "$T/tests/gjs/"
for f in "$T"/tests/gjs/*.test.js; do echo "== $(basename "$f")"; gjs -m "$f"; done
rm -rf "$T"
