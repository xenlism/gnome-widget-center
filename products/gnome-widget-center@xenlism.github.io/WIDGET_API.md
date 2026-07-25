# WIDGET_API.md — the widget author contract

This is the one file a widget author needs to build a new widget for
**GNOME Widget Center**, without knowing anything about the internals of
`products/gnome-widget-center@xenlism.github.io/`. It merges what used to
be two separate docs (`development/docs/WIDGET_API.md` for the widget
lifecycle, nothing centralized for settings) into a single reference, and
adds a full write-up of **both** settings systems that exist in this
codebase today — only one of which is actually wired up.

If you're building a widget with an AI assistant, see `SKILL.md` (same
folder) first — it's the condensed, task-oriented version of this file.

---

## 1. Folder layout of one widget

```
my-widget/
├── metadata.json      # required
├── widget.js          # required — runs in the Shell process, draws on the desktop
├── prefs.js           # optional — this widget's own settings UI
├── settings.js        # optional, rarely used — see §6.3, NOT currently wired up
├── stylesheet.css      # optional — documentation only, see the note in §3
└── icon.svg            # optional — shown in the Control Center
```

Drop this folder at `~/.local/share/gnome-widget-center/widgets/my-widget/`
and it works after "Rescan widgets" in the Control Center (or a Shell
restart). Bundled widgets ship inside this extension's own `widgets/`
folder instead, discovered the same way.

## 2. `metadata.json`

```json
{
  "id": "my-widget",
  "name": "My Widget",
  "description": "One line, shown in the Control Center list.",
  "version": "1.0.0",
  "author": "your name",
  "api-version": 1,
  "entry": "widget.js",
  "prefs": "prefs.js",
  "block-type": { "cols": 14, "rows": 9 },
  "default-position": { "x": 40, "y": 40, "monitor": 0 }
}
```

- `id` must match the folder name and be globally unique — the host
  rejects duplicates.
- `api-version` is a compatibility check. A breaking host API change
  bumps this; widgets built against an older number are disabled with a
  notice instead of crashing.
- `block-type` (`{cols, rows}`) is the on-screen size **in grid cells**,
  not pixels (see `development/architecture/specs/ui/size-constraints.md`
  — the block-type system). The host multiplies by
  `GridEngine.cellSize` (currently 16px/cell) when placing the widget —
  don't declare pixel sizes. Omit the field entirely and you get a
  `10 x 6` cell default. This size is fixed: **no min/max, and the user
  cannot resize it themselves** (there is no `size-constraints` field
  anymore).
