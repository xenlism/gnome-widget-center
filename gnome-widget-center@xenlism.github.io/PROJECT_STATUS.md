# Project Status

## 2026-08-06 — mediaApi.js: fixed live NameOwnerChanged regression, added stale-proxy guard

**Scope:** `lib/mediaApi.js` only. Nothing else touched.

- **Bug report:** media-player widget showed no track/cover while music was
  actively playing, but would correctly show cover + track name after
  disabling and re-enabling the extension. No errors in the journal.
- **Root cause:** a prior edit had reverted the `NameOwnerChanged`
  subscription from `Gio.DBus.session.signal_subscribe()` back to
  `this._dbusProxy.connectSignal('NameOwnerChanged', ...)` on the
  `org.freedesktop.DBus` proxy. A `GDBusProxy`'s signal delivery is gated by
  its own internal name-owner tracking, which doesn't apply cleanly to
  `org.freedesktop.DBus` itself — the signal silently never reached the
  callback. Method calls on the same proxy (like `ListNames`) were
  unaffected, which is why `_findExistingPlayer()` — run once on `start()`
  — always found a player that was already playing when the extension
  (re)loaded, while a player started *after* load was never picked up.
- **Fix:** restored `Gio.DBus.session.signal_subscribe()` /
  `signal_unsubscribe()` for `NameOwnerChanged`, this time filtering with
  `Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE` on
  `org.mpris.MediaPlayer2` so the bus daemon itself only delivers
  MPRIS-relevant name-owner changes, instead of every `NameOwnerChanged` on
  the session bus being filtered in JS.
- **Also fixed:** `_refreshThenEmit()`'s `Properties.GetAll` reply handler
  now captures the `_playerProxy` it was called against
  (`proxyAtCallTime`) and checks identity, not just null-ness, before
  writing the reply into the cache and emitting. Previously, a fast
  detach-then-reattach (one player quits, another starts) while a GetAll
  call was still in flight could feed the outgoing player's stale metadata
  into the new player's proxy cache.
## 2026-07-31 — Weather widgets: one shared "location" field + IP-detect button

**Scope:** `lib/widgetConfigUI.js`, `lib/widgetConfigValidator.js`,
`WIDGET_API.md`, `widgets/weather-dark/`, `widgets/weather-minimal/`,
`widgets/weather-modern/` only. Nothing else touched.

- **New generic `config.json` field type: `fieldType: "location"`.** A
  plain `text`-style "lat,lon" entry (same `pattern`/validation as
  `text`) plus one built-in suffix icon button
  (`find-location-symbolic`, this codebase's standing "auto-detect"
  icon convention) that looks up the caller's approximate coordinates
  from their IP address — `ip-api.com`, then `freeipapi.com`, then
  `ipwhois.io` as fallbacks — and fills them straight into the field.
  Implemented once in `lib/widgetConfigUI.js` (`_locationRow()` +
  `_fetchIpLocationForPrefs()`), registered in
  `lib/widgetConfigValidator.js`'s `FIELD_TYPES`, documented in
  `WIDGET_API.md` §6.4. Any widget that declares this field type gets
  identical settings-page UI/behavior for free.
- **All three weather widgets now use it for their `location` field,**
  replacing two different prior approaches:
  - weather-dark/weather-minimal: a plain `text` field with no way to
    fill it without knowing your own coordinates (see this file's
    2026-07-29 entry, which had already dropped the older two-field
    "Place" `autocomplete` + "Location" pair for a persistence bug).
    `widgets/weather-dark/autocomplete.js` and
    `widgets/weather-minimal/autocomplete.js` were leftover/orphaned
    from that generation — unreferenced by any `config.json` — and are
    now deleted outright.
  - weather-modern: a `text` field plus a separate momentary "Detect
    automatically" `switch` field (`detectNow`) that `widget.js`
    watched for in `onSettingsChanged()` and used to trigger its own
    IP lookup from the Shell process. That field, its i18n strings,
    and the `onSettingsChanged()` handling for it are all removed —
    the settings-page button does the same job directly, from the
    prefs process, with no round trip through `widget.js` needed.
- **First-run auto-detect is unchanged.** All three widgets still try
  once, on first load (gated by the `locationAutoDetected` settings
  flag), to replace the hardcoded Bangkok default with an IP-based
  location from `widget.js`'s own `_maybeAutoDetectLocation()` — that
  logic runs from the Shell process and is independent of the new
  settings-page button, which is only for deliberately setting/
  re-detecting a location afterward.
- **i18n:** updated `en.js`/`th.js` for all three widgets (group
  description text, dropped `field.detectNow.*` keys, corrected
  `meta.description` copy that still mentioned a "searchable place
  field").

## 2026-07-29 — Weather widgets: location field rework

**Scope:** `widgets/weather-dark/`, `widgets/weather-minimal/` only. Edit
Mode, `lib/gridEngine.js`, `lib/editModeDragController.js`, and every
other widget were not touched.

- **Fixed the Weather (Dark) layout error.** A prior attempt at the card
  layout set `x_fill`/`y_fill` on an `St.BoxLayout` - those aren't real
  `St`/`Clutter` actor properties (that's old Clutter child-meta API, not
  a constructor prop), so it threw. `widget.js` doesn't use `x_fill`/
  `y_fill` anywhere now; layout is done with `x_expand`/`y_expand`/
  `x_align`/`y_align` on `St.Bin`/`St.BoxLayout`, which are real
  properties.
- **Removed the autocomplete Place/Location setting.** Both widgets used
  to have a "Place" field (type a city, pick a suggestion) and a
  "Location" field, both `fieldType: "autocomplete"`, wired together via
  `fillsField`. The autocomplete row only saved on `Adw.EntryRow`'s
  `apply` signal (Enter / selecting a suggestion), so typing and tabbing
  away silently didn't persist anything - the reported bug.
- **Replaced it with a single validated `location` text field.**
  `fieldType: "text"` with pattern
  `^-?\d{1,2}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?$` - plain `latitude,longitude`
  (e.g. `15.1111,85.2555` or `15.1111, 85.2555`), saved on every valid
  keystroke like every other text field in the codebase already does. The
  `place` field, its i18n strings, and `autocomplete.js` were deleted from
  both widgets; `widget.js`'s own `_parseLocation()` regex now accepts the
  same optional space after the comma.
- **Added a first-run IP-geolocation default.** Since removing "Place"
  drops the only way to set a location without knowing your own
  coordinates, `widget.js` now tries once (gated by a
  `locationAutoDetected` settings flag, so it never repeats or overwrites
  a value you've since set) to replace the hardcoded Bangkok default with
  your approximate location from a free, no-key IP lookup - `ip-api.com`,
  then `freeipapi.com`, then `ipwhois.io` as fallbacks. This runs from the
  Shell process (widget.js), not the prefs page - see each widget's
  README "First-run auto-detect" section for the full details.
- **No changes to Edit Mode.** The Edit Mode floating-toolbar overlay,
  theme system, and grid/sizing code from prior sessions are untouched.
