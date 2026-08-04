# HANDOVER — GNOME Widget Center

Snapshot of where this project stands as of **2026-08-04**. This is the
"what's the state of the world right now" doc — for a chronological list of
individual changes see `CHANGELOG.md` and `CHANGES.md`; for the widget
authoring contract see `gnome-widget-center@xenlism.github.io/WIDGET_API.md`.

**Verification status, same caveat as CHANGELOG.md's:** everything below is
code-complete and passes `node --check` syntax validation across the whole
tree, but most of it has **not been confirmed end-to-end on real GNOME Shell
hardware**. Treat this document as an accurate map of the code, not a
guarantee it all runs perfectly yet.

---

## Widget Center Overlay — merged in this session

Was staged separately for a while (`lib/widgetCenterOverlay.js` +
supporting files, uploaded as `widget-center-overlay-changes.zip`). As of
this session it's fully merged into the extension:

- `lib/widgetCenterOverlay.js`, `lib/widgetCenterOverlayPreferences.js`,
  `lib/themePackRegistry.js` copied into `lib/`.
- `widget-center-prefs-app.js`, both `.desktop` launcher files, and
  `themepacks/README.txt` copied to the extension root.
- `extension.js`'s `enable()` now constructs `WidgetCenterOverlay` with the
  tight-integration callbacks (`onWidgetSettings`/`onWidgetRemove`/
  `onOpenPreferences`/`onApplyThemePack`) so its Remove/Settings buttons do
  exactly what Edit Mode's own buttons do. `disable()` tears it down FIRST,
  before `this._loader` etc, per `lib/widget-center-overlay-integration-
  example.js`'s ordering note (now historical — kept for reference).
- `lib/prefsWindowController.js` gained `showPreferencesPage()` /
  `this._preferencesPage` (was an overlay-only addition, now shared) so the
  overlay's Preferences tab can jump a real Preferences window straight to
  the Preferences page instead of Overview.
- `stylesheet.css` merged: this extension's own `.widget-edit-mode-*`
  classes plus the overlay's `.wc-overlay-*`/`.wc-pref-*` classes now live
  in one file.
- Schema merged into one `schemas/org.gnome.shell.extensions.widget-
  center.gschema.xml`, recompiled (`gschemas.compiled` regenerated in
  place, was stale before this session).

**Opens with `Super+F12`** by default (`widget-center-overlay-keybinding`
gschema key, customizable from either Preferences copy — see below).

### The overlay's "Preferences" tab is a real (partial) reimplementation

Not a GTK window embed (can't be — GTK4/libadwaita can't be hosted inside an
St/Clutter actor in the Shell process, see `widgetCenterOverlay.js`'s own
header). `lib/widgetCenterOverlayPreferences.js` rebuilds
**General/Appearance/Desktop/Interactions/About** natively in St, reusing
the *same* `SettingsService`/`ThemeService` classes (same GSettings schema /
`theme.json` file) the real window uses — a change in either place shows up
in the other live.

**Deliberately excluded from the overlay's copy:** Backup & Restore and
Import/Export — both need `Gtk.FileChooserNative` (a real GTK window) and
aren't reliable from inside the St overlay. A banner at the top of the
overlay's Preferences tab opens the real window for those two. Nothing
about the real window itself changed.

---

## Host-level `language` override — new this session

`api.hostLanguage` (WidgetAPI, `WIDGET_API.md` §5) — a **live getter**, not
a snapshot, reading the `language` gschema key (`''` = system locale,
unchanged default behavior). `onHostLanguageChanged(language)` (§3) is the
optional hook for widgets that need to react immediately rather than wait
for their next render.

Wired end-to-end:
- `pickLocale()`/`loadTranslations()` in all 12 copies of `i18n/index.js`
  (11 widgets + the extension root) accept an optional override argument.
- `weather-dark`/`weather-minimal`/`weather-modern` (the only 3 widgets
  whose `i18n/` tables actually have on-screen text, not just config-UI
  labels) pass `this._api.hostLanguage` through and implement
  `onHostLanguageChanged()`.
