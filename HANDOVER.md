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
- **Per-widget background color fields, all widgets** (2026-08-04): every
  widget's own `config.json` `backgroundColor`/`cardColor` colorpicker
  field now has `"alpha": true` too (`lib/widgetConfigFieldRows.js`'s
  colorpicker renderer only enables alpha in its `Gtk.ColorDialog` when the
  field declares it — most widgets' fields didn't). 22 widgets were
  missing it: `calendar-modern`, `clock-modern`, `date-modern`,
  `weather-{dark,minimal}`, all 4 `media-player-*`, and 14 of the 16
  `geek-*` widgets. Verified zero remaining gaps by re-scanning every
  widget's `config.json` afterward.

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

## Force theme bug fix + Function Helper extension (2026-08-04, later session)

**Real bug found and fixed**: the Appearance page's "Force this X on every
widget" switches only ever actually reached 2 real widgets
(`calendar-minimal`, `clock`) — everything else that calls
`cardStyleCss()` (the ~50 widgets from the standardization sweep above)
kept painting its own local settings, completely unaware "force" existed.
Root cause: the old force mechanism (`ThemeService.applyWidgetStyle()`)
only ran once, at widget placement / on a `theme.json` file change — any
widget's own next natural re-render (a media player's next track, a
clock's next tick, ...) would silently overwrite it right back, and it
was gated behind `metadata.json`'s `"themeable": true`, which almost
nothing opts into.

**Fix**: `lib/widgetVisualKit.js` now has module-level forced-theme state
(`setForcedTheme()`) that `cardStyleCss()`/`shadowBoxShadowCss()`/
`borderCss()`/`blurCss()` all consult transparently — every widget's
existing `cardStyleCss(this._settings, {...})` call site is unchanged,
but automatically becomes force-aware. `extension.js` seeds this at
startup and refreshes it on every `theme.json` change (same file-watch
that already existed), and `_reapplyTheme()` now calls `_render()` on
every widget (not just `themeable: true` ones) so a Force toggle takes
effect immediately instead of waiting for the widget's own next render.

**Function Helper extended**: `cardStyleCss()`'s scope grew from
Background/CornerRadius/Shadow to also include **Border** (`borderCss()`,
plain St `border` CSS) and **Blur** (`blurCss()`, St's real
`-st-background-blur` CSS property — already in use by
`applyWidgetStyle()`, reused rather than reinventing via a Clutter
effect). **Opacity** (`opacityValue()`/`applyCardOpacity()`) is separate —
it's a `Clutter.Actor` property, not expressible as a CSS string, so it's
not folded into `cardStyleCss()`'s return value; call it alongside.
Font/layout/padding/margin/animation/widget-specific CSS were explicitly
left out of this helper's scope, per design brief — a widget still writes
that part of its own `set_style()` call itself.

`lib/themeService.js`'s `DEFAULT_GLOBAL_THEME` gained `border` and
`opacity` as full categories (their own `force` flag each, matching
`background`/`cornerRadius`/`dropShadow`). **Not yet done**: the
Preferences UI (either copy) doesn't expose Border/Opacity controls yet —
only the backend + force-awareness exists so far.

**Also fixed**: the redundant "Close" button on a widget's settings
subpage — removed, kept "Save & Close" only (both did the identical
flush-and-close underneath).

**Still unreconciled**: a large (58-widget) batch upload with the user's
own hand/AI edits on top of a chunk of this session's own tree — includes
what look like genuinely new widgets (`circles-{battery,cpu,disk,mem,net}
-half`, `circles-system-nested`, `power-menu-bar`, `settings-control-bar`)
mixed in with edited versions of existing ones. Not yet diffed or merged.

## Widget Center overlay: Overview/Themes cards now a responsive flowbox — this session

`lib/widgetCenterOverlay.js`'s `_buildGrid()` - shared by the Overview
tab (every discovered widget) and the Themes tab (every discovered theme
pack), nothing else uses it - used to hard-chunk entries 2-per-row no
matter what, regardless of the actual monitor. Now `columns` (3 / 2 / 1)
comes from a new `_gridColumns()` based on
`Main.layoutManager.primaryMonitor.width` - the same monitor `_buildUI()`
already sizes the whole overlay to:

- `>= 1600px` monitor width → **3** cards per row
- `>= 1100px` → **2**
- otherwise → **1**

