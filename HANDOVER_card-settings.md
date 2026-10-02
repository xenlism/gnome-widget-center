# Handover: unified card setting keys (`card-*`)

## Naming pattern
`card-[setting type]-[sub-setting]`

| Group | Keys |
|---|---|
| Background | `card-background-color` (was `backgroundColor`, `cardColor`, `paperColor`) |
| Opacity | `card-opacity` (was `opacity`) |
| Corner | `card-corner-radius` (was `cornerRadius`, `widgetCornerRadius`), `card-corner-radius-enabled` |
| Border | `card-border-enabled`, `card-border-color`, `card-border-width` |
| Shadow | `card-shadow-enabled`, `-color`, `-opacity`, `-blur`, `-angle`, `-distance` |
| Blur | `card-blur-enabled`, `card-blur-radius` |

## What changed
- `lib/cardSettingKeys.js` (new): `CARD_KEYS` + `LEGACY_CARD_KEY_MAP` + `migrateCardSettings()`.
- `lib/storageService.js`: migrates on `getWidgetSettings()` and `saveWidgetSettings()`
  (covers saved settings.json, prefs subprocess, and old .gwct imports).
- `lib/appearanceFieldsSchema.js`, `lib/widgetVisualKit.js`, `lib/shell/cardLayers.js`,
  `lib/shell/halfCircleGaugeKit.js`: all ids/defaults/reads use new keys.
- 69 widgets: `config.json` ids, `widget.js`/`prefs.js` reads, widget `i18n/*.js` (`field.<id>.label|description`).
- 34 `themepacks/*.gwct`: per-widget `settings` keys rewritten.
- Docs: WIDGET_API.md (new section 9.3.1), CHANGELOG.md, widget READMEs, claude_widget_promt.md.

## Deliberately NOT renamed
- Global theme object (`themeService`/`exportService`/`backupService`): `cornerRadius`, `opacity`, `dropShadow.blurRadius`.
- Global gsettings `shadow-angle` / `shadow-distance`.
- Inner-element settings: `eventCard*` (calendar-events/mini-events), `cardBgColor` (notification-stack items),
  `buttonBorderColor` (pomodoro), `coverCornerRadius`, `textShadow*`, `lineNShadow*` (geek-architect).
- Clutter actor `opacity: 255` animation props (image-slideshow, widgetEditMode).

## Verified
- `node --check` on every .js; all config.json + .gwct parse as JSON; no duplicate field ids per widget.
- Migration unit test in Node: legacy keys move, new key wins on conflict, second run is a no-op.

## NOT verified (needs real GNOME Shell)
1. Enable a few widgets, edit Appearance in prefs, confirm live update (bg, radius, border, shadow, blur, opacity).
2. Widgets that used `cardColor`/`paperColor` (weather-*, calendar-*, clock-modern, date-modern, note*, sticky-note*): confirm bg color + custom prefs rows work (calendar-modern and clock-modern prefs.js use `_colorRow("card-background-color", ...)`).
3. Upgrade test: start with an old settings.json, confirm it is rewritten with `card-*` keys.
4. Import an old .gwct pack (legacy keys) and confirm it applies.
5. Hyphenated keys in i18n (`field.card-background-color.label`): confirm translated labels still show in prefs.
6. notification-stack: shares card border/corner/shadow keys with its per-notification items.

## Rule for future widgets
Never add ad-hoc names for card settings; use `CARD_KEYS` from `lib/cardSettingKeys.js`.


---
# Part 2: Card Color Scheme (`appearance.colorScheme`)

Roles: card-background, card-border, card-shadow, text-1, text-2, ring-1..ring-4, accent (scheme key = `<role>-color`).

## Changed
- `lib/colorScheme.js` (new): roles, defaults, normalize, `schemeDefaults()`, `applySchemeToSettings()`.
- 69 `config.json`: `schemeRole` on colorpicker fields (text-1 50, text-2 39, ring 23, accent 8, card 60).
  Mapping is data in each config.json, so it can be edited per widget.
