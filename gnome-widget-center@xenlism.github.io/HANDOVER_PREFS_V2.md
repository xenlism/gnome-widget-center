# Handover — Preferences Window V2 (Overview / Themes / Preferences / About)

## 2026-08-08 addendum — 800px width, 2-per-row cards, accordion Preferences

Three follow-up changes on top of everything below, requested this session:

1. **Fixed 800px width everywhere.** The old "full-bleed edge-to-edge"
   card grid (`_bareFullBleedPage()`, `window.maximize()`) is gone.
   Every tab — Overview, Themes, Preferences, About — now renders
   inside an explicit `Adw.Clamp` pinned to `maximum-size: 800`, so
   they all line up at the same reading width instead of Overview/
   Themes trying (and, per the "Known limitation" section below, not
   fully succeeding) to fill the whole window. `window.maximize()` was
   removed; the window now opens at a normal `900x760` default size.
2. **Cards: 3-per-row → 2-per-row.** `_buildCardFlowBox()`'s
   `max_children_per_line` dropped from 3 to 2, and `_buildCardShell()`'s
   fixed card width grew from 340px to 370px (two 370px cards + 20px
   spacing = 760px, comfortably inside the new 800px clamp — the old
   340×3 math is exactly what needed full-bleed to avoid clipping).
3. **Preferences: sidebar → accordion.** The Preferences tab no longer
   uses `Adw.NavigationSplitView` (sidebar list + Gtk.Stack). It's now
   a single page where each category (General, Appearance, Desktop, …)
   is a collapsible card the user opens/closes in place — see
   `lib/prefsPageBuilders.js`'s new `_buildCategoryAccordion()` /
   `_buildAccordionCategory()`. This is **opt-in** via a new
   `{layout: 'accordion'}` option on `_buildPreferencesPage()`; v1
   (`prefs.js` via `lib/prefsWindowController.js`) never passes it and
   keeps its sidebar exactly as before. Every category's own `build()`
   function is 100% unchanged — only how the result is displayed
   differs (revealed in place vs. swapped into a stack).

The "Known limitation: Overview/Themes can't go fully edge-to-edge"
section below is now historical — it described exactly the problem
change #1 above sidesteps by no longer trying to go edge-to-edge at
all. Left in place rather than deleted, since it's still useful
context for *why* the old shim existed.

## 2026-08-08, second addendum — shortcut moved to General, "load widget on install"

1. **Keyboard shortcut moved: Interactions → General.** The
   `widget-center-overlay-keybinding` recorder row (unchanged code —
   only its location moved) now lives at the bottom of General instead
   of Interactions, which is really about drag/snap behavior
   specifically. No bug fix was made to the shortcut recorder itself in
   this pass — nothing in this project's history flagged one open, and
   none was reported this session; if a specific shortcut bug is still
   showing up, please describe the exact symptom.
