## gwc-store completed, gwc-repo-maker: Browse / Generate key

- **gwc-store:** `tools/` brought up to date (`gwc_repo.py` gained `scan-source`, `list-keys`, `export-key`, `import-key`); added `README.md`, `LICENSE`, `.gitignore`; Python tests for the new commands (84 total). `gwc-repo-maker` now sits in `development/` next to it, so the backend-in-sync test runs instead of being skipped.
- **gwc-repo-maker:** forms can carry **Browse…** and **Generate key / Suggest** buttons. New repository: folder picker in the form, unused signing key id suggested. Add author: browse a `.pub.json` or generate an author key. Sign as author: generate a key when none exists. Keys dialog: **Import…** an existing private key file (`import-key`, never overwrites, mode 0600).
- **gwc-repo-maker fix:** rows no longer parse their text as Pango markup (the publish steps showed GTK warnings and lost text such as `<key>`).

## 2.0.0

### Block types: 1x1 to 6x6
- `BLOCK_TYPES` now has every `<W>x<H>` from `1x1` to `6x6` (36 names, a tier `n` is `12n - 1` cells) plus `barx1`-`barx4`. The `{cols, rows}` object form of `block-type` is no longer accepted (unknown values resolve to `1x1`). Docs: WIDGET_API.md §2, CONTRIBUTING.md, docs/CREATING_WIDGETS.md.