- `themeable` (optional boolean, default `false`) — opts this widget's
  root actor into the host-wide theme system
  (`development/docs/THEME_SYSTEM.md`): background/corner-radius/
  drop-shadow are styled from `theme.json`'s global appearance settings
  (with an optional per-widget override under `widgets.<id>.config`,
  itself editable from this widget's own Control Center settings page —
  see `_appendWidgetAppearanceGroup()` in `prefs.js`) via
  `ThemeService.applyWidgetStyle()`. A global "Force" switch on the
  Appearance page can pin background and/or corner radius to the global
  value for every themeable widget, ignoring any per-widget override.
  Leave this unset for widgets that already paint their own background in
  `widget.js` (e.g. any widget using the "card" pattern from
  `calendar-modern`/`clock-modern` — see §3's stylesheet.css note) so the
  host theme never silently overrides a widget's own design without the
  author asking for it.
- `settings` (optional array) — see §6.1. This is the **only** settings
  system with real Control Center UI generation today.

## 3. `widget.js` — must export a default class with these methods

```js
export default class MyWidget {
    /** @param {WidgetAPI} api - see §5 */
    constructor(api) {
        this._api = api;
        this._settings = api.settings; // read/write, scoped to this widget only
    }

    // Return an St.Widget/Clutter.Actor to place on the desktop.
    // Must NEVER throw, even with empty settings. If not ready yet,
    // return a placeholder and update it later (e.g. once enable()'s
    // timer/signal/DBus call resolves) rather than delaying this call.
    buildActor() {
        this._actor = new St.BoxLayout({ style_class: 'my-widget-root', vertical: true });
        return this._actor;
    }

    // Called once, right after buildActor()'s result is in the Widget
    // Layer. Start timers/signals/DBus proxies here.
    enable() {}

    // Must undo everything enable() started (every signal, every
    // GLib.timeout_add, every Gio.DBusProxy) — GNOME Shell warns/leaks on
    // every enable/disable cycle otherwise, and screen lock/unlock also
    // triggers this cycle.
    disable() {}

    // Defaults for this widget's settings file, merged in for any key
    // missing from an existing file (see §7 for the on-disk format).
    getDefaultSettings() {
        return { refreshInterval: 60 };
    }

    // Optional. Called when this widget's settings change from OUTSIDE
    // its own process (e.g. the user edited them in the Control Center,
    // which runs as a separate GTK4 process). `api.settings` is already
    // updated to the new values before this fires. Use it for anything
    // buildActor() doesn't already redo every frame on its own — e.g.
    // re-render a label set once in enable(), or restart a timer whose
    // interval just changed.
    onSettingsChanged(settings) {}
}
```

### Must-follow rules

- **Never** `import Gtk` in `widget.js` — it runs in the Shell process and
  conflicts with Clutter/St.
- **Never** keep state at module scope across enable/disable cycles —
  clean it all up in `disable()` (see the [GNOME Shell Extension Review
  Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)).
- Every signal you `connect()` must be `disconnect()`ed in `disable()`;
  every `GLib.timeout_add`/`idle_add` must be `GLib.source_remove()`d.
- Never touch files outside your own widget folder, and never reach into
  another widget directly — use `api.bus` (§5) if you need cross-widget
  communication.
- If you make the widget's root actor clickable (see §8), remember
  `reactive` defaults to `false` on every actor in the Widget Layer —
  you opt in yourself, and you're sharing that actor's
  `button-press-event` with the host's own Super+drag handler.

### Note on `stylesheet.css`

As of this writing, the host does **not** load a widget's own
`stylesheet.css` into the Shell's theme context automatically. Ship one
anyway for documentation/class-name hooks, but drive the actual look from
inline St `style` strings set in `widget.js` (`actor.set_style(...)`) —
see `widgets/clock-modern/widget.js` or `widgets/calendar-modern/widget.js`
for the pattern this project already uses everywhere.

## 4. `prefs.js` (optional)

```js
export default class MyWidgetPrefs {
    /** @param {WidgetSettingsHandle} settings - scoped to this widget only */
    constructor(settings) {
        this._settings = settings;
    }

    // Must return a Gtk.Widget (Adw.PreferencesPage recommended) — the
    // Control Center embeds whatever you return here.
    buildPrefsWidget() {
        const page = new Adw.PreferencesPage();
        // ... Adw.PreferencesGroup / Adw.SwitchRow / Adw.SpinRow / Adw.EntryRow
        // / Gtk.ColorDialogButton / Gtk.FileDialog, all wired to this._settings ...
        return page;
    }
}
```

Runs in the **separate prefs (GTK4) process** — completely apart from
`widget.js`. **Never** import `St`/`Clutter`/`Meta`/`Shell` here, and don't
import anything from `widget.js` either. `Gio`, `GLib`, `Gtk`, `Gdk`, and
`Adw` are all fine (the project's own `prefs.js` uses all five).

**If both `metadata.json`'s `settings` array (§6.1) and a hand-written
`prefs.js` are present, `prefs.js` always wins** — it's treated as the
author deliberately opting out of auto-generation, since hand-written code
can always do more than a schema (file pickers, custom layout, anything
`§6.1`'s types don't cover).

## 5. `WidgetAPI` — what the host passes into `widget.js`

| Property/Method | Description |
|---|---|
| `api.settings` | Read/write object bound to this widget's own settings file (§7). The **same object** is live-updated if the Control Center (a different process) changes a value — see `onSettingsChanged()` in §3. |
| `api.monitorInfo` | Current monitor info (geometry, scale). |
| `api.position` | Current widget position + `setPosition(x, y, monitorIndex)`. |
| `api.bus.emit(name, data)` / `api.bus.on(name, cb)` | Central event bus for widgets that opt in to talking to each other. |
| `api.path.me` | Absolute path (string) to this widget's own folder on disk — for reading a bundled asset (icons/, a template, etc.) that ships alongside `widget.js`. |
| `api.path.id(widgetId)` | Absolute path (string) to another widget's folder by id, or `null` if no widget with that id is installed. Works for any discovered widget, loaded or not. |
| `api.logger` | Logging pre-tagged with this widget's id. |

## 6. Settings — three systems, two of them wired up

There are now **three** declarative-or-semi-declarative settings
mechanisms in this codebase. Widget authors should default to §6.4
`config.json` (or a hand-written §6.2 `prefs.js` for anything §6.4 can't
express) — §6.1's flat `settings` array is kept for widgets that predate
config.json, and §6.3 exists in `lib/` but is not called from anywhere in
the live extension today.

Every bundled widget that used to ship a hand-written `prefs.js`
(`clock`, `clock-modern`, `calendar-modern`, `calendar-header`,
`calendar-minimal`, `media-player`) now ships a `config.json` instead —
`prefs.js` was deleted from each of those folders, and `metadata.json`'s
`"prefs"` field was removed along with it. `mini-notes` and
`system-stats` are untouched: they already used §6.1's `settings` array
and never had a `prefs.js` to begin with.

### 6.1 Legacy flat path: `metadata.json`'s `settings` array

Declare fields directly in `metadata.json` and the Control Center
generates a real GTK4/libadwaita page for you via
`lib/settingsSchemaUI.js` — no `Gtk`/`Adw` knowledge needed for ordinary
settings:

```json
{
  "id": "clock",
  "settings": [
    { "id": "format24h", "type": "boolean", "label": "24-hour format", "default": true },
    { "id": "fontSize", "type": "range", "label": "Font size", "description": "Size in points",
      "default": 32, "min": 12, "max": 96, "step": 1 },
    { "id": "accentColor", "type": "color", "label": "Accent color", "default": "#3584e4" },
    { "id": "labelFont", "type": "font", "label": "Label font", "default": "Sans Bold 12" },
    { "id": "iconSize", "type": "size", "label": "Icon size", "description": "Pixels",
      "default": 32, "min": 16, "max": 128, "step": 1 }
  ]
}
```

**Supported types (v1):** `string`, `number`, `range`, `boolean`,
`dropdown`, `color`, `font`, `size`. Field-level validation rules live in
`lib/settingsSchema.js`'s `validateSettingsSchema()` — e.g. `range`/`size`
(if `min`/`max` are declared) need both as matching numbers, `dropdown`
needs `options`, `font` needs a string `default` like `"Sans 10"`.

- `size` differs from `range`: `min`/`max` are **optional** (default
  0–10000px if omitted) — for "a normal pixel size, no hard bound needed",
  vs. `range` which always requires both. Value read from `api.settings`
  is a plain pixel number either way.
- `font` is read/written as a **plain string** — the result of
  `Pango.FontDescription.to_string()`, e.g. `"Sans Bold 12"`. `widget.js`
  doesn't need to import Pango; parse the string yourself if you need
  family and size separately.

**Not supported this way (out of scope in v1):** `file`, `folder`,
`desktop-file`, `command`, `date`, `time`, `password`, `url`, `icon`,
and structural fields (`label`/`separator`/`group`). Write a hand-rolled
`prefs.js` (§4) for any of these — e.g. `clock-modern`'s "browse a
`.desktop` file to launch on click" row uses a raw `Gtk.FileDialog`
because `file`/`desktop-file` aren't schema types.

**Validation:** a malformed `settings` array (duplicate `id`, unknown
`type`, `range` missing `min`/`max`, etc.) fails the **whole widget** —
it won't load, and shows up in the Control Center's error list exactly
like a broken `metadata.json` (see `WidgetLoader.discover()`).

**Defaults:** always come from `settings[].default`, merged with (and
overridable by) `getDefaultSettings()` if a key appears in both — same
merge behavior as defaults that only come from `getDefaultSettings()`.

### 6.2 Hand-written `prefs.js` (recommended for anything §6.1 can't express)

Every bundled widget so far (`clock`, `calendar-modern`, `clock-modern`)
actually ships a hand-written `prefs.js` instead of a `metadata.json`
`settings` array — it's the more common real-world path today, not just a
fallback, and it's the only option for file pickers, custom validation,
conditional rows beyond `showIf` (§6.3), or anything with a "Browse…"
button. See §4 for the contract, and `widgets/clock-modern/prefs.js` for a
full example including a `Gtk.FileDialog` filtered to `.desktop` entries.

### 6.3 `lib/settingsApi.js`'s fluent builder — implemented, but NOT wired up

`lib/settingsApi.js` (plus `lib/settingsRenderer.js` and
`lib/settingsStore.js`) implement a **third**, more expressive way to
declare settings: a per-widget `settings.js` file exporting
`defineSettings(gwc)`, using a chainable builder —

```js
// widgets/my-widget/settings.js
function defineSettings(gwc) {
    gwc.settings
        .group('Appearance')
        .setFont('fontFamily', { label: 'Font', default: 'Cantarell 11' })
        .setColor('accentColor', { label: 'Accent Color', default: '#3584e4' })
        .option('layout', { 1: 'Compact', 2: 'Comfortable', 3: 'Custom' }, { label: 'Layout', default: 1 })
        .setRange('customSpacing', { label: 'Spacing', min: 0, max: 32, default: 8 })
        .showIf('layout', '3')

        .group('Behavior')
        .setBoolean('showHeader', { label: 'Show Header', default: true })
        .setDate('startDate', { label: 'Start Date' })
        .setText('customLabel', { label: 'Custom Label', placeholder: 'My Widget' })
        .setMultiOption('activeDays', { 1: 'Mon', 2: 'Tue', 3: 'Wed' }, { label: 'Active Days' })
        .setAction('resetCache', {
            label: 'Cache', buttonLabel: 'Clear Cache', destructive: true,
            onActivate: (store) => store.setMany({ startDate: null }),
        });
}
```

Types available here: `font`, `color`, `date`, `boolean`, `option`,
`number`, `range`, `text`, `action`, `icon`, `multiOption` — a superset of
§6.1's types (adds `date`, `action`, `multiOption`, and unconditional
`showIf`-based conditional visibility). `setIcon`/`option` pair nicely
with reverse-DNS icon names, e.g. from the wildfire symlink script.

**Why this isn't in §6.1's recommendation:** `lib/settingsApi.js`,
`lib/settingsRenderer.js`, and `lib/settingsStore.js` are pure/GTK logic
with **no wiring into the real, ESM-based `extension.js`/`prefs.js`** this
project actually ships. The only place that calls
`GwcSettingsRenderer`/`GwcSettingsStore`/`GwcSettingsApi` is
`prefs/integration-example.js`, which says outright in its own header
comment that it is *"not a real file the engine loads — just a reference
snippet"* — and it (along with `settingsStore.js`/`settingsRenderer.js`)
uses the legacy global `imports.gi` / `imports.lib.*` syntax from
pre-GNOME-45 extensions, not the `import ... from 'gi://...'` ES-module
syntax `extension.js`/`prefs.js`/every bundled widget actually uses.

**Practical takeaway:** if you write a `widgets/my-widget/settings.js`
today, nothing in the shipped extension will ever call it. Use §6.1 or
§6.2. Treat §6.3 as a documented-but-dormant API — worth knowing about
(the type list is richer, and `showIf` is genuinely nice), but don't build
a real widget's only settings path on it until something in `extension.js`
or `prefs.js` actually imports `settingsRegistry`/`GwcSettingsRenderer` via
`gi://`-style ESM. If you're the one wiring it up, that's an intentional
API addition (touches `widgetLoader.js`'s widget discovery and this file
together), not something to do as a side effect of an unrelated change.

### 6.4 New recommended default: `config.json` (tabs/groups/fields)

Drop a `config.json` next to `metadata.json` in your widget's folder and
the Control Center generates a real GTK4/libadwaita page for you via
`lib/widgetConfigUI.js` — no `Gtk`/`Adw` knowledge needed, same pitch as
§6.1 but with a much larger type list and a two-level tabs/groups
structure instead of one flat array:

```json
{
  "version": "1.0",
  "tabs": [
    {
      "id": "general",
      "label": "Clock",
      "description": "Clock widget settings",
      "groups": [
        {
          "id": "clock",
          "label": "Clock settings",
          "description": "",
          "fields": [
            {
              "id": "format24h",
              "label": "24-hour format",
              "description": "Show time as 14:30 instead of 2:30 PM",
              "dataType": "boolean",
              "fieldType": "switch",
              "default": true
            },
            {
              "id": "fontSize",
              "label": "Font size",
              "description": "Size of the time text, in pixels",
              "dataType": "integer",
              "fieldType": "spinbutton",
              "default": 32,
              "min": 10,
              "max": 96,
              "step": 1,
              "suffix": "px"
            }
          ]
        }
      ]
    }
  ]
}
```

**Supported `fieldType`s:** `text`, `textarea`, `password`, `switch`,
`checkbox`, `dropdown`, `radio`, `spinbutton`, `slider`, `colorpicker`,
`fontpicker`, `iconpicker`, `filepicker`, `folderpicker`, `list`,
`object` — a strict superset of §6.1's eight types, covering every type
§6.1 explicitly calls out as "out of scope" (`file`, `folder`, `date`,
`time`, `password`, `url`, `icon`) plus structural nesting (`list`,
`object`) that neither §6.1 nor §6.3 has.

**`list` has two "add" flows depending on `item.fieldType`:** for every
ordinary item kind (`text`, `spinbutton`, `switch`, `dropdown`, etc), an
inline input control matching that type sits directly before the "+"
button — clicking "+" appends whatever's currently in it and clears it
for the next entry, rather than adding a blank item to edit in place. The
one exception is `item.fieldType: "application"`: each item is an
installed app's `.desktop` path, rendered with the app's real icon and
display name (via `Gio.DesktopAppInfo`) and a red trash-icon remove
button — reference: xenlism's own `URL-Chooser` app's `settings.js`
"browser_list" panel, a real, working, non-declarative implementation of
this same picker. "+" opens a `Gtk.FileDialog` scoped to
`item.scanDirectory` (default `/usr/share/applications`) instead of
showing an inline field (there's no sensible "type a `.desktop` path by
hand" input), and a second button next to it
(`find-location-symbolic`, matching URL-Chooser's own "auto-detect"
button) bulk-adds every not-yet-present `.desktop` entry in that
directory, optionally narrowed by `item.scanPattern` (a case-insensitive
regex matched against the filename) — a generic, config-declared stand-in
for URL-Chooser's own hardcoded-to-browsers `Core.autoDetectBrowsers()`.
`application` also works as a **standalone** (non-list) `fieldType` for
"pick one installed app" fields, using the same `Gtk.FileDialog`-scoped-
to-`scanDirectory` picker and icon/name resolution.

**`fontpicker` stores one combined string, not a family/size pair:**
`lib/widgetConfigUI.js` renders it with `Gtk.FontButton`
(`use_font`/`use_size` both on, `font_set` signal) — the same widget and
signal xenlism's own `showtime` extension uses in its shipped, real-
hardware-tested `prefs.js` — rather than the newer GTK 4.10+
`Gtk.FontDialogButton`/`Gtk.FontDialog` pair. Its value is always one
Pango font-description string like `"Sans Bold 30"` (face + style +
point size together), matching `Gtk.FontButton.get_font()`'s native
return shape. A widget that renders with Pango markup can pass that
string straight through as a `font_desc=` attribute with no parsing at
all; one that paints with St's CSS-like `set_style()` instead (separate
`font-family`/`font-size` properties, per this doc's own inline-styling
convention) needs to split the string back apart at render time — see
`widgets/clock-modern/widget.js`'s `_parseFontDescription()` for the
pattern (`Pango.FontDescription.from_string()`, read `get_size()`, then
`unset_fields(Pango.FontMask.SIZE)` + `to_string()` for the family+style
portion without the point size baked in).

**Validation:** `lib/widgetConfigValidator.js`'s `validateConfig()` — a
malformed `config.json` (duplicate tab/group/field `id`, unknown
`dataType`/`fieldType`, `dropdown`/`radio` missing `options`, invalid
`pattern` regex, `min > max`, etc.) does **not** fail the whole widget
the way a malformed §6.1 `settings` array does: it only affects the
*settings page*, so `widgetConfigReader.js` fails soft — the widget still
loads and renders on the desktop, and prefs.js falls back to a
hand-written `prefs.js` or `settings` array if either is also present, or
logs the validation errors and shows no Settings button if not.

**Structure:** `tabs` -> `groups` -> `fields`, each with a unique `id`
within its parent. Since `products/extension/prefs.js`'s
`_presentPrefsPage()` expects a single `Adw.PreferencesPage` back from
whatever builds a widget's settings page (same contract a hand-written
`prefs.js`'s `buildPrefsWidget()` already follows), `widgetConfigUI.js`
flattens `tabs` into `Adw.PreferencesGroup`s rather than real GTK
notebook tabs — a group's title becomes `"Tab Label — Group Label"` when
a widget declares more than one tab, or just `"Group Label"` for the
(common) single-tab case.

**Conditional fields:** `visibleIf` / `enabledIf` / `dependsOn` accept a
small boolean expression over other field ids in the same config — `!`,
`==`, `!=`, `&&`, `||` (no parentheses), e.g.
`"visibleIf": "launchOnClick"` or `"enabledIf": "layout == 'custom'"`.

**Precedence when a widget has more than one settings mechanism:**
`config.json` > hand-written `prefs.js` (§6.2) > `settings` array (§6.1)
— see `products/extension/prefs.js`'s `_openWidgetPrefs()` doc comment.
config.json is meant to fully replace `prefs.js` for a given widget, not
merge with it, matching how §6.1 already treated a widget with both a
schema and a hand-written `prefs.js`.

**Defaults:** come from each field's `default`, same merge-with-
`getDefaultSettings()` behavior as §6.1 (see `getConfigDefaults()` in
`widgetConfigValidator.js`) — a widget's own `widget.js` is still the
source of truth for runtime defaults; `config.json`'s `default` values
only affect what a settings row shows before the user has ever touched
it.

**`fieldType: "autocomplete"`** — a generic entry-with-suggestions field.
It contains no business logic of its own; it only shows an entry, calls a
search function the widget author supplies, renders whatever comes back,
and stores the selection. All business logic lives in the widget's own
`autocomplete.js`, loaded from the widget's own folder (`api.path.me` for
`widget.js`; the prefs process resolves the same folder via the `path`
argument to `buildConfigPage()`).