- The Prefs process honors it too: `prefsWindowController.js`'s own chrome
  strings and `prefsWidgetManagement.js`'s per-widget config-page/Overview-
  row translations both read the same `language` key via a local
  `SettingsService` instance.
- Real Preferences window's new **General** category has the language
  picker; the overlay's own General category mirrors it (via a custom
  `_cycleButton` helper, since St has no dropdown widget).

**Investigated and intentionally NOT wired:** the other 8 widgets with an
`i18n/` folder (`calendar-*`, `clock*`, `date-modern`, `mini-notes`,
`system-stats`) — their tables only contain config-panel label keys, no
on-screen text at all (their visible month/weekday text auto-localizes from
the OS locale via `GLib.DateTime.format()` independent of this system).
Wiring `loadTranslations()` into their `widget.js` would compile but
translate nothing.

---

## New "Interactions" preference category — new this session

Real settings backing what used to be a "coming soon" placeholder:
- **Magnetic snapping**: on/off (`snap-enabled`) + pull distance
  (`snap-distance`, replaces `lib/snapManager.js`'s old hardcoded
  `SNAP_DISTANCE=16`) + guide line color (`guide-color`).
- **Fixed grid snap** (`grid-snap-enabled` + `grid-size`): a new, **opt-in,
  off-by-default** feature layered on top of magnetic snapping — NOT a
  reintroduction of the pre-2026-07-28 default grid, which stays removed
  for everyone who doesn't turn this on.
- **Keyboard shortcut**: editable from here too (writes the same
  `widget-center-overlay-keybinding` key the overlay itself uses).

All four snap-related keys are read live by `lib/editModeDragController.js`
via `SettingsService.onChanged()` — a change in either Preferences copy
takes effect on the very next drag frame, no restart.

Real bug fixed along the way: `lib/guideRenderer.js`'s alignment guides and
the drag drop-placeholder were being positioned/sized correctly every
frame but painting **fully transparent** — `.widget-edit-mode-guide-line`/
`.widget-edit-mode-placeholder-valid`/`-invalid` were referenced by
`style_class` but never defined anywhere in the loaded `stylesheet.css`.
Fixed (definitions added + an inline-style fallback in the JS itself).

---

## Media player suite — square/circle/wide/poster

- **Refresh bug**: `lib/mediaApi.js` was trusting GDBusProxy's property
  cache unconditionally after every `g-properties-changed`. Some players
  send track-change metadata via `invalidated_properties` rather than
  `changed_properties` — GDBusProxy just *flushes* those from cache instead
  of updating them, so exactly the update that mattered (a new track
  starting) could get silently dropped. Now explicitly re-fetches via
  `Properties.GetAll` when invalidated properties are present.
- **Cover art fill / circle shape**: replaced `St.Icon` (aspect-preserving
  "contain" fit, which is why art was letterboxed / why circle's art never
  actually looked round — a rounded *parent* doesn't clip a square *child*,
  only its own background) with a plain `St.Widget` painted via CSS
  `background-image: cover`.
- **Hover on cover/text**: switched from manual `enter-event`/`leave-event`
  pairs to St's built-in `track_hover`/`hover` property — the documented-
  robust pattern for a container with overlapping reactive children.
- **Hide text when idle**: text now hides entirely instead of showing "No
  media playing".
- **176px vs 160px block-size bug**: `blockSizeManager.js`'s `1x1` block-
  type is 11×11 cells × 16px = 176px (current since 2026-07-27), not the
  stale 160px these four widgets' own `SIZE`/`COVER_SIZE`/etc constants
  still assumed — outer card was always forced to the correct size by
  `BlockSizeManager.applyBlockSize()` regardless, but the *inner* cover
  frame was undersized, leaving a real ~16px gap. Fixed, scaled the same
  way `circles-*` widgets already had been for this exact migration.
- All 4 migrated off their local duplicate `SHADOW_DEFAULTS`/
  `shadowBoxShadowCss`/`hexToRgba`/`toCssColor` copies onto the shared
  `lib/widgetVisualKit.js` import every other widget already used.

---

## Shared helpers (`lib/widgetVisualKit.js`)

