# Handover — Force Settings spec implementation (in progress)

Implementing `ForceSettingsSpecification.md` against an extension that
already had a DIFFERENT, older Force mechanism in place (per-property
force flags in `theme.json`, see `lib/themeService.js`). Decision made
with the user before starting:

- Background + Corner Radius + Shadow migrate to the new spec's single
  `force-appearance-enabled` GSettings switch.
- Border + Opacity (not mentioned in the spec) **stay on the OLDER
  per-property force mechanism** (`theme.json`'s `border.force` /
  `opacity.force`) — kept working exactly as before, unchanged.
- Additionally: border/opacity currently have NO Force switch in the
  Preferences UI at all (backend support exists in `themeService.js`,
  but `lib/prefsPageBuilders.js` never grew the matching `Adw.SwitchRow`
  for them) — user asked to add that missing UI. **Not done yet**, see
  "Next steps" below.

This doc will keep growing addendum-style as each phase lands, same
pattern as `HANDOVER_PREFS_V2.md`.

## Phase 1 (this pass) — schema + resolution helper, NOT wired in yet

### `schemas/org.gnome.shell.extensions.widget-center.gschema.xml`

New keys, all under a new "Force Settings" block at the end of the
file:

- `force-appearance-enabled` (`b`, default `false`) — the spec's single
  global switch.
- `force-background-color` (`s`), `force-corner-radius` (`i`, 0-32),
  `force-background-blur` (`i`, 0-60) — used when Force is on.
- `force-shadow-enabled` (`b`), `force-shadow-color` (`s`),
  `force-shadow-opacity` (`i`, 0-100), `force-shadow-spread` (`i`,
  0-20), `force-shadow-blur` (`i`, 0-60) — used when Force is on.
- `shadow-distance` (`i`, 0-30) and `shadow-angle` (`i`) — **always**
  read from GSettings regardless of `force-appearance-enabled`, per the
  spec's "Distance and Angle are always stored in GSettings" line. This
  is the one part of the spec that has no on/off branch at all.

Recompiled with `glib-compile-schemas schemas/` — `gschemas.compiled` is
up to date, XML validated clean.

### `lib/forceSettingsHelper.js` (NEW)

The "Force Settings Helper" from the spec's Resolution/Responsibility
sections. `ForceSettingsHelper` class, constructed once with the
extension's `Gio.Settings` object (same one `extension.js` already
builds). One method that matters: `resolve(widgetAppearance)` —

```js
resolve({
  background: {color, cornerRadius, blur},   // widget's own config.json values
  shadow: {enabled, color, opacity, spread, blur},
}) → {
  background: {color, cornerRadius, blur},   // GSettings values if Force on, else the input
  shadow: {enabled, color, opacity, spread, blur, distance, angle}, // distance/angle ALWAYS from GSettings
}
```

It never reads a widget's `config.json` itself — the caller (see "Widget
Container" note below) owns loading that and passes it in. It never
writes anything either; toggling Force never touches per-widget values,
matching the spec's "Changing Force Settings must not modify or
overwrite per-widget Appearance values."

Also has `watch(onChange)`/`unwatch(id)`, mirroring
`ThemeService.watch()`'s shape, for the next phase's live-reload wiring.

**Naming note on "Widget Container":** this codebase doesn't have one
object by that literal name — each widget paints its own background/
shadow/corner-radius via the shared CSS-string builders in
`lib/widgetVisualKit.js` (`cardStyleCss()`, `shadowBoxShadowCss()`,
etc), called from the widget's own `_render()`. Phase 2 will make those
builders call `ForceSettingsHelper.resolve()` instead of the OLDER
module-level `_forcedTheme` state — that's the closest existing thing to
the spec's "Widget Container… render resolved Appearance" role, short of
inventing a new intermediary object project-wide. Flagging this mapping
explicitly rather than silently reinterpreting the spec.

**Known pre-existing bug noticed, not touched:** `widgetVisualKit.js`'s
`SHADOW_ANGLE_STEPS` has `275` where it should almost certainly be `270`
(`[45, 90, 135, 180, 225, 275]`). `forceSettingsHelper.js` defines its
own correct `[45, 90, 135, 180, 225, 270, 315]` rather than importing
the buggy array, so the new spec's angle values are correct — but the
old array is still used elsewhere (widget-level shadow angle dropdowns)
unfixed. Worth a follow-up, called out here so it isn't lost.

## Not done yet — next steps

1. **Wire the helper in.** `lib/widgetVisualKit.js`'s `cardStyleCss()`/
   `shadowBoxShadowCss()` currently consult the OLDER `_forcedTheme`
   module state (set from `ThemeService.getGlobalTheme()`) for
   background/cornerRadius/dropShadow force. Needs to switch to calling
   `ForceSettingsHelper.resolve()` instead for those three, while
   leaving border/opacity's existing `_forcedTheme` consultation alone.
2. **`extension.js` startup/watch wiring** — construct one
   `ForceSettingsHelper`, call it alongside `ThemeService` at startup and
   on change, same pattern `setForcedTheme()` already uses.
3. **Retire the old background/cornerRadius/dropShadow force flags** from
   `lib/themeService.js`'s `DEFAULT_GLOBAL_THEME` + `getEffectiveWidgetTheme()`
   (keep `border`/`opacity` there) — needs a one-time migration note for
   anyone with an existing `theme.json` that has those flags set, so
   toggling doesn't silently appear to do nothing after upgrade.