```json
{
  "id": "place",
  "label": "Place",
  "description": "",
  "dataType": "string",
  "fieldType": "autocomplete",
  "autocomplete": "searchPlace",
  "fillsField": "location",
  "default": ""
}
```

- `autocomplete` (required, string) — the name of an exported `async
  function(keyword)` in this widget's `autocomplete.js`. One file may
  export several such functions; multiple fields can share the file while
  naming different functions.
- `fillsField` (optional, string) — see below.
- `pattern` (optional, like any other field) — e.g. a lat/lon field can
  set `"pattern": "^-?\\d+(\\.\\d+)?,-?\\d+(\\.\\d+)?$"` for the same
  regex-on-blur validation §6.4's plain `text` fields already get.

The search function returns an array of result objects. Minimum
contract:

```json
[{"label": "White", "value": "#FFFFFF"}]
```

Optional properties: `subtitle`, `icon`, `image`, `badge`, `data`, and
`fields` (see below). Only `value` is ever persisted to settings — the
entry displays `label`, and no hidden `Gtk.Entry` is involved.

**Cross-field fill (`fields`):** a result item may include a `fields` map
of `{otherFieldId: value}`. Selecting that suggestion writes each entry to
the named sibling field's setting AND, if that sibling is itself an
`autocomplete`/`text`-style row in the same config, updates its displayed
text too — this is how a Location Picker's "Place" and "Location" fields
stay in sync from either side (see
`widgets/weather-minimal/autocomplete.js` for a working
`searchPlace`/`searchLocation` pair built on Open-Meteo's free geocoding
API). `fillsField` on the field itself is documentation only — a hint for
readers of `config.json` about which sibling this field is paired with —
the actual fill happens via each result's `fields` map, not the schema
field.

