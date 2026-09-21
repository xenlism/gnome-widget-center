# Contributing to GNOME Widget Center

Thanks for your interest in improving GNOME Widget Center. This document
covers how to set up the extension for local development, the project's
conventions, and how to submit changes.

## Code of conduct

Be respectful and constructive in issues and pull requests. Assume good
faith, and focus feedback on the code, not the person.

## Ways to contribute

- **Bug reports** — open an issue with your GNOME Shell version, the
  widget(s) involved, steps to reproduce, and (if relevant) output from
  `journalctl -f -o cat /usr/bin/gnome-shell` or `journalctl --user -f`
  on Wayland.
- **New widgets** — see [Adding a new widget](#adding-a-new-widget) below.
- **Fixes/improvements to existing widgets or core** (`lib/`,
  `extension.js`, `prefs.js`) — please open an issue first for anything
  non-trivial so we can discuss the approach before you invest time.
- **Translations** — see [Adding a translation](#adding-a-translation).
- **Theme packs** — see [Contributing a theme pack](#contributing-a-theme-pack).

## Requirements

- GNOME Shell **50** or **51** (see `shell-version` in `metadata.json`).
  This project does not backport to older shells; if you need broad
  compatibility with older GNOME versions this may not be the right
  extension to build on.
- No Node/npm build step — the extension is plain ESM GJS, loaded
  directly by GNOME Shell. You don't need to compile anything to run it,
  except regenerating the GSettings schema after a schema change (see
  below).

## Local setup

1. Clone (or symlink your working copy) into the extensions directory
   using the UUID from `metadata.json`:

   ```
   git clone https://github.com/xenlism/gnome-widget-center.git ~/.local/share/gnome-shell/extensions/gnome-widget-center@xenlism.github.io
   ```

2. Compile the GSettings schema after any change under `schemas/`:

   ```
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/gnome-widget-center@xenlism.github.io/schemas
   ```

3. Enable the extension:

   ```
   gnome-extensions enable gnome-widget-center@xenlism.github.io
   ```

4. Reload GNOME Shell to pick up changes to `extension.js` or `lib/`:
   - **X11:** `Alt`+`F2`, type `r`, press `Enter`.
   - **Wayland:** log out and back in (or test in a nested session —
     see below).

5. For faster iteration, run a nested GNOME Shell session so you don't
   have to log out on every change:

   ```
   dbus-run-session -- gnome-shell --nested --wayland
   ```

### Dev-mode hot reload for widgets

Widgets support hot reload without a full Shell restart via
`lib/devWatcher.js` — when dev mode is on, editing a widget's files
on disk (`widget.js`, `config.json`, `stylesheet.css`) triggers that
widget to reload in place. This only reloads the widget instance, not
`extension.js` or `lib/` core changes. Check the preferences window for
the dev-mode toggle before doing repeated widget edits.

### Logging

Use `lib/logger.js` rather than raw `console.log`/`print()` so log
output is consistently tagged and can be filtered. When debugging,
watch logs with:

```
journalctl --user -f -o cat | grep -i widget-center
```

## Project layout

```
extension.js              Shell-side entry point
prefs.js                  Preferences entry point
widget-center-prefs-app.js  Preferences window bootstrap
lib/                       Core: layout engine, drag/snap, settings,
                            theming, i18n helpers, widget loader, etc.
lib/shell/                 Shell-actor-specific code (edit mode, drag,
                            tooltip)
widgets/<widget-id>/       One folder per bundled widget (see below)
themepacks/                Exported/importable `.gwct` theme packs
i18n/                      Per-locale string tables (`en.js`, `th.js`, ...)
schemas/                   GSettings schema (`org.gnome.shell.extensions.widget-center.gschema.xml`)
assets/                    Extension icon/screenshot
```

## Adding a new widget

Each widget lives in its own folder under `widgets/<widget-id>/` and is
picked up automatically by `lib/widgetLoader.js` — there is no central
registry file to edit. At minimum a widget folder needs:

```
widgets/my-widget/
├── metadata.json     # required
├── config.json       # required — settings schema shown in prefs
├── widget.js         # required — entry point (see "entry" in metadata.json)
├── stylesheet.css     # optional
├── screenshot.png     # optional, but recommended for the widget picker
├── README.md          # recommended — see convention below
└── i18n/               # optional, per-widget strings (see weather-dark)
```

**`metadata.json`** fields:

| Field              | Notes                                                             |
| ------------------ | ------------------------------------------------------------------ |
| `id`                | Reverse-DNS-ish unique id, e.g. `xenlism.github.io.my-widget`.     |
| `name`              | Display name shown in the widget picker.                          |
| `description`       | One or two sentences shown in the widget picker.                  |
| `version`           | Widget's own version string, independent of the extension version.|
| `author`            | Your name or handle.                                              |
| `api-version`       | Currently `1`.                                                     |
| `entry`             | Usually `widget.js`.                                               |
| `block-type`        | Default footprint — see existing values (`1x1`, `2x1`, `2x2`, `3x1`, `4x2`, `barx2`, ...); reuse an existing one where it fits rather than inventing a new aspect ratio. |
| `default-position`  | `{x, y, monitor}` — a sane default spot on first add.              |

**`config.json`** describes the settings tabs/groups/fields rendered in
the preferences window. Reuse the existing `fieldType`s where possible:
`colorpicker`, `dropdown`, `filepicker`, `folderpicker`, `fontpicker`, `list`,
`location`, `slider`, `spinbutton`, `switch`, `text`. Look at a widget
with similar settings (e.g. `weather-dark` for a widget calling an
external API, `circles-battery` for a ring gauge) as a starting
template rather than writing the schema from scratch.

**`widget.js`** conventions:

- Widgets that need to read their own `metadata.json`/`config.json`
  asynchronously at construction time should implement a static
  `async createInstance(api)` (see `widgets/xtile` or
  `widgets/geek-architect`) rather than doing a synchronous file read
  in the constructor — see `EGO.md` for why the synchronous path is
  being phased out.
- If your widget calls a network API, keep the request async, handle
  failure states gracefully (show a placeholder, don't throw), and
  respect any user-configured refresh interval rather than polling
  aggressively.
- Any secret/API-key style field should use the secret-field handling
  in `lib/secretFields.js` / `lib/crypto/` rather than storing it as a
  plain string.

**Per-widget `README.md`** — short, factual, written for the next
contributor, not marketing copy. Cover: what it draws, notable
implementation details (e.g. drawing approach, external APIs used),
and a bullet list of the `config.json` fields grouped by the tabs they
appear under. See `widgets/clock-analog-classic/README.md` for the
expected length and tone.

Before opening a PR for a new widget, add it to the widget list in the
top-level project README/description you're editing against, and make
sure it appears correctly in the widget picker and can be added,
moved, resized, and removed without errors in the log.

## Adding a translation

1. Copy `i18n/en.js` to `i18n/<locale>.js` (two-letter code) and
   translate the strings, keeping keys identical.
2. Add the locale code to `SUPPORTED_LOCALES` in `i18n/index.js`.
3. If your widget has its own strings, follow the same pattern inside
   `widgets/<widget-id>/i18n/`.
4. Test by switching your system language (or overriding the locale in
   prefs, if the widget supports it) and confirming no key falls back
   to `en` unintentionally.

Partial translations are fine — untranslated keys fall back to
English — but please don't leave obviously machine-translated strings
without flagging it in the PR description.

## Contributing a theme pack

Theme packs (`.gwct` files under `themepacks/`) are exported via the
in-app export dialog (`lib/themePackExportDialog.js`) and registered
through `lib/themePackRegistry.js`. If you're contributing one:

- Export it from a real, working layout rather than hand-editing the
  file.
- Give it a descriptive name matching the existing naming style (e.g.
  `Minimal-System-Control.gwct`).
- Add a short entry to `themepacks/README.txt` describing what it's
  for and which widgets it's built around.

## Code style

- Plain ESM GJS, matching the existing files — no build/transpile
  step, so avoid syntax the target GNOME Shell versions can't run.
- No new runtime dependencies without discussion first; this project
  intentionally has a minimal footprint.
- Match the formatting of the file you're editing rather than
  reformatting whole files in a functional PR — keep diffs reviewable.
- Prefer small, focused modules under `lib/` over adding more logic to
  `extension.js`.

## Before opening a pull request

- [ ] Syntax-check changed files (`node --check <file>` works fine for
  catching typos even without a GJS runtime available).
- [ ] Manually smoke-test in a real or nested GNOME Shell session:
  adding/removing the widget(s) you touched, editing their settings,
  and (if relevant) dragging/resizing/snapping.
- [ ] No leftover `console.log`/debug prints — use `lib/logger.js`.
- [ ] Update the relevant widget's `README.md` if you changed its
  settings or behavior.
- [ ] Keep the PR scoped to one widget/feature/fix where possible —
  it's easier to review and easier to revert if something's wrong.

## License

By contributing, you agree that your contribution is licensed under
the project's [GNU General Public License v3.0](LICENSE) (or, at your
option, any later version), matching the rest of the codebase.