### Rounded background blur
- Card blur uses `gi://Blur` ([gnome-rounded-blur](https://github.com/kancko/gnome-rounded-blur)) first, with `corner_radius` taken from the card, and falls back to `Shell.BlurEffect` when the library is missing. Install steps in README.md. `temp-*` widgets now use `lib/shell/cardLayers.js` instead of their own card/blur code.

### Widgets
- stock-markets (1x1, 2x1): extra providers Stooq, CNBC and Twelve Data (API key), Yahoo retries on `query2`, and `auto` tries them all in turn; "Starting symbol" applies when changed in Settings.
- daily-wallpaper (1x1, 2x1): new "Auto apply as desktop wallpaper" switch.
- `lib/widgetConfigUI.js` / `widgetConfigFieldRows.js`: fixed list and object fields failing with "Could not display this setting".

### Desktop right-click menu: Widgets Settings
- New "Widgets Settings" item in GNOME Shell's desktop right-click menu. It launches the extension Preferences (`widget-center-prefs-app.js`), the same window the overlay and edit mode open. Logic lives in `lib/shell/desktopMenu.js`; it wraps `BackgroundMenu.open()` through `InjectionManager`, so it covers every monitor and survives monitor hot-plug, and it is removed again in `disable()`.
- The label follows the extension's `language` override (key `menu.desktop.widgets_settings`) and updates live when the language changes.

### i18n: Preferences strings for all locales
- The Card Settings, Text Fonts, Theme Defaults and Card Color Scheme groups (67 keys) were only translated in `en` and `th`. They are now translated in all 46 locale files, together with the new `menu.desktop.widgets_settings` key (314 keys per locale, no English fallback needed).

### Theme packs: text fonts
- Exported theme packs (`.gwct`) and backups now carry `appearance.fontSettings`: default font face + size for `text-1` and `text-2`. If none was set in Preferences, export derives it from the exported widgets (most common value per role).
- New `fontRole` on `fontpicker` fields in `config.json` (54 bundled fields tagged); new Preferences -> Appearance -> Text Fonts group; 32 bundled packs updated. See WIDGET_API.md 9.3.4.

### Structure
- Prefs-only modules moved to `lib/prefs/` (process isolation: nothing under `lib/prefs/` or `prefs.js` reaches St/Clutter/Meta/Shell, nothing the shell loads reaches Gtk/Adw/Gdk). Import paths and docs updated.
- `metadata.json`: dropped `version` and `screenshots`, added `version-name` (2.0.0) and `settings-schema`; `getSettings()` no longer repeats the schema id.
- Theme pack loading is isolated in `lib/shell/themePackSwitcher.js`, so a theme pack store can later be added as another source of packs without touching the switch logic.

### Theme packs: loading a pack now replaces the desktop
- Loading a pack (overlay, Themes tab, *Import theme…*) unloads every widget on screen first, then writes the pack and loads the pack's own widgets at the pack's positions. Loaded widgets are no longer re-colored in place.
- New gsettings key `theme-pack-apply-request` (`<id>|<nonce>`) is the only trigger: every write reloads the pack from scratch, also when it is already the active pack. `active-theme-pack` is now only the "which one is loaded" marker.
- Switching lives in `lib/shell/themePackSwitcher.js`, which owns its signal handler and cleanup (`extension.js` no longer carries the logic).
- Requests are serialized and the newest wins; a failed switch restores the enabled widgets instead of leaving an empty desktop.
- A pack widget without a saved position goes back to its default position (stale layout entry removed).
- Loading a pack no longer overwrites `language`, `widget-center-overlay-keybinding` or `auto-enable-new-widgets`.
- *Import theme…* installs the file as a theme pack and loads it through the same path.
- Notification lists widgets/tools the pack needs that are not installed.

# Changelog

All notable changes to GNOME Widget Center are recorded here, grouped by the
`development/tasks/` phase that introduced them (see `development/tasks/ROADMAP.md`). This project has not
had a numbered public release yet — entries below track `products/extension/metadata.json`'s
internal `version` integer instead.

**Verification status:** everything listed below is code-complete and has passed
syntax-checks / Node-mockable unit tests, but most of it has **not yet been
confirmed end-to-end on real GNOME Shell hardware** — see `development/PROJECT_STATUS.md`
for the exact status per item before relying on this changelog as a "works on my
machine" guarantee.


## Store page: channel / tier / rollback

- **Added:** `lib/store/` (full P1-P3 client: storeClient, integrity, signatures, gwcFormat, rollback, installRegistry, ...), `lib/vendor/noble-ed25519.js`, `lib/prefs/storePage.js`. The Store tab shows the release channel, each repository with a tier badge (`effectiveTier()` on the verified manifest), and rollback buttons for items with a kept previous version.
- **Added:** `development/gwc-client/` (Node tests, run against the extension's own `lib/store`), `development/gwc-store/` (the GTK4 Repo Maker app now lives in its own project, `gwc-repo-maker`), `development/P2-P3-CHANGES.md`.
- **Fixed:** `repoConfig.js` used `structuredClone`, which older GJS (GNOME <= 46) does not have, so the Store page failed to load its config there. A test now keeps `lib/store` off such APIs.
- **Tests:** Node 112, Python 82, GJS rollback test all pass; the Store page was also run under real GTK4/libadwaita (channel saved, rollback rows, unverifiable repo message). Not run inside GNOME Shell.
- **Open:** `OFFICIAL_KEYS` in `repoConfig.js` is still empty, so the official store is refused until a real signing key is added. Page strings have English fallbacks only.

## Widget API 2.0

- **Changed:** widget API is now **2.0** (`"api-version": 2` in metadata.json). All 74 bundled widgets and templates bumped.
  2.0 is the `card-*` key rename plus `appearance.cardSettings` / `appearance.colorScheme`.
- **Added:** `lib/apiVersion.js` (`HOST_API_VERSION` 2, `MIN_SUPPORTED_API_VERSION` 2). `WidgetLoader.discover()` now enforces it:
  widgets with a missing/invalid `api-version`, one older than 2, or newer than the host are not loaded and are
  reported in the error list. Before this the field was documented but never checked.
- **Fixed:** applying a folder-style theme pack (theme.json) did not load its widgets (the disabled-widgets change
  was ignored while the pack was being applied). Both pack types now unload the current widgets and load the pack's.

## Card Settings in .gwct (load card look into new widgets)

- **Added:** `appearance.cardSettings` in `.gwct`, backups and theme.json: all 15 `card-*` settings
  (background, opacity, corner radius, border, shadow, blur). A widget opened for the first time loads them
  as its defaults, so card settings no longer need to be set widget by widget. Saved values are not overwritten.
- **Added:** Preferences -> Appearance -> Card Settings (edit, "Apply to all widgets", "Clear").
- **Added:** `lib/cardDefaults.js`; all 34 bundled theme packs now include a `cardSettings` block
  (most common value per key across the pack's widgets).
- **Changed:** `shadow-angle` and `shadow-distance` are now saved in `.gwct` (hostSettings) and `.gwcbak`.
- **Added:** English + Thai strings for the Card Settings and Card Color Scheme prefs groups (`appearance.card.*`, `appearance.scheme.*`).
- **Fixed:** duplicate `import { readWidgetConfig }` in `lib/exportService.js` (module failed to load).

## Card Color Scheme in .gwct

- **Added:** `appearance.colorScheme` (card background/border/shadow, text 1-2, ring 1-4, accent) in `.gwct`, backups and theme.json.
- **Added:** `schemeRole` on ~170 color fields across the bundled widgets; new widgets start from the scheme.
- **Added:** Preferences -> Appearance -> Card Color Scheme (edit palette, "Apply to all widgets", "Clear").
- **Added:** `lib/colorScheme.js`; sample scheme in `themepacks/Arctic-Glass.gwct`.

## Card setting keys unified (`card-*`)

- **Changed:** all per-widget card settings now follow `card-[type]-[sub-setting]`:
  `card-background-color`, `card-opacity`, `card-corner-radius(-enabled)`, `card-border-(enabled|color|width)`,
  `card-shadow-(enabled|color|opacity|blur|angle|distance)`, `card-blur-(enabled|radius)`.
  Replaces `backgroundColor`, `cardColor`, `paperColor`, `cornerRadius`, `widgetCornerRadius`, `shadowEnabled`, etc.
- **Added:** `lib/cardSettingKeys.js` with `CARD_KEYS` and `migrateCardSettings()`; `storageService` migrates
  saved `settings.json` and imported `.gwct` packs on read/write. Bundled theme packs were rewritten to the new keys.

## [Unreleased] — version 1

### 2026-08-28 — EGO-X-004 closed out: async widget construction for xtile/geek-architect

**Verification status: code-complete, syntax-checked (`node --check`) plus a
repo-wide import-graph check, NOT yet confirmed on real GNOME Shell
hardware.**

- **Fixed — last open EGO-X-004 item:** `widgets/xtile/widget.js` and
  `widgets/geek-architect/widget.js` read their own `metadata.json`
  synchronously in the constructor, purely to decide whether to null out
  `this._addChild` for child instances. Added an opt-in
  `static async createInstance(api)` to both, which reads metadata.json via
  `readTextFileAsync()` and passes it into the constructor.
  `lib/shell/widgetRuntimeLoader.js`'s two construction sites (`loadOne()`,
  `reloadWidget()`) now call `createInstance()` instead of plain `new` when
  a widget module defines it; every other bundled widget has no
  `createInstance()` and is constructed exactly as before — additive, not a
  contract change for the ~50 other widgets. The constructors' original
  synchronous `readTextFile()` path stays in place as a fallback for any
  direct `new` call. See `EGO.md` for the full writeup — EGO-X-004 is now
  fully resolved.

### 2026-08-28 — quick-drag overlap bug, theme export screenshot not downsized

**Verification status for everything below: code-complete, syntax-checked
(`node --check`), NOT yet confirmed on real GNOME Shell hardware.**

Found during a manual daily-use test pass (not via Claude Code — the built
extension used directly). See `development/PROJECT_STATUS.md`'s "Latest
manual test pass" for the full set of results from that session, including
the two items unaffected by this (Edit Mode, backup/restore) and the one
still outstanding (multi-monitor, untested).

- **Fixed — quick Super+drag ignored `prevent-widget-overlap`:** Edit Mode's
  drag (`lib/shell/editModeDragController.js`) already ran dropped positions
  through `LayoutEngine.findFreePosition()` to keep widgets from overlapping,
  but the plain Super+click-drag (`lib/shell/dragController.js`, used outside
  Edit Mode) never did — it only clamped to monitor bounds, so a widget could
  be dropped directly on top of another even with the setting on.
  `DragController` now takes an optional `layoutEngine` and an
  `setOthersProvider()` callback, wired up in `extension.js` the same way
  `EditModeDragController` already is, so both drag paths enforce the same
  collision check.
- **Fixed — Theme Pack export embedded the screenshot at full resolution:**
  `lib/prefs/themePackExportDialog.js` base64-encoded whatever screenshot was
  picked or captured — a full desktop screenshot on a 4K panel, for
  instance — directly into the `.gwct` JSON with no resizing step, so export
  size scaled with the source display instead of staying fixed. Added
  `resizeScreenshotToCover()` (GdkPixbuf: scale + center-crop, "cover" style)
  that downsizes to a fixed 460×270 before encoding, applied to both the
  file-picker flow and the desktop-capture (Super+Delete) flow. Removed the
  now-unused `MIME_BY_EXTENSION` map and `readBytesFileAsync` import left
  over from the old direct-embed path — screenshots are always re-encoded to
  PNG now, so per-extension MIME lookup no longer applies.

- **Fixed:** `lib/prefs/themePackExportDialog.js`'s Export Theme Pack… success handler called
  `window.close()` immediately after `showReportDialog(window, ...)` presented a modal
  dialog transient to that same window — closing the parent out from under its own
  still-open modal child, which hung the whole prefs process instead of just closing it.
  `lib/prefs/prefsDialogs.js`'s `showReportDialog()` now takes an optional `onClose` callback,
  fired on the dialog's own `response` signal, so the window only closes after the user
  dismisses the report.
- **Fixed:** the overlay's widget/theme search (`lib/widgetCenterOverlay.js`) re-ran full
  disk discovery (`_discoverWidgets()`/`_discoverThemePacks()` — a `metadata.json` read +
  mtime `stat()` per widget) on every keystroke in the search box, plus a synchronous
  `GdkPixbuf.Pixbuf.get_file_info()` per visible card's screenshot on every rebuild. Both
  are now cached: discovery once per tab render (`_widgetDiscoveryCache`/
  `_themePackDiscoveryCache`), and screenshot dimensions once per file path
  (`_imageDimsCache`) instead of once per keystroke.
- **Fixed — "Enable background blur" silently did nothing** on 11 bundled widgets that
  built their own card CSS by hand instead of going through the shared
  `applyLayeredCardStyle()`/`applyCardBlur()` helpers (`lib/cardLayers.js`), so their
  Blur Layer was never styled or given a `Shell.BlurEffect` at all:
  `power-menu`, `power-menu-bar`, `settings-control`, `settings-control-bar`,
  `launcher-big-1`, `launcher-big-2`, `launcher-square-1`, `launcher-square-2`,
  `launcher-folder-big`, `launcher-folder-square-1`, `switches`. The same widgets were
  also missing `applyCardOpacity()`, so the "Opacity" slider had no effect either — fixed
  in the same pass.
- **Added:** a "Round card corners" toggle (`cornerRadiusEnabled`, default `true`) next to
  every widget's existing corner-radius slider (`lib/appearanceFieldsSchema.js`), resolved
  through a new shared `resolveCornerRadius()` helper (`lib/widgetVisualKit.js`) that
  `cardStyleCss()` and `applyLayeredCardStyle()` (`lib/cardLayers.js`) both now use. The
  same 3 widgets that hand-roll their card CSS for a different reason (opacity, not this
  feature) — `power-menu`, `settings-control`, `notification-stack` — needed an explicit
  switch to `resolveCornerRadius()` too, or this toggle would have shown in their settings
  UI (auto-injected by `mergeAppearanceFields()`) and done nothing, same failure mode as
  the blur bug above.
- **Fixed:** `widgets/_architect_template_/widget.js` (the Architect scaffold, separate
  from `widgets/_template/`) never called any card-styling helper at all, so its
  auto-injected Appearance tab was entirely inert. Now calls `applyLayeredCardStyle()` in
  `_render()`, matching `widgets/_template/widget.js`'s existing pattern.
- **Not addressed / explicitly out of scope this pass:** `calendar-events`'s
  `eventCardCornerRadius`/`eventCardBlurEnabled` fields control that widget's *inner*
  event cards and are unrelated to the shared per-widget-card toggle above.

### 2026-07-16 — first real-hardware confirmation + bugfix

- **Confirmed on real GNOME Shell hardware for the first time:** widget discovery/load
  (`widgetLoader.js`) runs end-to-end without crashing; both `clock` and `media-player` load
  successfully. (Still only covers the load/enable path — not drag, multi-monitor, hot-reload,
  etc.)
- **Fixed:** `widgetLoader.js`'s `discover()` was scanning `widgets/_template/` (the
  scaffold folder for third-party devs, not a real widget) and loading it as a widget named
  "my-widget", because its `metadata.json` has a valid `id` and nothing skipped
  underscore-prefixed folders. Now skipped explicitly.
- Extracted the MPRIS/DBus client out of `media-player/widget.js` into a new
  `products/extension/lib/mediaApi.js` (`MprisMediaService`) for reuse by future media-related
  widgets. Bundled-widget-only code reuse — does not add a new public `WidgetAPI` hook, and
  third-party widgets still follow the direct-`Gio.DBusProxy` pattern in
  `development/docs/WIDGET_API.md` §8.

### Phase 0 — Feasibility

- Validated that widgets can render as `St`/`Clutter` actors inserted into
  `Main.layoutManager._backgroundGroup`, sitting below app windows and above the
  wallpaper, on real GNOME 50 / Wayland — confirmed by hand on hardware.
- Confirmed GNOME Shell's own session-mode handling already hides widgets on the
  lock screen with no extra code needed (no `session-modes` field in
  `metadata.json`), and that `_backgroundGroup` shows on every workspace by
  default.

### Phase 1 — Core host extension

- Widget loader (`products/extension/lib/widgetLoader.js`): discovers widgets from both
  the bundled and user-installed folders, isolates a broken `metadata.json` or
  duplicate `id` to a single widget instead of failing the whole host, and
  supports hot-reloading a single widget without restarting the Shell.
- Widget Layer (`products/extension/lib/widgetLayer.js`): the actor group every widget's
  `buildActor()` result is inserted into.
- Per-widget JSON settings store (`products/extension/lib/widgetSettings.js`,
  `products/extension/lib/storageService.js`): auto-saving (debounced ~300ms), path-
  sanitized against traversal, default-merging so a widget update that adds new
  setting keys doesn't wipe a user's existing file. Covered by unit tests that
  mock `GLib`/`StorageService` in plain Node.
- Drag & reposition (`products/extension/lib/dragController.js`): Super+drag support,
  positions persisted to `layout.json`, one write per drag gesture rather than
  per frame.
- Host-level settings (`products/extension/lib/settingsService.js`,
  `products/extension/schemas/*.gschema.xml`): compiled inside the extension's own
  folder rather than requiring a system-wide schema install, loaded via
  `Extension.getSettings()`.

### Phase 2 — UX / Control Center

- Control Center (`products/extension/prefs.js`): lists every discovered widget with an
  enable/disable switch wired to the same `disabled-widgets` GSettings key the
  Shell process watches, a per-widget "Settings" subpage for widgets that ship
  a `prefs.js`, and a separate error section for widgets with a broken
  `metadata.json` so one bad widget can't take the whole window down.
- Multi-monitor support (`products/extension/lib/monitorWatcher.js`): reacts to
  `monitors-changed`.

### Phase 3 — Developer experience

- SDK example pack: `clock` (time/date display, `format24h`/`showSeconds`/
  `showDate`/`fontSize` settings) and `media-player` (Now Playing widget
  driven by MPRIS2 over the session DBus via `products/extension/lib/mediaApi.js`
  (`MprisMediaService`) — Play/Pause/Next/Previous,
  graceful "No media playing" placeholder, no polling — see
  `development/docs/WIDGET_API.md` §8 for the DBus access pattern this proved out).
- Hot reload / dev mode (`products/extension/lib/devWatcher.js`): file-watches a
  widget's own folder and reloads just that widget (disable → re-import with
  a cache-busted path → re-enable) without restarting the Shell; isolates a
  syntax error in one widget instead of hanging/crashing the Shell.
- `widgets/_template/`: a copy-paste starting point (`metadata.json`,
  `widget.js`, `prefs.js`, `stylesheet.css`) with `TODO:` markers at every
  point a new widget author needs to change, plus a worked example of a
  timer started in `enable()` and cleaned up in `disable()`.
- `development/docs/PUBLISHING_A_WIDGET.md`: the guide a third-party developer needs —
  and only needs, alongside `development/docs/WIDGET_API.md` — to build and distribute a
  widget without ever reading code under `products/extension/`.

## Known gaps (tracked, not yet fixed)

- `stylesheet.css` is part of the documented per-widget folder layout
  (`development/docs/WIDGET_API.md` §1) but is not yet loaded into the Shell's theme
  context automatically by the host — widgets currently have to style
  themselves via `style_class` + inline St properties in `widget.js`.
- Two copies of the bundled example/template widgets exist in this repo
  (top-level `widgets/` and `products/extension/widgets/`, currently kept byte-identical
  by hand) but only `products/extension/widgets/` is actually scanned by the running
  host (`products/extension/extension.js`'s `bundledWidgetsPath`). Which one should be
  the source of truth — and whether a build step should sync the other —
  is an open decision (see `development/tasks/09-packaging-third-party-docs.md`'s Notes
  from implementation).
  **Resolved 2026-07-16:** dropped the top-level `widgets/` folder; `products/extension/widgets/`
  is the sole source of truth going forward (see `development/tasks/ROADMAP.md`'s
  "Decision (2026-07-16)").
- `development/tasks/07-multi-monitor-support.md` and `development/tasks/08-hot-reload-dev-mode.md` are
  missing a "Notes from implementation" section even though their code exists
  and is wired into `extension.js` — their actual acceptance-criteria status is
  unconfirmed (see `development/PROJECT_STATUS.md`).
- A setting changed through a widget's Control Center prefs page is written to
  disk immediately, but an already-running widget instance in the Shell
  process only picks up the new value the next time it's (re)loaded — not
  live within the same instance. Documented as a known limitation in
  `products/extension/prefs.js`.

## Planned (see README.md's Roadmap / Phase 5+)

- Theme export/import, backup & restore (`development/tasks/11-theme-backup-restore.md`) —
  not started (no "Notes from implementation" filled in yet).
- Widget Repository / Widget Store, AI services, CLI tools — out of scope for
  the current task list; would need a new roadmap phase.