- `lib/appearanceFieldsSchema.js`: card bg/border/shadow carry schemeRole.
- `lib/themeService.js`: `global.colorScheme`, `getColorScheme()`, `setColorScheme()`; setGlobalTheme preserves it.
- `lib/exportService.js` / `lib/backupService.js`: export + import (pack without scheme clears it).
  `applyColorSchemeToWidgets()` for the prefs button.
- `lib/shell/widgetRuntimeLoader.js` `_applyDefaults`: scheme defaults placed last (beat config/instance defaults, never saved values).
- `lib/prefs/prefsPageBuilders.js`: Appearance page gets a Card Color Scheme group.
- `themepacks/Arctic-Glass.gwct`: sample scheme. Docs: WIDGET_API 9.3.2, CHANGELOG.

## Not verified / open
1. Real GNOME Shell: add a widget after setting a scheme and confirm it shows scheme colors on first render
   (widget constructor may read settings before `_applyDefaults` runs; if first render uses its own fallback, re-render needed).
2. Prefs: color buttons, Apply (count label), Clear; shell picks up theme.json change via the existing watcher.
3. Prefs UI strings use `_tr` with English fallbacks; now translated in all 46 locale files (see CHANGELOG).
4. Only Arctic-Glass has a scheme; other 33 packs have none. Packs could be given schemes later.
5. Unmapped on purpose: status colors, calculator buttons, geek-architect lines, per-widget special colors.
6. Scheme colors may include alpha (#RRGGBBAA); fields without alpha UI still accept it.


---
# Part 3: Card Settings in .gwct (`appearance.cardSettings`)

Goal: a widget opened later loads all card settings from the .gwct instead of being configured one by one.

## Changed
- `lib/cardDefaults.js` (new): `CARD_SETTING_SPECS` (type/range per key), `normalizeCardSettings()`,
  `cardSettingsDefaults()`, `applyCardSettingsToSettings()`, `collectCardFieldIds()`.
- `lib/themeService.js`: `global.cardSettings`, `getCardSettings()`, `setCardSettings()`; `setGlobalTheme` preserves it.
- `lib/exportService.js` / `lib/backupService.js`: export + import (pack without the block clears it);
  `applyCardSettingsToWidgets()`; `shadow-angle` / `shadow-distance` added to host settings / backup gsettings keys.
  Also removed a duplicate `readWidgetConfig` import in exportService.js (was a SyntaxError).
- `lib/shell/widgetRuntimeLoader.js` `_applyDefaults`: card settings placed above widget defaults, below the color scheme.
- `lib/prefs/prefsPageBuilders.js`: Appearance page gets a Card Settings group (15 rows, Apply to all, Clear).
- 34 `themepacks/*.gwct`: `appearance.cardSettings` added, derived as the most common value per key across each pack's widgets.

## Verified (Node, no GNOME Shell)
- `node --check` on every modified module; every bundled pack's block survives `normalizeCardSettings` unchanged.
- Defaults only cover declared ids; invalid values dropped; numbers clamped; apply is idempotent.

## NOT verified (needs real GNOME Shell)
1. Enable a widget that has no saved settings after importing a pack: card look should match `cardSettings` on first render.
2. Prefs -> Appearance -> Card Settings: rows save, "Apply to all widgets" count label, "Clear".
3. Export a pack, re-import it: `cardSettings` and shadow angle/distance round-trip.
4. Prefs strings (Card Settings + Card Color Scheme groups) added to `i18n/en.js` and `i18n/th.js` (45 keys each); the other 43 locales fall back to the English text in code.
5. Packs' `cardSettings` are derived, not hand-tuned; corner radius / colors are the per-pack majority and may not suit every widget type.


---
# Part 4: Widget API 2.0 + theme pack apply

## Changed
- `lib/apiVersion.js` (new) + `lib/widgetLoader.js`: `api-version` enforced (must be 2..2; accepts 2, 2.0, "2", "2.0").
- 74 `metadata.json` (bundled widgets + development/widget-templates): `"api-version": 2`. Docs: WIDGET_API.md (2, version notes, 9.3.3), CONTRIBUTING.md, docs/CREATING_WIDGETS.md, chatgpt.md.
- `extension.js` `_applyActiveThemePack`: one flow for both pack types (unload all -> import/disable others -> loadAll).
  Folder packs previously only edited disabled-widgets while `_applyingThemePack` made the watcher ignore it.

## Decision to confirm
- Widgets with api-version 1 (e.g. third-party ones in ~/.local/share/gnome-widget-center/widgets/) are now refused, per the
  contract already written in WIDGET_API.md. To keep them loading set `MIN_SUPPORTED_API_VERSION = 1` in `lib/apiVersion.js`;
  they would still read the old card key names, which saved settings no longer contain.
- `.gwct` format version left at 1 (cardSettings is additive; old packs still import).

## NOT verified (needs real GNOME Shell)
1. Apply a bundled pack from Themes: old widgets vanish, pack widgets appear at their saved positions.
2. Apply a folder pack (theme.json): its widgets now load without a rescan.
3. A v1 widget in the user widgets dir shows up in the error list instead of loading.



---
# Part 5: Text Fonts in .gwct (`appearance.fontSettings`)

Goal: the exported theme pack also carries the default font face + size for the shared text roles (text-1, text-2).

## Changed
- `lib/fontScheme.js` (new): `FONT_ROLES`, `normalizeFontSettings()`, `fontSettingsDefaults()`, `applyFontSettingsToSettings()`, `deriveFontSettings()`. Value = Pango string, e.g. `"Sans Bold 22"`; keys `text-1-font`, `text-2-font`.
- 54 fontpicker fields in `widgets/*/config.json` tagged with `fontRole` (text-1 28, text-2 26): font fields paired with a `text-1`/`text-2` color field (`xFont` <-> `xColor`), default size <= 28. Unpaired fonts and display-size fonts are not tagged.
- `lib/themeService.js`: `global.fontSettings`, `getFontSettings()`, `setFontSettings()`; `setGlobalTheme` preserves it.
- `lib/exportService.js` / `lib/backupService.js`: export + import (pack without the block clears it). Export derives the block from the exported widgets when the user never set one. `applyFontSettingsToWidgets()` for the prefs button.
- `lib/shell/widgetRuntimeLoader.js` `_applyDefaults`: font settings placed above card settings, below the color scheme.
- `lib/prefs/prefsPageBuilders.js`: Appearance page gets a Text Fonts group (two font buttons, Apply to all, Clear). Strings in `i18n/en.js` and `i18n/th.js`.
- 32 of 34 `themepacks/*.gwct`: `appearance.fontSettings` added (most common value per role across the pack's widgets). Minimal-Analog-Clock-Menu and Minimal-Nothing-Style-Desktop have no tagged font fields, so no block.

## Verified (Node, no GNOME Shell)
- `node --check` on every modified module; all config.json + .gwct parse; unit tests for normalize / defaults / apply (idempotent) / derive; every bundled block survives `normalizeFontSettings` unchanged.

## NOT verified (needs real GNOME Shell)
1. Export from the overlay (Win+Del) with no Text Fonts set: the .gwct contains `appearance.fontSettings`; re-import round-trips.
2. Prefs -> Appearance -> Text Fonts: font buttons save, Apply count label, Clear (uses `Gtk.FontDialogButton`, `Pango` import added to prefsPageBuilders.js).
3. Add a widget after importing a pack: its tagged fonts use the pack's face and size on first render.
4. One size per role is applied to every tagged field, so a mini widget added later can start with a larger font than its own default; check the look. Face-only fill would be a small change in `fontSettingsDefaults`.
5. Prefs strings only added to en and th; the other locales fall back to the English text in code.

## Part 5b: Theme Defaults group (Preferences -> Appearance)
- New "Theme Defaults" group above Card Settings / Card Color Scheme / Text Fonts with "Apply all" and "Clear all" (one `setGlobalTheme` call for the three blocks). No widget changes, no gsettings key: all three blocks stay in theme.json.
- The four groups now share one `ThemeService` instance (before, each group had its own cache and a save from one could overwrite the others' blocks). Strings `appearance.defaults.*` in en/th.
- NOT verified in GNOME Shell: Apply all count label, Clear all (rows keep showing old values until Preferences is reopened).
