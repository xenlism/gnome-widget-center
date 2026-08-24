---
name: gnome-widget-center-maintenance
description: Use this skill whenever debugging, fixing, or extending the gnome-widget-center@xenlism.github.io GNOME Shell extension — its widgets/*/widget.js files, lib/*.js host services, schemas/*.xml GSettings, or the theme-pack export/import flow. Covers where the real docs live (WIDGET_API.md, HANDOVER_*.md, CLAUDE.md) and the static validation workflow to run since no live GNOME Shell session is available in this environment.
---

# gnome-widget-center maintenance

This skill packages the debugging workflow for the
`gnome-widget-center@xenlism.github.io` GNOME Shell extension so any
agent session — chat, Code, or otherwise — can pick up work on it
without re-deriving the same context each time.

## Where the real documentation lives (read these, don't guess)

- **`CLAUDE.md`** (repo root) — architecture facts, validation commands,
  and repo conventions. Read this first.
- **`WIDGET_API.md`** (repo root) — the widget author contract: folder
  layout, `metadata.json` schema, the four settings systems, and how a
  `widget.js` reaches DBus services / system metrics / GNOME Shell
  internals. This is the primary reference for anything under
  `widgets/*/`.
- **`HANDOVER_*.md`** (repo root, dated filenames) — prior session
  history: what was fixed, what was validated, what's genuinely still
  open. Treat "still open" claims as a lead to verify, not a fact — grep
  the current code before redoing something a note claims is undone.

## Core debugging loop

1. **Reproduce the claim in code, don't take a bug report at face
   value.** Grep for the relevant pattern across `widgets/*/widget.js`
   and `lib/*.js` before assuming where the bug is. Several "still
   open" items in this repo's own handovers turned out to already be
   fixed once actually checked.
2. **Fix at the pattern level, not the instance level**, when the same
   bug shape exists in a sibling widget (e.g. `settings-control` vs
   `settings-control-bar`) — check the sibling for the same issue while
   you're in there.
3. **Validate statically** — there is no live GNOME Shell in this
   environment. Run the full checklist below after every change; none
   of these individually prove the fix works at runtime, but together
   they catch the large majority of regressions this codebase has
   actually shipped:

   ```bash
   # Syntax-check every JS file
   find . -name "*.js" | while read f; do
     out=$(node --check "$f" 2>&1)
     [ -n "$out" ] && echo "FAIL: $f: $out"
   done

   # Double-card theming regression guard (themeable:true + self-painted
   # card content — see WIDGET_API.md and the 2026-08-11 handover)
   node tools/lint-themeable.js

   # GSettings schema well-formedness (catches dup keys, bad types)
   mkdir -p /tmp/schema-test && cp schemas/*.xml /tmp/schema-test/ \
     && glib-compile-schemas --strict /tmp/schema-test/
   ```

4. **Cross-check `metadata.json` references** (`entry`, `screenshot`)
   actually resolve to files on disk — a mismatch here silently breaks
   a widget's preview image or load path with no error anywhere. See
   `CLAUDE.md`'s Validation section for the one-liner.

## Common bug shapes already found in this codebase (check for these first)

- **Double card**: `themeable: true` in `metadata.json` while
  `widget.js` also paints its own card via `this._content.set_style(...)`
  instead of `this._actor.set_style(...)`. Caught by
  `tools/lint-themeable.js`.
- **Missing live-update signal subscription**: a widget reads external
  state (GSettings, DBus) once or on every render via a freshly-created
  object, instead of subscribing once (`connect('changed::...')` /
  `'g-properties-changed'` / `'notify::...'`) and re-rendering on the
  signal. Symptom: the widget's icon/state goes stale when changed from
  outside the widget (GNOME Quick Settings, a hardware key, another
  app). Fix by mirroring a sibling widget that already does this
  correctly (e.g. `settings-control-bar` for `settings-control`'s
  rfkill/Airplane Mode path).
- **Filename/reference mismatch**: `metadata.json` field points at a
  filename that doesn't exist in the widget's folder (wrong extension,
  leftover original filename after a rename). Compare against sibling
  widgets' naming convention.
- **Orphaned defaults extractor**: `config.json`'s per-field `default`
  only reaches the widget's live settings if something actually calls
  `getConfigDefaults()` (`lib/widgetConfigValidator.js`) at widget-load
  time and merges the result into `WidgetSettings.applyDefaults()`. A
  `field.default` used only as a *display* fallback in the settings-panel
  UI (`widgetConfigUI.js`'s `_buildRow()`) never gets written back until
  the user touches that control by hand. Symptom: a widget's appearance
  looks right with Force Settings ON (which overrides the value outright)
  but wrong with Force Settings OFF, until the user manually resaves any
  one setting. See `HANDOVER_2026-08-12-config-json-defaults-not-applied.md`.
- **Packaging exclude-pattern footgun**: a bare `-x "*.git*"` in `zip
  -r ... -x "*.git*"` also matches the extension folder name itself
  (`...@xenlism.github.io` contains `.git`), silently excluding
  everything. Use `-x "*/.git/*"`.

## After validating, write a handover

Add `HANDOVER_<date>-<short-slug>.md` at the repo root documenting: what
was found, what was changed, and the exact validation output (not just
"tests passed"). Future sessions read these before touching related
code — an accurate one saves real re-investigation time; keep "still
open" items honest since the next session will grep for them.
- **Widget layer structure violations**: every widget must follow the 7
  layer rules (see `CLAUDE.md` §"Widget layer rules"). Use
  `tools/audit-layer-rules.js` to catch violations automatically.
  Common mistakes found in this codebase:
  - Missing `Clutter.BindConstraint(SIZE)` on `_content` → content not
    reliably blocksize (R1).
  - `this._content.set_style(...)` / `content.style_class` — style on
    the clip wrapper instead of a `_background` child (R5).
  - Tooltip parented to `_content` via
    `insertChildAboveSafely(this._content, ...)` — tooltip is clipped to
    the card boundary instead of being able to overflow (R7). Fix: use
    `this._actor` as parent and recompute coordinates relative to it.
