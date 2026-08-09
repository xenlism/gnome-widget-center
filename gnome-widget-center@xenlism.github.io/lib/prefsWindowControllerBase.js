// products/extension/lib/prefsWindowControllerBase.js
//
// Shared base for the Control Center (Prefs GUI) window controller:
// constructor, a few small cross-window helpers (_loadMetadataFromPath,
// _tr, showPreferencesPage, openExportThemeDialog/
// openExportThemeDialogForPack), and the two mixins that add every
// actual page/category/widget-row builder
// (lib/prefsPageBuilders.js, lib/prefsWidgetManagement.js).
//
// 2026-08-08: this file no longer defines `build()` itself — that used
// to be the v1 two-tab window (Overview + Preferences-as-sidebar), now
// removed as dead code once `lib/prefsWindowController.js`'s
// `PrefsWindowControllerV2` (which `extends` the class this file
// exports, and overrides `build()` completely with its own four-tab
// accordion version) became the ONLY controller `prefs.js` /
// `widget-center-prefs-app.js` ever construct — see
// HANDOVER_PREFS_V2.md's "V2 wasn't actually wired up" addendum for the
// full story of how that happened. GNOME Shell runs the prefs process
// this ends up running in as its own separate GTK4/libadwaita process,
// completely apart from extension.js's Shell process
// (development/docs/WIDGET_API.md §4) — this file, and everything it
// imports, must NEVER import St/Clutter/Meta/Shell.
//
// Responsibilities actually fulfilled by PrefsWindowControllerV2 +
// these mixins together (development/tasks/05-prefs-control-center.md):
//   1. List every discovered widget (bundled + user), one Adw.SwitchRow
//      each, bound to the same `disabled-widgets` GSettings key
//      extension.js watches (see extension.js's onChanged() wiring) — so
//      toggling a row here takes effect on the desktop immediately, no
//      shell restart, even though this is a different process.
//   2. A "Settings" button per widget that has a config.json, a hand-
//      written prefs.js, a `settings.js` (§6.3 fluent builder), OR a
//      declarative `settings` schema in metadata.json:
//        - config.json present -> auto-builds an Adw page from it via
//          widgetConfigUI.js (development/docs/WIDGET_API.md §6.4) — the
//          recommended path for new widgets; tabs/groups/fields cover
//          every type in §6.4 without writing any GTK4 by hand.
//        - no config.json but prefs.js present -> dynamically imports
//          just that file (safe here, per widget author contract) and
//          embeds its buildPrefsWidget() as an Adw.PreferencesWindow
//          subpage.
//        - no config.json/prefs.js but settings.js present -> dynamically
//          imports its `defineSettings` export and renders it via
//          lib/settingsApi.js + lib/settingsRenderer.js (§6.3 — wired up
//          2026-07-28, previously "documented but dormant"; see
//          _openWidgetSettingsJsPrefs()).
//        - none of the above, but a `settings` schema present -> auto-
//          builds an Adw page from it instead (settingsSchemaUI.js) —
//          the older flat-array equivalent of config.json, kept for
//          widgets that predate it. Lowest priority since it's the
//          oldest and least expressive of the four.
//        - config.json wins if a widget somehow has more than one of
//          these — see _openWidgetPrefs()'s doc comment for why.
//   3. A separate error section for any widget whose metadata.json is
//      broken, so one bad widget can't take down the whole window.
//
// Cross-process live update (previously a documented known limitation of
// task 05 — see git history / ROADMAP.md for the old wording): a setting
// changed through a widget's prefs page is written straight to
// widgets/<id>.json via WidgetSettings/StorageService, exactly like
// extension.js does. The *already-running* widget instance in the Shell
// process no longer has to wait for its next load to notice — extension.js's
// WidgetLoader watches each loaded widget's settings file
// (lib/settingsWatcher.js) and merges external changes straight into the
// SAME live `api.settings` proxy the widget already holds, calling its
// optional `onSettingsChanged()` hook if it has one (development/docs/WIDGET_API.md §3).
// Nothing in THIS file changes to make that work — it's entirely a Shell-
// process concern — this comment stays here only because it's the natural
// place someone reading this file would look for "what happens to the
// running widget after I save".

