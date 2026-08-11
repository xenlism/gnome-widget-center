# Handover — Force Settings gaps (found, not yet fixed)

Written because we're close to this session's context limit. Two confirmed,
reproduced-in-code issues below, plus one in-progress dev tool. Nothing in
this file has been fixed yet — it's all analysis + exact locations so the
next session can go straight to the fix.

## 1. power-menu / power-menu-bar / settings-control / settings-control-bar
   don't support Force Settings at all

Confirmed by direct grep, not assumption:

- None of the 4 widgets' `metadata.json` sets `"themeable": true` — the key
  is simply absent, so `extension.js`'s `entry.metadata["themeable"]` gate
  (see `_reapplyTheme()` line ~233, `_placeEntry()` line ~267) is falsy for
  all four, and `ThemeService.applyWidgetStyle()` (the thing that actually
  calls `ForceSettingsHelper.resolve()`) is never invoked for them.
- `power-menu/widget.js` and `settings-control/widget.js` each have their
  own private `_cardStyle(hexColor, cornerRadius)` method (search for it —
  `power-menu/widget.js:125`, `settings-control/widget.js:412`) that builds
  CSS directly from the widget's own settings, with no Force Settings
  involvement whatsoever.
- `power-menu-bar/widget.js` and `settings-control-bar/widget.js` use
  `cardStyleCss()` from `lib/widgetVisualKit.js` directly — also bypasses
  `ThemeService`/`ForceSettingsHelper` entirely.

**To fix:** these 4 need the same treatment `ThemeService.applyWidgetStyle()`
already gives themeable widgets — resolve background/corner-radius/shadow
through `this._forceSettingsHelper.resolve(...)` before falling back to the
widget's own settings. Cleanest path is probably making `themeable: true`
in their metadata.json and routing their style computation through
`ThemeService` instead of each having a private `_cardStyle()` — but that's
a design call, not just a bugfix, so flag it to the user before doing it:
these 4 currently have bespoke styling (e.g. power-menu's per-button
color logic) that a naive switch to `applyWidgetStyle()` might not fully
replicate.

## 2. Force Settings' opacity/blur override widgets with themeable=false —
   should never happen

`extension.js`'s `_applyCardEffects(entry)` (called unconditionally, once
from `_reapplyTheme()` line ~237 and once from `_placeEntry()` line ~274 —
**neither call site checks `entry.metadata["themeable"]`**, unlike the
`applyWidgetStyle()` calls right next to them which do) calls
`applyCardOpacity(entry.actor, entry.settings)` and
`applyCardBlur(entry.actor, entry.settings)` for *every* widget regardless
of its `themeable` flag. If Force Settings' `opacity.force` / `blur.force`
globals are set, these two functions apply the forced value — meaning a
widget explicitly marked non-themeable still gets its opacity/blur
overridden. This is the literal bug the user described
("force settings override themeable=false ห้าม override").

**To fix:** guard both calls in `_applyCardEffects()` (or inside
`applyCardOpacity`/`applyCardBlur` themselves, in `lib/widgetVisualKit.js`)
behind the same `entry.metadata["themeable"]` check the adjacent
`applyWidgetStyle()` call already uses. Needs a decision on whether
`_applyCardEffects` should take `themeable` as a param or read it off
`entry.metadata` itself (it already receives the full `entry`, so the
latter is simplest — one line: `if (!entry?.metadata?.["themeable"]) return;`
near the top, right after the existing `if (!entry?.actor) return;`).

## 3. In progress, not finished: "bake current settings into config.json
   defaults" — one-click, all widgets, from the Development prefs page

- `lib/devConfigDefaults.js` — done, working, unit-tested (pure logic
  verified with mock data). Exports:
  - `applyCurrentValuesAsConfigDefaults(config, currentValues)`
  - `saveCurrentSettingsAsWidgetDefaults(widgetPath, currentValues, position)`
- **NOT done:** wiring a button into `lib/prefsPageBuilders.js`'s
  `_buildAdvancedCategory(settings)` (the "Development" page, right below
  the existing "Development Mode" switch, ~line 943-966) that:
  1. Discovers all widgets — `PrefsWidgetList`/`WidgetLoader.discover()`
     already used elsewhere in the prefs process (see
     `lib/prefsWidgetList.js`) gives `{id, path, metadata}` per widget.
  2. For each, reads current live settings via
     `StorageService.getWidgetSettings(id)` and position via
     `StorageService.getWidgetPosition(id)` (already imported/instantiated
     in `lib/prefsWindowController.js` — `new StorageService` at line ~74).
  3. Calls `saveCurrentSettingsAsWidgetDefaults(path, settings, position)`
     per widget, collects `{configUpdated, positionUpdated, errors}`.
  4. Confirms first via `confirmOverwrite()` (already in
     `lib/prefsDialogs.js` — destructive-styled Adw dialog, exactly this
     shape of action) since this overwrites every widget's own
     `config.json`/`metadata.json` on disk.
  5. Reports the result via `showReportDialog()` (also already in
     `lib/prefsDialogs.js`) — e.g. "Updated 9 widgets, 2 errors: ...".
- Open question to ask the user before wiring: should skipping a widget
  with *no* live settings yet (never customized) be silent, or listed in
  the report as "skipped — no changes"? Current `devConfigDefaults.js`
  logic makes it a safe no-op either way (untouched fields keep their old
  default), just a UX/reporting call.

## Also still open from earlier sessions (not re-investigated this pass)
- `st_widget_get_theme_node ... not in the stage` for
  `launcher-big-1` still appears in the user's latest log even after the
  `deferUntilMapped()` fix from last session (confirmed present in this
  codebase — `grep deferUntilMapped widgets/launcher-big-1/widget.js`
  returns 2 matches). Frequency dropped (2 lines vs. the original 6) but
  not eliminated — root cause not fully closed. Worth a fresh look: check
  whether `syncContentSize()`'s `set_position`/`set_size` calls (which run
  on every `notify::width`/`notify::height` of `this._actor`, including
  during the very first layout pass before `mapped` fires) are themselves
  triggering a style/theme-node query indirectly, independent of the
  `set_style()` calls already deferred.
