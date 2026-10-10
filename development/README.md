# Development notes

This directory intentionally contains only the current project status.

The previous task plans, handoff notes, placeholder specifications, and
architecture documents were removed because they described an older
`products/extension/` layout. The extension shipped in this archive lives at
the repository root in `gnome-widget-center@xenlism.github.io/`.

For the extension metadata and supported GNOME Shell version, see
`../gnome-widget-center@xenlism.github.io/metadata.json`. For the widget API,
see `../gnome-widget-center@xenlism.github.io/WIDGET_API.md`.

## Projects under `development/`
- `gwc-store/` - the store repository (widgets, theme packs, build/sign tools, CI). Python tests: `cd gwc-store && python3 -m unittest discover -s tests`.
- `gwc-repo-maker/` - the GTK4/libadwaita app that edits a store. Its `backend/tools` is a copy of `gwc-store/tools`
  (`gwc-repo-maker/sync-backend.sh ../gwc-store`); a test in `gwc-store` fails when they drift.
- `gwc-client/` - Node tests for the extension's `lib/store`.
