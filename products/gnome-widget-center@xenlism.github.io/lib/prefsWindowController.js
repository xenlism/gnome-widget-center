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

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';

import {PrefsWidgetList} from './prefsWidgetList.js';
import {SettingsService} from './settingsService.js';
import {StorageService} from './storageService.js';
import {WidgetSettings} from './widgetSettings.js';
import {buildSettingsPage} from './settingsSchemaUI.js';
import {readWidgetConfig} from './widgetConfigReader.js';
import {buildConfigPage} from './widgetConfigUI.js';
import {createGwcContext, validateSchema} from './settingsApi.js';
import {SettingsStore} from './settingsStore.js';
import {buildGroup as buildSettingsJsGroup} from './settingsRenderer.js';
import {ThemeService} from './themeService.js';
import {buildGwctDocument, writeGwctFile, readGwctFile, importGwctDocument} from './exportService.js';
import {createBackup, restoreBackup} from './backupService.js';
import {loadTranslations} from '../i18n/index.js';

/**
 * Gdk.RGBA -> `#rrggbb` (alpha deliberately dropped — theme.json's
 * "transparent" boolean fields control alpha independently, see
 * themeService.js's hexToRgba(); a stored `rgba(...)` string would bypass
 * that override entirely since hexToRgba() only recognizes hex input).
 * @param {Gdk.RGBA} rgba
 * @returns {string}
 */
function _rgbaToHex(rgba) {
    const toHex = c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0');
    return `#${toHex(rgba.red)}${toHex(rgba.green)}${toHex(rgba.blue)}`;
}