Thresholds are derived from each `.wc-overlay-card`'s fixed 480px width
(`stylesheet.css`) + 16px inter-card spacing + the content area's own
24px×2 side padding, rounded up for breathing room rather than cut at
the exact fitting width. Snapshotted once per tab render (same
non-live-resize scope `_buildUI()`'s own monitor sizing already has -
the overlay is rebuilt fresh on every open and every tab switch anyway,
see `_renderTab()`), not wired to a live monitor-resize signal -
deliberately, per `_gridColumns()`'s own doc comment: this codebase has
already been bitten once by allocation-timing bugs (see
`blockSizeManager.js`'s file header), so a width snapshot at build time
was preferred over a Clutter.FlowLayout/live-allocation approach here.
Settings/Preferences tab (`widgetCenterOverlayPreferences.js`) untouched
- only Overview and Themes use `_buildGrid()`.

`node --check` across the whole tree: clean.

---

## Geek series bay/big widgets: text sizes + transparent background — this session

Applied to the 9 two-line "bay"/"big" geek widgets specifically (excludes
`bar` variants - smaller, still tuned for their own size - and
`geek-archey-systech-{bay,squre}`, which are neofetch-style info dumps
with no single top/lower text-line pair to resize):
`geek-clock-date-{bay,big}`, `geek-date-stat-big`,
`geek-date-week-{bay,big}`, `geek-week-date-{bay,big}`,
`geek-week-stat-{bay,big}`.

- **Top text line** (whichever field renders first -
  `clockFont`/`dateFont`/`weekFont` depending on the widget - confirmed
  against each widget's own `add_child()` order, not just guessed from
  field order) → font size default **80**.
- **Lower text line** → font size default **14**.
- **`backgroundColor`** default → **`#FFFFFF00`** (transparent white -
  `alpha:true` was already set on all of these per the 2026-08-04 sweep;
  this only changes the stored default value, same field).

Changed in **both** places each widget declares its own defaults - not
just `config.json` (the value a freshly-added widget/a Reset-to-defaults
starts from) but also each `widget.js`'s own `getDefaultSettings()` +
`_parseFontDescription(..., fallback string, fallback family, fallback
size)` call + `_cardStyleCss(..., {backgroundColorFallback: ...})` call
(the value used if `api.settings` is ever missing/malformed at
render-time) - these three copies existed per widget already and had to
stay in sync by hand; this is exactly the "config.json field-default
audit... haven't been cross-checked" gap HANDOVER.md previously flagged
for these widgets, now done for this specific set of fields. Regex-
replaced with a match-count assertion per occurrence (1 in
`getDefaultSettings()`, 1 in the `_parseFontDescription()` call, 2 for
the background fallback) so a widget with an unexpected shape would have
been caught rather than silently skipped - all 9 matched cleanly.

`node --check` across the whole tree + JSON-parsed every `config.json`
after the edit: clean.

---

## Media player: play/pause icon could lag one step behind — fixed this session

Real bug, separate from the earlier Metadata `invalidated_properties` fix
(2026-08-04, still valid and unchanged). `lib/mediaApi.js`'s
`g-properties-changed` handler decided how to refresh purely off the
signal's `invalidated_properties` argument and **completely discarded
`changed_properties`**, trusting GDBusProxy's own cache to already be in
sync with it by the time the callback ran. A plain Play↔Pause toggle -
which almost every player sends via `changed_properties` (a small scalar,
no reason to ever invalidate it) rather than `invalidated_properties` -
had no code path here that actually guaranteed the new `PlaybackStatus`
landed in the widget's read before `_emitFromProxy()` ran off the cache;
all four widgets' `_renderState()` themselves have always applied
`state.status` to the icon correctly and immediately, so the delay/
staleness traced back to here, not to widget.js.

**Fix**: the handler now walks `changed_properties` itself (same boxed-
variant `n_children()`/`get_child_value()` pattern `_refreshThenEmit()`
already used for `Properties.GetAll`'s result) and calls
`set_cached_property()` for every key in it, synchronously, before
`_emitFromProxy()` reads the cache — no dependency on cache-timing
assumptions, no DBus round-trip for anything that arrived this way.
`invalidated_properties` handling (the async `Properties.GetAll` refresh
for Metadata et al) is untouched. Shared by all four widgets
(`media-player-{square,circle,wide,poster}`) since they all go through
this one file — no per-widget changes needed or made.

`node --check` clean across the whole tree after the change (same
whole-tree pass as below).

---

## Text/content overflow clipping — verified this session

Explicit ask this session: *"Text must never extend beyond the widget's
block size... implemented in the core rendering function, not
individually inside each widget."* Audited the tree for this rather than
adding a new mechanism, because one already exists and already matches
the ask exactly:

- `lib/widgetLoader.js`'s `_enforceBlockSize()` is the **only** place any
  widget actor's pixel size is ever set at load/hot-reload time (called
  from both `loadOne()` and the hot-reload path, plus re-run on every
  `shadowOverflowMargin` change) — it sizes the actor to
  `cols/rows * BLOCK_CELL_SIZE` from `BlockSizeManager.getBlockSizeFor()`
  and then calls `StWidgetWrapper.clip(true, shadowOverflowMargin)`
  (`lib/gjskit/st/StWidget.js`), which sets `clip_to_allocation` (or an
  inflated explicit `Clutter` clip rect when shadow bleed room is
  configured).
- This is a **paint-level clip on the widget's own root actor** — Clutter
  clips that actor's paint, and every descendant's paint, at the
  allocation boundary regardless of what's inside (a long `St.Label`, a
  child with its own oversized inline/CSS width, absolute positioning,
  etc.). Individual widgets don't need their own clipping logic, and
  can't accidentally opt out of it — confirmed no widget's `widget.js`
  calls `clip_to_allocation`/`set_clip` itself (grepped the tree; none
  do).
- Confirmed `WidgetLoader` is the sole caller of any widget's
  `buildActor()` anywhere in the extension (`widgetLayer.js`,
  `widgetEditMode.js`, `extension.js` only ever consume the actor
  `WidgetLoader` already built and clipped — none of them build widget
  actors independently). `extension.js`'s own
  `BlockSizeManager.applyBlockSize()` calls (theme-reapply /
  hot-reload-adjacent paths) only re-set size, never touch clipping —
  harmless, since the clip installed by `_enforceBlockSize()` stays in
  effect (and `clip_to_allocation`, the default `shadowOverflowMargin=0`
  case, auto-tracks any later size change; only the non-default
  explicit-clip-rect path, used when shadow bleed room is configured,
  would need a re-clip if size changed after the fact outside
  `_enforceBlockSize()` — not currently a real path since
  `applyBlockSize()` is called with metadata that hasn't changed size).
- `prefs.js`'s `PrefsWidgetList` path never calls `buildActor()` at all
  (GTK4 process, no St), so nothing there needs or has this.

No code changes made for this — the ask was already met. Ran
`node --check` across the whole tree as a final syntax sanity pass (all
clean) rather than touching working clipping code.

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
