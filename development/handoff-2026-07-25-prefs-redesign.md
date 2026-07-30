# Handoff — 2026-07-25 session: Control Center redesign (Overview/Preferences concept)

Scope: implement, for real, the Overview + Preferences pages from a
provided UI concept (Overview/Store/Preferences mockup — a generic
Electron-style desktop app), explicitly **excluding the Store section**
per instructions. Target was the actual GTK4/libadwaita prefs.js Control
Center, not a prototype.

## Concept → real extension: the adaptations made

The concept mockup imagines a standalone desktop app with its own window
chrome (Overview / Store / Preferences tabs). This extension's real
equivalent is a single `Adw.PreferencesWindow` with a page switcher —
there's no separate "Preferences" tab distinct from "Overview", because
they're already both pages in the same window. So:

- The existing widget-list page (was titled "Widgets") is renamed
  **"Overview"** to match the concept's naming — it already had the
  concept's per-widget Enable toggle + Settings button; adding Uninstall
  to this list (concept's Overview cards have one) was deliberately
  **not** done this session — prefs.js has no established pattern for
  triggering a file-deleting uninstall from the separate GTK process
  (that logic lives in extension.js's `_uninstallWidget()`, Shell-process
  only, wired from Edit Mode). Flagging as a known gap, not silently
  dropped.
- Store: skipped entirely per instructions — this Control Center has no
  widget marketplace, only local bundled/user-folder discovery.
- Concept's General section listed "Start with GNOME" and update-check
  toggles that don't apply to a Shell extension (it always loads with
  GNOME Shell; there's no separate update channel outside
  extensions.gnome.org) — omitted rather than faked. Only "Enable
  animations" (which the concept's own screenshot shows in General) is
  real and kept.
- Concept's "Grid Size: 8x8" (a grid *dimension*) was reinterpreted as
  **Grid Cell Size in px** — that's what `GridEngine` actually has a
  concept of; there's no fixed-dimension grid anywhere in this codebase.

## New GSettings keys (`schemas/*.gschema.xml`)

`enable-animations` (b, default true), `confirm-before-remove` (b,
default true), `widget-spacing` (i, 0–64, default 16), `desktop-margin`
(i, 0–128, default 16), `snap-to-grid` (b, default true), `grid-cell-size`
(i, 4–64, default 16). Compiles clean with `glib-compile-schemas
--strict`. All live-synced cross-process the same way
`disabled-widgets`/`dev-mode` already are.

## `lib/gridEngine.js`

`GridEngine` constructor now takes `(cellSize, {snapEnabled, spacing,
margin})`, all optional, all backward-compatible defaults. New live
setters: `setCellSize()`, `setSnapEnabled()`, `setSpacing()`,
`setMargin()`.

- `snap()`/`snapPoint()` pass the value through unchanged when
  `snapEnabled` is false — collision-avoidance ring-walking in
  `findNearestFreeCell()` is unaffected (it's a search step size, not a
  visual snap).
- `hasCollision()` inflates the candidate rect by `spacing / 2` on each
  side before the overlap test — this is how "Widget Spacing" actually
  keeps widgets apart, not a separate padding check.
- `_clampToBounds()` insets the placement area by `margin` on all sides.

No existing tests reference `GridEngine` by name (searched the whole
repo) so nothing to update there, but worth adding real unit tests for
the three new behaviors next session — none written this session
(time-boxed out).

## `extension.js`

