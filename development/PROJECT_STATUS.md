# Project status

Last reviewed: 2026-08-28

## Release state

GNOME Widget Center is a **pre-release** GNOME Shell extension: it has been
submitted to [extensions.gnome.org](https://extensions.gnome.org/) (EGO) and
is currently awaiting review. It is packaged as
`gnome-widget-center@xenlism.github.io` and `metadata.json` declares support
for **GNOME Shell 50**.

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

## Latest manual test pass

Daily hands-on testing on real GNOME Shell hardware (not via Claude Code —
manual use of the built extension), most recent round:

| Area | Result |
| --- | --- |
| Multi-monitor | Not exercised this round — still unverified. |
| Drag-and-drop (quick Super+drag, outside Edit Mode) | **Bug found and fixed**: `prevent-widget-overlap` was silently ignored for this drag path — a widget could be dropped directly on top of another. Edit Mode's drag already enforced this correctly; the quick-drag path now uses the same collision check. |
| Edit Mode | Works well. |
| Backup / restore | Works well. |
| Theme Pack export — screenshot | **Bug found and fixed**: the screenshot was embedded into the exported `.gwct` at its original captured/chosen resolution instead of being downsized first, bloating the file. It is now resized and center-cropped to a fixed 460×270 before being base64-encoded into the export. |

Still needed: a real multi-monitor test pass, and a follow-up check that the
quick-drag fix behaves the same as Edit Mode's collision handling across
multiple monitors once that pass happens.

## EGO-X-004 (synchronous file IO) — now fully resolved

The last open item — `widgets/xtile/widget.js` and
`widgets/geek-architect/widget.js` reading `metadata.json` synchronously in
their constructors — is closed via an opt-in async factory
(`static createInstance()`) that `lib/shell/widgetRuntimeLoader.js` calls
instead of `new` when a widget defines it. No other bundled widget was
touched. See `EGO.md` for the detail. **Not yet smoke-tested on real GNOME
Shell hardware** — needs: adding `xtile`/`geek-architect` to the desktop,
confirming "Add child" shows correctly on the parent only, and confirming
dev-mode hot-reload still works for both.
