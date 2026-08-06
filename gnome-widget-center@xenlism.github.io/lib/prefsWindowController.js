// products/extension/prefs.js
//
// Task 05 — Control Center (Prefs GUI) entrypoint. GNOME Shell runs this
// in its own separate GTK4/libadwaita process, completely apart from
// extension.js's Shell process (development/docs/WIDGET_API.md §4) — this file, and
// everything it imports, must NEVER import St/Clutter/Meta/Shell.
//
// Responsibilities (development/tasks/05-prefs-control-center.md):
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
// place someone reading prefs.js would look for "what happens to the
// running widget after I save".
//
// This class itself is now just: constructor + build() (the fillPrefer-
// encesWindow() entrypoint) + a couple of tiny shared helpers
// (_loadMetadataFromPath, _tr). Everything that actually builds UI is
// two mixins applied below (2026-08-01 split, ~1600 lines -> three
// files): prefsPageBuilders.js (whole-page/category builders) and
// prefsWidgetManagement.js (per-widget row/settings-opening logic). See
// each mixin file's own header for why a mixin rather than a straight
// module split — short version: every method on either mixin still
// reads/writes the exact same `this.xxx` state declared in the
// constructor below, same as if all three files' methods were still
// physically in one file.

import GLib from 'gi://GLib';

