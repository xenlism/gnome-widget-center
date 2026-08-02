---
name: gnome-widget-center-widget
description: "Use this skill whenever building, extending, or debugging a widget for the gnome-widget-center GNOME Shell extension — i.e. anything under widgets/<id>/ (metadata.json, widget.js, config.json, prefs.js, settings.js, stylesheet.css) in the products/gnome-widget-center@xenlism.github.io/ extension folder. Trigger on requests like \"build a widget\", \"add a new widget for gnome-widget-center\", \"add a setting to the clock widget\", or any task touching an existing widgets/*/ folder in this project. Read WIDGET_API.md (same folder) for the full spec this skill summarizes."
---

# Building a widget for GNOME Widget Center

Full spec: `WIDGET_API.md`, same folder as this file. This skill is the
condensed, do-this-first version for actually building one.

## 0. Before writing anything

Look at the closest existing widget to what's being asked and copy its
shape rather than inventing a new one:

| If the new widget is like... | Copy the pattern from... |
|---|---|
| A plain timer-driven text display | `widgets/clock/` |
| A "card" with background + inline St styling | `widgets/calendar-modern/` or `widgets/clock-modern/` |
| Talks to a DBus service (media player, etc.) | `widgets/media-player/` + WIDGET_API.md §9.1 (`lib/mediaApi.js`'s `MprisMediaService` for bundled widgets) |
| Reads CPU/RAM/network | `widgets/system-stats/` + WIDGET_API.md §9.2 (bundled widgets only) |
| Nothing close exists yet | `widgets/_template/` |

For drop-shadow CSS, hex/rgba color conversion, or Pango font-string
parsing — nearly every card-style widget needs at least one of these —
import from `lib/widgetVisualKit.js` (WIDGET_API.md §9.3, bundled widgets
only) rather than pasting a local copy.

Every widget needs, at minimum: `metadata.json` + `widget.js`. Add
`config.json` only if it has user-facing settings (see §3 below).

## 1. `metadata.json` checklist

- `id` = folder name, globally unique.
- `block-type` is a **name** (e.g. `"2x2"`), not `{cols, rows}` — see
  WIDGET_API.md §2 for the full 10-entry size table (grid cells, 16px
  each). No field, or an unrecognized name, → `1x1` (10 × 10 cells).
  This is the widget's fixed size — there is no user-resize and no
  min/max.
- Only set `themeable: true` if the widget does **not** already paint its
  own background in `widget.js`. Card-style widgets (calendar-modern,
  clock-modern) leave it unset/`false`.
- Don't add a `settings` array here unless you're doing step 3d below —
  `config.json` (3a), `settings` array (3d), and hand-written `prefs.js`
  (3b) are alternatives to each other, not additions — see §3 for the
  precedence order when a widget somehow has more than one.

## 2. `widget.js` — the parts that actually matter

```js
import St from 'gi://St';
import GLib from 'gi://GLib';
// import Clutter from 'gi://Clutter';  — only if you need click handling (step 4)
// import Gio from 'gi://Gio';          — only if you need DBus, files, or app launching

export default class MyWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
    }
    buildActor() { /* build + return an St actor, never throw */ }
    enable()  { /* start timers/signals here, save every id you create */ }
    disable() { /* remove/disconnect every single thing enable() started */ }
    getDefaultSettings() { return { /* every key you read anywhere, with a value */ }; }
    onSettingsChanged() { /* re-render immediately; restart any timer whose interval just changed */ }
}
```

Non-negotiable gotchas, all learned the hard way in this project:

- **Every setting read must have a `?? fallback`** in `_render()`/wherever
  you use it, even though `getDefaultSettings()` backfills it — cheap
  insurance against a widget shipped before a key existed.
- **`disable()` must undo everything `enable()` did.** An untracked
  `GLib.timeout_add` or a signal never disconnected is a leak the review
  guidelines explicitly flag, and screen lock/unlock runs this cycle too.
- **`stylesheet.css` is not loaded by the host (yet).** Ship it for
  documentation/class-name hooks, but do the actual styling with
  `actor.set_style('color: ...; font-size: ...px;')` inline in
  `_render()`. Every bundled widget already works this way — don't be the
  one widget that assumes the CSS file is live.
- **If a dynamic `import()` of a widget module throws `"Clutter is not
  defined"`** the first time it loads: add `import Clutter from
  'gi://Clutter';` even if you don't otherwise touch it directly — St's
  typelib depends on Clutter's, and some import orders resolve Clutter
  earlier than others by accident. `calendar-modern` hit this; the fix is
  one import line.
- **Never import `Gtk` in `widget.js`.** It runs in the Shell process,
  not the prefs GTK4 process — that's what `config.json`/`prefs.js` are
  for.

## 3. Settings — pick ONE, in this order of preference

### 3a. `config.json` (tabs/groups/fields) — use this first

Types: `text`, `location`, `textarea`, `password`, `switch`, `checkbox`, `dropdown`,
`radio`, `spinbutton`, `slider`, `colorpicker`, `fontpicker`,
`iconpicker`, `filepicker`, `folderpicker`, `application`, `list`,
`object`. Auto-generates the Control Center page via
`lib/widgetConfigUI.js` — zero GTK code, and covers everything the other
settings paths below can't (file/folder pickers, an installed-app picker,
passwords, an IP-based location picker, nested `list`/`object` fields,
`visibleIf`/`enabledIf`/`dependsOn` conditional rows). See WIDGET_API.md
§6.4 for the full field grammar. Most bundled widgets (`clock`,
`clock-modern`, `calendar-modern`, `calendar-header`, `calendar-minimal`,
`media-player`) ship a `config.json` — use one of those as your
copy-paste starting point.