**Known limitation:** only `value` persists between sessions, so on first
load an autocomplete row shows the raw stored value (e.g.
`13.756331,100.501762`) rather than a resolved `label`, until the user
searches/selects again.

## 7. On-disk settings format (applies to §6.1, §6.2, and §6.4)

```
~/.config/gnome-widget-center/
├── layout.json                # x/y/monitor for every widget (host-owned)
└── widgets/
    ├── clock.json
    ├── my-widget.json
    └── ...
```

```json
{
  "_schemaVersion": 1,
  "format24h": true,
  "showSeconds": false,
  "fontSize": 32
}
```

`lib/widgetSettings.js`'s `WidgetSettings` class owns this: loads the
file (creating it from `getDefaultSettings()` if missing, merging in any
new default keys an updated widget introduces), and returns a **proxy**
that auto-saves on every write (~300ms debounce). `_schemaVersion` is
yours to bump and branch on if you ever need to migrate a widget's
settings shape. Widget settings are plain JSON files on purpose — no
GSettings schema to compile, no system-level install step, just drop a
folder in and go (see `development/docs/SETTINGS_SPEC.md` for the full
GSettings-vs-JSON tradeoff writeup). Host-level settings (disabled widget
list, dev-mode) are the one exception and do use GSettings, compiled into
this extension's own `schemas/` folder — that's unrelated to anything a
widget author needs to touch.