4. **Prefs UI** (`lib/prefsPageBuilders.js`): replace the three existing
   "Force this X on every widget" switches (background/corner-radius/
   shadow at lines ~646-812) with ONE switch bound to
   `force-appearance-enabled`, plus rows for the new GSettings-backed
   fields. **Also add the missing Force switches for Border and
   Opacity** (per user's ask this session) — those stay on the OLD
   `theme.json` mechanism, just need the UI row that was never built.
5. **`checklist.md` update** — item 1 ("Force
   background-color/corner-radius") needs a rewrite once the UI changes;
   add a new item for Shadow Distance/Angle always-global behavior
   (verify they stay in effect even with Force off).
6. Nothing in this phase has been runtime-tested against real GNOME
   Shell — schema compiled clean and the helper's syntax-checked, that's
   all so far.

---

## Addendum (2026-08-09, later same day) — split single switch into 4 independent switches

User asked (mid-Phase-1, before anything downstream was wired in) to
replace the single `force-appearance-enabled` switch with **4
independent switches**, so a user can force e.g. Corner Radius alone
without also forcing Background Color/Blur/Shadow. Confirmed the exact
4-way grouping with the user before touching anything:

- **Background Color**
- **Corner Radius**
- **Background Blur**
- **Shadow** (kept as one group — enabled/color/opacity/spread/blur
  move together, gated by one switch; the user's ask was 4 switches
  total, not a further breakdown of Shadow's own sub-fields)

Low-risk timing to make this change: `force-appearance-enabled` had
**zero consumers outside this helper file** (confirmed via grep —
Phase 1 explicitly ended before "wire the helper in", see "Not done
yet" step 1 above), so this was a clean schema + helper edit with
nothing downstream to migrate.

### `schemas/org.gnome.shell.extensions.widget-center.gschema.xml`

- Removed `force-appearance-enabled`.
- Added 4 new boolean keys, each defaulting `false`, each documented as
  independent of the other 3:
  - `force-background-color-enabled`
  - `force-corner-radius-enabled`
  - `force-background-blur-enabled`
  - `force-shadow-appearance-enabled`
- The 8 existing *value* keys (`force-background-color`,
  `force-corner-radius`, `force-background-blur`, `force-shadow-enabled`,
  `force-shadow-color`, `force-shadow-opacity`, `force-shadow-spread`,
  `force-shadow-blur`) are **unchanged** — same names, same types, same
  defaults/ranges. Only their `<summary>` text was updated to name which
  of the 4 new switches gates them, instead of the old singular "used
  when Force is on".
- `shadow-distance`/`shadow-angle` unchanged — still always-global
  regardless of any switch, per the original spec; description tweaked
  from "regardless of force-appearance-enabled" to "regardless of any
  of the 4 force switches".
- Recompiled with `glib-compile-schemas schemas/` — validated clean in
  an isolated dir first, then the real `schemas/gschemas.compiled` was
  regenerated.

### `lib/forceSettingsHelper.js`

- `isForceEnabled()` replaced with 4 separate methods:
  `isBackgroundColorForced()`, `isCornerRadiusForced()`,
  `isBackgroundBlurForced()`, `isShadowForced()` — each reads its own
  GSettings key.
- `resolve()` rewritten so each of the 3 background properties
  (color/cornerRadius/blur) checks its own switch independently rather
  than one shared `forced` boolean — e.g. `background.cornerRadius`
  comes from GSettings iff `force-corner-radius-enabled` is on, fully
  independent of the other two background properties' switches. Shadow
  still resolves as one group behind `isShadowForced()`, matching the
  confirmed 4-way split (Shadow's 5 sub-fields aren't broken out
  further).
- `watch(onChange)` needed **no change** — it already matches on any
  key starting with `force-`, which covers all 4 new keys for free
  (plus the 8 unchanged value keys).
- File header comment rewritten to describe the 4-switch model instead
  of the single switch; `unwatch()` untouched.
- Syntax-checked with `node --check lib/forceSettingsHelper.js` — OK.

### Not touched by this addendum (still true, per original Phase 1 scope)

Everything in the original "Not done yet — next steps" list (1-6)
still applies, just against 4 switches instead of 1 wherever those
steps mention `force-appearance-enabled`:

1. **Wire the helper in** — `lib/widgetVisualKit.js`'s `cardStyleCss()`/
   `shadowBoxShadowCss()` still consult the OLDER `_forcedTheme` module
   state, not this helper. Still pending.
2. **`extension.js` startup/watch wiring** — still pending, construct
   one `ForceSettingsHelper`, same as before.
3. **Retire the old background/cornerRadius/dropShadow force flags**
   from `lib/themeService.js` — still pending, unaffected by the
   4-switch split.
4. **Prefs UI** (`lib/prefsPageBuilders.js`) — still needs the actual
   `Adw.SwitchRow`s built. This is now **4 switch rows instead of 1**:
   one each for Background Color / Corner Radius / Background Blur /
   Shadow, each bound to its own new GSettings key above, plus the
   value-field rows (color pickers, sliders, etc.) for
   force-background-*/force-shadow-* same as before. Also still need
   the separate missing Border/Opacity switches for the OLDER
   mechanism (unrelated to this addendum, unchanged ask from earlier).
5. **`checklist.md` update** — still pending, now should mention 4
   switches rather than 1.
6. Still **not runtime-tested** against real GNOME Shell — schema
   compiled clean, helper syntax-checked, that's all so far.

---

## Addendum 2 (2026-08-09, later still) — Prefs UI: 4 switch rows built

Did next-steps item 4 from the addendum above: real `Adw.SwitchRow`s for
the 4 GSettings switches, in the real GTK4/libadwaita Preferences window
(`lib/prefsPageBuilders.js`'s `_buildAppearanceCategory()`). Also added
the previously-missing Border/Opacity Force switch rows (older
theme.json mechanism, unrelated to the 4 new switches) per the original
user ask noted in the first Handover section above.

### What changed, `lib/prefsPageBuilders.js`

- `_buildAppearanceCategory()` completely rewritten. Was:
  Background/Corner-radius/Drop-shadow groups, all reading/writing
  `theme.json` via `ThemeService`, one "Force this X" switch per group.
  Now: **6 groups**, first 4 backed by GSettings via `this._settings`'s
  `SettingsService` wrapper (**not** raw `Gio.Settings` — see "API
  mismatch caught" below), last 2 still on `theme.json`/`ThemeService`:
  1. **Force: Background Color** — color picker + `force-background-color-enabled` switch
  2. **Force: Corner Radius** — spin row (0–32px) + `force-corner-radius-enabled` switch
  3. **Force: Background Blur** — spin row (0–60px) + `force-background-blur-enabled` switch
  4. **Force: Shadow** — enabled/color/opacity/spread/blur rows (all
     `force-shadow-*` GSettings keys) + ONE `force-shadow-appearance-enabled`
     switch gating all 5 together (matches the confirmed 4-way split —
     Shadow itself isn't broken down further)
  5. **Shadow distance & angle** (new group, no Force switch — always
     global per spec) — `shadow-distance`/`shadow-angle` GSettings rows
  6. **Widget border** / **Widget opacity** (theme.json, unchanged
     mechanism) — added the Force switch row each was missing; value
     rows (enabled/width/color for border, value for opacity) were also
     entirely new, since neither section existed in the UI at all before
     this pass (backend `.force`/value support already existed in
     `themeService.js`, just no UI)
- **Dropped the "Transparent" toggle** for Background Color and Shadow —
  the new GSettings color keys store alpha directly in an 8-digit hex
  (`#rrggbbaa`), so transparency is just "lower the alpha on the color
  picker" now, not a separate boolean. No spec key for it either. Border
  keeps no transparent toggle (never had one). This is a real, visible
  behavior difference from the old page — flagging clearly, not silently.
- New local helper `rgbaToHex8()` (top of file, near the modifier-key
  helper) — alpha-preserving `Gdk.RGBA` → hex, since the shared
  `colorUtils.js#rgbaToHex()` deliberately drops alpha (used by
  border/theme.json colors, which encode transparency via their own
  separate boolean instead). Existing `rgbaToHex` import/usage
  (`lib/prefsPageBuilders.js:1199`'s guide-color row) untouched.
- Swapped the `SHADOW_ANGLE_STEPS` import from `./widgetVisualKit.js`
  (has the pre-existing `275` typo, see first Handover section above)
  to `./forceSettingsHelper.js` (correct `[45,90,135,180,225,270,315]`)
  — only used in this one method, confirmed via grep before switching.

### API mismatch caught before it shipped

First draft of this pass called `settings.get_boolean()`/`set_boolean()`
/`get_int()`/`set_int()`/`get_string()`/`set_string()` directly, assuming
`this._settings` was a raw `Gio.Settings`. It isn't — it's this
project's own `SettingsService` wrapper (`lib/settingsService.js`),
whose only public API is `getGlobalValue(key)`/`setGlobalValue(key,
value)` (auto-detects the GVariant type from the schema). Caught by
grepping how every other row in this same file already talks to
`settings` (`_buildGeneralCategory()`'s language/keybinding/dev-mode
rows etc all use `getGlobalValue`/`setGlobalValue` + a `ready =
settings?.isReady` guard) before this got any further — rewrote every
new row to match that existing convention instead. Worth remembering
for next time: this codebase's "settings" is never the raw GJS object,
always this wrapper.

### Second mismatch caught: missing `settings` parameter

`_buildAppearanceCategory()` was also called with **zero arguments**
from `_buildPreferencesPage()` originally (`build: () =>
this._buildAppearanceCategory()`), while every sibling category builder
(`_buildGeneralCategory(settings)`, `_buildDesktopCategory(settings)`,
`_buildInteractionsCategory(settings)`) receives `settings` explicitly.
The old `_buildAppearanceCategory()` never needed it (theme.json only,
via its own local `ThemeService()`). Fixed by adding a `settings`
parameter and updating the one call site to pass it through, matching
the sibling convention rather than reaching for `this._settings`.

### Validated

- `node --check lib/prefsPageBuilders.js` — OK.
- Manually swept for any remaining raw `settings.get_/set_*` calls in
  the file after the rewrite — none found.
- **Not** runtime-tested against real GNOME Shell/libadwaita (no such
  environment here) — same caveat as every prior phase.

### Known desync — NOT fixed this pass, flagging explicitly

`lib/widgetCenterOverlayPreferences.js` has its own **separate,
St/Clutter-based** mirror of this same Appearance page, for the Widget
Center Overlay's in-Shell "Preferences" tab (GTK4/libadwaita widgets
can't be hosted inside the Shell process — see that file's header).
Its own `_buildAppearanceCategory()` (around line 353) still implements
the **old** single-theme.json-force-flag model verbatim (Background/
Corner-radius/Shadow with one `force` boolean each inside `theme.json`,
no GSettings, no Border/Opacity sections at all) — it was never touched
by either of today's changes. It still works exactly as it did before
(nothing broken), but it's now **out of sync** with the real Preferences
window: a user forcing Background Color from the overlay writes
`theme.json`'s `background.force`, which nothing reads anymore on the
GSettings-resolution path (once step 1/2 from the first Handover
section's "Not done yet" list eventually get done) — while the real
window's own 4 switches write to GSettings instead. Left as-is rather
than expanding this pass's scope; needs its own dedicated pass once
`widgetVisualKit.js`/`extension.js` wiring (next-steps 1–2) is decided,
so the overlay's rewrite can target the same final resolution path
instead of guessing at it twice.

### Still not done (unchanged from Addendum 1, renumbered)

1. Wire `ForceSettingsHelper` into `lib/widgetVisualKit.js`'s
   `cardStyleCss()`/`shadowBoxShadowCss()` — still reads `_forcedTheme`.
2. `extension.js` startup/watch wiring.
3. Retire old background/cornerRadius/dropShadow force flags from
   `themeService.js` (border/opacity stay).
4. ~~Prefs UI~~ — **done this pass**, GTK/libadwaita side only.
5. Mirror the same 4-switch + Border/Opacity rework into
   `lib/widgetCenterOverlayPreferences.js`'s own `_buildAppearanceCategory()`
   (new item, see "Known desync" above).
6. `checklist.md` update.
7. Runtime test against real GNOME Shell.

---

## Addendum 3 (2026-08-09, later still) — item 1: helper wired into widgetVisualKit.js

Did next-steps item 1: `lib/widgetVisualKit.js`'s `cardStyleCss()`,
`blurCss()`, and `shadowBoxShadowCss()` now consult
`ForceSettingsHelper.resolve()` for Background Color / Corner Radius /
Background Blur / Shadow, instead of only the older `_forcedTheme`
module state. `borderCss()` is untouched — border stays on
`_forcedTheme` per the original product decision.

### What changed, `lib/widgetVisualKit.js`

- New module state `_forceSettingsHelper` (mirrors `_forcedTheme`'s
  existing pattern) + new export `setForceSettingsHelper(helper)`, for
  `extension.js` to call once a `ForceSettingsHelper` instance exists
  (that's next-steps item 2, **not done in this pass** — see below).
- New private `_resolveForceSettings(settings, {backgroundColorKey,
  cornerRadiusKey})` — bridges this file's flat widget-settings field
  names (`backgroundColor`/`cornerRadius`/`blurEnabled`+`blurRadius`/
  `shadowEnabled`/`shadowColor`/`shadowOpacity`/`shadowBlur`) into the
  `{background, shadow}` shape `ForceSettingsHelper.resolve()` expects,
  and returns its resolved result — or `null` when no helper has been
  wired in yet, so every call site below has a clean "haven't gotten to
  step 2 yet" fallback.
- `cardStyleCss()` — Background Color and Corner Radius both go through
  one `_resolveForceSettings()` call (the helper already resolves each
  property against its own switch internally, so no need for two
  separate calls here). Falls back to the old two independent
  `_isForced('background')`/`_isForced('cornerRadius')` branches,
  unchanged, when `resolved` is `null`.
- `blurCss()` — same pattern, falls back to the old
  `_isForced('background')` blur consultation (blur used to ride on
  background's switch; now has its own independent switch once wired).
- `shadowBoxShadowCss()` — same pattern; when resolved, Shadow's 5
  fields move together per the confirmed 4-switch split, and
  distance/angle come from the resolved object (always GSettings,
  regardless of the switch, per spec) rather than the widget's own
  `shadowDistance`/`shadowAngle` settings fields. Falls back to the old
  `_isForced('dropShadow')` consultation, unchanged, when `resolved` is
  `null`.

### Behavior impact of this pass, by itself: none

`setForceSettingsHelper()` is a new export with zero callers anywhere
in the codebase yet (grepped to confirm) — `_forceSettingsHelper` stays
`null` until `extension.js` is updated (next-steps item 2), so every
function above takes its `resolved === null` fallback branch, which is
byte-for-byte the same code that ran before this pass. This commit is
inert on its own; item 2 is what actually turns it on.

### Bug noticed, not touched (separate from the pre-existing 275/270 typo)

`lib/cardLayers.js` imports and calls `applyCardBlur(layers.background,
settings)` from `./widgetVisualKit.js` — but `widgetVisualKit.js` has
**no `applyCardBlur` export at all** (confirmed: `grep -n
"applyCardBlur" lib/widgetVisualKit.js` only matches doc-comment
mentions, no `export function applyCardBlur`). This means any widget
using `createLayeredCard()`/`cardLayers.js`'s blur path is currently
calling `undefined(...)`, which would throw at runtime. Out of scope
for this pass (not part of the Force Settings work), but flagging
clearly rather than leaving it silently broken — worth a dedicated
follow-up. `blurCss()` itself (which this pass DID touch) is unaffected
by this bug; it's a plain CSS-string builder, not the actor-effect path
`cardLayers.js` uses.

### Validated

- `node --check lib/widgetVisualKit.js` — OK.
- Not runtime-tested against real GNOME Shell (no such environment
  here, same caveat as every prior phase) — and per "Behavior impact"
  above, there's nothing to runtime-test yet anyway since the new code
  path is unreachable until item 2 lands.

### Not done yet (renumbered again)

1. ~~Wire the helper into `widgetVisualKit.js`~~ — **done this pass**.
2. `extension.js` startup/watch wiring — construct one
   `ForceSettingsHelper`, call `setForceSettingsHelper()` alongside
   `setForcedTheme()` at startup and on GSettings change. **This is the
   step that actually activates everything done so far** — recommended
   next.
3. Retire old background/cornerRadius/dropShadow force flags from
   `themeService.js` (border/opacity stay).
4. Mirror the 4-switch + Border/Opacity rework into
   `widgetCenterOverlayPreferences.js`'s own `_buildAppearanceCategory()`.
5. `checklist.md` update.
6. Runtime test against real GNOME Shell.
7. *(new, found this pass)* Fix or remove the broken `applyCardBlur`
   import in `lib/cardLayers.js` — separate bug, unrelated to Force
   Settings, flagged above.

---

## Addendum 4 (2026-08-09, later still) — fixed the broken `applyCardBlur` (user asked: use Clutter.BlurEffect)

Fixed next-steps item 7 from Addendum 3, per explicit user instruction
to implement it with `Clutter.BlurEffect`. Separate bug from the Force
Settings work itself, but fixing it here since it was found during that
work and blocks anything exercising `createLayeredCard()`'s blur path.

### What changed, `lib/cardLayers.js`

- `applyCardBlur(actor, settings)` is now defined **in this file**
  (previously only imported — and only ever imported, never
  defined — from `./widgetVisualKit.js`). Adds/removes a real
  `Clutter.BlurEffect` (name-tagged `'wc-card-blur'` via
  `add_effect_with_name()`/`get_effect()` so repeated calls toggle the
  same effect instead of stacking duplicates) based on the widget's own
  `blurEnabled`/`blurRadius` settings, using `BLUR_DEFAULTS` imported
  from `widgetVisualKit.js` for fallbacks (that const has no Clutter
  dependency, safe to import as before).
- Defined here rather than in `widgetVisualKit.js` because it needs
  `gi://Clutter`, which that file can never import (Prefs-process
  constraint — see this file's own header comment, which I also
  corrected: it previously said `setClutterBackend()` was documented
  over in `widgetVisualKit.js`, but grepped and confirmed no such
  function exists anywhere in the codebase — stale comment, removed
  that dangling reference rather than repeating it).
- Header "why this needed to exist" note updated to stop describing
  `applyCardBlur()` as if it still lived in/was imported from
  `widgetVisualKit.js` — it's self-contained in this file now.

### IMPORTANT — confirmed against Mutter's own Clutter.BlurEffect API reference

`Clutter.BlurEffect` has **no configurable properties of its own** —
only `enabled`/`name`/`actor`, inherited from `ClutterActorMeta`.
`clutter_blur_effect_new()` is a single fixed-strength blur with no
sigma/radius/strength knob (checked
`https://mutter.gnome.org/clutter/class.BlurEffect.html` directly — its
own property list confirms this). Practical effect: `blurRadius` (and,
once wired, the Force system's `force-background-blur` value) can only
ever act as **ON/OFF** here (`radius > 0` → effect added, else
removed) — there is no way to make this specific effect stronger or
weaker, because it exposes nothing to carry that number to.

If a genuinely variable-strength blur is wanted later, GNOME Shell's
own private `Shell.BlurEffect` (`gi://Shell`) does expose a `radius`
property (per the GNOME 46 porting notes: "sigma in Shell.BlurEffect
should be replaced by radius") and would be the class to reach for
instead — noted here rather than silently implemented, since swapping
to a private Shell API is a bigger decision than this pass's scope.

### Separate open question, flagged not resolved

`applyLayeredCardStyle()` calls this new `applyCardBlur()` **alongside**
`background.set_style(cardStyleCss(...))`, and `cardStyleCss()`'s
`includeBlur` option (default `true`) already appends
`widgetVisualKit.js`'s own `blurCss()` — which paints a real
`-st-background-blur: Npx;` CSS declaration on that same actor. Now
that `applyCardBlur()` actually does something (rather than throwing),
a layered card's background gets **both** a CSS background-blur and a
`Clutter.BlurEffect` stacked on the same actor at once. Left as-is —
deciding whether that's intentional (extra strength) or a leftover from
two blur mechanisms that were never reconciled is its own follow-up,
not assumed either way here.

### Validated

- `node --check lib/cardLayers.js` — OK.
- `node --check lib/widgetVisualKit.js` — OK (unaffected by this
  addendum, listed for completeness since both were touched today).
- Grepped for any other importer of `applyCardBlur` — only
  `cardLayers.js` itself (`applyLayeredCardStyle()`) calls it; no other
  file imports it from anywhere.
- **Not** runtime-tested against real GNOME Shell — `Clutter.BlurEffect`
  behavior (visual result, `add_effect_with_name`/`get_effect` toggling)
  is unverified outside a real Shell process, same caveat as everything
  else in this handover.

### Not done yet (renumbered again)

1. `extension.js` startup/watch wiring for `ForceSettingsHelper` —
   still the step that activates Addendum 3's work. Recommended next.
2. Retire old background/cornerRadius/dropShadow force flags from
   `themeService.js` (border/opacity stay).
3. Mirror the 4-switch + Border/Opacity rework into
   `widgetCenterOverlayPreferences.js`'s own `_buildAppearanceCategory()`.
4. `checklist.md` update.
5. Runtime test against real GNOME Shell.
6. Decide the CSS-blur-vs-Clutter.BlurEffect double-application question
   noted above.

## Addendum 5 (2026-08-09, later still) — item 2: extension.js wiring done, Force Settings now LIVE

Did next-steps item 2 — the step Addendum 3 called out as the one that
actually activates everything done in Phases 1–4. `ForceSettingsHelper`
is now constructed at startup and its resolved values are what every
widget's `cardStyleCss()`/`blurCss()`/`shadowBoxShadowCss()` actually
paints with — the 4-switch model is no longer inert.

### What changed, `extension.js`

- New imports: `setForceSettingsHelper` (added to the existing
  `widgetVisualKit.js` import) and `ForceSettingsHelper` from
  `./lib/forceSettingsHelper.js`.
- `enable()` — new block right after the existing `ThemeService.watch()`
  call (before `SettingsService` is constructed):
  - `this.getSettings('org.gnome.shell.extensions.widget-center')` —
    called directly on the `Extension` instance for a **second, raw**
    `Gio.Settings` object, separate from the `SettingsService` wrapper
    built one line below. Necessary because `ForceSettingsHelper`'s
    constructor contract needs `get_boolean()`/`get_int()`/
    `get_string()`/`connect('changed', ...)` directly (see its own file
    header) — `SettingsService`'s only public surface is
    `getGlobalValue()`/`setGlobalValue()`, deliberately not widened for
    this (see Addendum 2's "API mismatch caught" note, same reasoning
    applies here). Two independent `Gio.Settings` objects on the same
    schema is the same shape `ThemeService`/`SettingsService` already
    coexist in, not a new pattern.
  - `new ForceSettingsHelper(forceGSettings)`, then immediately
    `setForceSettingsHelper(this._forceSettingsHelper)` — seeded before
    any widget's first render, same "don't wait for the first change
    signal" reasoning `setForcedTheme()` already documents for
    `theme.json` right above it (a widget opening with a Force switch
    already on must render forced on its very first paint).
  - `this._forceSettingsHelper.watch(() => this._reapplyTheme())` — reuses
    the *existing* `_reapplyTheme()` method verbatim (the same one
    `ThemeService.watch()` already calls) rather than adding a second
    repaint path; `ForceSettingsHelper.watch()`'s own filter (any
    `force-*`/`shadow-distance`/`shadow-angle` key) means this fires for
    all 4 switches and all 8 value keys with one connection.
  - Wrapped in try/catch, degrading to `this._forceSettingsHelper = null`
    on failure — same non-essential-service pattern
    `SettingsService.init()` uses immediately below it. A Force Settings
    setup failure now means "widgets render with their own per-widget
    values, same as Force being off everywhere," never a startup crash.
- `disable()` — new teardown block, inserted right after the existing
  `ThemeService`/`setForcedTheme(null)` teardown and before
  `disabled-widgets`/etc GSettings disconnects: `unwatch()`s the helper's
  change handler, nulls `this._forceSettingsHelper`, and calls
  `setForceSettingsHelper(null)` so `widgetVisualKit.js` falls back to
  its (already-nulled) `_forcedTheme` path rather than holding a
  reference into a `Gio.Settings` object that's about to go away.
  Ordering mirrors ThemeService's own teardown for the same reason
  (stop watching before anything `_reapplyTheme()` touches is destroyed
  further down `disable()`).

### Behavior impact of this pass: real, for the first time

Unlike Addendum 3 (inert — zero callers of `setForceSettingsHelper()`
anywhere), this pass **is** that caller. All 4 Force switches +
Shadow Distance/Angle now take effect the moment `enable()` runs and
live-update on every GSettings change, for every widget that calls
`widgetVisualKit.js`'s CSS-string builders (the ~50 non-`themeable`
widgets — `themeable: true` widgets like clock/calendar-minimal are
unaffected, they still go through `ThemeService.applyWidgetStyle()`
only, per `_reapplyTheme()`'s own existing branch).

### Validated

- `node --check extension.js` — OK.
- Manually re-read the new `enable()`/`disable()` blocks against
  `ThemeService`'s existing sibling blocks for parameter/ordering
  parity — no raw `Gio.Settings` calls leaked outside the try/catch, no
  new module left unimported, `_forceSettingsChangedId` initialized to
  `null` on the failure path so `disable()`'s `unwatch()` call is always
  safe even if setup threw.
- **Not** runtime-tested against real GNOME Shell — same caveat as every
  prior phase; this is the first pass where that caveat actually matters
  for *visible* behavior (Phases 1–4 were schema/helper/UI/plumbing with
  no live effect until now).

### Not done yet (renumbered again)

1. ~~`extension.js` startup/watch wiring~~ — **done this pass**.
2. Retire old background/cornerRadius/dropShadow force flags from
   `themeService.js` (border/opacity stay).
3. ~~Mirror the 4-switch + Border/Opacity rework into
   `widgetCenterOverlayPreferences.js`'s own `_buildAppearanceCategory()`~~
   — **turned out to be moot**: that file was already deleted 2026-08-09
   as dead code (see `schemas/…gschema.xml`'s `widget-center-overlay-
   keybinding` key doc and `stylesheet.css`'s matching comment) once the
   overlay's "Preferences" button started handing off to the real
   Preferences window instead of hosting its own reimplementation. This
   item pre-dates that deletion and should have been struck out earlier
   — no in-Shell Appearance page exists to desync from any more.
4. `checklist.md` update — should also add a case for the 4
   independent switches actually being live now (e.g. forcing Corner
   Radius alone while Background Color stays per-widget).
5. Runtime test against real GNOME Shell — this pass is the one that
   makes that test meaningful for the first time.
6. Decide the CSS-blur-vs-`Clutter.BlurEffect` double-application
   question from Addendum 4 (unrelated, still open).

---

## Addendum 6 (2026-08-09, later still) — item 2 done, blur question resolved, angle typo fixed, overlay-prefs confirmed already gone

Four small, independent cleanups this pass, each user-directed:

### 1. Confirmed: no overlay-preferences file to delete

Checked next-steps item 3 above before touching anything —
`lib/widgetCenterOverlayPreferences.js` doesn't exist in this tree.
`stylesheet.css` and the gschema's `widget-center-overlay-keybinding`
key doc both already record it as deleted 2026-08-09, dead code once
`widgetCenterOverlay.js`'s "Preferences" button started handing off to
the real Preferences window instead of hosting its own
`_buildAppearanceCategory()`. No code change needed — item 3 above is
now struck through as moot rather than actually completed.

### 2. Retired background/cornerRadius/dropShadow's old force flags — `lib/themeService.js`

Did next-steps item 2. `DEFAULT_GLOBAL_THEME.background.force` /
`.cornerRadius.force` / `.dropShadow.force` removed; `getEffectiveWidgetTheme()`
now always merges those three with the per-widget `config` (no more
`base.X.force ? {...base.X} : {...base.X, ...config.X}` ternary for
them). `border.force` / `opacity.force` and their ternaries are
UNCHANGED — that split was an explicit, standing product decision (see
this file's own header comment), not something this pass revisited.

**Migration note** (also written into the file itself): an existing
`theme.json` with `global.background.force: true` (etc.) from before
this date keeps that key on disk — `save()`/`reload()` round-trip the
file verbatim — but it's dead data now, silently ignored rather than
stripped.

**Known gap, flagged not fixed**: `ThemeService.applyWidgetStyle()` —
the method actually used for `themeable: true` widgets (clock,
calendar-minimal, etc. — see `extension.js`'s `_reapplyTheme()`) — was
left untouched. It never consulted `ForceSettingsHelper` and still
doesn't. Net effect: Force Settings (all 4 switches) currently affects
only the ~50 non-themeable widgets that go through
`widgetVisualKit.js`'s CSS builders; the handful of `themeable: true`
widgets now have **no** way to be forced for background/corner-radius/
shadow at all (not even the old, retired mechanism). Two ways to close
this, neither done here: wire `applyWidgetStyle()` into
`ForceSettingsHelper` too, or accept/document that Force Settings is
scoped to non-themeable widgets only.

### 3. Fixed `SHADOW_ANGLE_STEPS`'s long-standing typo — `lib/widgetVisualKit.js` + `lib/forceSettingsHelper.js`

Did next-steps item 6 (Addendum 3's numbering). Was
`[45, 90, 135, 180, 225, 275]` — `275` was a typo for `270`, and `315`
was missing outright. Now `[45, 90, 135, 180, 225, 270, 315]`, matching
what `forceSettingsHelper.js` already had as its own hand-kept
"corrected" copy (its own comment already named the exact bug — see
that file, pre-existing). Since the two arrays are now identical,
`forceSettingsHelper.js` was changed to `import`+`re-export` the
constant from `widgetVisualKit.js` instead of duplicating it — confirmed
safe (no circular import): `widgetVisualKit.js` never statically
imports `forceSettingsHelper.js`, only holds an externally-injected
reference via `setForceSettingsHelper()`. `prefsPageBuilders.js` already
imported `SHADOW_ANGLE_STEPS` from `forceSettingsHelper.js`, so it needs
no change and transparently gets the fixed values.

**Behavior note**: a stored angle of `275` from before this fix (GSettings
`shadow-angle` or a widget's own `config.dropShadow.angle`) no longer
matches any array entry. `forceSettingsHelper.js`'s `coerceAngle()`
already falls back to the 90° default for any unrecognized value, so
this degrades gracefully rather than crashing — but IS a visible change
for anyone who had actually picked 275°.

### 4. Resolved the blur double-application question — `lib/cardLayers.js` (Clutter.BlurEffect wins, per user)

Did next-steps item 5/6 (numbered differently across addenda above).
User confirmed: CSS `-st-background-blur` does not actually render in
the target environment, so `Clutter.BlurEffect` is the one blur
mechanism going forward. `applyLayeredCardStyle()` now forces
`includeBlur: false` when calling `cardStyleCss()`, so that CSS
declaration is never emitted on the layered-card path —
`applyCardBlur()` (already Clutter.BlurEffect-based, see Addendum 4) is
the only thing that paints blur there now.

**Scope note, flagged not fixed**: this only resolves the
`createLayeredCard()`/`applyLayeredCardStyle()` path, and — per
Addendum 5 — **nothing calls that path yet**, so this was a dormant bug.
The ~24 widgets that call `widgetVisualKit.js`'s `cardStyleCss()`
directly on their own single root actor (`circles-*`,
`media-player-*`, `calendar-modern`, `power-menu-bar`,
`settings-control-bar`, `switches`) still rely solely on the
(apparently non-rendering) CSS blur declaration — their blur setting is
therefore still effectively a no-op in the target environment. Fixing
those for real means migrating each one to `createLayeredCard()` first
(background/content actors split), since adding `Clutter.BlurEffect`
directly to their current root actor would blur their own labels/icons
too — the exact bug `cardLayers.js` was built to solve for the layered
path. Left undone this pass; user did not ask for the 24-widget
migration, only for the mechanism decision.

### Validated

- `node --check` clean on all four touched files: `lib/themeService.js`,
  `lib/widgetVisualKit.js`, `lib/forceSettingsHelper.js`,
  `lib/cardLayers.js`.
- Grepped every consumer of `SHADOW_ANGLE_STEPS`
  (`prefsPageBuilders.js`, `themeService.js`'s doc comments,
  `cardLayers.js`'s doc comments) — only `prefsPageBuilders.js` actually
  imports the binding, and it already imported from
  `forceSettingsHelper.js`, so no caller needed updating.
- Grepped every consumer of `getEffectiveWidgetTheme()` /
  `applyWidgetStyle()` — only `extension.js`'s `_reapplyTheme()` and
  widget-side theme-page code call these; neither reads `.force` off
  the returned background/cornerRadius/dropShadow objects directly (the
  old ternary was internal to `getEffectiveWidgetTheme()` itself), so
  removing those three `force` flags doesn't leave any caller reading a
  now-undefined field.
- **Not** runtime-tested against real GNOME Shell — same caveat as
  every prior addendum.

### Not done yet (superseded by Addendum 7 below for item 1)

1. ~~Wire `applyWidgetStyle()` (themeable widgets) into
   `ForceSettingsHelper`~~ — **done, see Addendum 7**.
2. `checklist.md` update.
3. Runtime test against real GNOME Shell.
4. Migrate the ~24 direct-`cardStyleCss()` widgets to
   `createLayeredCard()` so their blur setting actually renders via
   `Clutter.BlurEffect` — not requested this pass, flagged only.

---

## Addendum 7 (2026-08-09, later still) — item 1: `applyWidgetStyle()` (themeable widgets) wired into ForceSettingsHelper

Closed the gap Addendum 6 flagged: `themeable: true` widgets (clock,
calendar-minimal, etc. — the only ones rendered via
`ThemeService.applyWidgetStyle()` instead of `widgetVisualKit.js`'s CSS
builders, see `extension.js`'s `_reapplyTheme()`) previously had **no**
way to be forced for Background Color/Corner Radius/Background
Blur/Shadow at all, even with every other widget on the desktop obeying
those switches. They now resolve Force identically to every other
widget.

### `lib/widgetVisualKit.js` — two private helpers exported for reuse

- `_boxShadowCss()` → `export function boxShadowCss(...)`. No behavior
  change; only reason to touch this file at all. Its existing "8-digit
  alpha-baked hex fails the 6-hex-digit color check, falls back to
  black, `opacityPercent` supplies alpha instead" quirk is unchanged and
  now documented explicitly in its doc comment (pre-existing, not
  introduced here — same quirk already applied to every OTHER widget's
  forced-shadow render path before this pass; wiring `applyWidgetStyle()`
  into the same helper just makes themeable widgets consistent with
  that, not different from it).
- `_withAlphaHex()` → `export function withAlphaHex(...)`. No behavior
  change.
- Both were already private, single-internal-caller functions; exporting
  them avoids `themeService.js` hand-rolling a third copy of either.

### `lib/themeService.js`

- New constructor field `this._forceSettingsHelper = null`.
- New method `setForceSettingsHelper(helper)` — same
  "store-or-null" shape as `widgetVisualKit.js`'s own function of the
  same name, called once by `extension.js` right after constructing its
  `ForceSettingsHelper`, and again with `null` on `disable()`.
- `applyWidgetStyle(actor, widgetId)` rewritten: bridges the widget's
  own effective `{background, cornerRadius, dropShadow}` (from
  `getEffectiveWidgetTheme()`, unchanged) into the `{background, shadow}`
  shape `ForceSettingsHelper.resolve()` expects — `background.color`
  baked to an alpha-hex via the newly-exported `withAlphaHex()` (folding
  in this file's separate `transparent` boolean, since the resolve()
  contract has no separate flag for that), `dropShadow`'s `enabled`
  similarly folds in `!dropShadow.transparent` up front, `opacity`
  converted from this file's `0-1` float to the helper's `0-100` percent.
  When a helper is wired in, renders from the resolved values (using the
  newly-exported `toCssColor()`/`boxShadowCss()` from
  `widgetVisualKit.js` for consistency with every other widget's forced
  path) instead of `getEffectiveWidgetTheme()`'s raw values. When no
  helper is wired (`this._forceSettingsHelper` still `null`), falls
  through to the **exact, byte-for-byte unchanged** pre-2026-08-09 code
  path — same "inert until wired" contract `widgetVisualKit.js`'s own
  copy of this pattern already has (see Addendum 3).
- Border/Opacity are completely untouched — `getEffectiveWidgetTheme()`
  still resolves those two only from `global.border.force`/
  `global.opacity.force`, unaffected by any of this.
- File header's "Known gap" note (in the 2026-08-09 migration section)
  rewritten to record the gap as closed rather than open.

### `extension.js`

- `enable()`: right after `setForceSettingsHelper(this._forceSettingsHelper)`
  (the existing call that wires `widgetVisualKit.js`), one new line:
  `this._themeService.setForceSettingsHelper(this._forceSettingsHelper)`
  — same instance, seeded before any widget's first paint, same as
  `widgetVisualKit.js`'s own call right above it. `ThemeService` is
  already constructed/`init()`'d earlier in `enable()`, so this is safe
  at this point in the method.
- `disable()`: `this._themeService?.setForceSettingsHelper(null)` added
  right before `this._themeService = null`, so `ThemeService` drops its
  reference before the `ForceSettingsHelper`/its `Gio.Settings` are torn
  down two lines later — same ordering reasoning already documented for
  the `widgetVisualKit.js` teardown right below it.

### Validated

- `node --check` clean on all three touched files: `extension.js`,
  `lib/themeService.js`, `lib/widgetVisualKit.js`.
- Grepped every consumer of `applyWidgetStyle()`/`getEffectiveWidgetTheme()`
  — only `extension.js`'s `_reapplyTheme()`/first-placement code call
  `applyWidgetStyle()`, both already updated implicitly (they just call
  the method, no shape assumptions about its internals); one doc-comment
  mention in `lib/prefsWidgetManagement.js`, not a call site, untouched.
- Grepped every consumer of the two newly-exported `widgetVisualKit.js`
  functions (`_boxShadowCss`/`_withAlphaHex` old names) — none remain;
  only the renamed exports are referenced anywhere in the tree now.
- **Not** runtime-tested against real GNOME Shell — same caveat as
  every prior addendum. This pass changes real, visible behavior for
  `themeable: true` widgets (same "first pass where the caveat matters"
  situation Addendum 5 flagged for the non-themeable path).

### Not done yet

1. ~~Wire `applyWidgetStyle()` (themeable widgets) into
   `ForceSettingsHelper`~~ — **done, see Addendum 7**.
2. ~~`checklist.md` update~~ — **done, see Addendum 8**.
3. Runtime test against real GNOME Shell.
4. Migrate the ~24 direct-`cardStyleCss()` widgets to
   `createLayeredCard()` so their blur setting actually renders via
   `Clutter.BlurEffect` — not requested this pass, flagged only.

---

## Addendum 8 (2026-08-09, later still) — item 2: checklist.md rewritten for the 4-switch model

Did next-steps item 2. `checklist.md`'s old "## 1. Force
(background-color / corner-radius)" section described the pre-Addendum-2
single-group UI (two properties, one Force switch each, no Shadow/
Border/Opacity coverage at all) — stale since the Prefs UI rewrite.

### What changed, `checklist.md`

Replaced with "## 1. Force Settings — 4 independent switches (+
Border/Opacity, older mechanism)", split into six subsections matching
the six actual Preferences groups:

- **1a Background Color / 1b Corner Radius / 1c Background Blur / 1d
  Shadow** — each with its own on/off check, explicitly run against
  **both** a non-themeable widget (qa-test-widget) and a themeable one
  (`clock`/`calendar-minimal`) — the latter is new, since themeable
  widgets couldn't be forced at all before Addendum 7 landed. 1a calls
  this out as the most important case to verify, since it's the one
  that was previously silently broken.
- **1b** also adds an explicit independence check (forcing Corner
  Radius must not affect whether Background Color is forced), covering
  the Addendum 1/3 "4 independent switches, not 1" behavior that had no
  checklist coverage before.
- **1c** adds a note to verify Background Blur is visibly ON/OFF only
  (per Addendum 4's finding that `Clutter.BlurEffect` has no strength
  knob), so a tester doesn't mistake "no visible change as the slider
  moves" for a bug.
- **1d** adds a check that Shadow's 5 sub-fields move together as one
  group (by design, per the confirmed 4-way split), so a tester doesn't
  mistake that for a missing feature.
- **1e Shadow Distance & Angle** — new subsection, covering next-steps'
  other ask ("verify they stay in effect even with Force off"):
  confirms distance/angle apply globally with **Force: Shadow off**,
  since that's the one part of the spec with no on/off branch at all.
- **1f Border / Opacity** — new subsection covering the Addendum 2 UI
  addition (these switches didn't exist in the UI before that pass, so
  had no checklist coverage since); confirms independence from the 4
  newer switches too.
- Sections 2–8 (dependency checking, `.gwct`/`.gwcbak` export/import/
  backup/restore, edge cases, Weather Dark) are content-unrelated to
  Force Settings and were left exactly as they were — only renumbering
  checked (still 1–8, unchanged) since section 1 grew subsections rather
  than shifting anything after it.

### Not done yet

1. ~~Wire `applyWidgetStyle()` (themeable widgets) into
   `ForceSettingsHelper`~~ — **done, see Addendum 7**.
2. ~~`checklist.md` update~~ — **done this pass**.
3. Runtime test against real GNOME Shell — this checklist is what that
   test would actually run through now.
4. Migrate the ~24 direct-`cardStyleCss()` widgets to
   `createLayeredCard()` so their blur setting actually renders via
   `Clutter.BlurEffect` — not requested this pass, flagged only.

---

## Addendum 9 (2026-08-09, later still) — the actual "Force Blur/Border/Opacity doesn't work" bug reports, root-caused and fixed

User reported three things not working: Force Blur, Force Border,
Force Opacity. All three had real, distinct root causes — none of them
were about the Force *switches* themselves (those have been correct
since Addendum 7); every one of them was a missing/absent application
step downstream of a correctly-resolved value.

### Root cause 1 — Opacity: no widget ever applied it, ever

`lib/widgetVisualKit.js`'s `opacityValue()`/`applyCardOpacity()` were
already fully Force-aware (consult `_isForced('opacity')` on the older
`_forcedTheme` mechanism, same as `borderCss()`) — but grepping the
entire tree found **zero** callers of either function outside
`lib/cardLayers.js` (dead `createLayeredCard()` path, nothing uses it)
and `lib/themeService.js` (which doesn't call it either, on inspection
— only imports it). No widget.js anywhere ever set `actor.opacity`
from its own settings. This was never wired at all, force or no force.

### Root cause 2 — Blur: CSS blur doesn't render (known, Addendum 6), and the Clutter.BlurEffect fallback is also never called

Confirmed again: `blurCss()`'s `-st-background-blur` CSS declaration
(still emitted by `cardStyleCss()` for the ~22 widgets that call it,
and by `applyWidgetStyle()` for themeable widgets) does not render in
the target environment (per Addendum 6/4, unchanged). The one thing
that DOES work — `lib/cardLayers.js`'s `applyCardBlur()`, a real
`Clutter.BlurEffect` — has zero callers anywhere in the tree, same as
opacity above. `createLayeredCard()` (the path `applyCardBlur()` was
built for) is never used by any of the 64 bundled widgets.

### Root cause 3 — Border: `applyWidgetStyle()` (themeable widgets) never emitted a `border:` declaration

Non-themeable widgets get border for free — `cardStyleCss()` already
calls `borderCss()` internally, and `borderCss()` was already correct.
But `themeable: true` widgets (`clock`, `calendar-minimal`) render
exclusively through `lib/themeService.js`'s `applyWidgetStyle()`, which
builds its own separate CSS string and simply never had a `border:`
line in it — `getEffectiveWidgetTheme()` was already correctly
resolving Force for `border` (returns a fully force-merged `border`
object), the resolved value just had nowhere to go.

### Fixes

- **`extension.js`** — new `_applyCardEffects(entry)`, called from both
  `_placeEntry()` (initial placement) and `_reapplyTheme()` (every
  Force-switch/theme.json change), on every widget's own root
  `entry.actor` — regardless of `themeable`, since this is the one
  place in the codebase that already has both the actor and its
  settings object for every widget without exception. Calls
  `applyCardOpacity(entry.actor, entry.settings)` (from
  `widgetVisualKit.js`) and `applyCardBlur(entry.actor, entry.settings)`
  (from `cardLayers.js`) — both pre-existing, both already correct,
  neither previously called by anything.
- **`lib/themeService.js`**'s `applyWidgetStyle()` — now destructures
  `border` from `getEffectiveWidgetTheme()` and, unconditionally (same
  "stays on the older mechanism regardless of `resolved`" rule Border
  has always followed), pushes a `border: {width}px solid {color};`
  declaration when `border.enabled`. Mirrors `borderCss()`'s own CSS
  shape in `widgetVisualKit.js` for consistency.

### Known limitation, flagged not fixed — blur now blurs the WHOLE widget, not just its background

`applyCardBlur()` adds `Clutter.BlurEffect` directly to `entry.actor` —
which, for every widget except the (currently zero) `createLayeredCard()`
ones, is the widget's single root actor containing its own labels/
icons/content, not a dedicated background-only layer.
`Clutter.BlurEffect` has no way to target only part of an actor's paint
(same "no strength knob" limitation already documented in Addendum 4),
so turning Force Blur on now visibly blurs a widget's text/icons along
with its background — a real, visible improvement over "does nothing
at all," but not the isolated background-only blur the layered-card
path was designed to eventually provide. Properly isolating this still
means the ~24-widget `createLayeredCard()` migration flagged (and
explicitly not requested) back in Addendum 6/8's "Not done yet" list —
unchanged, still open, now the same fix would also make blur
background-only instead of whole-actor.

### Validated

- `node --check` clean on all five touched files: `extension.js`,
  `lib/themeService.js`, `lib/widgetLoader.js`, `lib/widgetCenterOverlay.js`,
  `lib/prefsWindowController.js`.
- Grepped `applyCardOpacity`/`applyCardBlur` call sites after the fix —
  `extension.js`'s new `_applyCardEffects()` is now the only call site
  for each, in addition to their own definitions.
- **Not** runtime-tested against real GNOME Shell — same caveat as
  every prior addendum; this is the first pass where Opacity/Blur have
  ever had a code path to test at all.

---

## Addendum 10 (2026-08-09, later still) — 5 more user-reported items, unrelated to Force Settings but fixed alongside it

Bundled into the same session since they came in on the same report.
None of these touch Force Settings; listed here only because
`checklist.md` (this doc's usual companion) doesn't have a better home
for a mixed bag this size yet.

1. **Shadow clipped by its own block** (`lib/widgetLoader.js`) —
   `_enforceBlockSize()` called `.clip(true)` with no second argument,
   silently defaulting `StWidgetWrapper.clip()`'s `overflowPx` to `0`
   (exact clip, no bleed) — even though the class already tracked
   `this._shadowOverflowMargin` (seeded from the `widget-spacing`
   GSetting, default 16px) specifically so a shadow could bleed past
   the block footprint before being cut. The margin was computed and
   kept live (`shadowOverflowMargin` setter) but never actually passed
   in. Now `.clip(true, this._shadowOverflowMargin)`. One-line fix; no
   `overflowPx` support needed adding, it already existed unused.
2. **Theme pack card: "Load" → "Apply"** (`lib/widgetCenterOverlay.js`,
   `_buildThemePackCard()`) — label and `accessible_name` text only,
   no behavior change; internal method name `_loadThemePack()` left
   as-is.
3. **Overview tab (overlay): icon-only Settings/Uninstall buttons →
   icon+text** (`lib/widgetCenterOverlay.js`, `_buildWidgetCard()`) —
   swapped `_buildIconButton()` for `_buildIconTextButton()`, same
   pattern the Themes tab's own Uninstall button already used. Matches
   the real GTK4 Preferences window's own Overview tab
   (`prefsWindowController.js`), which already had icon+text here.
4. **Preferences (GTK4) Overview tab: Enable/Disable text button →
   switch** (`lib/prefsWindowController.js`, `_buildWidgetCard()`) —
   replaced the `Gtk.ToggleButton` (whose label had to be manually kept
   in sync with its own state) with a plain `Gtk.Switch`, matching the
   overlay's own custom switch-styled toggle for the same control.
5. **Theme pack export: dialog existed, no way to open it from the
   overlay** — `lib/themePackExportDialog.js` (name/description/
   author/email/url/screenshot fields, Close/Export, Export → native
   Save dialog) was already complete and already wired into the real
   Preferences window's Import/Export category. The
   `--export-theme-id=`/`--export-theme-new` CLI flags that launch it
   pre-filled for a specific pack (or blank, for the current desktop)
   were also already implemented in `widget-center-prefs-app.js`. What
   was missing: the overlay's Themes tab never actually called either
   flag. Added two entry points in `lib/widgetCenterOverlay.js`: a
   per-card "Export" button (`_exportThemePack(entry)`, wired to
   `--export-theme-id=<id>`) and a tab-level "Export current desktop…"
   button in the sort bar (blank form, `--export-theme-new`).

### Validated

- `node --check` clean on all touched files (see Addendum 9's list,
  same set).
- Not runtime-tested against real GNOME Shell/GTK4 — same caveat as
  everything else in this document.

### Not done yet

1. Runtime test against real GNOME Shell — everything in Addenda 9/10
   is code-reviewed and syntax-checked only.
2. The ~24-widget `createLayeredCard()` migration (Addendum 9's "Known
   limitation") — still the only way to make Blur background-only
   instead of whole-actor.
3. `checklist.md` — not updated for items 2-6 of this session's report
   (Force Blur/Border/Opacity fixes ARE covered by the existing
   Section 1 checklist items, no change needed there; the shadow-clip,
   Load→Apply, icon+text, and Enable-switch/Export-button items have no
   checklist coverage yet).