### 3b. Hand-written `prefs.js` — use this for anything 3a can't express

Still the escape hatch for custom layout, live preview, or anything with
truly bespoke logic. Runs in a **separate GTK4 process** — never import
`St`/`Clutter`/`Meta`/`Shell` here, and never import anything from
`widget.js`.

Row helpers worth copy-pasting (see `lib/widgetConfigUI.js` for all of
these built generically, or any bundled widget's `prefs.js` for a
hand-written example):

- `Adw.SwitchRow` — booleans
- `Adw.EntryRow` — free text (font family strings, labels, URLs)
- `Adw.SpinRow` + `Gtk.Adjustment` — bounded numbers
- `Gtk.ColorDialogButton` + `Gtk.ColorDialog` — colors; convert
  `colorButton.get_rgba()` → `#rrggbb` with
  `Math.round(v*255).toString(16).padStart(2,'0')` per channel
- `Gtk.FileDialog` + `Gtk.FileFilter` — file/`.desktop` pickers (GTK
  4.10+, same generation as `ColorDialogButton`); get the parent window
  via `someButton.get_root()` at click time, not in `buildPrefsWidget()`

### 3c. `lib/settingsApi.js`'s `gwc.settings` builder — wired up, rarely needed

`lib/settingsApi.js` + `lib/settingsRenderer.js` + `lib/settingsStore.js`
+ a per-widget `settings.js` exporting `defineSettings(gwc)`. It's wired
into `_openWidgetPrefs()`'s fallback chain (`prefsWidgetList.js` reports
`hasSettingsJs`, `prefsWindowController.js` opens it via
`_openWidgetSettingsJsPrefs()`) and works end to end. It has a richer
type list than 3d (adds `date`, `action`, `multiOption`, `showIf`), and
persists to its own storage location separate from `WidgetSettings`
(`~/.local/share/gnome-widget-center/settings/<id>.json`, not
`widgets/<id>.json`) — see WIDGET_API.md §6.3 before mixing it with
`api.settings` reads in `widget.js`. Reach for 3a first regardless — this
mechanism exists mainly for widgets that specifically want its chainable
builder or its `date`/`action`/`multiOption` types.

### 3d. `metadata.json`'s `settings` array — legacy, prefer 3a for new widgets

Types: `string`, `number`, `range`, `boolean`, `dropdown`, `color`,
`font`, `size`. Auto-generates the Control Center page via
`lib/settingsSchemaUI.js` — zero GTK code, but a strict subset of 3a's
type list and with no conditional visibility. See WIDGET_API.md §6.1.
Kept for widgets that predate `config.json` (`mini-notes`,
`system-stats`) — don't reach for this on a new widget when 3a covers
the same ground plus more.

## 4. Making the widget clickable (optional)

No dedicated API hook for this — wire it directly:

```js
this._actor.reactive = true;
this._pressId = this._actor.connect('button-press-event', (_actor, event) => {
    if (event.get_button() !== Clutter.BUTTON_PRIMARY)
        return Clutter.EVENT_PROPAGATE;
    if (event.get_state() & Clutter.ModifierType.MOD4_MASK)
        return Clutter.EVENT_PROPAGATE; // Super held -> that's drag-to-reposition, not a click
    // ... do the click behavior ...
    return Clutter.EVENT_STOP;
});
```

Disconnect `_pressId` in `disable()`. The Super-modifier check is what
keeps this from fighting `lib/dragController.js`'s own Super+drag handler
on the same actor — both can coexist on one `button-press-event` as long
as you check for Super the same way it does.

To launch an app: `Gio.DesktopAppInfo.new_from_filename(path).launch([],
null)` — not a raw shell command. Let the user pick `path` via a
`filepicker` field in `config.json` (3a, `filters: ["*.desktop"]`) or, for
anything more custom, a `Gtk.FileDialog` filtered to
`application/x-desktop` in a hand-written `prefs.js` (3b) — see
`widgets/clock-modern/config.json` for the complete `config.json` pattern
end to end.

## 5. Before calling it done

- [ ] `buildActor()` survives being called with a totally empty settings
      object (delete the widget's settings file and reload to check)
- [ ] Every `enable()` timer/signal has a matching `disable()` cleanup
- [ ] `node --check widget.js` (and `node --check prefs.js` too, if you
      wrote one instead of a `config.json`) at minimum — catches syntax
      errors before real GNOME Shell testing (it won't catch missing
      GJS/GI modules, only JS syntax). For `config.json`, validate it
      against `lib/widgetConfigValidator.js`'s `validateConfig()` instead.
- [ ] No hardcoded dev-machine paths
- [ ] If settings changed via the Control Center should be visible
      immediately (not just on next timer tick), handle that in
      `onSettingsChanged()` — see `clock/widget.js`'s `showSeconds` handling
      for the "restart the timer with the new interval" version of this
