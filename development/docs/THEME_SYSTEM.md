# Theme System (2026-07-21)

Implemented in `products/extension/lib/themeService.js`.

## File

`~/.config/gnome-widget-center/theme.json` — separate from `layout.json`
(position) and `widgets/<id>.json` (per-widget behavior settings), same
"one file, one responsibility" rule the rest of storage follows.

```json
{
  "version": 1,
  "global": {
    "background": {
      "transparent": true,
      "color": "#1e1e2e",
      "blur": 12
    },
    "dropShadow": {
      "enabled": true,
      "transparent": false,
      "color": "#000000",
      "opacity": 0.45,
      "offsetX": 0,
      "offsetY": 4,
      "blurRadius": 12,
      "spread": 0
    }
  },
  "widgets": {
    "clock": {
      "theme": "default",
      "config": { "accentColor": "#ffffff" },
      "position": { "x": 300, "y": 400, "monitor": 0 }
    }
  }
}
```

- `global.background` — desktop-wide widget card background. `transparent`
  toggles alpha 0 vs 1 on `color`; `blur` is emitted as St's
  `-st-background-blur` (px).
- `global.dropShadow` — desktop-wide widget card shadow. `enabled: false`
  or `transparent: true` short-circuits to no shadow at all (an alpha-0
  shadow still costs a render pass for nothing).
- `widgets.<id>` — per-widget override. `theme` is a widget-declared
  variant name (a widget can ship more than one stylesheet, e.g.
  macos-clock's light/dark); `config` is free-form appearance data a
  widget's own theme reads (kept separate from `widgetSettings.js`'s
  behavior settings); `position` is an *optional* theme-driven placement
  (e.g. a "reset to theme default" action) — `layout.json` via
  `StorageService` remains the single source of truth for where a widget
  actually renders day to day.

## API (`ThemeService`)

- `init()` / `reload()` — load from disk (missing/corrupt file = defaults,
  never an error).
- `save(config)` / `setGlobalTheme(patch)` / `setWidgetTheme(id, patch)` —
  atomic write (same `replace_contents(REPLACE_DESTINATION)` pattern as
  `StorageService`).
- `getGlobalTheme()` / `getWidgetTheme(id)` — always return a fully-shaped
  object (merged over defaults), never `null`/`undefined` fields.
- `getGlobalBackgroundCss()` / `getGlobalDropShadowCss()` /
  `applyGlobalStyle(actor)` — render to a St ad hoc CSS string
  (`actor.set_style()`), additive with a widget's own `stylesheet.css`
  class rules (`set_style()` is inline-priority, same as HTML).

## Current wiring

`extension.js` constructs one `ThemeService` alongside `StorageService` and
hands it to `WidgetEditMode`, which calls `applyGlobalStyle()` on each
widget's Edit Mode back-card the first time it's built (see
`widgetEditMode.js`'s `_buildBackActor()`) — a self-contained surface,
independent of the widget-placement pipeline, so this is safe to ship
without touching how widgets themselves render.

## Not yet wired (follow-up work)

- Applying `global.background`/`dropShadow` to widgets' own FRONT actors
  (not just the Edit Mode back-card) — needs a decision on whether that's
  a `blockSizeManager.js`-style "host sets it, widget can't override"
  rule or something a widget's own `stylesheet.css` can still win over.
- A Control Center (`prefs.js`) page to edit `theme.json` — currently
  it's edit-the-JSON-by-hand only; `ThemeService.setGlobalTheme()`/
  `setWidgetTheme()` are ready for a prefs page to call directly (same
  process boundary as `widgetSettings.js` — see its doc comment on
  Shell vs Prefs being separate GJS runtimes) once one exists.
- Live cross-process reload: `SettingsWatcher` (`settingsWatcher.js`)
  already solves exactly this problem for `widgets/<id>.json`; the same
  `Gio.FileMonitor` pattern applies directly to `theme.json` once a prefs
  page writes to it from the separate Prefs process — not added yet since
  there's no writer to react to on real hardware until that page exists.