`enable()` now reads all six new keys up front (same "read now, watch
below" pattern as `disabled-widgets`/`dev-mode`), constructs
`this._grid = new GridEngine(cellSize, {snapEnabled, spacing, margin})`
instead of the old bare `new GridEngine()`, and stores
`this._animationsEnabled` / `this._confirmBeforeRemove` as plain fields.
Six new `SettingsService.onChanged()` watchers keep all of this live;
six matching `disconnect()` calls added to `disable()` (looped over a
field-name array rather than six repeated blocks).

`WidgetEditMode` now gets two extra callbacks: `getAnimationsEnabled`
and `getConfirmBeforeRemove`, both closures reading the live fields
above (not values captured once). `EditModeDragController`'s constructor
gained a 6th param, `getAnimationsEnabled`, same pattern.

## `lib/editModeDragController.js`

Drop-settle `ease()` duration is `getAnimationsEnabled() ? 120 : 0` —
both the front actor's persisted-position ease and the back actor's
visual-feedback ease.

## `lib/widgetEditMode.js` — Remove button real rework

Went with an **arm-then-confirm pattern on the button itself** instead of
a modal confirmation dialog. Reasoning: this codebase has zero prior art
for a GTK/Adw-style modal in the Shell (St/Clutter) process — building
one from scratch, untested on real hardware, felt like exactly the kind
of thing that's caused the repeated real-hardware bug rounds already
documented in this file's history (2026-07-19/07-21 flip/toolbar bugs).
The arm/confirm pattern reuses only actor state this file already
manages.

- First click (when `getConfirmBeforeRemove()` is true): icon swaps
  `window-close-symbolic` → `dialog-warning-symbolic`, a
  `widget-edit-mode-action-remove-armed` CSS class is added (amber,
  `stylesheet.css`), tooltip text becomes "Click again to remove"
  (`_attachTooltip()` was extended to accept a `()=>string` getter, not
  just a static string, for this), and a 3s `GLib.timeout_add` auto-
  reverts if there's no second click.
- Second click while armed: actually calls `_onRemove(widgetId)`.
- `getConfirmBeforeRemove() === false`: single click removes immediately,
  old behavior, unchanged.
- `_hideToolbar()` now calls `entry.disarmRemove?.()` first — leaving
  Edit Mode (ESC, right-click again, drag start) always cancels a
  pending confirm rather than leaving it silently armed for next time.

Toolbar show/hide fade duration also gated: `getAnimationsEnabled() ?
TOOLBAR_FADE_MS : 0`.

## `lib/storageService.js` / `lib/themeService.js` — small additions

- `StorageService.listWidgetSettingsIds()` — enumerates `widgets/*.json`
  and returns the ids, for Backup/Export to discover every widget
  without needing `PrefsWidgetList`'s discovery pass.
- `ThemeService.getRawConfig()` — the whole `{global, widgets}` payload
  in one call, for a full backup (existing getters were per-widget/
  global-only, would've missed a `theme.json` entry for a widget that's
  no longer installed).

## New: `lib/backupService.js`

Pure logic, no Gtk — `BackupService(storage, theme, settings)` with four
methods: `buildFullBackup()` / `restoreFullBackup()` (everything:
`GLOBAL_SETTINGS_KEYS` list of GSettings keys + theme.json + layout.json
+ every widget's settings) and `buildWidgetsExport()` /
`restoreWidgetsExport()` (layout + widget settings only, no theme/global
prefs — this is the Import/Export page's narrower scope, kept
deliberately separate from Backup & Restore rather than one
"export everything" button). Both restore paths are best-effort per
section (one bad section doesn't abort the rest) and return `{ok,
errors}`.

Restoring is pure file/dconf writes — a widget already running in the
Shell process picks most of it up live via the same channels every
other cross-process write in this codebase already uses
(`settingsWatcher.js`, `themeService.js`'s `watch()`,
`SettingsService.onChanged()`), nothing in `backupService.js` needs to
talk to the Shell process directly.

## `prefs.js` — full page lineup

Order now matches the concept sidebar minus Store:
**Overview** (renamed from Widgets) → **General** → **Appearance**
(unchanged) → **Desktop** → **Interactions** → **Backup & Restore** →
**Import / Export** → **Advanced** (unchanged) → **About**.

Two small shared helpers added, `_buildSwitchRow()`/`_buildSpinRow()`,
so General/Desktop/Interactions don't each hand-roll the same
isReady-guard/try-catch every existing write-straight-through row in
this file already uses (`_buildAdvancedPage()`'s dev-mode row was left
as its own hand-written version, unchanged, to avoid touching working
code for a pure DRY pass this session).

Backup & Restore / Import-Export pages use `Gtk.FileDialog` (`.save()`/
`.open()`, callback not promise — same pattern `lib/widgetConfigUI.js`'s
`_pathRow()` Browse… button already established) plus a `.json` filter,
and write status into a plain `Adw.ActionRow` subtitle rather than a
modal/toast (avoided libadwaita-version-specific `Adw.AlertDialog`/
`Adw.Toast` APIs — this window has no `ToastOverlay` set up, and I didn't
want to guess at a libadwaita version this session).

About page reads `this.metadata` (name/version/description/url) —
zero hand-duplicated info.

## Not done / next session

- **Real hardware verification** — nothing in this session has been run
  on an actual GNOME Shell. Everything was `node --check`ed for syntax
  and the schema was `glib-compile-schemas --strict`ed, but the GTK4
  widget tree (Backup & Restore/Import-Export pages especially — new
  `Gtk.FileDialog` usage, new `Adw.SpinRow`/`Adw.SwitchRow` combos) needs
  a real run.
- **Overview page's missing Uninstall button** (see "adaptations" above)
  — deliberately deferred, not forgotten.
- **No unit tests** were added for `GridEngine`'s three new behaviors
  (`setSpacing`'s collision inflation, `setMargin`'s clamp inset,
  `setSnapEnabled(false)`'s pass-through) or for `BackupService`. Given
  `gridEngine.js`'s existing "pure geometry, unit-testable" design goal,
  these should be quick to add and are the highest-value next step.
- `_buildAdvancedPage()`'s dev-mode row was intentionally left
  unrefactored (see above) — could be migrated to `_buildSwitchRow()` for
  consistency in a later cleanup-only pass.
