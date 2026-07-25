# Theme System (2026-07-21, corner radius + force flags 2026-07-25)

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
      "blur": 12,
      "force": false
    },
    "cornerRadius": {
      "value": 12,
      "force": false
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
      "config": {
        "accentColor": "#ffffff",
        "background": { "transparent": false, "color": "#202030" },
        "cornerRadius": { "value": 20 }
      },
      "position": { "x": 300, "y": 400, "monitor": 0 }
    }
  }
}
```

- `global.background` — desktop-wide widget card background. `transparent`
  toggles alpha 0 vs 1 on `color`; `blur` is emitted as St's
  `-st-background-blur` (px); `force` (2026-07-25), when true, makes every
  themeable widget use this background verbatim and ignore its own
  `config.background`.
- `global.cornerRadius` (2026-07-25) — desktop-wide widget card corner
  radius (`value`, px), rendered as `border-radius`. Independent from
  `background` — a widget can be square+filled, rounded+transparent, etc.
  `force` works the same way as `background.force`, for `config.cornerRadius`.
- `global.dropShadow` — desktop-wide widget card shadow. `enabled: false`
  or `transparent: true` short-circuits to no shadow at all (an alpha-0
  shadow still costs a render pass for nothing).
- `widgets.<id>` — per-widget override. `theme` is a widget-declared
  variant name (a widget can ship more than one stylesheet, e.g.
  macos-clock's light/dark); `config` is free-form appearance data a
  widget's own theme reads (kept separate from `widgetSettings.js`'s
  behavior settings) — `config.background`/`config.cornerRadius` are the
  two keys `ThemeService`/the Control Center's per-widget Appearance UI
  itself understands, anything else is left for the widget's own code to
  interpret; `position` is an *optional* theme-driven placement (e.g. a
  "reset to theme default" action) — `layout.json` via `StorageService`
  remains the single source of truth for where a widget actually renders
  day to day.

## API (`ThemeService`)

- `init()` / `reload()` — load from disk (missing/corrupt file = defaults,
  never an error).
- `save(config)` / `setGlobalTheme(patch)` / `setWidgetTheme(id, patch)` —
  atomic write (same `replace_contents(REPLACE_DESTINATION)` pattern as
  `StorageService`).
- `getGlobalTheme()` / `getWidgetTheme(id)` — always return a fully-shaped
  object (merged over defaults), never `null`/`undefined` fields.
- `getEffectiveWidgetTheme(id)` — `getGlobalTheme()`'s background/
  cornerRadius/dropShadow, overridden field-by-field by the widget's own
  `config`, EXCEPT that `background`/`cornerRadius` are not merged at all
  (global wins outright) while the matching `force` flag is on.
- `getGlobalBackgroundCss()` / `getGlobalCornerRadiusCss()` /
  `getGlobalDropShadowCss()` / `applyGlobalStyle(actor)` — render the
  GLOBAL theme to a St ad hoc CSS string (`actor.set_style()`), additive
  with a widget's own `stylesheet.css` class rules.
- `applyWidgetStyle(actor, id)` — same, but resolved through
  `getEffectiveWidgetTheme(id)` so per-widget overrides (and `force`) take
  effect; background + corner radius + drop shadow all applied in one
  `set_style()` call.

## Current wiring

- `extension.js` constructs one `ThemeService` alongside `StorageService`.
  `WidgetEditMode` calls `applyGlobalStyle()` on each widget's Edit Mode
  toolbar/back-card. Any widget's own FRONT actor gets
  `applyWidgetStyle()` too, but ONLY if it opts in via metadata.json's
  `"themeable": true` (`_placeEntry()`) — every bundled widget now sets
  this. `ThemeService.watch()` live-reloads `theme.json` cross-process and
  `_reapplyTheme()` re-styles every themeable widget + Edit Mode surface
  when the Control Center writes a change, no Shell restart needed.
- The Control Center (`prefs.js`) has a top-level "Appearance" page
  (`_buildAppearancePage()`) editing `global.background` (incl. its
  `force` switch), `global.cornerRadius` (incl. its `force` switch), and
  `global.dropShadow` — every row writes straight through via
  `setGlobalTheme()`, no separate Save step.
- Each themeable widget's own settings subpage additionally gets an
  "Appearance" group (`_appendWidgetAppearanceGroup()`) for that widget's
  `config.background`/`config.cornerRadius`, writing via
  `setWidgetTheme(id, ...)`. Its rows are shown but disabled (and display
  the global value) while the matching global `force` switch is on, since
  a value saved there would otherwise be silently ignored.

## Not yet wired (follow-up work)

- A widget-facing API (`api.theme`? a `theme.js` hook, similar to
  `api.settings`) so a widget's own `widget.js` can read
  `getEffectiveWidgetTheme()` directly instead of only getting it applied
  as a `set_style()` override from outside — useful for widgets that want
  to adapt internal drawing (e.g. text color) to a light vs dark
  background, not just the card's own fill/radius/shadow.
- Widget-declared `theme` variants (the `theme: "default"` field in a
  widget's `theme.json` entry) — the field is read/written by
  `getWidgetTheme()`/`setWidgetTheme()` today but nothing yet resolves it
  to an actual alternate stylesheet.
