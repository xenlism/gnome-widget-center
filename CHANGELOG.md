# Changelog

All notable changes to GNOME Widget Center are recorded here, grouped by the
`development/tasks/` phase that introduced them (see `development/tasks/ROADMAP.md`). This project has not
had a numbered public release yet — entries below track `products/extension/metadata.json`'s
internal `version` integer instead.

**Verification status:** everything listed below is code-complete and has passed
syntax-checks / Node-mockable unit tests, but most of it has **not yet been
confirmed end-to-end on real GNOME Shell hardware** — see `development/tests/e2e-checklist.md`
for the exact status per item before relying on this changelog as a "works on my
machine" guarantee.

## [Unreleased] — version 1

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
  unconfirmed (see `development/tests/e2e-checklist.md`).
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
