# Project status

Last reviewed: 2026-08-11

## Release state

GNOME Widget Center is an **alpha / preview** GNOME Shell extension. It is
packaged as `gnome-widget-center@xenlism.github.io` and `metadata.json`
declares support for **GNOME Shell 50**.

The archive includes the extension entry points (`extension.js` and
`prefs.js`), its compiled GSettings schema, bundled widgets, translations,
themes, backup/restore code, and the widget API reference.

## Included capabilities

- Desktop widget discovery, loading, placement, and management.
- Preferences / Control Center and per-widget configuration.
- Edit mode, drag-and-drop, grid and layout helpers.
- Multi-monitor and settings-watch support.
- Bundled widgets, themes, and localization resources.
- Theme export/import and password-protected backup/restore implementation.

## Verification boundary

The source archive contains implementation work for these capabilities, but
it is not a production release. Clean-session testing on real GNOME Shell 50
hardware remains necessary, including enable/disable, preferences, widgets,
multi-monitor behavior, and backup/restore.

Report defects with the installed GNOME Shell version, session type
(Wayland/Xorg), distribution, and relevant `journalctl` output.