## 8. Making a widget clickable / launchable

There's no dedicated "on click" hook in `WidgetAPI` — wire it yourself in
`buildActor()`/`enable()`:

```js
this._actor.reactive = true; // off by default in the Widget Layer
this._pressId = this._actor.connect('button-press-event', (_actor, event) => {
    if (event.get_button() !== Clutter.BUTTON_PRIMARY)
        return Clutter.EVENT_PROPAGATE;
    if (event.get_state() & Clutter.ModifierType.MOD4_MASK)
        return Clutter.EVENT_PROPAGATE; // Super held - let drag-to-reposition handle it
    // ... your click behavior ...
    return Clutter.EVENT_STOP;
});
```

Disconnect `_pressId` in `disable()` like any other signal (§3). The
Super-modifier check matters: `lib/dragController.js` attaches its own
`button-press-event` handler to the same actor for Super+drag
repositioning, and only consumes the event (`EVENT_STOP`) when Super is
held — a plain click always propagates to your handler too, so the two
never conflict as long as you check for Super the same way.

To launch an installed app (rather than shelling out to a raw command
string), use `Gio.DesktopAppInfo`, the same mechanism GNOME Shell itself
uses for `.desktop` entries:

```js
import Gio from 'gi://Gio';
const appInfo = Gio.DesktopAppInfo.new_from_filename(desktopFilePath);
if (appInfo)
    appInfo.launch([], null);
```

