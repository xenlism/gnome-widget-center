# WIDGET_API.md — the widget author contract

This is the one file a widget author needs to build a new widget for
**GNOME Widget Center**, without knowing anything about the internals of
`products/gnome-widget-center@xenlism.github.io/`. It covers the widget
lifecycle contract and a full write-up of every settings system available
in this codebase today.

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
  "block-type": "1x1",
  "default-position": { "x": 40, "y": 40, "monitor": 0 }
}
```

- `id` must match the folder name and be globally unique — the host
  rejects duplicates.
- `api-version` is a compatibility check. A breaking host API change
  bumps this; widgets built against an older number are disabled with a
  notice instead of crashing.
- `block-type` (a **name**, not `{cols, rows}`) is the on-screen size **in
  grid cells**, not pixels (see
  `development/architecture/specs/ui/size-constraints.md` — the
  block-type system) and `lib/blockSizeManager.js`'s `BLOCK_TYPES` table
  for the authoritative list. The host multiplies the resolved cols/rows
  by `BlockSizeManager.BLOCK_CELL_SIZE` (currently 16px/cell) when placing
  the widget. Names read as `<colsTier>x<rowsTier>`, where tier bar/1/2/3/4 map to
  5/11/23/35/47 cells (NOT literal cols×rows — check the table for the
  real cell counts):

  | name    | cols × rows |
  |---------|-------------|
  | `barx1` | 11 × 5      |
  | `barx2` | 23 × 5      |
  | `barx3` | 35 × 5      |
  | `barx4` | 47 × 5      |
  | `1x1`   | 11 × 11     |
  | `2x1`   | 23 × 11     |
  | `2x2`   | 23 × 23     |
  | `3x1`   | 35 × 11     |
  | `3x2`   | 35 × 23     |
  | `3x3`   | 35 × 35     |
  | `4x1`   | 47 × 11     |
  | `4x2`   | 47 × 23     |
  | `4x3`   | 47 × 35     |
  | `4x4`   | 47 × 47     |

  This is a **closed** list — these 10 sizes only, nothing else. Omit
  the field entirely (or use an unrecognized name) and you get `1x1`
  (10 × 10 cells). This size is fixed: **no min/max, and the user cannot
  resize it themselves** (there is no `size-constraints` field). A legacy
  `{cols, rows}` object shape is still accepted for backward compatibility
  — sanitized/remapped rather than trusted as-is — but new widgets should
  pick directly from the table above.
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
- `dependencies` (optional object) — system binaries this widget needs
  that aren't guaranteed to exist on every distro (most widgets need
  none of this — pure GJS/DBus code needs nothing declared here at all).
  Checked via `lib/dependencyChecker.js` (`GLib.find_program_in_path()`,
  no subprocess spawn) both by a `.gwct` theme import
  (`lib/exportService.js`) and, in future, a widget-install flow — never
  enforced automatically at load time, just surfaced as a warning so a
  missing binary fails with a clear message instead of an obscure crash
  the first time the widget tries to use it.

  ```json
  "dependencies": {
    "system": [
      {
        "bin": "playerctl",
        "reason": "Needed to control playback for non-MPRIS players.",
        "package": { "apt": "playerctl", "dnf": "playerctl", "pacman": "playerctl" }
      }
    ]
  }
  ```

  Only `bin` is required. `package` is an optional hint map (keyed by
  package manager name) used purely to suggest an install command for
  whichever package manager is actually present — it's never run
  automatically.

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

## 6. Settings — four systems, in order of precedence

This codebase has four declarative-or-semi-declarative settings
mechanisms. Widget authors should default to §6.4 `config.json` (or a
hand-written §6.2 `prefs.js` for anything §6.4 can't express). §6.3
`settings.js` is fully wired up but rarely needed since `config.json`
covers more ground with no code at all. §6.1's flat `settings` array is
legacy — kept for widgets that predate `config.json`.

Precedence when a widget somehow ships more than one: `config.json`
(§6.4) > hand-written `prefs.js` (§6.2) > `settings.js` (§6.3) > the
legacy `metadata.json` `settings` array (§6.1). In practice a widget
should only ever have ONE of these.

Most bundled widgets (`clock`, `clock-modern`, `calendar-modern`,
`calendar-header`, `calendar-minimal`, `media-player`) ship a
`config.json`. `mini-notes` and `system-stats` still use §6.1's legacy
`settings` array.

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

### 6.3 `lib/settingsApi.js`'s fluent builder

`lib/settingsApi.js` (plus `lib/settingsRenderer.js` and
`lib/settingsStore.js`) implement a **third**, more expressive way to
declare settings: a per-widget `settings.js` file exporting
`defineSettings(gwc)`, using a chainable builder —

```js
// widgets/my-widget/settings.js
export function defineSettings(gwc) {
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

**Status:** `lib/settingsApi.js`, `lib/settingsRenderer.js`, and
`lib/settingsStore.js` are plain ESM (`import`/`export`, `gi://...`
imports) and are wired into `prefsWindowController.js`.
`prefsWidgetList.js` reports `hasSettingsJs` for any widget shipping a
`settings.js`, and `_openWidgetPrefs()` dynamically imports it
(`_openWidgetSettingsJsPrefs()`) exactly the way it already does for a
hand-written `prefs.js` (§6.2) — see that file for the details.
`prefs/integration-example.js` is a short, standalone illustration of the
same wiring for anyone who wants to read it without
`prefsWindowController.js`'s window-management code around it.

**Storage note:** `SettingsStore` (this path only) persists to its own
location, `~/.local/share/gnome-widget-center/settings/<id>.json` —
deliberately separate from `widgets/<id>.json`/`WidgetSettings`, which
§6.1/§6.2/§6.4 all share. A widget using `settings.js` should use ONLY
`gwc.settings`/its `SettingsStore` for its settings, not also read/write
`api.settings` from `widget.js` expecting the same values — they are two
different files on disk.

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

**Supported `fieldType`s:** `text`, `location`, `textarea`, `password`,
`switch`, `checkbox`, `dropdown`, `radio`, `spinbutton`, `slider`,
`colorpicker`, `fontpicker`, `iconpicker`, `filepicker`, `folderpicker`,
`list`, `object` — a strict superset of §6.1's eight types, covering every type
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
within its parent. Since `lib/prefsWindowController.js`'s
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

**Precedence:** see §6's opening for the full order — `config.json` wins
outright over any other settings mechanism a widget might also ship,
matching how §6.1 already treats a widget with both a schema and a
hand-written `prefs.js`. See `prefsWindowController.js`'s
`_openWidgetPrefs()` doc comment for the implementation.

**Defaults:** come from each field's `default`, same merge-with-
`getDefaultSettings()` behavior as §6.1 (see `getConfigDefaults()` in
`widgetConfigValidator.js`) — a widget's own `widget.js` is still the
source of truth for runtime defaults; `config.json`'s `default` values
only affect what a settings row shows before the user has ever touched
it.

**`fieldType: "location"`** — a plain `text`-style "lat,lon" entry (same
validation as `text`: `pattern`/`minLength`/`maxLength`/`required`, saved
on every valid keystroke) with one extra built-in feature: a
`find-location-symbolic` suffix icon button that looks up the caller's
approximate coordinates from their IP address and fills them straight
into the field.

```json
{
  "id": "location",
  "label": "Location",
  "description": "Coordinates as latitude,longitude - e.g. 15.1111,85.2555",
  "dataType": "string",
  "fieldType": "location",
  "pattern": "^-?\\d{1,2}(\\.\\d+)?\\s*,\\s*-?\\d{1,3}(\\.\\d+)?$",
  "default": "13.756331,100.501762"
}
```

The lookup itself (`ip-api.com`, then `freeipapi.com`, then `ipwhois.io`
as fallbacks — the same free, no-API-key endpoints and order every
weather widget's own `widget.js` already uses for its first-run
auto-detect default) lives once in `lib/widgetConfigUI.js`
(`_locationRow()`/`_fetchIpLocationForPrefs()`), not in any per-widget
file — every widget that declares `fieldType: "location"` gets
identical UI and behavior for free, no `autocomplete.js` required. See
`widgets/weather-dark/config.json`, `widgets/weather-minimal/config.json`,
and `widgets/weather-modern/config.json` for three widgets sharing this
one field type. See `PROJECT_STATUS.md` if you want the history of how
each widget's location field got here.

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
text too — this is how a two-field "Place" + "Location" pair (one
`autocomplete` field, one `text` field, wired together via a search
function's `fields` map) can stay in sync from either side. No bundled
widget currently uses `fieldType: "autocomplete"` — the simpler,
single-field `fieldType: "location"` above covers every weather widget's
needs — but the mechanism remains available for a widget that genuinely
needs free-text search-as-you-type suggestions (e.g. picking from a
large, non-enumerable list) rather than just an IP-based default.
`fillsField`
on the field itself is documentation only — a hint for readers of
`config.json` about which sibling this field is paired with — the actual
fill happens via each result's `fields` map, not the schema field.

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

For bundled widgets, use `lib/mediaApi.js`'s `MprisMediaService` instead
of talking to `Gio.DBusProxy` directly — it already handles player
discovery, `NameOwnerChanged` tracking, signal cleanup, and GVariant
unpacking:

```js
import {MprisMediaService} from '../../lib/mediaApi.js';
// bundled widgets only - see the path restriction below

this._media = new MprisMediaService(api.logger);

enable() {
    this._media.start((state) => {
        // state is `MediaState | null` - null when no MPRIS player is
        // currently attached. See the state shape in mediaApi.js's
        // MediaState typedef (title, artist, album, status, artUrl,
        // lengthMs, positionMs, volume, shuffle, loopStatus, appName,
        // busName, trackId, and the canControl/canPlay/canPause/canSeek/
        // canGoNext/canGoPrevious/canRaise/canQuit capability flags).
    });
}

disable() {
    this._media.stop();
}
```

Playback controls: `playPause()`, `play()`, `pause()`, `stopPlayback()`,
`next()`, `previous()`, `seek(offsetMs)`, `setVolume(0..1)`,
`setShuffle(bool)`, `setLoop(mode)`, `raise()`, `quit()`. See
`widgets/media-player/widget.js` for a complete worked example.

**Path restriction:** the relative import above only works for widgets
bundled inside this extension (like `media-player`). Third-party widgets
installed under `~/.local/share/gnome-widget-center/widgets/` **cannot**
import this file — there's no path connecting the two folders (same
restriction as `lib/systemMetricsApi.js` in §9.2), and it isn't exposed
as `api.media` yet. Exposing it that way would be an intentional API
addition (`widgetLoader.js`'s `_buildApi()` + this doc, together), not a
side effect of something else.

A third-party widget (or a bundled widget talking to a DBus service
`mediaApi.js` doesn't cover) still works directly against
`Gio.DBusProxy`:

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

Must-follow either way: handle the target service not existing at all
(`buildActor()` must never throw — show a placeholder/empty state
instead); subscribe via signals (`g-properties-changed`, or
`NameOwnerChanged` on `org.freedesktop.DBus`) rather than polling with
`GLib.timeout_add`; disconnect every proxy/signal in `disable()` (or call
`stop()` on the service); never write externally-read data (e.g. "now
playing" title) into your own settings file — that's transient state,
not a user preference, keep it in a plain instance field; document your
selection behavior if more than one instance of the target service can
exist (`mediaApi.js` picks the first MPRIS name found — document the
same choice if you roll your own).

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

### 9.3 Shared visual helpers (shadow, color, font)

`lib/widgetVisualKit.js` holds the small pure-function helpers almost
every card-style widget needs: drop-shadow CSS, hex/rgba color
conversion, and Pango font-description parsing. Import the pieces you
need instead of pasting a local copy:

```js
import {
    SHADOW_DEFAULTS,
    shadowBoxShadowCss,
    hexToRgba,
    toCssColor,
    parseFontDescription,
} from '../../lib/widgetVisualKit.js';
// bundled widgets only - see the path restriction below
```

| Export | Use it for |
|---|---|
| `SHADOW_DEFAULTS` | spread into `getDefaultSettings()`: `...SHADOW_DEFAULTS` |
| `shadowBoxShadowCss(settings)` | build the `box-shadow: ...;` fragment for `set_style()` |
| `hexToRgba(hex)` | `"#rrggbb"`/`"#rrggbbaa"` → `{r,g,b,a}` (0..1) for Cairo `setSourceRGBA()` |
| `toCssColor(hex, fallback)` | 8-digit `"#rrggbbaa"` → `"rgba(...)"` for St CSS (St doesn't understand 8-digit hex) |
| `parseFontDescription(fontStr, fallbackFamily, fallbackSize)` | one Pango string (`"Sans Bold 22"`) → `{family, size}` for St's separate `font-family`/`font-size` |

**Path restriction:** same as §9.1/§9.2 — the relative import only
resolves for widgets bundled inside this extension. Third-party widgets
under `~/.local/share/gnome-widget-center/widgets/` cannot reach this
file and must keep their own local copy of any of these helpers they
need.

Do **not** re-introduce a local `_shadowBoxShadowCss()`/`_hexToRgba()`/
`_toCssColor()`/`_parseFontDescription()` in a new bundled widget — copy
the import above instead. (Earlier bundled widgets each carried their own
byte-identical copy of these; that's been consolidated here as of the
2026-08 cleanup pass. If you're editing an old widget and still find a
local copy, replace it with this import while you're in there.)

**Shadow bleed past the block-type edge:** a widget's `box-shadow` is
painted on the same root actor `widgetLoader.js`'s `_enforceBlockSize()`
clips to the block-type footprint - by default that clip is exact, so a
large `shadowBlur`/`shadowDistance` gets visibly cut off at a hard,
dead-straight line right at the widget's edge instead of fading out.
As of the 2026-08 cleanup pass this is no longer a hard 0px clip: the
clip is inflated by the current `widget-spacing` GSetting value (default
16px) in every direction, so a shadow can bleed that far past the
block-type edge before being cut - deliberately capped at exactly
`widget-spacing` (not more) so a bled shadow can never reach into a
neighboring widget's own footprint, since that's the minimum gap
`lib/layoutEngine.js`'s collision-avoidance already guarantees between
any two widgets while `prevent-widget-overlap` is on. Nothing in
`widget.js` needs to change to get this - it's applied centrally, the
same as the block-size clip itself always was. If `prevent-widget-overlap`
is off, collision-avoidance (and therefore this guarantee) is skipped
entirely, same as it always has been for that setting.

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
