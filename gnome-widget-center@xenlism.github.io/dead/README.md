# dead/

Files removed from active use, kept here instead of deleted outright so
they're recoverable if the "no importer anywhere" verdict below turns
out to be wrong. Mirrors the original relative path each file had
before being moved (`dead/lib/x.js` was `lib/x.js`, etc.).

None of these are imported, `require`d, or dynamically loaded by
anything in the live tree — confirmed by grepping the whole repo
(source, `metadata.json`, `.md`) for each file's exported class/const
name with zero hits outside the file itself. `tools/audit-layer-rules.js`
and `tools/lint-themeable.js` both only scan `widgets/`, so this folder
is invisible to them either way; `extension.js` only loads `lib/*.js`
via explicit named imports, never a directory scan, so nothing here can
be accidentally picked up at runtime.

## `dead/lib/`

| File | Superseded by | Why |
|---|---|---|
| `colorWheel.js` | `Gtk.ColorDialogButton` in `lib/prefsPageBuilders.js` (guide-color picker) | Custom Clutter/St color wheel; the actual color picker in the prefs UI is a native GTK widget instead. |
| `gridEngine.js` | `lib/layoutEngine.js`'s `LayoutEngine` | Same method set (`rectsOverlap`, `hasCollision`, `getAlignmentGuides`) under a different class name; `extension.js` imports `LayoutEngine`, never `GridEngine`. |
| `sizeConstraintManager.js` | `lib/blockSizeManager.js`'s `BlockSizeManager` | Reads a `size-constraints` metadata field that 0 of 63 widgets declare — all use `block-type` (the grid-based system) instead. |
| `widgetEditToolbar.js` | `lib/widgetEditMode.js`'s inline `_buildToolbar()` | Same on-screen edit-mode toolbar, rebuilt as a plain `St.Widget` directly in `widgetEditMode.js` rather than this standalone class. |
| `widgetManager.js` | `extension.js` (`_resetWidgetViaEditMode`/`_reloadWidget`) + `lib/widgetLoader.js`'s `reloadWidget()` + `lib/storageService.js`'s `resetWidgetSettings()` | Already flagged as dead code independently in `HANDOVER_2026-08-12-settings-defaults-and-reset-bug.md` — calls `this._settingsService.resetInstanceSettings()`, a method that doesn't exist anywhere in the repo, and has no constructor to set `this._settingsService`/`this._widgetLoader`/`this._widgetLayer` in the first place. |

## `dead/themepacks/`

| File | Why |
|---|---|
| `test-2.gwct`, `text-1.gwct` | Two exports of the same manual test of the theme-pack export flow, 29 seconds apart, byte-identical `appearance` data, no `id`/`name`/`packMeta`. `geek-half-moon.gwct` (a real, named pack) stayed in `themepacks/`. |

If a future session confirms one of these really is needed, move it
back to its original path and re-run `node tools/lint-themeable.js` +
`node tools/audit-layer-rules.js` to confirm nothing regressed.