Let the user pick `desktopFilePath` via a `Gtk.FileDialog` in `prefs.js`
filtered to `application/x-desktop` / `*.desktop` (§6.1 has no `file` type
— this is exactly the kind of thing that needs §6.2). See
`widgets/clock-modern/prefs.js` and `widgets/clock-modern/widget.js` for a
complete worked example.

## 9. Accessing external system state from `widget.js`

### 9.1 DBus services (e.g. media players via MPRIS2)

```js
import Gio from 'gi://Gio';

const proxy = new Gio.DBusProxy.new_for_bus_sync(
    Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
    'org.mpris.MediaPlayer2.<player-name>', '/org/mpris/MediaPlayer2',
    'org.mpris.MediaPlayer2.Player', null
);

const metadata = proxy.get_cached_property('Metadata')?.deep_unpack();
proxy.call('PlayPause', null, Gio.DBusCallFlags.NONE, -1, null, null);
proxy.connect('g-properties-changed', (_p, changed) => { /* ... */ });
```

Must-follow: handle the target service not existing at all (`buildActor()`
must never throw — show a placeholder/empty state instead); subscribe via
signals (`g-properties-changed`, or `NameOwnerChanged` on
`org.freedesktop.DBus`) rather than polling with `GLib.timeout_add`;
disconnect every proxy/signal in `disable()`; never write externally-read
data (e.g. "now playing" title) into your own settings file — that's
transient state, not a user preference, keep it in a plain instance
field; document your selection behavior if more than one instance of the
target service can exist (e.g. "first one found", not a crash or a
random pick).