import {PrefsWidgetList} from './prefsWidgetList.js';
import {readTextFile} from './fsUtils.js';
import {pickTranslation} from './i18nUtils.js';
import {SettingsService} from './settingsService.js';
import {StorageService} from './storageService.js';
import {WidgetSettings} from './widgetSettings.js';
import {ThemeService} from './themeService.js';
import {ThemePackRegistry} from './themePackRegistry.js';
import {openThemePackExportDialog} from './themePackExportDialog.js';
import {loadTranslations} from '../i18n/index.js';
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
        /** @private set once build() has run - see showBackupPage(). */
        this._categoryListBox = null;
        this._categoryRowsById = null;
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

    /**
     * @description Jumps an already-built window straight to the
     * "Backup & Restore" category inside the Preferences tab, skipping
     * both Overview and the General category `_buildPreferencesPage()`
     * otherwise selects first — added for widget-center-prefs-app.js's
     * `--focus=backup` flag (used by lib/widgetCenterOverlay.js's new
     * Settings-tab Backup button, so clicking it doesn't dump the user
     * on the General page and make them find Backup & Restore
     * themselves). No-op if build() hasn't run yet, or on a
     * theoretical Shell-version-driven prefs window that never went
     * through `_buildPreferencesPage()` at all — both covered by the
     * same `this._categoryRowsById` presence check. Same idle-loop
     * deferral as showPreferencesPage()/jumpToWidget() and for the same
     * reason: row selection needs the window mapped first.
     * @param {Adw.PreferencesWindow} window
     */
    showBackupPage(window) {
        if (!this._preferencesPage || !this._categoryListBox || !this._categoryRowsById?.backup)
            return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                window.set_visible_page(this._preferencesPage);
                this._categoryListBox.select_row(this._categoryRowsById.backup);
            } catch (e) {
                logError(e, '[widget-center] prefs: showBackupPage() failed');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

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

    /**
     * Top-level layout (2026-07-26 restructure): exactly three
     * Adw.PreferencesPage siblings under `window`, which is what makes
     * Adw.PreferencesWindow render its built-in pill-style switcher at
     * the top matching the "Overview / Store / Preferences" concept —
     * see repo/concept/preferences.png / overview.png for the reference
     * mockups this maps to.
     *   1. Overview  — the widget list (previously the only/default page,
     *      titled "Widgets"; renamed, content unchanged).
     *   2. Store     — placeholder; no widget marketplace exists yet.
     *   3. Preferences — everything that used to be its own top-level
     *      page (Appearance, Advanced) plus new placeholder categories
     *      from the concept mockup, now behind a single vertical sidebar
     *      list (`_buildPreferencesPage()`) instead of separate pill
     *      tabs, since 8 categories in the pill switcher would be far too
     *      cramped.
     *
     * 2026-07-30 extraction: this used to be `fillPreferencesWindow()`,
     * called directly by GNOME Shell on a class extending
     * ExtensionPreferences. Renamed to `build()` and moved to this plain
     * class so widget-center-prefs-app.js's standalone process can call
     * it too — see this file's header and that file's own header for
     * why. Safe to call exactly once per window; call jumpToWidget()
     * afterwards for any subsequent "open this widget's settings" request
     * against the same window.
     */
    async build(window) {
        // Bug fix (2026-07-26): a widget-settings edit made right before
        // closing the Preferences window could be silently lost. Every
        // write goes through WidgetSettings' ~300ms debounce (see that
        // file's header) — closing the settings subpage via the plain
        // "Close" button never flushed it (only "Save & Close" did, see
        // _presentPrefsPage()), and even that only covers ONE widget's
        // pending write, not any other subpage the user had touched and
        // already navigated away from. Closing the whole window (X
        // button, Esc, Ctrl+W, or the process just exiting) raced that
        // timer with no guarantee it won. flushAll() here is the same
        // safety net extension.js's WidgetLoader.unloadAll() already uses
        // for the Shell-side equivalent of this problem — belt-and-
        // suspenders alongside _presentPrefsPage()'s per-subpage flush,
        // not a replacement for it.
        window.connect('close-request', () => {
            WidgetSettings.flushAll();
            return false; // still allow the window to close normally.
        });

        const settings = new SettingsService(
            this._extensionObject ?? GLib.build_filenamev([this.path, 'schemas'])
        );
        try {
            settings.init();
        } catch (e) {
            logError(e, '[widget-center] prefs: SettingsService.init() failed');
        }

        // Extension-level UI strings (tab titles, category names, etc —
        // see gen/generate_i18n.py's EXTENSION_KEYS). GNOME Shell awaits
        // fillPreferencesWindow() if it returns a Promise (has since
        // GNOME 44), so it's safe to resolve this before building
        // anything rather than translating progressively like the
        // per-widget Overview rows do (_applyWidgetI18n()) — there's
        // only 15 short strings here, the wait is imperceptible, and it
        // means every tab is correctly labeled from the very first frame
        // instead of visibly relabeling itself a moment later.
        // 2026-08-04: settings is now built BEFORE this (used to be
        // after) specifically so the `language` override below can be
        // read in time for this very first load, rather than only
        // taking effect on the next widget subpage opened afterwards.
        const languageOverride = settings.isReady ? (settings.getGlobalValue('language') || undefined) : undefined;
        this._i18n = await loadTranslations(GLib.build_filenamev([this.path, 'i18n']), languageOverride).catch(() => ({}));

        // Same StorageService file layer extension.js uses — plain
        // Gio/GLib file I/O, so it's just as safe to use from this
        // process as from the Shell's.
        const storage = new StorageService();
        storage.init();

        const bundledWidgetsPath = GLib.build_filenamev([this.path, 'widgets']);
        const userWidgetsPath = GLib.build_filenamev([
            GLib.get_user_data_dir(), 'gnome-widget-center', 'widgets',
        ]);
        const {ok, errors} = new PrefsWidgetList([bundledWidgetsPath, userWidgetsPath]).list();

        this._settings = settings;
        this._storage = storage;
        this._discovered = ok;

        this._buildOverviewPage(window, settings, storage, ok, errors);
        this._buildStorePage(window);
        this._preferencesPage = this._buildPreferencesPage(window, settings, storage, ok, {bundledWidgetsPath, userWidgetsPath});

        // 2026-07-20 fix ("click settings opens the extension prefs, not
        // the widget prefs"): extension.js's Edit Mode "Settings" action
        // writes the widget id here (requested-widget-id) right before
        // calling openPreferences() — see extension.js's
        // _openWidgetSettings() for the other half of this. Read it back
        // and jump straight to that widget's settings sub-page instead of
        // leaving the user on the top-level list. Cleared right after
        // reading so a later manually-opened Control Center window (e.g.
        // from GNOME's Extensions app) doesn't jump anywhere unexpected.
        this._openRequestedWidgetPrefs(window, settings, storage, ok);

        // 2026-07-30 fix ("click Settings on a widget while Preferences
        // is already open does nothing, and logs an error"): the one-shot
        // read above only ever runs once, right when fillPreferencesWindow()
        // is called - fine the first time GNOME Shell creates a new prefs
        // window, but if that window is still open and the user clicks
        // Settings on a *different* widget, extension.js's
        // openExtensionPrefs() call doesn't spawn a second window (either
        // it re-focuses the existing one, or its returned promise just
        // rejects — see extension.js's _openWidgetSettings() for that
        // side), so fillPreferencesWindow() never runs again and nothing
        // re-reads requested-widget-id. The write still lands in dconf
        // correctly either way — nothing in *this* already-running prefs
        // process was listening for it anymore, so the click appeared to
        // do nothing.
        //
        // Fixed by keeping a live subscription for as long as this
        // specific window stays open, on top of the one-shot check above.
        // SettingsService.onChanged() wraps a plain dconf-backed
        // Gio.Settings 'changed' signal, which fires here in the prefs
        // process just as reliably as it does back in the Shell process
        // (see that method's own doc comment) — so every subsequent
        // Settings click, not just the one that happened to open this
        // window, now jumps straight to the right widget's sub-page
        // instead of requiring the user to close and reopen Preferences.
        if (settings.isReady) {
            const requestedIdHandlerId = settings.onChanged('requested-widget-id', value => {
                this._jumpToWidgetPrefs(window, settings, storage, ok, value);
            });
            window.connect('close-request', () => {
                settings.disconnect(requestedIdHandlerId);
                return false;
            });
        }
    }

    /** @private this._i18n[key] if present, else `fallback` — see fillPreferencesWindow()'s doc comment. */
    _tr(key, fallback) {
        return pickTranslation(this._i18n, key, fallback);
    }
}

/**
 * The two mixins are applied in this order so a page-builder method
 * (e.g. `_buildOverviewPage`) can call a widget-management method (e.g.
 * `_buildWidgetRow`) on `this` — both end up on the same prototype
 * chain either way (mixin order doesn't affect method visibility, only
 * matters if the two ever defined the SAME method name, which they
 * don't — see each mixin file for its method list).
 */
export class PrefsWindowController extends PrefsWidgetManagementMixin(PrefsPageBuildersMixin(PrefsWindowControllerBase)) {}
