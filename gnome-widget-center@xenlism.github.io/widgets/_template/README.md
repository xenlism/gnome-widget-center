# _template

Starting point for a new bundled widget (`widgets/<your-id>/`). Copy
this whole folder, rename it, then:

1. `metadata.json` — change `"id"` and `"name"`, write a real
   `"description"`, pick a real `"block-type"` (see other widgets'
   `metadata.json` for the size grammar).
2. `widget.js` — rename the class, replace the single label with your
   actual content, replace `template-widget-` style_class prefixes with
   your own.
3. `config.json` — replace the one example field (`labelText`) with
   your widget's real settings.
4. `stylesheet.css` — rename the `.template-widget-*` classes to match.

## Why this scaffold looks the way it does

`widget.js` uses `lib/cardLayers.js`'s `createLayeredCard()` — every
bundled widget does. See the comment block at the top of `widget.js`
for the full R1–R7 rule table (also documented in
`HANDOVER_2026-08-12-widget-layer-rules.md`); the short version is that
`createLayeredCard()` already guarantees correct sizing and clipping
for you, and the two things you can still get wrong yourself are (a)
styling `layers.content` directly instead of your own child wrapper,
and (b) getting `themeable`/`forceSettingsAware` out of sync — see
`HANDOVER_2026-08-15-forcesettingsaware-r3-coverage.md` for exactly
what breaks if you do.

## Settings: use `config.json`, not `prefs.js` or `settings.js`

This template ships `config.json` only. The loader actually supports
three different ways for a widget to expose settings UI (hand-written
`prefs.js`, a `settings.js` `defineSettings()` DSL, and `config.json`'s
auto-generated UI), but **only one is checked** for a given widget -
`lib/prefsWidgetManagement.js`'s `_openWidgetPrefs()` tries them in
this order and stops at the first one present:

1. `config.json` (if valid)
2. `prefs.js` (hand-written `Adw.PreferencesPage`)
3. `settings.js` (`defineSettings(gwc)` DSL)
4. `metadata.json`'s `"settings"` array (oldest fallback)

If you add more than one, the ones later in that list silently never
run - not an error, just dead code sitting in your widget folder. Stick
to `config.json` unless you specifically need custom prefs UI beyond
what its field types (`text`, `colorpicker`, `fontpicker`, `switch`,
`spinbutton`, `dropdown`, etc. - see `lib/widgetConfigValidator.js` for
the full list) can do - in that case, delete `config.json` and copy an
existing widget's `prefs.js` instead (e.g.
`widgets/calendar-modern/prefs.js`), don't keep both.
