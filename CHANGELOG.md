# Changelog

All notable changes to GNOME Widget Center are recorded here, grouped by the
`tasks/` phase that introduced them (see `tasks/ROADMAP.md`). This project has not
had a numbered public release yet — entries below track `extension/metadata.json`'s
internal `version` integer instead.

**Verification status:** everything listed below is code-complete and has passed
syntax-checks / Node-mockable unit tests, but most of it has **not yet been
confirmed end-to-end on real GNOME Shell hardware** — see `tests/e2e-checklist.md`
for the exact status per item before relying on this changelog as a "works on my
machine" guarantee.

## [Unreleased] — version 1

### Phase 0 — Feasibility

- Validated that widgets can render as `St`/`Clutter` actors inserted into
  `Main.layoutManager._backgroundGroup`, sitting below app windows and above the
  wallpaper, on real GNOME 50 / Wayland — confirmed by hand on hardware.
- Confirmed GNOME Shell's own session-mode handling already hides widgets on the
  lock screen with no extra code needed (no `session-modes` field in
  `metadata.json`), and that `_backgroundGroup` shows on every workspace by
  default.

### Phase 1 — Core host extension

- Widget loader (`extension/lib/widgetLoader.js`): discovers widgets from both
  the bundled and user-installed folders, isolates a broken `metadata.json` or
  duplicate `id` to a single widget instead of failing the whole host, and
  supports hot-reloading a single widget without restarting the Shell.
- Widget Layer (`extension/lib/widgetLayer.js`): the actor group every widget's
  `buildActor()` result is inserted into.
- Per-widget JSON settings store (`extension/lib/widgetSettings.js`,
  `extension/lib/storageService.js`): auto-saving (debounced ~300ms), path-
  sanitized against traversal, default-merging so a widget update that adds new
  setting keys doesn't wipe a user's existing file. Covered by unit tests that
  mock `GLib`/`StorageService` in plain Node.
- Drag & reposition (`extension/lib/dragController.js`): Super+drag support,
  positions persisted to `layout.json`, one write per drag gesture rather than
  per frame.
- Host-level settings (`extension/lib/settingsService.js`,
  `extension/schemas/*.gschema.xml`): compiled inside the extension's own
  folder rather than requiring a system-wide schema install, loaded via
  `Extension.getSettings()`.

### Phase 2 — UX / Control Center

- Control Center (`extension/prefs.js`): lists every discovered widget with an
  enable/disable switch wired to the same `disabled-widgets` GSettings key the
  Shell process watches, a per-widget "Settings" subpage for widgets that ship
  a `prefs.js`, and a separate error section for widgets with a broken
  `metadata.json` so one bad widget can't take the whole window down.
- Multi-monitor support (`extension/lib/monitorWatcher.js`): reacts to
  `monitors-changed`.

### Phase 3 — Developer experience

- SDK example pack: `clock` (time/date display, `format24h`/`showSeconds`/
  `showDate`/`fontSize` settings) and `media-player` (Now Playing widget
  driven by MPRIS2 over the session DBus — Play/Pause/Next/Previous,
  graceful "No media playing" placeholder, no polling — see
  `docs/WIDGET_API.md` §8 for the DBus access pattern this proved out).
- Hot reload / dev mode (`extension/lib/devWatcher.js`): file-watches a
  widget's own folder and reloads just that widget (disable → re-import with
  a cache-busted path → re-enable) without restarting the Shell; isolates a
  syntax error in one widget instead of hanging/crashing the Shell.
- `widgets/_template/`: a copy-paste starting point (`metadata.json`,
  `widget.js`, `prefs.js`, `stylesheet.css`) with `TODO:` markers at every
  point a new widget author needs to change, plus a worked example of a
  timer started in `enable()` and cleaned up in `disable()`.
- `docs/PUBLISHING_A_WIDGET.md`: the guide a third-party developer needs —
  and only needs, alongside `docs/WIDGET_API.md` — to build and distribute a
  widget without ever reading code under `extension/`.

## Known gaps (tracked, not yet fixed)

- `stylesheet.css` is part of the documented per-widget folder layout
  (`docs/WIDGET_API.md` §1) but is not yet loaded into the Shell's theme
  context automatically by the host — widgets currently have to style
  themselves via `style_class` + inline St properties in `widget.js`.
- Two copies of the bundled example/template widgets exist in this repo
  (top-level `widgets/` and `extension/widgets/`, currently kept byte-identical
  by hand) but only `extension/widgets/` is actually scanned by the running
  host (`extension/extension.js`'s `bundledWidgetsPath`). Which one should be
  the source of truth — and whether a build step should sync the other —
  is an open decision (see `tasks/09-packaging-third-party-docs.md`'s Notes
  from implementation).
- `tasks/07-multi-monitor-support.md` and `tasks/08-hot-reload-dev-mode.md` are
  missing a "Notes from implementation" section even though their code exists
  and is wired into `extension.js` — their actual acceptance-criteria status is
  unconfirmed (see `tests/e2e-checklist.md`).
- A setting changed through a widget's Control Center prefs page is written to
  disk immediately, but an already-running widget instance in the Shell
  process only picks up the new value the next time it's (re)loaded — not
  live within the same instance. Documented as a known limitation in
  `extension/prefs.js`.

## Planned (see README.md's Roadmap / Phase 5+)

- Theme export/import, backup & restore (`tasks/11-theme-backup-restore.md`) —
  not started (no "Notes from implementation" filled in yet).
- Widget Repository / Widget Store, AI services, CLI tools — out of scope for
  the current task list; would need a new roadmap phase.