### 9.2 System metrics (CPU/RAM/network)

```js
import {SystemMetricsService} from '../../lib/systemMetricsApi.js';
// bundled widgets only - see the path restriction below

this._metrics = new SystemMetricsService(); // one instance per widget instance

this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
    const {cpu, memory, network, devices} = this._metrics.sample();
    return GLib.SOURCE_CONTINUE;
});
```

| Method | Returns |
|---|---|
| `getCpuUsage()` | `{percent}` since the last call (first call always 0) |
| `getMemoryUsage()` | `{totalKb, availableKb, usedKb, percent}` — instantaneous, no history needed |
| `getNetworkUsage()` | `{interfaces: [...], totalRxBytesPerSec, totalTxBytesPerSec}` since the last call (first call always 0) |
| `listNetworkDevices()` | `[{name}]` — everything found, including `lo` |
| `sample()` | all four combined in one call — convenient for a single timer |

**Path restriction:** the relative import above only works for widgets
bundled inside this extension (like `system-stats`). Third-party widgets
installed under `~/.local/share/gnome-widget-center/widgets/` **cannot**
import this file — there's no path connecting the two folders (same
restriction as `lib/mediaApi.js` in §9.1), and it isn't exposed as
`api.system` yet. Exposing it that way would be an intentional API
addition (`widgetLoader.js`'s `_buildApi()` + this doc, together), not a
side effect of something else.

Must-follow: never call these from a timer tighter than actually needed
(each call re-reads `/proc/*`; 1–10s, like `system-stats`'s own default,
is the right ballpark); one `SystemMetricsService` per widget *instance*
(sharing one across widgets corrupts the CPU%/network delta state); the
first `getCpuUsage()`/`getNetworkUsage()` call always returns 0 (no prior
sample to diff against) — call once and discard during `enable()` if you
need a correct value from the very first real frame.

## 10. Minimum supported version

- GNOME Shell 45+ (ES module extension API) — developed and tested mainly
  on GNOME 50 / Wayland.
- If a widget needs a feature only present on a newer Shell, declare it
  via `shell-version` in `metadata.json`.

## 11. Checklist before shipping a widget

- [ ] `buildActor()` never throws, even with settings still empty
- [ ] `disable()` cleans up everything `enable()` started
- [ ] Tested across monitor switch/unplug/resolution change
- [ ] Tested across screen lock/unlock (widget must never appear on the
      lock screen)
- [ ] No hardcoded paths, no dev-machine absolute paths
