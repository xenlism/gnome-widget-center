// products/extension/prefs.js
//
// 2026-07-30 ("run the widget Settings window fully independently of
// GNOME's extension-prefs flow"): this file used to contain the ENTIRE
// Control Center implementation (~1,600 lines - Overview/Store/
// Preferences pages, backup/restore, per-widget settings subpages, the
// works). All of that moved to lib/prefsWindowControllerBase.js's
// `PrefsWindowController` class, which only needed `this.path` and
// `this.metadata` from this class and never anything else
// ExtensionPreferences-specific — so it was already, structurally, a
// plain object in disguise. This file is now just the required GNOME
// entry point (`fillPreferencesWindow()`) handing straight off to it.
//
// Why keep this file at all, instead of deleting it now that
// widget-center-prefs-app.js exists as a real standalone alternative: two
// things in the wider GNOME ecosystem only know how to call
// fillPreferencesWindow() and have no idea widget-center-prefs-app.js
// exists — `gnome-extensions prefs <uuid>` on the command line, and the
// gear-icon "Settings" button next to this extension in GNOME's own
// Extensions app. Removing this file would break both of those, for a
// user who never even touches Edit Mode's own "Settings" button (which
// now goes straight to the standalone app instead - see extension.js's
// _openWidgetSettings()).
//
// GNOME Shell runs this in its own separate GTK4/libadwaita process,
// completely apart from extension.js's Shell process
// (development/docs/WIDGET_API.md §4) — this file, and everything it
// imports, must NEVER import St/Clutter/Meta/Shell.

// 2026-08-08: import switched from `PrefsWindowController` (v1 —
// sidebar Preferences) to `PrefsWindowControllerV2` (Overview / Themes /
// Preferences-as-accordion / About). This is now THE live prefs window
// GNOME Shell / `gnome-extensions prefs <uuid>` opens — see
// HANDOVER_PREFS_V2.md for the full v2 changelog. `prefsV2.js`, a
// second, separate entry point this used to hand off to for isolated
// testing before this switch, has been deleted as fully redundant now
// that this file does exactly what it did.

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PrefsWindowControllerV2} from './lib/prefsWindowController.js';

export default class WidgetCenterPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        // Passing `this` (not `this.path`) preserves the official
        // Extension.getSettings() schema-lookup path AND this.metadata —
        // see PrefsWindowControllerV2's constructor doc comment for why
        // that still matters here even though widget-center-prefs-app.js's
        // own, separate PrefsWindowController instance gets by with just
        // a path string instead (reading metadata.json by hand).
        await new PrefsWindowControllerV2(this).build(window);
    }
}