export class PrefsWindowController {
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
    }

    /** @private standalone-app fallback for `this.metadata` (see constructor doc) - plain JSON read, same file GNOME itself parses for the ExtensionPreferences path. */
    _loadMetadataFromPath(extensionPath) {
        try {
            const [, contents] = Gio.File.new_for_path(
                GLib.build_filenamev([extensionPath, 'metadata.json'])
            ).load_contents(null);
            return JSON.parse(new TextDecoder().decode(contents));
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

        // Extension-level UI strings (tab titles, category names, etc —
        // see gen/generate_i18n.py's EXTENSION_KEYS). GNOME Shell awaits
        // fillPreferencesWindow() if it returns a Promise (has since
        // GNOME 44), so it's safe to resolve this before building
        // anything rather than translating progressively like the
        // per-widget Overview rows do (_applyWidgetI18n()) — there's
        // only 15 short strings here, the wait is imperceptible, and it
        // means every tab is correctly labeled from the very first frame
        // instead of visibly relabeling itself a moment later.
        this._i18n = await loadTranslations(GLib.build_filenamev([this.path, 'i18n'])).catch(() => ({}));

        const settings = new SettingsService(
            this._extensionObject ?? GLib.build_filenamev([this.path, 'schemas'])
        );
        try {
            settings.init();
        } catch (e) {
            logError(e, '[widget-center] prefs: SettingsService.init() failed');
        }

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
        this._buildPreferencesPage(window, settings, storage, ok, {bundledWidgetsPath, userWidgetsPath});

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
        const value = this._i18n?.[key];
        return typeof value === 'string' && value.length > 0 ? value : fallback;
    }

    /**
     * @private "Overview" tab — the widget list, unchanged from the old
     * top-level "Widgets" page other than the title (see
     * repo/concept/overview.png).
     * @param {Adw.PreferencesWindow} window
     * @param {SettingsService} settings
     * @param {StorageService} storage
     * @param {Array} ok - discovered widgets, from PrefsWidgetList.list()
     * @param {Array} errors - widgets that failed to load
     */
    _buildOverviewPage(window, settings, storage, ok, errors) {
        const page = new Adw.PreferencesPage({
            title: this._tr('tab.overview.label', 'Overview'),
            icon_name: 'view-grid-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: this._tr('overview.group.title', 'Installed widgets'),
            description: this._tr('overview.group.description',
                'Turn a widget off to remove it from the desktop immediately — no restart needed.'),
        });
        page.add(group);

        const disabled = new Set(settings.isReady ? settings.getGlobalValue('disabled-widgets') : []);

        if (ok.length === 0) {
            group.add(new Adw.ActionRow({
                title: this._tr('overview.empty', 'No widgets found'),
                subtitle: 'Nothing was discovered in the bundled or user widget folders.',
            }));
        }

        for (const widget of ok)
            group.add(this._buildWidgetRow(window, settings, storage, widget, disabled.has(widget.id)));

        if (errors.length > 0) {
            const errorGroup = new Adw.PreferencesGroup({
                title: 'Widgets that failed to load',
                description: 'Fix metadata.json for these, then reopen this window to retry.',
            });
            page.add(errorGroup);

            for (const err of errors) {
                const row = new Adw.ActionRow({
                    title: err.id,
                    subtitle: err.reason,
                    css_classes: ['error'],
                });
                row.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic'}));
                errorGroup.add(row);
            }
        }
    }

    /**
     * @private "Store" tab — deliberately blank. There is no widget
     * marketplace/store backend yet (nothing in lib/ fetches or lists
     * remotely-published widgets); this is a placeholder so the tab
     * exists in the right position now rather than being bolted on
     * later, matching repo/concept/store.png.
     * @param {Adw.PreferencesWindow} window
     */
    _buildStorePage(window) {
        const page = new Adw.PreferencesPage({
            title: this._tr('tab.store.label', 'Store'),
            icon_name: 'system-search-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup();
        page.add(group);
        group.add(new Adw.StatusPage({
            icon_name: 'folder-download-symbolic',
            title: this._tr('store.title', 'Coming soon'),
            description: 'A widget store is planned but not built yet — for now, install ' +
                'third-party widgets manually into\n~/.local/share/gnome-widget-center/widgets/.',
            vexpand: true,
        }));
    }

    /**
     * @private "Preferences" tab — a single Adw.PreferencesPage whose
     * one PreferencesGroup holds a full-height Adw.NavigationSplitView:
     * a vertical category list on the left (repo/concept/preferences.png),
     * and that category's content on the right. Each category is built
     * lazily on first selection (`_categoryBuilders`) rather than all up
     * front, since most are Adw.StatusPage placeholders that don't need
     * to exist until looked at, and Appearance/Advanced already do
     * non-trivial GSettings/ThemeService reads.
     * @param {Adw.PreferencesWindow} window
     * @param {SettingsService} settings
     * @param {StorageService} storage
     * @param {Array} discoveredWidgets - `ok` from PrefsWidgetList.list(),
     *   needed by Backup & Restore / Import-Export below.
     * @param {{bundledWidgetsPath: string, userWidgetsPath: string}} widgetPaths
     */
    _buildPreferencesPage(window, settings, storage, discoveredWidgets, widgetPaths) {
        const page = new Adw.PreferencesPage({
            title: this._tr('tab.preferences.label', 'Preferences'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup();
        page.add(group);

        const categories = [
            {id: 'general', title: this._tr('category.general', 'General'), subtitle: 'General settings and behavior',
                icon: 'preferences-system-symbolic',
                build: () => this._buildComingSoonCategory('General',
                    'GNOME Shell extensions load automatically when enabled, so there\'s no ' +
                    'separate autostart/update setting to expose here yet.')},
            {id: 'appearance', title: this._tr('category.appearance', 'Appearance'), subtitle: 'Theme, colors and layout',
                icon: 'applications-graphics-symbolic',
                build: () => this._buildAppearanceCategory()},
            {id: 'desktop', title: this._tr('category.desktop', 'Desktop'), subtitle: 'Margins, spacing and position',
                icon: 'video-display-symbolic',
                build: () => this._buildDesktopCategory(settings)},
            {id: 'interactions', title: this._tr('category.interactions', 'Interactions'), subtitle: 'Dragging, animations and actions',
                icon: 'input-mouse-symbolic',
                build: () => this._buildComingSoonCategory('Interactions',
                    'Drag/snap behavior and animation toggles will live here.')},
            {id: 'backup', title: this._tr('category.backup', 'Backup & Restore'), subtitle: 'Backup and restore widgets',
                icon: 'cloud-upload-symbolic',
                build: () => this._buildBackupCategory(window, settings, storage, discoveredWidgets, widgetPaths)},
            {id: 'importexport', title: this._tr('category.importexport', 'Import / Export'), subtitle: 'Import or export widget data',
                icon: 'send-to-symbolic',
                build: () => this._buildImportExportCategory(window, storage, discoveredWidgets)},
            {id: 'advanced', title: this._tr('category.advanced', 'Advanced'), subtitle: 'Advanced developer options',
                icon: 'applications-engineering-symbolic',
                build: () => this._buildAdvancedCategory(settings)},
            {id: 'about', title: this._tr('category.about', 'About'), subtitle: 'About GNOME Widget Center',
                icon: 'help-about-symbolic',
                build: () => this._buildAboutCategory()},
        ];

        const split = new Adw.NavigationSplitView({
            min_sidebar_width: 200,
            max_sidebar_width: 260,
            sidebar_width_fraction: 0.3,
            vexpand: true,
        });
        split.set_size_request(-1, 560);

        const listBox = new Gtk.ListBox({
            css_classes: ['navigation-sidebar'],
            selection_mode: Gtk.SelectionMode.SINGLE,
        });
        const contentStack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            vexpand: true,
        });

        // Gtk.ListBoxRow can't hold an arbitrary object ref as a GObject
        // property without registering one — attach it as a plain JS
        // expando property instead (safe: GJS keeps JS-side properties
        // alive alongside the wrapped GObject for as long as the row is
        // reachable, which here is the whole lifetime of the window).
        for (const category of categories) {
            const row = new Adw.ActionRow({title: category.title, subtitle: category.subtitle});
            row.add_prefix(new Gtk.Image({icon_name: category.icon}));
            row._category = category;
            listBox.append(row);
        }

        listBox.connect('row-selected', (_box, row) => {
            if (!row)
                return;
            const {id, build} = row._category;
            if (!contentStack.get_child_by_name(id)) {
                const built = build();
                contentStack.add_named(built, id);
            }
            contentStack.set_visible_child_name(id);
        });

        const sidebarPage = new Adw.NavigationPage({
            title: 'Preferences',
            child: new Adw.ToolbarView({content: new Gtk.ScrolledWindow({child: listBox, vexpand: true})}),
        });
        const contentPage = new Adw.NavigationPage({
            title: 'Preferences',
            child: new Adw.ToolbarView({content: contentStack}),
        });
        split.sidebar = sidebarPage;
        split.content = contentPage;

        group.add(split);

        // Select "General" first so the right pane is never blank.
        listBox.select_row(listBox.get_row_at_index(0));
    }

    /** @private a simple "not built yet" placeholder used by several Preferences categories. */
    _buildComingSoonCategory(title, description) {
        return new Adw.StatusPage({
            icon_name: 'view-more-symbolic',
            title,
            description,
            vexpand: true,
        });
    }

    /**
     * @private Task 11 — a small results dialog shared by every
     * export/import/backup/restore action below: one title, one
     * scrollable body of plain text, one "Close" button.
     * @param {Adw.PreferencesWindow} window
     * @param {string} title
     * @param {string} bodyText
     */
    _showReportDialog(window, title, bodyText) {
        const dialog = new Adw.MessageDialog({
            transient_for: window,
            heading: title,
            body: bodyText || '(nothing to report)',
            modal: true,
        });
        dialog.add_response('close', 'Close');
        dialog.present();
    }

    /**
     * @private Prompts for a password (backup/restore only — `.gwct`
     * theme export/import never needs one, see exportService.js's file
     * header). Resolves with the entered string, or null if the user
     * cancelled — callers must treat null as "abort the whole action",
     * never as an empty password.
     * @param {Adw.PreferencesWindow} window
     * @param {string} heading
     * @param {string} body
     * @returns {Promise<string|null>}
     */
    _promptPassword(window, heading, body) {
        return new Promise(resolve => {
            const dialog = new Adw.MessageDialog({transient_for: window, heading, body, modal: true});
            const entry = new Gtk.PasswordEntry({show_peek_icon: true, margin_top: 8});
            dialog.set_extra_child(entry);
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('ok', 'Continue');
            dialog.set_response_appearance('ok', Adw.ResponseAppearance.SUGGESTED);
            dialog.set_default_response('ok');
            entry.connect('activate', () => dialog.response('ok'));
            dialog.connect('response', (_d, response) => {
                resolve(response === 'ok' ? entry.text : null);
            });
            dialog.present();
        });
    }

    /**
     * @private A plain yes/no confirmation, used before any action below
     * that overwrites the user's current settings/appearance wholesale —
     * importing a `.gwct` theme or restoring a `.gwcbak` backup. Neither
     * of those actions is undoable from inside this window (no "undo",
     * no diff-before-apply), so this is the only chance to back out
     * after the file/password has already been chosen.
     * @param {Adw.PreferencesWindow} window
     * @param {string} heading
     * @param {string} body
     * @param {string} [confirmLabel]
     * @returns {Promise<boolean>} true only if the user picked the
     *   destructive confirm button; false for Cancel OR the dialog being
     *   dismissed any other way (Esc, close button) — callers must treat
     *   anything other than true as "abort the whole action".
     */
    _confirmOverwrite(window, heading, body, confirmLabel = 'Overwrite') {
        return new Promise(resolve => {
            const dialog = new Adw.MessageDialog({transient_for: window, heading, body, modal: true});
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('confirm', confirmLabel);
            dialog.set_response_appearance('confirm', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('cancel');
            dialog.set_close_response('cancel');
            dialog.connect('response', (_d, response) => {
                resolve(response === 'confirm');
            });
            dialog.present();
        });
    }

    /**
     * @private GTK4 native file chooser wrapper (save or open), Promise-
     * based so the async export/import/backup/restore handlers below can
     * just `await` a chosen path instead of nesting callbacks.
     * @param {Adw.PreferencesWindow} window
     * @param {{action: 'save'|'open', title: string, initialName?: string,
     *           pattern?: string}} opts
     * @returns {Promise<string|null>} chosen path, or null if cancelled.
     */
    _chooseFile(window, opts) {
        return new Promise(resolve => {
            const chooser = new Gtk.FileChooserNative({
                title: opts.title,
                action: opts.action === 'save' ? Gtk.FileChooserAction.SAVE : Gtk.FileChooserAction.OPEN,
                transient_for: window,
                modal: true,
                accept_label: opts.action === 'save' ? '_Save' : '_Open',
            });
            if (opts.initialName)
                chooser.set_current_name(opts.initialName);
            if (opts.pattern) {
                const filter = new Gtk.FileFilter();
                filter.add_pattern(opts.pattern);
                filter.set_name(opts.pattern);
                chooser.add_filter(filter);
            }
            chooser.connect('response', (_c, response) => {
                const file = response === Gtk.ResponseType.ACCEPT ? chooser.get_file() : null;
                resolve(file ? file.get_path() : null);
                chooser.destroy();
            });
            chooser.show();
        });
    }

    /**
     * @private "Import / Export" category — `.gwct` theme files (see
     * lib/exportService.js's file header for exactly what's in/out).
     * @param {Adw.PreferencesWindow} window
     * @param {StorageService} storage
     * @param {Array} discoveredWidgets
     */
    _buildImportExportCategory(window, storage, discoveredWidgets) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: this._tr('importexport.group.title', 'Theme file (.gwct)'),
            description: this._tr('importexport.group.description',
                'Appearance and per-widget settings, with any passwords, API keys, ' +
                'usernames or emails left out. Does not include the widgets themselves — ' +
                'importing on a machine missing one of these widgets will skip it.'),
        });
        page.add(group);

        const exportRow = new Adw.ActionRow({
            title: this._tr('importexport.export.title', 'Export theme…'),
            subtitle: this._tr('importexport.export.subtitle', 'Save the current appearance and widget settings to a .gwct file.'),
            activatable: true,
        });
        exportRow.add_suffix(new Gtk.Image({icon_name: 'document-save-symbolic'}));
        exportRow.connect('activated', async () => {
            const path = await this._chooseFile(window, {
                action: 'save', title: this._tr('importexport.export.filechooser_title', 'Export theme'),
                initialName: 'gnome-widget-center.gwct', pattern: '*.gwct',
            });
            if (!path)
                return;
            try {
                const theme = new ThemeService();
                theme.init();
                const {document, redactedFields} = buildGwctDocument(discoveredWidgets, {storage, theme});
                const finalPath = writeGwctFile(path, document);

                const lines = [
                    this._tr('importexport.result.saved_to', 'Saved to {path}').replace('{path}', finalPath),
                    this._tr('importexport.result.widgets_exported', 'Widgets exported: {count}').replace('{count}', document.widgets.length),
                ];
                if (redactedFields.length > 0) {
                    lines.push('', this._tr('importexport.result.left_out', 'Left out (secrets are never exported):'));
                    for (const r of redactedFields)
                        lines.push(`  ${r.widgetId}: ${r.keys.join(', ')}`);
                }
                this._showReportDialog(window, this._tr('importexport.result.export_heading', 'Theme exported'), lines.join('\n'));
            } catch (e) {
                logError(e, '[widget-center] prefs: theme export failed');
                this._showReportDialog(window, this._tr('importexport.result.export_failed_heading', 'Export failed'), e.message);
            }
        });
        group.add(exportRow);

        const importRow = new Adw.ActionRow({
            title: this._tr('importexport.import.title', 'Import theme…'),
            subtitle: this._tr('importexport.import.subtitle', 'Apply appearance and widget settings from a .gwct file.'),
            activatable: true,
        });
        importRow.add_suffix(new Gtk.Image({icon_name: 'document-open-symbolic'}));
        importRow.connect('activated', async () => {
            const path = await this._chooseFile(window, {
                action: 'open', title: this._tr('importexport.import.filechooser_title', 'Import theme'), pattern: '*.gwct',
            });
            if (!path)
                return;

            const confirmed = await this._confirmOverwrite(window,
                this._tr('importexport.import.confirm_heading', 'Import this theme?'),
                this._tr('importexport.import.confirm_body',
                    'This applies appearance and widget settings from the chosen file, ' +
                    'overwriting any current values for the widgets it covers. This cannot be undone.'),
                this._tr('importexport.import.confirm_button', 'Import'));
            if (!confirmed)
                return;

            try {
                const document = readGwctFile(path);
                const theme = new ThemeService();
                theme.init();
                const discoveredWidgetsById = new Map(discoveredWidgets.map(w => [w.id, w]));
                const {appliedWidgetIds, missingWidgets, dependencyWarnings} =
                    importGwctDocument(document, {storage, theme, discoveredWidgetsById});

                const lines = [this._tr('importexport.result.applied_to', 'Applied to {count} widget(s).').replace('{count}', appliedWidgetIds.length)];
                if (missingWidgets.length > 0) {
                    lines.push('', this._tr('importexport.result.not_installed', 'Not installed here — skipped:'));
                    for (const w of missingWidgets)
                        lines.push(`  ${w.name} (${w.id})`);
                }
                if (dependencyWarnings.length > 0) {
                    lines.push('', this._tr('shared.result.missing_dependencies', 'Missing system dependencies:'));
                    for (const d of dependencyWarnings) {
                        lines.push(`  ${d.widgetId}: ${d.bin}${d.reason ? ` — ${d.reason}` : ''}`);
                        if (d.suggestedCommand)
                            lines.push(`    ${this._tr('shared.result.install_with', 'install with:')} ${d.suggestedCommand}`);
                    }
                }
                this._showReportDialog(window, this._tr('importexport.result.import_heading', 'Theme imported'), lines.join('\n'));
            } catch (e) {
                logError(e, '[widget-center] prefs: theme import failed');
                this._showReportDialog(window, this._tr('importexport.result.import_failed_heading', 'Import failed'), e.message);
            }
        });
        group.add(importRow);

        return page;
    }

    /**
     * @private "Backup & Restore" category — `.gwcbak` full,
     * password-protected backups (see lib/backupService.js's file
     * header). Only user-installed widgets (not the ones bundled inside
     * the extension) get their files copied into the archive — same
     * distinction fillPreferencesWindow() already draws between
     * `bundledWidgetsPath`/`userWidgetsPath`.
     * @param {Adw.PreferencesWindow} window
     * @param {SettingsService} settings
     * @param {StorageService} storage
     * @param {Array} discoveredWidgets
     * @param {{bundledWidgetsPath: string, userWidgetsPath: string}} widgetPaths
     */
    _buildBackupCategory(window, settings, storage, discoveredWidgets, widgetPaths) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: this._tr('backup.group.title', 'Full backup (.gwcbak)'),
            description: this._tr('backup.group.description',
                'Everything — appearance, every widget\'s settings (including passwords/API ' +
                'keys), host preferences, and the widget files themselves for anything you\'ve ' +
                'installed yourself. Password-protected (AES-256, PBKDF2-derived key) — see the ' +
                'file itself for what that does and doesn\'t protect against.'),
        });
        page.add(group);

        const backupRow = new Adw.ActionRow({title: this._tr('backup.create.title', 'Create backup…'), activatable: true});
        backupRow.add_suffix(new Gtk.Image({icon_name: 'cloud-upload-symbolic'}));
        backupRow.connect('activated', async () => {
            const password = await this._promptPassword(window, this._tr('backup.password_prompt.heading', 'Backup password'),
                this._tr('backup.password_prompt.create_body', 'Choose a password to protect this backup file. You\'ll need it to restore.'));
            if (!password)
                return;
            const path = await this._chooseFile(window, {
                action: 'save', title: this._tr('backup.create.filechooser_title', 'Create backup'),
                initialName: 'gnome-widget-center.gwcbak', pattern: '*.gwcbak',
            });
            if (!path)
                return;
            try {
                const theme = new ThemeService();
                theme.init();
                const userWidgets = discoveredWidgets.filter(w => w.path.startsWith(widgetPaths.userWidgetsPath));
                const finalPath = createBackup(path, password, userWidgets, {storage, theme, settings});
                this._showReportDialog(window, this._tr('backup.result.created_heading', 'Backup created'),
                    `${this._tr('importexport.result.saved_to', 'Saved to {path}').replace('{path}', finalPath)}\n` +
                    `${this._tr('backup.result.widgets_included', 'Widgets included: {count}').replace('{count}', userWidgets.length)}`);
            } catch (e) {
                logError(e, '[widget-center] prefs: backup failed');
                this._showReportDialog(window, this._tr('backup.result.create_failed_heading', 'Backup failed'), e.message);
            }
        });
        group.add(backupRow);

        const restoreRow = new Adw.ActionRow({title: this._tr('backup.restore.title', 'Restore backup…'), activatable: true});
        restoreRow.add_suffix(new Gtk.Image({icon_name: 'cloud-download-symbolic'}));
        restoreRow.connect('activated', async () => {
            const path = await this._chooseFile(window, {
                action: 'open', title: this._tr('backup.restore.filechooser_title', 'Restore backup'), pattern: '*.gwcbak',
            });
            if (!path)
                return;
            const password = await this._promptPassword(window, this._tr('backup.password_prompt.heading', 'Backup password'),
                this._tr('backup.password_prompt.restore_body', 'Enter this backup\'s password.'));
            if (!password)
                return;

            const confirmed = await this._confirmOverwrite(window,
                this._tr('backup.restore.confirm_heading', 'Restore this backup?'),
                this._tr('backup.restore.confirm_body',
                    'This overwrites appearance, host preferences, and settings for every widget ' +
                    'in the backup with the values it contains, and reinstalls the widget files it ' +
                    'includes. This cannot be undone.'),
                this._tr('backup.restore.confirm_button', 'Restore'));
            if (!confirmed)
                return;

            try {
                const theme = new ThemeService();
                theme.init();
                const {restoredWidgetIds, restoredWidgetFileIds, dependencyWarnings} = restoreBackup(
                    path, password, {storage, theme, settings, userWidgetsDir: widgetPaths.userWidgetsPath});

                const lines = [
                    this._tr('backup.result.settings_restored', 'Restored settings for {count} widget(s).').replace('{count}', restoredWidgetIds.length),
                    this._tr('backup.result.files_restored', 'Restored files for {count} widget(s).').replace('{count}', restoredWidgetFileIds.length),
                    this._tr('backup.result.reopen_hint', 'Reopen this window (or restart the widgets) to see everything.'),
                ];
                if (dependencyWarnings.length > 0) {
                    lines.push('', this._tr('shared.result.missing_dependencies', 'Missing system dependencies:'));
                    for (const d of dependencyWarnings) {
                        lines.push(`  ${d.widgetId}: ${d.bin}${d.reason ? ` — ${d.reason}` : ''}`);
                        if (d.suggestedCommand)
                            lines.push(`    ${this._tr('shared.result.install_with', 'install with:')} ${d.suggestedCommand}`);
                    }
                }
                this._showReportDialog(window, this._tr('backup.result.restored_heading', 'Backup restored'), lines.join('\n'));
            } catch (e) {
                logError(e, '[widget-center] prefs: restore failed');
                this._showReportDialog(window, this._tr('backup.result.restore_failed_heading', 'Restore failed'), e.message);
            }
        });
        group.add(restoreRow);

        return page;
    }

    /**
     * @private "About" category — real (not placeholder) data pulled
     * straight from metadata.json, same object `this.metadata` already
     * exposes to any ExtensionPreferences subclass.
     */
    _buildAboutCategory() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        page.add(group);

        group.add(new Adw.StatusPage({
            icon_name: 'preferences-desktop-applications-symbolic',
            title: this.metadata.name ?? 'GNOME Widget Center',
            description: this.metadata.description ?? '',
        }));

        const versionRow = new Adw.ActionRow({title: 'Version'});
        versionRow.add_suffix(new Gtk.Label({label: String(this.metadata.version ?? '—'), css_classes: ['dim-label']}));
        group.add(versionRow);

        if (this.metadata.url) {
            const linkRow = new Adw.ActionRow({
                title: 'Source code',
                subtitle: this.metadata.url,
                activatable: true,
            });
            linkRow.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
            linkRow.connect('activated', () => {
                Gtk.show_uri(null, this.metadata.url, Gdk.CURRENT_TIME);
            });
            group.add(linkRow);
        }

        return page;
    }

    /**
     * @private Theme system (2026-07-21, corner radius + force flags
     * 2026-07-25) — an Appearance page for editing `theme.json`'s GLOBAL
     * background/corner-radius/drop-shadow settings (see
     * development/docs/THEME_SYSTEM.md and lib/themeService.js). This
     * page only ever calls `ThemeService.setGlobalTheme()`; per-widget
     * overrides are exposed on each themeable widget's own settings
     * subpage instead (see `_appendWidgetAppearanceGroup()` below), and
     * the "Force" switches here (`background.force`/`cornerRadius.force`)
     * make those per-widget overrides get ignored entirely while on.
     *
     * Every row writes straight through on change (same "no separate Save
     * step" convention settingsSchemaUI.js's rows already use) —
     * ThemeService.save() is a single small atomic file write, cheap
     * enough to do on every toggle/color-pick/spin-value change with no
     * debounce needed (unlike widgetSettings.js's per-keystroke text
     * fields).
     * @returns {Adw.PreferencesPage} content only — caller (now
     *   `_buildPreferencesPage()`'s "Appearance" category) decides where
     *   this ends up; it's no longer added to `window` directly.
     */
    _buildAppearanceCategory() {
        const theme = new ThemeService();
        theme.init();
        const current = theme.getGlobalTheme();

        const page = new Adw.PreferencesPage();

        // --- Background -------------------------------------------------
        const bgGroup = new Adw.PreferencesGroup({
            title: 'Widget background',
            description: 'Applies to any widget that opts in via metadata.json\'s ' +
                '"themeable": true, plus every widget\'s Edit Mode card.',
        });
        page.add(bgGroup);

        const bgTransparentRow = new Adw.SwitchRow({
            title: 'Transparent',
            subtitle: 'When on, the background color below is fully see-through.',
            active: !!current.background.transparent,
        });
        bgGroup.add(bgTransparentRow);

        const bgColorRow = new Adw.ActionRow({title: 'Background color'});
        const bgRgba = new Gdk.RGBA();
        bgRgba.parse(current.background.color ?? '#1e1e2e');
        const bgColorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog(),
            rgba: bgRgba,
            valign: Gtk.Align.CENTER,
        });
        bgColorRow.add_suffix(bgColorButton);
        bgColorRow.set_activatable_widget(bgColorButton);
        bgGroup.add(bgColorRow);

        const bgBlurAdjustment = new Gtk.Adjustment({
            lower: 0,
            upper: 64,
            step_increment: 1,
            value: current.background.blur ?? 0,
        });
        const bgBlurRow = new Adw.SpinRow({
            title: 'Background blur',
            subtitle: '0\u201364 px',
            adjustment: bgBlurAdjustment,
        });
        bgGroup.add(bgBlurRow);

        const bgForceRow = new Adw.SwitchRow({
            title: 'Force this background on every widget',
            subtitle: 'Overrides any background color/transparency a widget sets for itself ' +
                'in its own Appearance settings.',
            active: !!current.background.force,
        });
        bgGroup.add(bgForceRow);

        const saveBackground = () => {
            theme.setGlobalTheme({
                background: {
                    transparent: bgTransparentRow.active,
                    color: _rgbaToHex(bgColorButton.rgba),
                    blur: bgBlurRow.value,
                    force: bgForceRow.active,
                },
            });
        };
        bgTransparentRow.connect('notify::active', saveBackground);
        bgColorButton.connect('notify::rgba', saveBackground);
        bgBlurRow.connect('notify::value', saveBackground);
        bgForceRow.connect('notify::active', saveBackground);

        // --- Corner radius --------------------------------------------
        const radiusGroup = new Adw.PreferencesGroup({
            title: 'Widget corner radius',
            description: 'Same opt-in rule as the background above.',
        });
        page.add(radiusGroup);

        const radiusRow = new Adw.SpinRow({
            title: 'Corner radius',
            subtitle: '0\u201364 px',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 64, step_increment: 1,
                value: current.cornerRadius.value ?? 12,
            }),
        });
        radiusGroup.add(radiusRow);

        const radiusForceRow = new Adw.SwitchRow({
            title: 'Force this corner radius on every widget',
            subtitle: 'Overrides any corner radius a widget sets for itself ' +
                'in its own Appearance settings.',
            active: !!current.cornerRadius.force,
        });
        radiusGroup.add(radiusForceRow);

        const saveCornerRadius = () => {
            theme.setGlobalTheme({
                cornerRadius: {
                    value: radiusRow.value,
                    force: radiusForceRow.active,
                },
            });
        };
        radiusRow.connect('notify::value', saveCornerRadius);
        radiusForceRow.connect('notify::active', saveCornerRadius);

        // --- Drop shadow --------------------------------------------------
        const shadowGroup = new Adw.PreferencesGroup({
            title: 'Widget drop shadow',
            description: 'Same opt-in rule as the background above.',
        });
        page.add(shadowGroup);

        const shadowEnabledRow = new Adw.SwitchRow({
            title: 'Enabled',
            active: !!current.dropShadow.enabled,
        });
        shadowGroup.add(shadowEnabledRow);

        const shadowTransparentRow = new Adw.SwitchRow({
            title: 'Transparent',
            subtitle: 'Overrides Enabled above — a fully transparent shadow is drawn as none at all.',
            active: !!current.dropShadow.transparent,
        });
        shadowGroup.add(shadowTransparentRow);

        const shadowColorRow = new Adw.ActionRow({title: 'Shadow color'});
        const shadowRgba = new Gdk.RGBA();
        shadowRgba.parse(current.dropShadow.color ?? '#000000');
        const shadowColorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog(),
            rgba: shadowRgba,
            valign: Gtk.Align.CENTER,
        });
        shadowColorRow.add_suffix(shadowColorButton);
        shadowColorRow.set_activatable_widget(shadowColorButton);
        shadowGroup.add(shadowColorRow);

        const shadowOpacityRow = new Adw.SpinRow({
            title: 'Opacity',
            subtitle: '0.0\u20131.0',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 1, step_increment: 0.05,
                value: current.dropShadow.opacity ?? 0.45,
            }),
            digits: 2,
        });
        shadowGroup.add(shadowOpacityRow);

        const shadowOffsetXRow = new Adw.SpinRow({
            title: 'Offset X',
            subtitle: 'px',
            adjustment: new Gtk.Adjustment({
                lower: -64, upper: 64, step_increment: 1,
                value: current.dropShadow.offsetX ?? 0,
            }),
        });
        shadowGroup.add(shadowOffsetXRow);

        const shadowOffsetYRow = new Adw.SpinRow({
            title: 'Offset Y',
            subtitle: 'px',
            adjustment: new Gtk.Adjustment({
                lower: -64, upper: 64, step_increment: 1,
                value: current.dropShadow.offsetY ?? 4,
            }),
        });
        shadowGroup.add(shadowOffsetYRow);

        const shadowBlurRow = new Adw.SpinRow({
            title: 'Blur radius',
            subtitle: 'px',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 128, step_increment: 1,
                value: current.dropShadow.blurRadius ?? 12,
            }),
        });
        shadowGroup.add(shadowBlurRow);

        const shadowSpreadRow = new Adw.SpinRow({
            title: 'Spread',
            subtitle: 'px',
            adjustment: new Gtk.Adjustment({
                lower: -64, upper: 64, step_increment: 1,
                value: current.dropShadow.spread ?? 0,
            }),
        });
        shadowGroup.add(shadowSpreadRow);

        const saveShadow = () => {
            theme.setGlobalTheme({
                dropShadow: {
                    enabled: shadowEnabledRow.active,
                    transparent: shadowTransparentRow.active,
                    color: _rgbaToHex(shadowColorButton.rgba),
                    opacity: shadowOpacityRow.value,
                    offsetX: shadowOffsetXRow.value,
                    offsetY: shadowOffsetYRow.value,
                    blurRadius: shadowBlurRow.value,
                    spread: shadowSpreadRow.value,
                },
            });
        };
        for (const row of [shadowEnabledRow, shadowTransparentRow, shadowOpacityRow,
            shadowOffsetXRow, shadowOffsetYRow, shadowBlurRow, shadowSpreadRow]) {
            row.connect(row instanceof Adw.SwitchRow ? 'notify::active' : 'notify::value', saveShadow);
        }
        shadowColorButton.connect('notify::rgba', saveShadow);

        return page;
    }

    /**
     * @private Added 2026-07-19 alongside the real-hardware Edit Mode
     * bug-fix session (development/handoff-2026-07-19-editmode-bugs.md) —
     * "Development Mode" reuses the existing `dev-mode` GSettings key
     * (previously only wired to task 08's hot-reload file watcher, with
     * no UI of its own) as a single switch that now ALSO gates debug
     * logging (lib/logger.js). See that file's header for how to view
     * the output on real hardware.
     * @param {SettingsService} settings
     * @returns {Adw.PreferencesPage} content only — see
     *   `_buildAppearanceCategory()`'s doc comment for why this no
     *   longer takes/uses `window`.
     */
    _buildAdvancedCategory(settings) {
        const page = new Adw.PreferencesPage();

        const group = new Adw.PreferencesGroup({
            title: 'Development',
            description: 'For debugging the extension itself — safe to leave off otherwise.',
        });
        page.add(group);

        const row = new Adw.SwitchRow({
            title: 'Development Mode',
            subtitle: 'Hot-reloads widgets on file change, and logs internal debug output ' +
                '(Edit Mode flips, drag start/stop, etc) to the system journal — ' +
                'view with: journalctl -f -o cat | grep widget-center',
            active: settings.isReady ? !!settings.getGlobalValue('dev-mode') : false,
            sensitive: settings.isReady,
        });
        row.connect('notify::active', () => {
            if (!settings.isReady) {
                logError(new Error('SettingsService not ready — could not toggle Development Mode'));
                return;
            }
            try {
                settings.setGlobalValue('dev-mode', row.active);
            } catch (e) {
                logError(e, 'could not toggle Development Mode');
            }
        });
        group.add(row);

        return page;
    }

    /**
     * @private "Desktop" category — the three LayoutEngine (task 14)
     * GSettings keys added 2026-07-28 when the old fixed 16px
     * snap-to-grid was removed ("เอา grid ออก" — see lib/layoutEngine.js
     * for the actual geometry). Same live-sync pattern as
     * `_buildAdvancedCategory()`'s Development Mode switch: writes go
     * straight to GSettings, and extension.js's own onChanged()
     * listeners pick the new value up in the Shell process immediately,
     * no shell restart needed.
     * @param {SettingsService} settings
     * @returns {Adw.PreferencesPage}
     */
    _buildDesktopCategory(settings) {
        const page = new Adw.PreferencesPage();

        const group = new Adw.PreferencesGroup({
            title: 'Widget placement',
            description: 'Applies while dragging widgets in Edit Mode.',
        });
        page.add(group);

        const overlapRow = new Adw.SwitchRow({
            title: 'Prevent widgets from overlapping',
            subtitle: 'ห้าม widget ทับกัน — when off, widgets can be dropped on top of each other.',
            active: settings.isReady ? !!settings.getGlobalValue('prevent-widget-overlap') : true,
            sensitive: settings.isReady,
        });
        overlapRow.connect('notify::active', () => {
            if (!settings.isReady) {
                logError(new Error('SettingsService not ready — could not toggle widget overlap prevention'));
                return;
            }
            try {
                settings.setGlobalValue('prevent-widget-overlap', overlapRow.active);
            } catch (e) {
                logError(e, 'could not toggle prevent-widget-overlap');
            }
        });
        group.add(overlapRow);

        const marginRow = new Adw.SpinRow({
            title: 'Screen edge margin',
            subtitle: 'พื้นที่จากขอบจอที่ widget วางไม่ได้ — minimum distance (px) a widget ' +
                'must keep from every edge of the screen.',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 256, step_increment: 1,
                value: settings.isReady ? settings.getGlobalValue('edge-margin') : 32,
            }),
            sensitive: settings.isReady,
        });
        marginRow.connect('notify::value', () => {
            if (!settings.isReady) {
                logError(new Error('SettingsService not ready — could not save edge margin'));
                return;
            }
            try {
                settings.setGlobalValue('edge-margin', Math.round(marginRow.value));
            } catch (e) {
                logError(e, 'could not save edge-margin');
            }
        });
        group.add(marginRow);

        const spacingRow = new Adw.SpinRow({
            title: 'Spacing between widgets',
            subtitle: 'widget ต้องห่างกันเท่าไหร่ — minimum gap (px) kept between widgets ' +
                'while overlap prevention above is on.',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 256, step_increment: 1,
                value: settings.isReady ? settings.getGlobalValue('widget-spacing') : 16,
            }),
            sensitive: settings.isReady,
        });
        spacingRow.connect('notify::value', () => {
            if (!settings.isReady) {
                logError(new Error('SettingsService not ready — could not save widget spacing'));
                return;
            }
            try {
                settings.setGlobalValue('widget-spacing', Math.round(spacingRow.value));
            } catch (e) {
                logError(e, 'could not save widget-spacing');
            }
        });
        group.add(spacingRow);

        return page;
    }

    /**
     * @description Jumps an already-built window straight to one widget's
     * settings subpage - the standalone app's equivalent of writing
     * requested-widget-id and waiting for build()'s dconf plumbing, for
     * callers (widget-center-prefs-app.js) that already know exactly
     * which window and which widget id, with no GSettings round-trip
     * needed. No-op if build() hasn't been called yet or the id is
     * unknown/empty (see _jumpToWidgetPrefs()).
     * @param {Adw.PreferencesWindow} window
     * @param {string} widgetId
     */
    jumpToWidget(window, widgetId) {
        this._jumpToWidgetPrefs(window, this._settings, this._storage, this._discovered, widgetId);
    }

    /**
     * @private 2026-07-20 fix — the other half of extension.js's
     * `_openWidgetSettings()`. Reads `requested-widget-id` back out of the
     * shared GSettings key, clears it immediately (so it's a one-shot
     * hint, not a sticky "always jump here"), and — if it names a widget
     * that was actually discovered — presents that widget's settings
     * sub-page right away, exactly as if the user had clicked its own
     * "Settings" suffix button in the list (`_openWidgetPrefs()`, same
     * method `_buildWidgetRow()`'s button uses).
     *
     * Deliberately queued with `GLib.idle_add()` rather than called
     * inline: `window.present_subpage()` needs the window (and the page
     * this method is called from inside `fillPreferencesWindow()`) to
     * actually be mapped/realized first — calling it synchronously while
     * the window is still being built out is exactly the kind of timing
     * issue this codebase's other real-hardware fixes keep running into
     * (see e.g. widgetEditMode.js's `_buildBackActor()` non-positive-size
     * warning for the general pattern). One idle-loop turn is enough for
     * GTK to finish mapping the window.
     * @param {Adw.PreferencesWindow} window
     * @param {SettingsService} settings
     * @param {StorageService} storage
     * @param {Array} discovered - the `ok` list from `PrefsWidgetList.list()`
     */
    _openRequestedWidgetPrefs(window, settings, storage, discovered) {
        if (!settings.isReady)
            return;

        let requestedId;
        try {
            requestedId = settings.getGlobalValue('requested-widget-id');
        } catch (e) {
            logError(e, '[widget-center] prefs: could not read requested-widget-id');
            return;
        }

        this._jumpToWidgetPrefs(window, settings, storage, discovered, requestedId);
    }

    /**
     * @private shared by `_openRequestedWidgetPrefs()`'s one-shot read at
     * startup and `fillPreferencesWindow()`'s live `onChanged` subscription
     * (2026-07-30 fix, see that call site's comment) — both ultimately
     * just want "given whatever requested-widget-id currently says, jump
     * to that widget's settings subpage". Safe to call with an empty/
     * unknown id (a no-op) since both callers may fire with nothing
     * actually requested.
     * @param {Adw.PreferencesWindow} window
     * @param {SettingsService} settings
     * @param {StorageService} storage
     * @param {Array} discovered - the `ok` list from `PrefsWidgetList.list()`
     * @param {string} requestedId
     */
    _jumpToWidgetPrefs(window, settings, storage, discovered, requestedId) {
        if (!requestedId)
            return;

        // One-shot: clear right away so a plain "open the Control Center"
        // later (no widget id in flight) never jumps anywhere, and so a
        // second `changed::requested-widget-id` emission for the exact
        // same id doesn't jump twice.
        try {
            settings.setGlobalValue('requested-widget-id', '');
        } catch (e) {
            logError(e, '[widget-center] prefs: could not clear requested-widget-id');
        }

        const widget = discovered.find(w => w.id === requestedId);
        if (!widget) {
            // Widget vanished (uninstalled, disabled-with-error, etc)
            // between the Settings click and this window opening — fall
            // back to the top-level list rather than throwing.
            logError(new Error(`requested-widget-id "${requestedId}" not found among discovered widgets`));
            return;
        }
        if (!widget.hasConfigJson && !widget.hasPrefs && !widget.hasSettingsSchema && !widget.metadata?.['themeable'])
            return; // no settings page to jump to for this widget

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._openWidgetPrefs(window, storage, widget).catch(e =>
                logError(e, `[widget-center] prefs: opening requested settings for "${widget.id}" failed`));
            return GLib.SOURCE_REMOVE;
        });
    }

    /** @private builds one Adw.SwitchRow (+ optional Settings button) for a discovered widget. */
    _buildWidgetRow(window, settings, storage, widget, isDisabled) {
        const row = new Adw.SwitchRow({
            title: widget.name,
            subtitle: widget.description,
            active: !isDisabled,
        });
        // Progressive i18n: this._loadWidgetI18n() is async (dynamic
        // import()), but building the widget list can't wait on 12
        // separate file loads before showing anything — start with
        // metadata.json's own English name/description (above) and
        // relabel the row in place once/if a translation shows up. Not
        // awaited on purpose; see _loadWidgetI18n()'s doc comment.
        this._loadWidgetI18n(widget).then(translations => {
            row.title = this._t(translations, 'meta.name', widget.name);
            row.subtitle = this._t(translations, 'meta.description', widget.description);
        }).catch(() => {});

        const handlerId = row.connect('notify::active', () => {
            const ok = this._setWidgetEnabled(settings, widget.id, row.active);
            if (!ok) {
                // Write failed (see _setWidgetEnabled) — the switch already
                // flipped visually before this handler ran, but the
                // underlying value never changed, so revert it rather than
                // leave the UI showing a state that isn't real. Block the
                // handler while reverting so this doesn't just recurse.
                row.block_signal_handler(handlerId);
                row.active = !row.active;
                row.unblock_signal_handler(handlerId);
            }
        });

        if (widget.hasConfigJson || widget.hasPrefs || widget.hasSettingsSchema || widget.metadata?.['themeable']) {
            const settingsButton = new Gtk.Button({
                icon_name: 'go-next-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: `${widget.name} settings`,
            });
            settingsButton.connect('clicked', () => {
                this._openWidgetPrefs(window, storage, widget).catch(e =>
                    logError(e, `[widget-center] prefs: opening settings for "${widget.id}" failed`));
            });
            row.add_suffix(settingsButton);
        }

        return row;
    }

    /**
     * @private Dynamically loads one widget's own i18n/ table for the
     * current locale — see i18n/index.js's loadTranslations(), the
     * exact same loader every widget's i18n/index.js copy also exports
     * (see that file's header for why prefs.js reuses this one static
     * import instead of dynamically importing each widget's own copy:
     * the function is pure/stateless, it only cares about the dirPath
     * argument, so which physical copy runs it is irrelevant — each
     * widget still ships a fully working, self-contained i18n/index.js
     * of its own for anything that imports the widget directly, e.g. its
     * own widget.js).
     * @param {object} widget - a PrefsWidgetList entry (has .path)
     * @returns {Promise<Object>} {} if the widget has no i18n/ folder or
     *   nothing matched the current locale — never rejects.
     */
    _loadWidgetI18n(widget) {
        return loadTranslations(GLib.build_filenamev([widget.path, 'i18n'])).catch(() => ({}));
    }

    /** @private translations[key] if present, else `fallback`. */
    _t(translations, key, fallback) {
        const value = translations?.[key];
        return typeof value === 'string' && value.length > 0 ? value : fallback;
    }

    /**
     * @private flips one widget id in/out of the `disabled-widgets`
     * GSettings array.
     * @returns {boolean} true if the write succeeded, false otherwise (so
     *   the caller can revert a switch that already flipped visually).
     */
    _setWidgetEnabled(settings, widgetId, enabled) {
        if (!settings.isReady) {
            logError(new Error(`SettingsService not ready — could not ${enabled ? 'enable' : 'disable'} "${widgetId}"`));
            return false;
        }

        try {
            const current = new Set(settings.getGlobalValue('disabled-widgets'));
            if (enabled)
                current.delete(widgetId);
            else
                current.add(widgetId);
            settings.setGlobalValue('disabled-widgets', Array.from(current));
            return true;
        } catch (e) {
            logError(e, `could not ${enabled ? 'enable' : 'disable'} "${widgetId}"`);
            return false;
        }
    }

    /**
     * @private Opens a widget's settings page as a subpage of the
     * Control Center window. Four sources, in priority order:
     *   1. config.json (development/docs/WIDGET_API.md §6.4), read +
     *      validated by widgetConfigReader.js and auto-built into an Adw
     *      page by widgetConfigUI.js — the recommended path, and the one
     *      every bundled widget now ships instead of a hand-written
     *      prefs.js. Wins over #2/#3/#4 if a widget somehow has more
     *      than one, since config.json is meant to fully replace the
     *      others for a given widget, not merge with them.
     *   2. The widget's own prefs.js, dynamically imported (only this
     *      file, never widget.js — see development/docs/WIDGET_API.md
     *      §4) and embedded via its buildPrefsWidget() — kept for
     *      user-installed widgets that still ship one, or anything a
     *      declarative schema genuinely can't express (custom layout,
     *      live preview, etc).
     *   3. The widget's own settings.js (§6.3's `gwc.settings` fluent
     *      builder), dynamically imported and rendered via
     *      lib/settingsApi.js + lib/settingsRenderer.js — see
     *      _openWidgetSettingsJsPrefs(). Richer type set than #4 (adds
     *      date/action/multiOption/font/color, plus unconditional
     *      showIf()), but newer and less common than config.json, so it
     *      sits below #1/#2 rather than replacing them.
     *   4. A declarative `settings` array in metadata.json, auto-built
     *      into an Adw page by settingsSchemaUI.js — the oldest and
     *      least expressive of the four; only reached for widgets with
     *      none of #1-#3 of their own.
     */
    async _openWidgetPrefs(window, storage, widget) {
        const translations = await this._loadWidgetI18n(widget);
        const title = this._t(translations, 'meta.name', widget.name);

        if (widget.hasConfigJson) {
            const {config, errors} = readWidgetConfig(widget.path);
            if (config) {
                const settingsHandle = WidgetSettings.load(widget.id, storage);
                const prefsPage = buildConfigPage(config, settingsHandle, title, widget.path, translations);
                this._appendWidgetAppearanceGroup(prefsPage, widget);
                this._presentPrefsPage(window, widget, prefsPage);
                return;
            }
            // config.json exists but failed to read/parse/validate —
            // fall through to prefs.js/settings.js/schema below rather
            // than showing nothing, and log why so it's not silent.
            logError(new Error(
                `config.json for "${widget.id}" invalid: ${errors.map(e => e.message).join('; ')}`));
        }

        if (widget.hasPrefs) {
            this._openHandWrittenPrefs(window, storage, widget);
            return;
        }

        if (widget.hasSettingsJs) {
            this._openWidgetSettingsJsPrefs(window, widget, title);
            return;
        }

        // Scoped to this widget only, same WidgetSettings class
        // extension.js's WidgetLoader uses — the auto-generated rows
        // read/write it exactly like a hand-written prefs.js would.
        // (settingsSchemaUI.js's flat-array path predates config.json,
        // settings.js, and this i18n system — every bundled widget has
        // since moved to config.json, see this method's class-level doc
        // comment for the fallback order.)
        const settingsHandle = WidgetSettings.load(widget.id, storage);
        const prefsPage = buildSettingsPage(widget.metadata.settings ?? [], settingsHandle, title);
        this._appendWidgetAppearanceGroup(prefsPage, widget);
        this._presentPrefsPage(window, widget, prefsPage);
    }

    /**
     * @private §6.3 path — the widget's own `settings.js`, dynamically
     * imported and rendered via the `gwc.settings` fluent builder
     * (lib/settingsApi.js -> lib/settingsRenderer.js), backed by its own
     * SettingsStore (lib/settingsStore.js — a separate on-disk location,
     * `~/.local/share/gnome-widget-center/settings/<id>.json`, NOT
     * `widgets/<id>.json`/WidgetSettings; see settingsStore.js's file
     * header for why this is a deliberately separate "third system").
     *
     * Unlike the WidgetSettings-backed paths (config.json/prefs.js/
     * legacy schema, which debounce writes ~300ms and need an explicit
     * flush on close — see _presentPrefsPage()'s doc comment),
     * SettingsStore.set()/setMany() write straight to disk synchronously,
     * so there's nothing to flush here — only its Gio.FileMonitor to
     * release, done via store.destroy() in the onClose callback below.
     * @param {Adw.PreferencesWindow} window
     * @param {object} widget - discovered widget entry (needs .id/.path).
     * @param {string} title - already-translated display title.
     */
    _openWidgetSettingsJsPrefs(window, widget, title) {
        const entryPath = GLib.build_filenamev([widget.path, 'settings.js']);
        const entryFile = Gio.File.new_for_path(entryPath);
        if (!entryFile.query_exists(null)) {
            logError(new Error(`settings.js not found for "${widget.id}"`));
            return;
        }

        import(`file://${entryPath}`)
            .then(module => {
                if (typeof module.defineSettings !== 'function')
                    throw new Error(`settings.js for "${widget.id}" has no defineSettings() export`);

                const gwc = createGwcContext(widget.id);
                module.defineSettings(gwc);
                const schema = gwc.settings.build();
                validateSchema(schema);

                const store = new SettingsStore(widget.id, schema.fields);
                const prefsPage = new Adw.PreferencesPage({title});
                for (const group of buildSettingsJsGroup(schema, store, {title}))
                    prefsPage.add(group);

                this._appendWidgetAppearanceGroup(prefsPage, widget);
                this._presentPrefsPage(window, widget, prefsPage, () => store.destroy());
            })
            .catch(e => {
                logError(e, `[widget-center] prefs: failed to open settings.js for "${widget.id}"`);
            });
    }

    /**
     * @private Theme system (2026-07-25) — appends a per-widget
     * "Appearance" group (background color/transparent + corner radius)
     * to any settings page for a widget that opts in via metadata.json's
     * `"themeable": true`. Reads/writes `theme.json`'s per-widget
     * `config.background` / `config.cornerRadius` via
     * `ThemeService.getWidgetTheme()`/`setWidgetTheme()` — deliberately
     * NOT `WidgetSettings`/`widgets/<id>.json`, since this is an
     * APPEARANCE concern, not a behavior one (see themeService.js's file
     * header and development/docs/SETTINGS_SPEC.md's "one file, one
     * responsibility" principle).
     *
     * When the Appearance page's global "Force this ... on every widget"
     * switch is on for a property, that property's row here is shown but
     * disabled (greyed out, displaying the global value) — matches what
     * `ThemeService.getEffectiveWidgetTheme()` actually does at render
     * time: a per-widget value stored while forced would just be silently
     * ignored, so letting the user edit it here would be misleading.
     * @param {Adw.PreferencesPage} prefsPage
     * @param {object} widget - discovered widget entry (needs .id,
     *   .metadata.themeable).
     */
    _appendWidgetAppearanceGroup(prefsPage, widget) {
        if (!widget.metadata?.['themeable'])
            return;

        const theme = new ThemeService();
        theme.init();
        const global = theme.getGlobalTheme();
        const {config} = theme.getWidgetTheme(widget.id);
        const widgetBackground = config.background ?? {};
        const widgetCornerRadius = config.cornerRadius ?? {};

        const group = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'This widget\'s own background and corner radius. Set in the ' +
                'Control Center\'s Appearance page, "Force" can override these for every widget.',
        });
        prefsPage.add(group);

        const bgForced = !!global.background.force;
        const transparentRow = new Adw.SwitchRow({
            title: 'Transparent',
            active: bgForced ? !!global.background.transparent : !!widgetBackground.transparent,
            sensitive: !bgForced,
            subtitle: bgForced ? 'Forced by the global Appearance settings.' : null,
        });
        group.add(transparentRow);

        const colorRow = new Adw.ActionRow({
            title: 'Background color',
            sensitive: !bgForced,
        });
        const rgba = new Gdk.RGBA();
        rgba.parse((bgForced ? global.background.color : widgetBackground.color) ?? '#1e1e2e');
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog(),
            rgba,
            valign: Gtk.Align.CENTER,
            sensitive: !bgForced,
        });
        colorRow.add_suffix(colorButton);
        colorRow.set_activatable_widget(colorButton);
        group.add(colorRow);

        if (!bgForced) {
            const saveBackground = () => {
                theme.setWidgetTheme(widget.id, {
                    config: {
                        background: {
                            transparent: transparentRow.active,
                            color: _rgbaToHex(colorButton.rgba),
                        },
                    },
                });
            };
            transparentRow.connect('notify::active', saveBackground);
            colorButton.connect('notify::rgba', saveBackground);
        }

        const radiusForced = !!global.cornerRadius.force;
        const radiusRow = new Adw.SpinRow({
            title: 'Corner radius',
            subtitle: radiusForced ? 'Forced by the global Appearance settings.' : '0\u201364 px',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 64, step_increment: 1,
                value: (radiusForced ? global.cornerRadius.value : widgetCornerRadius.value) ?? 12,
            }),
            sensitive: !radiusForced,
        });
        group.add(radiusRow);

        if (!radiusForced) {
            radiusRow.connect('notify::value', () => {
                theme.setWidgetTheme(widget.id, {
                    config: {cornerRadius: {value: radiusRow.value}},
                });
            });
        }
    }

    /**
     * @private Real-hardware bug report (2026-07-19): a widget's settings
     * subpage had no visible "Save"/"Close" of its own — every row
     * writes straight through to disk on change (see settingsSchemaUI.js
     * / widgets' own hand-written prefs.js), so there was never a
     * separate "Save" step, and closing relied entirely on the Control
     * Center window's own title-bar chrome. That's not obvious enough on
     * its own, so every settings subpage now gets an explicit action bar:
     * both "Close" and "Save & Close" flush any pending debounced write
     * immediately (see the 2026-07-26 bug-fix note on
     * fillPreferencesWindow()'s close-request handler for why relying on
     * the ~300ms debounce alone was silently losing edits) — the two
     * buttons are kept distinct only so "my change is saved" stays an
     * explicit, visible action for anyone who wants that confirmation,
     * not because "Close" behaves any differently underneath.
     * @param {Adw.PreferencesWindow} window
     * @param {object} widget - discovered widget entry (needs .id for
     *   WidgetSettings.flush()).
     * @param {Adw.PreferencesPage} prefsPage - built by either
     *   buildSettingsPage() or a widget's own buildPrefsWidget().
     * @param {() => void} [onClose] - extra cleanup to run alongside the
     *   WidgetSettings.flush() below, before closing the subpage. Used
     *   by _openWidgetSettingsJsPrefs() to release its SettingsStore's
     *   Gio.FileMonitor (settings.js pages don't use WidgetSettings at
     *   all, so flush() is a harmless no-op for them, not a replacement
     *   for this).
     */
    _presentPrefsPage(window, widget, prefsPage, onClose = () => {}) {
        const actionsGroup = new Adw.PreferencesGroup();
        const buttonBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.END,
        });

        const closeButton = new Gtk.Button({label: 'Close'});
        closeButton.connect('clicked', () => {
            WidgetSettings.flush(widget.id);
            onClose();
            window.close_subpage();
        });

        const saveButton = new Gtk.Button({
            label: 'Save & Close',
            css_classes: ['suggested-action'],
        });
        saveButton.connect('clicked', () => {
            WidgetSettings.flush(widget.id);
            onClose();
            window.close_subpage();
        });

        buttonBox.append(closeButton);
        buttonBox.append(saveButton);
        actionsGroup.add(buttonBox);
        prefsPage.add(actionsGroup);

        window.present_subpage(prefsPage);
    }

    /** @private the pre-task-05 hand-written-prefs.js path, unchanged. */
    _openHandWrittenPrefs(window, storage, widget) {
        const entryPath = GLib.build_filenamev([widget.path, widget.metadata.prefs]);
        const entryFile = Gio.File.new_for_path(entryPath);
        if (!entryFile.query_exists(null)) {
            logError(new Error(`prefs entry "${widget.metadata.prefs}" not found for "${widget.id}"`));
            return;
        }

        import(`file://${entryPath}`)
            .then(module => {
                if (typeof module.default !== 'function')
                    throw new Error(`${widget.metadata.prefs} has no default export class`);

                // Scoped to this widget only, same WidgetSettings class
                // extension.js's WidgetLoader uses — the widget author's
                // prefs.js reads/writes it exactly like widget.js's
                // api.settings, just from this process instead.
                const settingsHandle = WidgetSettings.load(widget.id, storage);
                const prefsInstance = new module.default(settingsHandle);
                const prefsPage = prefsInstance.buildPrefsWidget();
                this._appendWidgetAppearanceGroup(prefsPage, widget);
                this._presentPrefsPage(window, widget, prefsPage);
            })
            .catch(e => {
                logError(e, `[widget-center] prefs: failed to open settings for "${widget.id}"`);
            });
    }
}