2. **New: "Load new widgets automatically" (General → Widgets).** A new
   `auto-enable-new-widgets` GSettings key (default `true`, preserving
   every prior version's behavior) controls what happens the first time
   a widget id is ever seen — installed manually, dropped in by a theme
   pack, or newly bundled by an update. On (default): enabled
   immediately, same as before this key existed. Off: added straight to
   `disabled-widgets` so it shows up in Overview but stays off the
   desktop until turned on manually.

   Implementation: a new shared `applyAutoEnablePolicy(settings,
   discoveredIds)` method (`lib/prefsWidgetManagement.js`, in the same
   mixin both v1 and v2 already compose onto `PrefsWindowController`)
   diffs the discovered widget ids against a new bookkeeping-only
   `known-widget-ids` GSettings key and applies the policy to anything
   not yet known, called once near the top of both v1's
   `_buildOverviewPage()` and v2's `_buildOverviewCardsTab()`, before
   either reads `disabled-widgets` to render. `known-widget-ids` is
   deliberately excluded from `.gwct` theme export (same reasoning
   `disabled-widgets` itself already was) but IS included in the full
   `.gwcbak` backup, alongside the new `auto-enable-new-widgets` key
   itself.

   Not yet exercised against a real GNOME Shell prefs process — worth
   confirming on real hardware that a widget dropped into
   `~/.local/share/gnome-widget-center/widgets/` while the Preferences
   window is closed is correctly picked up as "new" the next time it's
   opened (relies on `known-widget-ids` genuinely persisting across
   window-open/close cycles via dconf, which it should, but hasn't been
   watched happen).

## 2026-08-08, third addendum — shortcut recorder bug fix (2-key combos)

**Bug found and fixed:** the Preferences window's shortcut recorder
(General → Keyboard shortcut, `lib/prefsPageBuilders.js`) could never
actually record a combo — pressing e.g. `Ctrl+Shift+A` would stop
recording after just the first key (`Ctrl` alone), producing a broken
one-key "shortcut" instead of waiting for the rest of the combo.

Root cause: the old code's comment said "Modifier-only presses do not
form a useful shortcut" but the actual check (`if (!accel) return
true`, where `accel = Gtk.accelerator_name(keyval, state)`) never
filtered them — `Gtk.accelerator_name()` happily returns a non-empty
string for a bare modifier keyval (e.g. `"Control_L"`), so that guard
never triggered and recording ended on the very first key pressed. The
overlay's own separate shortcut recorder
(`lib/widgetCenterOverlayPreferences.js`'s `_shortcutRecorder()`, a
different Clutter-based implementation for the St/Clutter overlay UI)
already had this filter and was NOT affected — only the GTK4
Preferences window's recorder had the bug.

Fix: a new `isModifierKeyval()` helper explicitly lists every bare
modifier keyval (Ctrl/Shift/Alt/Super/Meta/Hyper L+R, plus lock and
ISO-level-shift keys) and the key-pressed handler now returns early on
any of them — actually waiting, rather than completing — so by the
time a "real" key is pressed, `state` already reflects every modifier
still held down and forms the intended multi-key combo. Also now masks
`state` through `Gtk.accelerator_get_default_mod_mask()` and validates
with `Gtk.accelerator_valid()` before accepting, so stray bits like
Caps Lock/Num Lock being on can't corrupt the recorded accelerator.

Not yet re-tested against a real GNOME Shell prefs process (same
caveat as everything else in this file) — logic checked by hand
against GTK4's own `Gtk.EventControllerKey`/`accelerator_name`
semantics, worth confirming a real two-key press records cleanly on
real hardware.

## 2026-08-08, fifth addendum — old v1 sidebar code removed entirely

Requested directly ("เอาของเก่าออก" — take the old one out) once V2 was
confirmed as the live window (fourth addendum above). Everything below
this point in the "What was added"/"How to merge" sections further down
describes the ORIGINAL 2026-08-08 checkpoint, when V2 was still a
second, inert, side-by-side window — most of it is now historical and
superseded by what's listed here:

- **`prefsV2.js` deleted.** It was a byte-for-byte duplicate of what
  `prefs.js` now does directly (both just `import
  {PrefsWindowControllerV2}` and call `.build()`) — dead weight once
  `prefs.js` itself made the switch in the fourth addendum.
- **The `Adw.NavigationSplitView` sidebar layout removed from
  `_buildPreferencesPage()`** (`lib/prefsPageBuilders.js`) — it was the
  `{layout: 'sidebar'}` (default/omitted) branch of an options flag that
  existed alongside `{layout: 'accordion'}`; since every caller that
  still exists (only `PrefsWindowControllerV2`) always requests
  accordion, the sidebar branch was unreachable dead code. The method no
  longer takes a `layout` option at all — it always builds the
  accordion. `Adw.NavigationSplitView`/`Gtk.Stack`/the per-category
  `Gtk.ListBox` selection wiring, and the `_categoryListBox`/
  `_categoryRowsById` fields that supported it, are gone.
- **v1's own `_buildOverviewPage()`** (the plain `Adw.SwitchRow` list,
  as opposed to V2's card grid) **removed** — nothing called it anymore
  once `_buildPreferencesPage()`'s sidebar branch (its only caller,
  via v1's now-removed `build()`) was gone.
- **`lib/prefsWindowController.js`'s own `build()` removed** — the old
  v1 two-tab window (Overview list + Preferences sidebar). Nothing
  constructs the base `PrefsWindowController` class directly anymore
  (only `PrefsWindowControllerV2`, which completely overrides `build()`
  with its own four-tab version), so this was dead code the moment
  `prefs.js`'s import switched. The base class is now genuinely just:
  constructor + `_loadMetadataFromPath`/`_tr`/`showPreferencesPage`/
  `openExportThemeDialog`/`openExportThemeDialogForPack` + the two
  mixins (`PrefsPageBuildersMixin`, `PrefsWidgetManagementMixin`) that
  add every page/category/widget-row builder V2 actually uses.
- **`lib/prefsWindowController.js`'s own `showBackupPage()` removed**
  too, for the same reason as the sidebar removal above — it read
  `_categoryListBox`/`_categoryRowsById`, which no longer exist.
  `PrefsWindowControllerV2`'s own `showBackupPage()` override (added in
  the fourth addendum, reading `_accordionCategoriesById` instead) is
  now the only implementation, base class or not.
- Five now-unused imports (`PrefsWidgetList`, `SettingsService`,
  `StorageService`, `WidgetSettings`, `loadTranslations`) dropped from
  `lib/prefsWindowController.js`'s import list — all four were only
  ever used inside the `build()` method just removed.

**What's now the accurate, current picture** (superseding the sections
below): a single window class, `PrefsWindowControllerV2`, is the only
Control Center this project builds, constructed directly by both live
entry points (`prefs.js`, `widget-center-prefs-app.js`). There is no
second/inert/"v2 as an option" window anymore, no `layout` flag to pick
between two Preferences layouts, and no `prefsV2.js` file. The "How to
merge" section further down is now purely historical — there's nothing
left to merge.


## 2026-08-08, fourth addendum — V2 wasn't actually wired up as the live window

**Root cause of "ทำไมยังเห็น UI เก่าอยู่" (why is the old UI still
showing) despite disable/log-out/reload:** every edit up through the
third addendum only ever touched `prefsV2.js` /
`lib/prefsWindowControllerV2.js` — but the actual entry point GNOME
Shell calls (the gear-icon "Settings" button, `gnome-extensions prefs
<uuid>`) is `prefs.js`, which still imported v1's
`lib/prefsWindowController.js`. `prefsV2.js` was, by its own header
comment, deliberately "a SECOND entry point... not a replacement" —
built and validated in isolation, never actually switched on. No
amount of reloading/logging out could have shown the new UI because it
was never being run.

**Fixed:** `prefs.js` now imports `PrefsWindowControllerV2` instead of
`PrefsWindowController` — this is now genuinely the live prefs window.
`widget-center-prefs-app.js` (the standalone app Edit Mode's own
Settings button opens) was switched the same way, for consistency —
otherwise reaching Preferences via Edit Mode would still show the old
sidebar even after this fix.

**Regression caught and fixed in the same pass:** `PrefsWindowControllerV2`
subclasses v1's `PrefsWindowController` and inherits `showBackupPage()`
unchanged — but that method reads `this._categoryListBox`/
`this._categoryRowsById.backup`, both of which are only ever populated
by the sidebar branch of `_buildPreferencesPage()`. V2 always requests
`{layout: 'accordion'}`, which never touches either field, so
`showBackupPage()` would have silently no-op'd — the overlay's own
"Backup" button (`lib/widgetCenterOverlay.js`'s Settings tab →
`widget-center-prefs-app.js --focus=backup`) would stop jumping to
Backup & Restore under V2. Fixed with two changes:
- `_buildCategoryAccordion()` (`lib/prefsPageBuilders.js`) now also
  populates `this._accordionCategoriesById` (keyed by the same
  `category.id`s the old sidebar used, e.g. `'backup'`), storing each
  category's own `expand()` function.
- `PrefsWindowControllerV2` now overrides `showBackupPage()` to use
  `this._accordionCategoriesById.backup.expand()` instead of selecting
  a sidebar row.

`showPreferencesPage()`, `openExportThemeDialog()`,
`openExportThemeDialogForPack()`, and the widget-settings deep-link
path (`_jumpToWidgetPrefs()`/`_openRequestedWidgetPrefs()`) were all
checked and do NOT touch sidebar-only state — inherited as-is, no
further overrides needed.

Not yet re-tested against a real GNOME Shell prefs process. This is
now, genuinely, the file that needs a real reload/re-test — prefs.js's
import line is the actual switch that was missing before.



GNOME Shell prefs process.** This checkpoint adds a second, independent
Control Center window next to the existing one — nothing about the
current `prefs.js` / `widget-center-prefs-app.js` flow was changed
behaviorally, so the extension keeps working exactly as before until you
deliberately wire this in (see "How to merge" below).

## What was added

| File | Purpose |
|---|---|
| `assets/about-logo.svg` | New logo for the About tab (loaded from disk, not the icon theme). |
| `lib/prefsWindowControllerV2.js` | The new 4-tab window logic. Subclasses the existing `PrefsWindowController` and overrides `build()`. |
| `prefsV2.js` | A second `fillPreferencesWindow()` entry point wired to the class above. Not referenced by `metadata.json` — inert until you point something at it. |
| `HANDOVER_PREFS_V2.md` | This file. |

## What was changed (small, additive, backward-compatible)

- `lib/prefsPageBuilders.js`: `_buildPreferencesPage()` gained a 6th,
  optional `options` parameter (`{includeAbout: false}`) so V2 can reuse
  it for the Preferences tab while excluding the "About" row (which V2
  shows as its own top-level tab instead). Every existing call site
  (`prefs.js` via `PrefsWindowController`) passes nothing for this
  parameter and behaves identically to before.

Nothing else in the existing codebase was touched.

## The four tabs

1. **Overview** — 3-cards-per-row grid of every discovered widget
   (screenshot, name, description, author). Each card has exactly 3
   buttons/controls: **Settings**, **Remove** (only shown for
   user-installed widgets — a bundled widget has no Remove button, same
   rule the St/Clutter overlay's Overview tab already follows), and an
   **Enable/Disable** toggle button.
   - Remove actually **deletes the widget's files from disk**
     (`~/.local/share/gnome-widget-center/widgets/<id>/`), not just
     disables it — per this checkpoint's explicit spec ("remove only
     widget from users not bundle widget"). It also cleans up the id
     from the `disabled-widgets` GSettings key so nothing stale lingers.
2. **Themes** — same 3-per-row card grid, sourced from
   `lib/themePackRegistry.js` (bundled + user `themepacks/` folders).
   Each card has an **Apply** button and a **read-only** `Gtk.Switch`
   showing whether that pack is the currently active one
   (`active-theme-pack` GSettings key) — deliberately not a togglable
   switch, since only one theme pack is ever "active" at a time (same
   reasoning the overlay's own Themes tab already documents for its
   status pill). A small circular Remove button sits in the top-right
   corner of the screenshot for user-installed packs only.
3. **Preferences** — unchanged content, reused verbatim from
   `prefsPageBuilders.js` (`_buildPreferencesCategory` sidebar: General,
   Appearance, Desktop, Interactions, Backup & Restore, Import/Export,
   Advanced), just with `includeAbout: false` since About now has its
   own top-level tab.
4. **About** — new. Uses `Adw.PreferencesPage` + `Adw.PreferencesGroup`
   (the one tab in this file that does — see the "Known limitation"
   section for why the other three deliberately don't), showing the new
   `assets/about-logo.svg`, name, version, license, source-code link,
   and a short project summary written for this tab specifically.

## How to merge (make V2 the live window)

Pick ONE of:

**A. Replace prefs.js's own window (simplest, single source of truth
   going forward):**

```js
// prefs.js
import {PrefsWindowControllerV2 as PrefsWindowController} from './lib/prefsWindowControllerV2.js';
// ...rest of the file unchanged — the renamed import keeps every other
// line (constructor call, method name) exactly as it already reads.
```

**B. Keep both, pick per-entry-point:** leave `prefs.js` alone (still
   v1) and instead update `widget-center-prefs-app.js` (the standalone,
   single-instance app extension.js's "Settings" button actually
   spawns) to import `PrefsWindowControllerV2` instead of
   `PrefsWindowController` — same one-line swap as option A, just in
   the other file. This is the version most users would actually see
   day-to-day (Edit Mode's Settings button goes through this file, not
   plain `prefs.js` — see that file's own header), while
   `gnome-extensions prefs <uuid>` / the Extensions app's gear icon
   (which do go through `prefs.js`) keep seeing v1.

Either way, delete (or keep as an inert reference — your call)
`prefsV2.js` once the swap is made; it only exists so V2 could be
built/reviewed as a self-contained diff without touching the live entry
points first.

## Known limitation: Overview/Themes can't go fully edge-to-edge

`Adw.PreferencesWindow.add()` only accepts `Adw.PreferencesPage`
children, and `Adw.PreferencesPage` applies its own internal
max-content-width clamp (an `AdwClamp` with no public setter) around
whatever its `Adw.PreferencesGroup` holds — that's a deliberate
Libadwaita HIG behavior (comfortable reading width for a settings page),
not a bug in this code. `_bareFullBleedPage()` in
`prefsWindowControllerV2.js` gets the card grid as close to full window
width as this window class allows (no title/description, zero group
margins, `hexpand`/`vexpand` everywhere) — on a normal 1080p-ish window
this reads as effectively full-width, but on a very wide/ultrawide
monitor the grid will still end up centered with visible side margins
rather than running to the literal window edge.

The only way past that ceiling within GNOME's own contract is to stop
using `Adw.PreferencesWindow` at all for this specific window — i.e.
build a genuinely standalone window the way `test.js` (from the
reference zip) does: a plain `Adw.ApplicationWindow` +
`Adw.ToolbarView` + `Adw.ViewStack` + `Adw.ViewSwitcher`, with Overview/
Themes/Preferences/About as `Adw.ViewStack` pages instead of
`Adw.PreferencesWindow` tabs. That's a real option for
`widget-center-prefs-app.js` specifically, since that file already
constructs its own window from scratch (unlike `prefs.js`, which is
handed an already-built `Adw.PreferencesWindow` by GNOME Shell via
`fillPreferencesWindow(window)` and has no way to swap its class).
Deliberately **not** done in this checkpoint — flagged here as the
natural next step if the current clamp turns out to be too tight in
practice.

## Not yet verified

Same caveat this whole project's other checkpoints carry (see
`README.md`'s Current Status table) — this code is written and
`node --check`-clean, but has not been exercised against a real running
GNOME Shell prefs process. Worth checking first against a real log if
anything looks wrong on real hardware:

- `window.remove(page)` — used to swap the Overview/Themes tab content
  in place after Enable/Remove actions. Documented Libadwaita API, but
  not exercised here.
- `window.maximize()` called before the window is mapped, in `build()`
  — some Wayland compositors defer or ignore this; wrapped in
  try/catch so it's non-fatal either way, just worth a visual check.
- `Gtk.Picture.set_filename()` for screenshots/the About logo — GTK4
  API, should load a local SVG/PNG file directly, not spot-checked
  against this project's actual widget screenshot files.

Status: **code-complete, `node --check`-clean, NOT yet run against a real
GNOME Shell prefs process.**