- `textShadowCss(settings)` / `TEXT_SHADOW_DEFAULTS` — same angle/distance/
  blur/color/opacity model as the existing `shadowBoxShadowCss`, applied as
  `text-shadow` instead of `box-shadow`. Applied to `archey-sysfetch` and
  all 16 `geek-*` widgets (enabled by default).
- `cardStyleCss(settings, options)` — the standard `background-color +
  border-radius + box-shadow` builder every widget should call instead of
  hand-assembling those three declarations. **Migrated so far:**
  `media-player-{square,circle,wide,poster}`, `calendar-modern`,
  `circles-{clock,cpu,disk,mem,net,year}`, `circles-system`,
  `circles-battery`, `switches` (14 widgets — `switches` also had its own
  private `_cardStyle()` method, removed). **Not yet migrated** (still
  hand-assemble the three declarations inline, though most already import
  `toCssColor`/`shadowBoxShadowCss` individually): `clock-modern`, `clock`,
  `cpu-monitor`, `date-modern`, `mem-monitor`, `mini-notes`,
  `network-monitor`, `power-menu`, `settings-control`,
  `system-monitor-mini`, `system-stats`, `weather-{dark,minimal,modern}`,
  `folder-widget-{2x2-1,2x2-2,3x3-1,3x3-2}`, `archey-sysfetch`, all 16
  `geek-*` widgets. (`calendar-header` deliberately excluded — its design
  has multiple color zones, no single card background to standardize.)
- `dropShadow.force` (`lib/themeService.js`) — was missing entirely
  (background/cornerRadius had a "force this on every widget" toggle,
  drop shadow didn't). Added, with the matching switch in both Preferences
  copies.
- Background color pickers in the real Preferences window now have
  `with_alpha: true` (background color is fully alpha-aware downstream via
  `toCssColor()`). Shadow color's picker deliberately does NOT — it has its
  own separate Opacity slider, and `shadowBoxShadowCss()` only accepts a
  strict 6-digit hex for `shadowColor`; enabling alpha there would silently
  break to black instead.

---

## New widgets added this session

- **`geek-*` (16 widgets)**: `geek-archey-systech-{bay,squre}`,
  `geek-clock-date-{bar,bay,big}`, `geek-date-stat-{bar,big}`,
  `geek-date-week-{bar,bay,big}`, `geek-week-date-{bar,bay,big}`,
  `geek-week-stat-{bar,bay,big}`. None hardcode a fixed pixel size (use
  `BlockSizeManager`-driven sizing), so none had the 176-vs-160 bug. All
  migrated to the shared `textShadowCss()` helper (14 already had a local
  duplicate copy of it pre-migration; the 2 archey-style ones had none and
  got it added fresh).
- **`circles-system`, `circles-battery`, `switches`**: already imported
  the shared `widgetVisualKit.js` kit on arrival (no local-copy cleanup
  needed); migrated their root card style onto `cardStyleCss()`.

---

## Known gaps / next things to check

1. **Real-hardware verification** — nothing in this session has been
   confirmed on an actual running GNOME Shell yet. Priority list: does the
   overlay actually open with `Super+F12`; does `St.Slider`'s constructor/
   property assumptions in `widgetCenterOverlayPreferences.js` hold on the
   target Shell version; do the `-slider-handle-*`/`-barlevel-*` custom CSS
   properties added for it render as expected.
2. **`cardStyleCss` sweep** — 14 of ~34 eligible widgets done, see the list
   above.
3. **`system-stats/widget.js`** — relies entirely on a per-widget
   `stylesheet.css` that the host never loads (confirmed: no
   `load_stylesheet`/`get_theme()` call anywhere touches per-widget
   stylesheets, only the extension root one auto-loads). Its bars/labels
   may be rendering unstyled. Flagged, not fixed — out of scope of what
   was asked so far.
4. **`config.json` field-default audit** — the fallback values passed to
   `cardStyleCss()`/used elsewhere for the 3 new widgets + 16 `geek-*`
   widgets haven't been cross-checked line-by-line against each
   `config.json`'s own declared defaults.