import GLib from 'gi://GLib';

import {readTextFile} from './fsUtils.js';
import {pickTranslation} from './i18nUtils.js';
import {ThemeService} from './themeService.js';
import {ThemePackRegistry} from './themePackRegistry.js';
import {openThemePackExportDialog} from './themePackExportDialog.js';
import {PrefsPageBuildersMixin} from './prefsPageBuilders.js';
import {PrefsWidgetManagementMixin} from './prefsWidgetManagement.js';

class PrefsWindowControllerBase {
    /**
     * @param {Extension|string} extensionOrPath - either the
     *   ExtensionPreferences instance itself (`this` from prefs.js's
     *   `fillPreferencesWindow()`) — preserves the official
     *   `Extension.getSettings()` schema-lookup path SettingsService
     *   normally uses, and gives us `this.metadata` straight from GNOME —
     *   or a plain string path to the extension's own install directory
     *   (2026-07-30 addition, for widget-center-prefs-app.js's standalone
     *   process, which has no Extension instance at all; see that file's
     *   header). When given a bare path, `metadata.json` is read by hand
     *   instead (see _loadMetadataFromPath()) since there's no
     *   `Extension.metadata` to borrow.
     */
    constructor(extensionOrPath) {
        if (typeof extensionOrPath === 'string') {
            this._extensionObject = null;
            this.path = extensionOrPath;
            this.metadata = this._loadMetadataFromPath(extensionOrPath);
        } else {
            this._extensionObject = extensionOrPath;
            this.path = extensionOrPath.path;
            this.metadata = extensionOrPath.metadata;
        }
        /** @private i18n strings, loaded by build() before anything else. */
        this._i18n = null;
        /** @private set once build() has run - see jumpToWidget(). */
        this._settings = null;
        this._storage = null;
        this._discovered = [];
        /** @private set once build() has run - see showPreferencesPage(). */
        this._preferencesPage = null;
    }

    /**
     * @description Jumps an already-built window straight to the
     * "Preferences" top-level tab, skipping past Overview/Store — added
     * for widget-center-prefs-app.js's `--focus=preferences` flag (used
     * by lib/widgetCenterOverlay.js's Preferences tab, which already has
     * its own native widget list and doesn't want to show Overview
     * again). No-op if build() hasn't run yet. Same idle-loop deferral as
     * jumpToWidget()/_jumpToWidgetPrefs() and for the same reason: the
     * window needs to be mapped before set_visible_page() takes effect.
     * @param {Adw.PreferencesWindow} window
     */
    showPreferencesPage(window) {
        if (!this._preferencesPage)
            return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                window.set_visible_page(this._preferencesPage);
            } catch (e) {
                logError(e, '[widget-center] prefs: showPreferencesPage() failed');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // showBackupPage() used to live here too (jump straight to the
    // "Backup & Restore" category by selecting a sidebar row) but relied
    // entirely on `_categoryListBox`/`_categoryRowsById`, both removed
    // 2026-08-08 along with the sidebar layout itself (see
    // `_buildPreferencesPage()`'s doc comment, lib/prefsPageBuilders.js).
    // lib/prefsWindowController.js now defines its own
    // `showBackupPage()` against the category accordion that replaced
    // it — the only implementation that exists, since V2 is the only
    // window this project builds.

    /**
     * @description Opens the "Export Theme…" dialog
     * (lib/themePackExportDialog.js) against an already-built window,
     * either blank (current live-desktop selection, `prefill` omitted)
     * or seeded from a specific already-discovered theme pack. No-op if
     * build() hasn't finished yet (this._settings/_storage/_discovered
     * are only set at the end of build() — see that method).
     * @param {Adw.PreferencesWindow} window
     * @param {object} [prefill] - see themePackExportDialog.js's own
     *   `prefill` param doc.
     */
    openExportThemeDialog(window, prefill = {}) {
        if (!this._settings || !this._storage)
            return;
        const theme = new ThemeService();
        theme.init();
        openThemePackExportDialog(window, {
            storage: this._storage, theme, settings: this._settings, discoveredWidgets: this._discovered,
        }, prefill);
    }

    /**
     * @description Same as openExportThemeDialog(), but looks up an
     * already-discovered theme pack by id first (bundled + user
     * themepacks/ folders, same search paths
     * lib/widgetCenterOverlay.js's Themes tab uses) and prefills the
     * dialog's Name/Description/Author/URL fields and restricts the
     * export to exactly that pack's own widget set — added for the
     * overlay's per-card "Export" icon button
     * (widget-center-prefs-app.js's `--export-theme-id=<id>` flag) so
     * re-exporting an existing pack doesn't start from a blank form or
     * silently pick up whatever's enabled on the live desktop right now
     * instead of what that pack actually contains. Silently does
     * nothing if the id isn't found (pack removed/renamed on disk
     * between the overlay listing it and this click landing) rather
     * than erroring — same "missing entry, not a crash" policy
     * ThemePackRegistry.discover() itself already follows for one bad
     * entry among many.
     * @param {Adw.PreferencesWindow} window
     * @param {string} themePackId
     */
    openExportThemeDialogForPack(window, themePackId) {
        if (!this._settings || !this._storage)
            return;
        const bundledThemepacksPath = GLib.build_filenamev([this.path, 'themepacks']);
        const userThemepacksPath = GLib.build_filenamev([
            GLib.get_user_config_dir(), 'gnome-widget-center', 'themepacks',
        ]);
        const registry = new ThemePackRegistry([
            {path: bundledThemepacksPath, source: 'bundled'},
            {path: userThemepacksPath, source: 'user'},
        ]);
        const entry = registry.discover().find(e => e.id === themePackId);
        if (!entry) {
            logError(new Error(`theme pack "${themePackId}" not found`), '[widget-center] prefs: openExportThemeDialogForPack');
            return;
        }
        this.openExportThemeDialog(window, {
            id: entry.manifest.id,
            name: entry.manifest.name,
            description: entry.manifest.description ?? '',
            author: entry.manifest.author ?? '',
            email: entry.manifest.email ?? '',
            url: entry.manifest.url ?? '',
            widgetIds: entry.manifest.widgets ?? [],
        });
    }

    /** @private standalone-app fallback for `this.metadata` (see constructor doc) - plain JSON read, same file GNOME itself parses for the ExtensionPreferences path. */
    _loadMetadataFromPath(extensionPath) {
        try {
            const contents = readTextFile(GLib.build_filenamev([extensionPath, 'metadata.json']));
            return contents === null ? {} : JSON.parse(contents);
        } catch (e) {
            logError(e, '[widget-center] prefs: could not read metadata.json');
            return {};
        }
    }

    // build() used to live here too — the v1 two-tab window (Overview +
    // Preferences-as-sidebar, see repo/concept/preferences.png /
    // overview.png). Removed 2026-08-08: PrefsWindowControllerV2
    // (lib/prefsWindowController.js) completely overrides build() with
    // its own four-tab version and is the only class this project ever
    // constructs and calls .build() on (`prefs.js`,
    // `widget-center-prefs-app.js`) — this base implementation was dead
    // code the moment that switch happened. `PrefsWindowControllerBase`
    // below is now just: constructor + shared helpers
    // (_loadMetadataFromPath, _tr, showPreferencesPage,
    // openExportThemeDialog/openExportThemeDialogForPack) + whatever the
    // two mixins add — every actual `build()` lives on
    // `PrefsWindowControllerV2` alone. If a v1-style window is ever
    // wanted again, it's in this file's git history.

    /** @private this._i18n[key] if present, else `fallback` — see fillPreferencesWindow()'s doc comment. */
    _tr(key, fallback) {
        return pickTranslation(this._i18n, key, fallback);
    }
}

/**
 * The two mixins are applied in this order so a page-builder method
 * (e.g. `_buildGeneralCategory`) can call a widget-management method
 * (e.g. `_buildWidgetRow`) on `this` — both end up on the same
 * prototype chain either way (mixin order doesn't affect method
 * visibility, only matters if the two ever defined the SAME method
 * name, which they don't — see each mixin file for its method list).
 */
export class PrefsWindowController extends PrefsWidgetManagementMixin(PrefsPageBuildersMixin(PrefsWindowControllerBase)) {}
