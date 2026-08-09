// products/extension/lib/prefsPageBuilders.js
//
// Split out of prefsWindowControllerBase.js (2026-08-01 lib/ cleanup pass) —
// the "build one Adw.PreferencesPage/category" methods (Overview, Store,
// Preferences shell, Import/Export, Backup/Restore, About, Appearance,
// Advanced, Desktop). Applied as a mixin onto PrefsWindowControllerBase
// (see prefsWindowControllerBase.js) rather than moved into a standalone
// class, so every `this.xxx` reference below keeps meaning exactly what
// it meant before the split — `this` is still the one
// PrefsWindowController instance, same prototype-chain method lookup as
// any other JS inheritance; only the file a method's source lives in
// changed, not its behavior or what it can access on `this`.
//
// Widget-row/prefs-opening logic (a different concern — "handle one
// specific widget" rather than "lay out one whole page") lives in the
// sibling prefsWidgetManagement.js mixin instead.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';

import {showReportDialog, promptPassword, confirmOverwrite, chooseFile} from './prefsDialogs.js';
import {ThemeService} from './themeService.js';
import {buildGwctDocument, writeGwctFile, readGwctFile, importGwctDocument} from './exportService.js';
import {createBackup, restoreBackup} from './backupService.js';
import {openThemePackExportDialog} from './themePackExportDialog.js';
import {rgbaToHex} from './colorUtils.js';
import {SUPPORTED_LOCALES} from '../i18n/index.js';
import {SHADOW_ANGLE_STEPS} from './forceSettingsHelper.js';

/**
 * @private Gdk.RGBA -> `#rrggbbaa` (alpha INCLUDED, unlike
 * colorUtils.js's `rgbaToHex()` which deliberately drops it - that one's
 * for theme.json's border/dropShadow/background colors, which encode
 * transparency via a separate boolean `transparent` field instead. The
 * Force Settings GSettings keys (force-background-color/
 * force-shadow-color) store an 8-digit hex with alpha baked in directly
 * (see their schema defaults, e.g. `'#1e1e2eff'`), so they need alpha
 * kept - this is a local variant just for those two fields, not a
 * replacement for the shared one.
 * @param {Gdk.RGBA} rgba
 * @returns {string}
 */
function rgbaToHex8(rgba) {
    const toHex = c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0');
    return `#${toHex(rgba.red)}${toHex(rgba.green)}${toHex(rgba.blue)}${toHex(rgba.alpha)}`;
}

/**
 * @private true if `keyval` is a bare modifier key (both L/R variants of
 * Ctrl/Shift/Alt/Super/Meta/Hyper, plus the lock keys and ISO level-shift
 * keys) with no "real" key attached yet. Used by the shortcut recorder
 * below (`_buildGeneralCategory()`) so a combo like `<Control><Shift>a`
 * can actually be recorded — pressing Ctrl then Shift then `a` must keep
 * waiting through the first two key-pressed events, only completing on
 * `a` (by which point `state` already reflects both modifiers being
 * held). GDK keyvals, plus a couple of extras (Meta/Hyper/lock/
 * ISO-level-shift) a plain Ctrl/Shift/Alt/Super filter wouldn't
 * otherwise need to worry about.
 * @param {number} keyval
 * @returns {boolean}
 */
function isModifierKeyval(keyval) {
    return [
        Gdk.KEY_Control_L, Gdk.KEY_Control_R,
        Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
        Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
        Gdk.KEY_Super_L, Gdk.KEY_Super_R,
        Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
        Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
        Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_ISO_Level5_Shift,
        Gdk.KEY_Caps_Lock, Gdk.KEY_Shift_Lock,
        Gdk.KEY_Num_Lock, Gdk.KEY_Scroll_Lock,
    ].includes(keyval);
}

export const PrefsPageBuildersMixin = Base => class extends Base {
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
     * @private "Preferences" tab — a single Adw.PreferencesPage whose one
     * PreferencesGroup holds the category accordion (`_buildCategoryAccordion()`)
     * — each category (General, Appearance, Desktop, …) is a collapsible
     * "card" the user opens/closes in place, built lazily on first
     * expand rather than all up front, since most are non-trivial
     * GSettings/ThemeService reads that don't need to run until looked
     * at.
     *
     * 2026-08-08: this used to also support a `Adw.NavigationSplitView`
     * sidebar+stack layout (v1's original design, `{layout: 'sidebar'}`
     * — a left-hand category list swapping right-hand content, see
     * repo/concept/preferences.png) selectable via an options flag.
     * Removed now that lib/prefsWindowController.js's accordion is the
     * only window this project actually builds (`prefs.js` and
     * `widget-center-prefs-app.js` both construct
     * `PrefsWindowControllerV2` exclusively — see HANDOVER_PREFS_V2.md's
     * "V2 wasn't actually wired up" addendum) — keeping a second,
     * unreachable layout path around was just dead weight. If a sidebar
     * layout is ever wanted again, it's in this file's git history.
     * @param {Adw.PreferencesWindow} window
     * @param {SettingsService} settings
     * @param {StorageService} storage
     * @param {Array} discoveredWidgets - `ok` from PrefsWidgetList.list(),
     *   needed by Backup & Restore / Import-Export below.
     * @param {{bundledWidgetsPath: string, userWidgetsPath: string}} widgetPaths
     * @param {{includeAbout?: boolean}} [options] - `includeAbout: false`
     *   drops the "About" row from the category list below without
     *   touching `_buildAboutCategory()` itself, which
     *   lib/prefsWindowController.js still reuses verbatim for its own
     *   standalone About tab (Overview/Themes/Preferences/About as
     *   SEPARATE top-level tabs, About not nested in here). Omitted
     *   default (About included) is unused by any current caller —
     *   V2 always passes `{includeAbout: false}` — kept only so a
     *   future caller isn't forced to remember to pass it.
     */
    _buildPreferencesPage(window, settings, storage, discoveredWidgets, widgetPaths, options = {}) {
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
                build: () => this._buildGeneralCategory(settings)},
            {id: 'appearance', title: this._tr('category.appearance', 'Appearance'), subtitle: 'Theme, colors and layout',
                icon: 'applications-graphics-symbolic',
                build: () => this._buildAppearanceCategory(settings)},
            {id: 'desktop', title: this._tr('category.desktop', 'Desktop'), subtitle: 'Margins, spacing and position',
                icon: 'video-display-symbolic',
                build: () => this._buildDesktopCategory(settings)},
            {id: 'interactions', title: this._tr('category.interactions', 'Interactions'), subtitle: 'Dragging, animations and actions',
                icon: 'input-mouse-symbolic',
                build: () => this._buildInteractionsCategory(settings)},
            {id: 'backup', title: this._tr('category.backup', 'Backup and Restore'), subtitle: 'Backup and restore widgets',
                icon: 'drive-multidisk-symbolic',
                build: () => this._buildBackupCategory(window, settings, storage, discoveredWidgets, widgetPaths)},
            {id: 'importexport', title: this._tr('category.importexport', 'Import / Export'), subtitle: 'Import or export widget data',
                icon: 'send-to-symbolic',
                build: () => this._buildImportExportCategory(window, storage, discoveredWidgets)},
            {id: 'advanced', title: this._tr('category.advanced', 'Advanced'), subtitle: 'Advanced developer options',
                icon: 'applications-engineering-symbolic',
                build: () => this._buildAdvancedCategory(settings)},
        ];

        // See this method's `options` doc comment above.
        if (options.includeAbout !== false) {
            categories.push({id: 'about', title: this._tr('category.about', 'About'), subtitle: 'About GNOME Widget Center',
                icon: 'help-about-symbolic',
                build: () => this._buildAboutCategory()});
        }

        group.add(this._buildCategoryAccordion(categories));

        // Returned so PrefsWindowController.showPreferencesPage() can jump
        // straight to this page (skipping Overview) — see
        // lib/widgetCenterOverlay.js's Preferences tab / widget-center-
        // prefs-app.js's `--focus=preferences` flag.
        return page;
    }

    /**
     * @private "Group settings" accordion — the `{layout: 'accordion'}`
     * alternative to the NavigationSplitView sidebar above. Wrapped in
     * an `Adw.Clamp` (maximum-size 800) so it lines up with the same
     * fixed 800px reading width lib/prefsWindowController.js's
     * Overview/Themes/About tabs use (`_buildClampedCardPage()`) — this
     * is the one place in this sidebar-oriented file that needs to know
     * about that number, since v1's sidebar (unaffected by this option)
     * has never needed a matching width elsewhere.
     *
     * Each category renders as one collapsible "card": a boxed-list
     * header row (icon + title + subtitle + chevron) toggling a
     * Gtk.Revealer around that category's own, completely unmodified
     * `build()` result — same lazy-build-on-first-open behavior the
     * sidebar's Gtk.Stack already had (a category's Adw.PreferencesPage
     * is only constructed the first time it's expanded, not up front),
     * just swapped for "reveal in place" instead of "switch the visible
     * stack child". The first category starts pre-expanded so the
     * accordion is never blank on first open (same reasoning the
     * sidebar's own `listBox.select_row(...)` line above has for
     * picking General first).
     *
     * KNOWN CAVEAT (same "written and node-check-clean, not yet
     * exercised against a real GNOME Shell prefs process" flag this
     * project's other 2026-08-08 checkpoints carry): nesting an
     * Adw.PreferencesPage — which wraps its own content in an internal
     * Gtk.ScrolledWindow — inside a Gtk.Revealer, itself inside this
     * page's own outer scrolling, could in principle produce a
     * scroll-within-scroll. `vexpand: false` is forced on each revealed
     * category page below to discourage that, but it's worth a visual
     * check on real hardware before calling this done.
     * @param {Array<{id: string, title: string, subtitle: string, icon: string, build: () => Adw.PreferencesPage}>} categories
     * @returns {Adw.Clamp}
     */
    _buildCategoryAccordion(categories) {
        const clamp = new Adw.Clamp({maximum_size: 800, tightening_threshold: 800});
        const list = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_top: 12, margin_bottom: 24, margin_start: 12, margin_end: 12,
        });
        clamp.set_child(list);

        // 2026-08-08: keyed by category.id (same ids the old sidebar's
        // `_categoryRowsById` used), so PrefsWindowControllerV2's own
        // showBackupPage() override can jump straight to a specific
        // category the same way v1's sidebar-based showBackupPage() did
        // with `_categoryListBox.select_row(...)` — see that override
        // in lib/prefsWindowController.js for why this exists (v1's
        // implementation reads `this._categoryListBox`/
        // `_categoryRowsById`, neither of which this accordion layout
        // builds, so without this map that deep-link silently no-ops).
        this._accordionCategoriesById = {};

        categories.forEach((category, index) => {
            const {widget, expand} = this._buildAccordionCategory(category);
            list.append(widget);
            this._accordionCategoriesById[category.id] = {widget, expand};
            if (index === 0)
                expand();
        });

        return clamp;
    }

    /**
     * @private One collapsible category "card" for `_buildCategoryAccordion()`.
     * @param {{title: string, subtitle: string, icon: string, build: () => Adw.PreferencesPage}} category
     * @returns {{widget: Gtk.Box, expand: () => void}}
     */
    _buildAccordionCategory(category) {
        const outer = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['card'],
            overflow: Gtk.Overflow.HIDDEN,
        });

        const headerList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });
        const headerRow = new Adw.ActionRow({
            title: category.title, subtitle: category.subtitle, activatable: true,
        });
        headerRow.add_prefix(new Gtk.Image({icon_name: category.icon}));
        const chevron = new Gtk.Image({icon_name: 'pan-end-symbolic'});
        headerRow.add_suffix(chevron);
        headerList.append(headerRow);
        outer.append(headerList);

        const revealer = new Gtk.Revealer({
            transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN,
            reveal_child: false,
        });
        outer.append(revealer);

        let built = false;
        const setExpanded = expanded => {
            revealer.reveal_child = expanded;
            chevron.icon_name = expanded ? 'pan-down-symbolic' : 'pan-end-symbolic';
            if (expanded && !built) {
                built = true;
                const content = category.build();
                content.vexpand = false;
                revealer.set_child(content);
            }
        };
        headerList.connect('row-activated', () => setExpanded(!revealer.reveal_child));

        return {widget: outer, expand: () => setExpanded(true)};
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
                'Appearance, host preferences, and settings for your currently-enabled ' +
                'widgets, with any passwords, API keys, usernames or emails left out. ' +
                'Disabled widgets and the widgets themselves are not included — ' +
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
            const path = await chooseFile(window, {
                action: 'save', title: this._tr('importexport.export.filechooser_title', 'Export theme'),
                initialName: 'gnome-widget-center.gwct', pattern: '*.gwct',
            });
            if (!path)
                return;
            try {
                const theme = new ThemeService();
                theme.init();
                const {document, redactedFields} = buildGwctDocument(discoveredWidgets, {storage, theme, settings: this._settings});
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
                showReportDialog(window, this._tr('importexport.result.export_heading', 'Theme exported'), lines.join('\n'));
            } catch (e) {
                logError(e, '[widget-center] prefs: theme export failed');
                showReportDialog(window, this._tr('importexport.result.export_failed_heading', 'Export failed'), e.message);
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
            const path = await chooseFile(window, {
                action: 'open', title: this._tr('importexport.import.filechooser_title', 'Import theme'), pattern: '*.gwct',
            });
            if (!path)
                return;

            const confirmed = await confirmOverwrite(window,
                this._tr('importexport.import.confirm_heading', 'Import this theme?'),
                this._tr('importexport.import.confirm_body',
                    'This applies appearance and widget settings from the chosen file, ' +
                    'overwriting any current values for the widgets it covers, and disables ' +
                    'every other widget so your desktop matches the theme exactly. This cannot be undone.'),
                this._tr('importexport.import.confirm_button', 'Import'));
            if (!confirmed)
                return;

            try {
                const document = readGwctFile(path);
                const theme = new ThemeService();
                theme.init();
                const discoveredWidgetsById = new Map(discoveredWidgets.map(w => [w.id, w]));
                const {appliedWidgetIds, missingWidgets, dependencyWarnings} =
                    importGwctDocument(document, {storage, theme, settings: this._settings, discoveredWidgetsById});

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
                showReportDialog(window, this._tr('importexport.result.import_heading', 'Theme imported'), lines.join('\n'));
            } catch (e) {
                logError(e, '[widget-center] prefs: theme import failed');
                showReportDialog(window, this._tr('importexport.result.import_failed_heading', 'Import failed'), e.message);
            }
        });
        group.add(importRow);

        // --- Theme packs (Widget Center overlay's "Themes" tab) -------
        // A DIFFERENT export from the two rows above: those two are a
        // plain desktop-appearance snapshot; this one bundles pack-
        // authoring metadata (name/description/author/url + an embedded
        // screenshot) into the SAME .gwct shape, meant to be dropped into
        // a themepacks/ folder and shown as a browsable "Theme" card
        // rather than silently re-applied. See
        // lib/themePackExportDialog.js's file header.
        const packGroup = new Adw.PreferencesGroup({
            title: this._tr('importexport.packgroup.title', 'Theme pack (.gwct, shareable)'),
            description: this._tr('importexport.packgroup.description',
                'Package the current appearance and enabled widgets as a named, described, ' +
                'screenshotted theme pack other people can drop into their own Widget Center.'),
        });
        page.add(packGroup);

        const exportPackRow = new Adw.ActionRow({
            title: this._tr('importexport.exportpack.title', 'Export Theme…'),
            subtitle: this._tr('importexport.exportpack.subtitle',
                'Name, description, author, URL and screenshot, saved to a file you choose.'),
            activatable: true,
        });
        exportPackRow.add_suffix(new Gtk.Image({icon_name: 'send-to-symbolic'}));
        exportPackRow.connect('activated', () => {
            const theme = new ThemeService();
            theme.init();
            openThemePackExportDialog(window, {storage, theme, settings: this._settings, discoveredWidgets});
        });
        packGroup.add(exportPackRow);

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
        backupRow.add_suffix(new Gtk.Image({icon_name: 'drive-multidisk-symbolic'}));
        backupRow.connect('activated', async () => {
            const password = await promptPassword(window, this._tr('backup.password_prompt.heading', 'Backup password'),
                this._tr('backup.password_prompt.create_body', 'Choose a password to protect this backup file. You\'ll need it to restore.'));
            if (!password)
                return;
            const path = await chooseFile(window, {
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
                showReportDialog(window, this._tr('backup.result.created_heading', 'Backup created'),
                    `${this._tr('importexport.result.saved_to', 'Saved to {path}').replace('{path}', finalPath)}\n` +
                    `${this._tr('backup.result.widgets_included', 'Widgets included: {count}').replace('{count}', userWidgets.length)}`);
            } catch (e) {
                logError(e, '[widget-center] prefs: backup failed');
                showReportDialog(window, this._tr('backup.result.create_failed_heading', 'Backup failed'), e.message);
            }
        });
        group.add(backupRow);

        const restoreRow = new Adw.ActionRow({title: this._tr('backup.restore.title', 'Restore backup…'), activatable: true});
        restoreRow.add_suffix(new Gtk.Image({icon_name: 'snapshots-alt-symbolic'}));
        restoreRow.connect('activated', async () => {
            const path = await chooseFile(window, {
                action: 'open', title: this._tr('backup.restore.filechooser_title', 'Restore backup'), pattern: '*.gwcbak',
            });
            if (!path)
                return;
            const password = await promptPassword(window, this._tr('backup.password_prompt.heading', 'Backup password'),
                this._tr('backup.password_prompt.restore_body', 'Enter this backup\'s password.'));
            if (!password)
                return;

            const confirmed = await confirmOverwrite(window,
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
                showReportDialog(window, this._tr('backup.result.restored_heading', 'Backup restored'), lines.join('\n'));
            } catch (e) {
                logError(e, '[widget-center] prefs: restore failed');
                showReportDialog(window, this._tr('backup.result.restore_failed_heading', 'Restore failed'), e.message);
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
     * @private Appearance page. Rewritten 2026-08-09 for the Force
     * Settings spec (see HANDOVER_FORCE_SETTINGS.md): Background Color /
     * Corner Radius / Background Blur / Shadow now write straight to the
     * extension's own GSettings (`this._settings`) via 4 INDEPENDENT
     * Force switches (`force-background-color-enabled` /
     * `force-corner-radius-enabled` / `force-background-blur-enabled` /
     * `force-shadow-appearance-enabled`) instead of the older
     * `theme.json`-based single-switch-per-property model. Each switch
     * can be on/off independently of the other 3 - e.g. Corner Radius
     * forced while Background Color/Blur/Shadow stay per-widget.
     * Shadow Distance/Angle have NO Force switch at all - they're always
     * read from GSettings regardless (per spec), so their rows here are
     * unconditional.
     *
     * Border and Opacity are NOT part of this spec and deliberately stay
     * on the OLDER theme.json mechanism (`ThemeService`/`current.border`/
     * `current.opacity`) — this pass just adds the Force switch rows for
     * them that were previously missing from the UI (backend `.force`
     * support already existed in themeService.js).
     *
     * No "Transparent" toggle here anymore for Background Color/Shadow -
     * the new GSettings color keys store alpha directly in an 8-digit
     * hex (`rgbaToHex8()` below), so transparency is just "pick a color
     * with lower alpha" rather than a separate boolean, unlike the older
     * theme.json model.
     *
     * GSettings rows write straight through via `settings.set_*()` on
     * change - no separate save step needed, same immediate-write feel
     * as the theme.json rows below (`ThemeService.save()` is likewise a
     * cheap atomic write done per keystroke/toggle).
     * @param {SettingsService} settings - same instance every sibling
     *   category builder in this file receives (`_buildGeneralCategory()`
     *   etc) - passed explicitly by `_buildPreferencesPage()` rather than
     *   read off `this._settings`, matching that existing convention.
     * @returns {Adw.PreferencesPage} content only — caller (now
     *   `_buildPreferencesPage()`'s "Appearance" category) decides where
     *   this ends up; it's no longer added to `window` directly.
     */
    _buildAppearanceCategory(settings) {
        const theme = new ThemeService();
        theme.init();
        const current = theme.getGlobalTheme();
        // Same "not ready yet" guard the rest of this file's GSettings-backed
        // rows already use (e.g. _buildGeneralCategory()'s language/keybinding
        // rows below) - falls back to the schema's own defaults so the page
        // still renders sane values if build() is called before `settings`
        // finished initializing.
        const ready = settings?.isReady;

        const page = new Adw.PreferencesPage();

        // --- Force: Background Color (independent switch) ---------------
        const bgColorGroup = new Adw.PreferencesGroup({
            title: 'Force: Background Color',
            description: 'Independent of the other 3 Force switches below. When off, ' +
                'each widget keeps its own background color from its Appearance settings.',
        });
        page.add(bgColorGroup);

        const bgColorRow = new Adw.ActionRow({title: 'Background color'});
        const bgRgba = new Gdk.RGBA();
        bgRgba.parse((ready && settings.getGlobalValue('force-background-color')) || '#1e1e2eff');
        const bgColorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: true}),
            rgba: bgRgba,
            valign: Gtk.Align.CENTER,
        });
        bgColorRow.add_suffix(bgColorButton);
        bgColorRow.set_activatable_widget(bgColorButton);
        bgColorGroup.add(bgColorRow);
        bgColorButton.connect('notify::rgba', () => {
            settings.setGlobalValue('force-background-color', rgbaToHex8(bgColorButton.rgba));
        });

        const bgColorForceRow = new Adw.SwitchRow({
            title: 'Force this background color on every widget',
            subtitle: 'Overrides any background color a widget sets for itself ' +
                'in its own Appearance settings.',
            active: ready ? !!settings.getGlobalValue('force-background-color-enabled') : false,
        });
        bgColorGroup.add(bgColorForceRow);
        bgColorForceRow.connect('notify::active', () => {
            settings.setGlobalValue('force-background-color-enabled', bgColorForceRow.active);
        });

        // --- Force: Corner Radius (independent switch) -------------------
        const radiusGroup = new Adw.PreferencesGroup({
            title: 'Force: Corner Radius',
            description: 'Independent of the other 3 Force switches above/below.',
        });
        page.add(radiusGroup);

        const radiusRow = new Adw.SpinRow({
            title: 'Corner radius',
            subtitle: '0\u201332 px',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 32, step_increment: 1,
                value: ready ? settings.getGlobalValue('force-corner-radius') : 12,
            }),
        });
        radiusGroup.add(radiusRow);
        radiusRow.connect('notify::value', () => {
            settings.setGlobalValue('force-corner-radius', Math.round(radiusRow.value));
        });

        const radiusForceRow = new Adw.SwitchRow({
            title: 'Force this corner radius on every widget',
            subtitle: 'Overrides any corner radius a widget sets for itself ' +
                'in its own Appearance settings.',
            active: ready ? !!settings.getGlobalValue('force-corner-radius-enabled') : false,
        });
        radiusGroup.add(radiusForceRow);
        radiusForceRow.connect('notify::active', () => {
            settings.setGlobalValue('force-corner-radius-enabled', radiusForceRow.active);
        });

        // --- Force: Background Blur (independent switch) -----------------
        const blurGroup = new Adw.PreferencesGroup({
            title: 'Force: Background Blur',
            description: 'Independent of the other 3 Force switches above/below.',
        });
        page.add(blurGroup);

        const blurRow = new Adw.SpinRow({
            title: 'Background blur',
            subtitle: '0\u201360 px',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 60, step_increment: 1,
                value: ready ? settings.getGlobalValue('force-background-blur') : 0,
            }),
        });
        blurGroup.add(blurRow);
        blurRow.connect('notify::value', () => {
            settings.setGlobalValue('force-background-blur', Math.round(blurRow.value));
        });

        const blurForceRow = new Adw.SwitchRow({
            title: 'Force this background blur on every widget',
            subtitle: 'Overrides any background blur a widget sets for itself ' +
                'in its own Appearance settings.',
            active: ready ? !!settings.getGlobalValue('force-background-blur-enabled') : false,
        });
        blurGroup.add(blurForceRow);
        blurForceRow.connect('notify::active', () => {
            settings.setGlobalValue('force-background-blur-enabled', blurForceRow.active);
        });

        // --- Force: Shadow (independent switch, 5 fields move together) --
        const shadowGroup = new Adw.PreferencesGroup({
            title: 'Force: Shadow',
            description: 'Independent of the other 3 Force switches above. All 5 fields below ' +
                'move together as one group when this switch is on - Shadow isn\'t split ' +
                'further. Distance/Angle live in the section below and are always global, ' +
                'unaffected by this switch.',
        });
        page.add(shadowGroup);

        const shadowEnabledRow = new Adw.SwitchRow({
            title: 'Enabled',
            active: ready ? !!settings.getGlobalValue('force-shadow-enabled') : true,
        });
        shadowGroup.add(shadowEnabledRow);
        shadowEnabledRow.connect('notify::active', () => {
            settings.setGlobalValue('force-shadow-enabled', shadowEnabledRow.active);
        });

        const shadowColorRow = new Adw.ActionRow({title: 'Shadow color'});
        const shadowRgba = new Gdk.RGBA();
        shadowRgba.parse((ready && settings.getGlobalValue('force-shadow-color')) || '#000000ff');
        const shadowColorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: true}),
            rgba: shadowRgba,
            valign: Gtk.Align.CENTER,
        });
        shadowColorRow.add_suffix(shadowColorButton);
        shadowColorRow.set_activatable_widget(shadowColorButton);
        shadowGroup.add(shadowColorRow);
        shadowColorButton.connect('notify::rgba', () => {
            settings.setGlobalValue('force-shadow-color', rgbaToHex8(shadowColorButton.rgba));
        });

        const shadowOpacityRow = new Adw.SpinRow({
            title: 'Opacity',
            subtitle: '0\u2013100 %',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 100, step_increment: 1,
                value: ready ? settings.getGlobalValue('force-shadow-opacity') : 45,
            }),
        });
        shadowGroup.add(shadowOpacityRow);
        shadowOpacityRow.connect('notify::value', () => {
            settings.setGlobalValue('force-shadow-opacity', Math.round(shadowOpacityRow.value));
        });

        const shadowSpreadRow = new Adw.SpinRow({
            title: 'Spread',
            subtitle: '0\u201320 px',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 20, step_increment: 1,
                value: ready ? settings.getGlobalValue('force-shadow-spread') : 0,
            }),
        });
        shadowGroup.add(shadowSpreadRow);
        shadowSpreadRow.connect('notify::value', () => {
            settings.setGlobalValue('force-shadow-spread', Math.round(shadowSpreadRow.value));
        });

        const shadowBlurRow = new Adw.SpinRow({
            title: 'Blur radius',
            subtitle: '0\u201360 px',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 60, step_increment: 1,
                value: ready ? settings.getGlobalValue('force-shadow-blur') : 12,
            }),
        });
        shadowGroup.add(shadowBlurRow);
        shadowBlurRow.connect('notify::value', () => {
            settings.setGlobalValue('force-shadow-blur', Math.round(shadowBlurRow.value));
        });

        const shadowForceRow = new Adw.SwitchRow({
            title: 'Force this drop shadow on every widget',
            subtitle: 'Overrides any drop shadow a widget sets for itself in its own ' +
                'Appearance settings. Distance/Angle below are excluded - always global.',
            active: ready ? !!settings.getGlobalValue('force-shadow-appearance-enabled') : false,
        });
        shadowGroup.add(shadowForceRow);
        shadowForceRow.connect('notify::active', () => {
            settings.setGlobalValue('force-shadow-appearance-enabled', shadowForceRow.active);
        });

        // --- Shadow Distance/Angle — always global, NO Force switch ------
        const shadowGlobalGroup = new Adw.PreferencesGroup({
            title: 'Shadow distance &amp; angle',
            description: 'Always applied to every widget\'s shadow - no Force switch needed, ' +
                'these two fields have no per-widget alternative to override.',
        });
        page.add(shadowGlobalGroup);

        const shadowDistanceRow = new Adw.SpinRow({
            title: 'Distance',
            subtitle: '0\u201330 px',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 30, step_increment: 1,
                value: ready ? settings.getGlobalValue('shadow-distance') : 4,
            }),
        });
        shadowGlobalGroup.add(shadowDistanceRow);
        shadowDistanceRow.connect('notify::value', () => {
            settings.setGlobalValue('shadow-distance', Math.round(shadowDistanceRow.value));
        });

        const shadowAngleModel = new Gtk.StringList({strings: SHADOW_ANGLE_STEPS.map(deg => `${deg}\u00b0`)});
        const shadowAngleRow = new Adw.ComboRow({
            title: 'Shadow angle',
            subtitle: 'Direction the shadow is cast in.',
            model: shadowAngleModel,
        });
        const shadowAngleIndex = SHADOW_ANGLE_STEPS.indexOf(ready ? settings.getGlobalValue('shadow-angle') : 90);
        shadowAngleRow.selected = shadowAngleIndex >= 0 ? shadowAngleIndex : SHADOW_ANGLE_STEPS.indexOf(90);
        shadowGlobalGroup.add(shadowAngleRow);
        shadowAngleRow.connect('notify::selected', () => {
            settings.setGlobalValue('shadow-angle', SHADOW_ANGLE_STEPS[shadowAngleRow.selected] ?? 90);
        });

        // --- Border (OLDER theme.json mechanism) --------------------------
        // Not part of the Force Settings spec - stays on ThemeService by
        // product decision. This pass adds the Force switch row that was
        // previously missing (backend `.force` support already existed).
        const borderGroup = new Adw.PreferencesGroup({
            title: 'Widget border',
            description: 'Applies to any widget that opts in via metadata.json\'s ' +
                '"themeable": true. Uses the older theme.json mechanism, not the 4 ' +
                'GSettings Force switches above.',
        });
        page.add(borderGroup);

        const borderEnabledRow = new Adw.SwitchRow({
            title: 'Enabled',
            active: !!current.border.enabled,
        });
        borderGroup.add(borderEnabledRow);

        const borderColorRow = new Adw.ActionRow({title: 'Border color'});
        const borderRgba = new Gdk.RGBA();
        borderRgba.parse(current.border.color ?? '#FFFFFF33');
        const borderColorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: true}),
            rgba: borderRgba,
            valign: Gtk.Align.CENTER,
        });
        borderColorRow.add_suffix(borderColorButton);
        borderColorRow.set_activatable_widget(borderColorButton);
        borderGroup.add(borderColorRow);

        const borderWidthRow = new Adw.SpinRow({
            title: 'Width',
            subtitle: 'px',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 16, step_increment: 1,
                value: current.border.width ?? 1,
            }),
        });
        borderGroup.add(borderWidthRow);

        const borderForceRow = new Adw.SwitchRow({
            title: 'Force this border on every widget',
            subtitle: 'Overrides any border a widget sets for itself in its own Appearance settings.',
            active: !!current.border.force,
        });
        borderGroup.add(borderForceRow);

        const saveBorder = () => {
            theme.setGlobalTheme({
                border: {
                    enabled: borderEnabledRow.active,
                    width: borderWidthRow.value,
                    color: rgbaToHex8(borderColorButton.rgba),
                    force: borderForceRow.active,
                },
            });
        };
        borderEnabledRow.connect('notify::active', saveBorder);
        borderColorButton.connect('notify::rgba', saveBorder);
        borderWidthRow.connect('notify::value', saveBorder);
        borderForceRow.connect('notify::active', saveBorder);

        // --- Opacity (OLDER theme.json mechanism) --------------------------
        // Same story as Border above - stays on ThemeService, this pass
        // just adds the previously-missing Force switch row.
        const opacityGroup = new Adw.PreferencesGroup({
            title: 'Widget opacity',
            description: 'Fades the entire widget, not just the background fill. Uses the ' +
                'older theme.json mechanism, not the 4 GSettings Force switches above.',
        });
        page.add(opacityGroup);

        const opacityRow = new Adw.SpinRow({
            title: 'Opacity',
            subtitle: '0\u2013100 %',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 100, step_increment: 1,
                value: current.opacity.value ?? 100,
            }),
        });
        opacityGroup.add(opacityRow);

        const opacityForceRow = new Adw.SwitchRow({
            title: 'Force this opacity on every widget',
            subtitle: 'Overrides any opacity a widget sets for itself in its own Appearance settings.',
            active: !!current.opacity.force,
        });
        opacityGroup.add(opacityForceRow);

        const saveOpacity = () => {
            theme.setGlobalTheme({
                opacity: {
                    value: opacityRow.value,
                    force: opacityForceRow.active,
                },
            });
        };
        opacityRow.connect('notify::value', saveOpacity);
        opacityForceRow.connect('notify::active', saveOpacity);

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
    /**
     * @private "General" category — the `language` GSettings key
     * (2026-08-04). See WIDGET_API.md §5's api.hostLanguage and this
     * repo's i18n/index.js's pickLocale() for how widgets and this very
     * Preferences window's own chrome both honor it. Same live-sync
     * pattern as _buildAdvancedCategory()'s Development Mode switch.
     * @param {SettingsService} settings
     * @returns {Adw.PreferencesPage}
     */
    /**
     * @private "General" category — language override (2026-08-04),
     * plus (2026-08-08) "load widget on install" and the overlay
     * keyboard shortcut, both MOVED here from Interactions per this
     * session's request ("shortcut ย้ายมาอยู่ general" /
     * "General เพิ่ม settings load widget on install") — General is a
     * better home for both than Interactions, which is really about
     * drag/snap behavior specifically. `_buildInteractionsCategory()`
     * below no longer has its own "Shortcut" group; nothing about the
     * `widget-center-overlay-keybinding` GSettings key itself changed,
     * only which category's page the row lives on.
     * @param {SettingsService} settings
     * @returns {Adw.PreferencesPage}
     */
    _buildGeneralCategory(settings) {
        const page = new Adw.PreferencesPage();
        const ready = settings.isReady;

        const group = new Adw.PreferencesGroup({
            title: 'Language',
            description: 'Overrides the system locale for this extension\'s own UI text and ' +
                'any widget that ships translations - only where a widget actually has that ' +
                'language available, otherwise it falls back to the system locale as before.',
        });
        page.add(group);

        // index 0 is always "System default" ('' - no override)
        const localeNames = {
            en: 'English', zh: '中文', es: 'Español', th: 'ไทย', de: 'Deutsch', ja: '日本語',
        };
        const codes = ['', ...SUPPORTED_LOCALES];
        const labels = ['System default', ...SUPPORTED_LOCALES.map(c => localeNames[c] ?? c)];

        const row = new Adw.ComboRow({
            title: 'UI language',
            subtitle: 'Applies immediately, no restart needed.',
            model: Gtk.StringList.new(labels),
            selected: Math.max(0, codes.indexOf(ready ? (settings.getGlobalValue('language') || '') : '')),
            sensitive: ready,
        });
        row.connect('notify::selected', () => {
            if (!ready) {
                logError(new Error('SettingsService not ready — could not save language'));
                return;
            }
            try {
                settings.setGlobalValue('language', codes[row.selected] ?? '');
            } catch (e) {
                logError(e, 'could not save language');
            }
        });
        group.add(row);

        // --- Widgets: "load widget on install" (2026-08-08) -----------
        const widgetsGroup = new Adw.PreferencesGroup({
            title: 'Widgets',
            description: 'What happens the first time a widget is found — installed manually, ' +
                'dropped in by a theme pack, or newly bundled by an update.',
        });
        page.add(widgetsGroup);

        const autoEnableRow = new Adw.SwitchRow({
            title: 'Load new widgets automatically',
            subtitle: 'On: a widget is enabled the first time it\'s found (previous behavior). ' +
                'Off: it appears in Overview but stays off the desktop until you turn it on.',
            active: ready ? !!settings.getGlobalValue('auto-enable-new-widgets') : true,
            sensitive: ready,
        });
        autoEnableRow.connect('notify::active', () => {
            if (!ready) {
                logError(new Error('SettingsService not ready — could not toggle auto-enable-new-widgets'));
                return;
            }
            try {
                settings.setGlobalValue('auto-enable-new-widgets', autoEnableRow.active);
            } catch (e) {
                logError(e, 'could not toggle auto-enable-new-widgets');
            }
        });
        widgetsGroup.add(autoEnableRow);

        // --- Keyboard shortcut (moved here from Interactions, 2026-08-08) ---
        const shortcutGroup = new Adw.PreferencesGroup({
            title: 'Keyboard shortcut',
            description: 'Opens/closes the Widget Center Overlay (lib/widgetCenterOverlay.js). ' +
                'Also editable live from the overlay\'s own Preferences tab.',
        });
        page.add(shortcutGroup);

        const currentAccel = ready ? (settings.getGlobalValue('widget-center-overlay-keybinding')?.[0] ?? '') : '<Super>F12';
        const shortcutRow = new Adw.ActionRow({
            title: 'Shortcut',
            subtitle: 'Click Record shortcut, then press the key combination.',
            sensitive: ready,
        });
        const recordButton = new Gtk.Button({
            label: currentAccel || 'Disabled',
            valign: Gtk.Align.CENTER,
            sensitive: ready,
        });
        let recording = false;
        recordButton.connect('clicked', () => {
            recording = true;
            recordButton.label = 'Press shortcut…';
            recordButton.grab_focus();
        });
        const keyController = new Gtk.EventControllerKey();
        keyController.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            if (!recording)
                return false;
            if (keyval === Gdk.KEY_Escape) {
                recording = false;
                recordButton.label = currentAccel || 'Disabled';
                return true;
            }
            // 2026-08-08 bug fix: a bare modifier key (Ctrl, Shift, Alt,
            // Super…) pressed on its own must NOT end recording — only
            // wait, so the user can go on to press the actual key while
            // still holding it, forming a real "2 keys at once" combo
            // (e.g. <Control><Shift>a). Gtk.accelerator_name() alone
            // doesn't do this filtering — it happily stringifies a bare
            // modifier keyval too (e.g. "Control_L" is accepted as a
            // non-empty, "valid-looking" name), which is why this used
            // to stop recording after just the FIRST key of any combo,
            // making a real two-key shortcut impossible to record.
            if (isModifierKeyval(keyval))
                return true;
            // Strip Lock/NumLock/etc noise from `state` the same way
            // Gtk.accelerator_valid() expects, so e.g. Caps Lock being on
            // doesn't silently corrupt the recorded combo.
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (!Gtk.accelerator_valid(keyval, mask))
                return true;
            const accel = Gtk.accelerator_name(keyval, mask);
            recording = false;
            recordButton.label = accel;
            try {
                settings.setGlobalValue('widget-center-overlay-keybinding', [accel]);
            } catch (e) {
                logError(e, 'could not save widget-center-overlay-keybinding');
            }
            return true;
        });
        recordButton.add_controller(keyController);
        shortcutRow.add_suffix(recordButton);
        shortcutRow.activatable_widget = recordButton;
        shortcutGroup.add(shortcutRow);

        return page;
    }

    /**
     * @private "Interactions" category (2026-08-04) — drag/snap behavior:
     * the alignment-guide color, magnetic snapping's own on/off + pull
     * distance, and the opt-in fixed-grid snap on top of it. See
     * lib/snapManager.js/lib/guideRenderer.js for where these are
     * actually consumed, and lib/editModeDragController.js for the live
     * SettingsService.onChanged() wiring that picks up a change made
     * here immediately, no restart. (2026-08-08: the overlay keyboard
     * shortcut previously lived here too — moved to General, see
     * `_buildGeneralCategory()`'s doc comment for why.)
     * @param {SettingsService} settings
     * @returns {Adw.PreferencesPage}
     */
    _buildInteractionsCategory(settings) {
        const page = new Adw.PreferencesPage();
        const ready = settings.isReady;

        // --- Magnetic snapping ---
        const snapGroup = new Adw.PreferencesGroup({
            title: 'Magnetic snapping',
            description: 'Pulls a dragged widget toward screen edges and other widgets\' edges.',
        });
        page.add(snapGroup);

        const snapEnabledRow = new Adw.SwitchRow({
            title: 'Enable snapping',
            active: ready ? !!settings.getGlobalValue('snap-enabled') : true,
            sensitive: ready,
        });
        snapEnabledRow.connect('notify::active', () => {
            if (!ready) return;
            try {
                settings.setGlobalValue('snap-enabled', snapEnabledRow.active);
            } catch (e) {
                logError(e, 'could not save snap-enabled');
            }
        });
        snapGroup.add(snapEnabledRow);

        const snapDistanceRow = new Adw.SpinRow({
            title: 'Snap distance',
            subtitle: 'How close (px) an edge must get before it\'s pulled the rest of the way.',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 128, step_increment: 1,
                value: ready ? settings.getGlobalValue('snap-distance') : 16,
            }),
            sensitive: ready,
        });
        snapDistanceRow.connect('notify::value', () => {
            if (!ready) return;
            try {
                settings.setGlobalValue('snap-distance', Math.round(snapDistanceRow.value));
            } catch (e) {
                logError(e, 'could not save snap-distance');
            }
        });
        snapGroup.add(snapDistanceRow);

        const guideColorRow = new Adw.ActionRow({title: 'Guide line color'});
        const guideColorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: true}),
            valign: Gtk.Align.CENTER,
            sensitive: ready,
        });
        const initialGuideColor = new Gdk.RGBA();
        initialGuideColor.parse(ready ? (settings.getGlobalValue('guide-color') || '#F5A623E6') : '#F5A623E6');
        guideColorButton.set_rgba(initialGuideColor);
        guideColorButton.connect('notify::rgba', () => {
            if (!ready) return;
            try {
                settings.setGlobalValue('guide-color', rgbaToHex(guideColorButton.rgba));
            } catch (e) {
                logError(e, 'could not save guide-color');
            }
        });
        guideColorRow.add_suffix(guideColorButton);
        guideColorRow.activatable_widget = guideColorButton;
        snapGroup.add(guideColorRow);

        // --- Fixed grid snap (opt-in, 2026-08-04 - separate from and
        // layered on top of the magnetic snapping above, NOT the pre-
        // 2026-07-28 default grid, which was removed for everyone) ---
        const gridGroup = new Adw.PreferencesGroup({
            title: 'Fixed grid snap',
            description: 'Off by default. Rounds a dragged widget\'s position to the nearest ' +
                'grid cell, applied after magnetic snapping above.',
        });
        page.add(gridGroup);

        const gridEnabledRow = new Adw.SwitchRow({
            title: 'Snap to grid',
            active: ready ? !!settings.getGlobalValue('grid-snap-enabled') : false,
            sensitive: ready,
        });
        gridEnabledRow.connect('notify::active', () => {
            if (!ready) return;
            try {
                settings.setGlobalValue('grid-snap-enabled', gridEnabledRow.active);
            } catch (e) {
                logError(e, 'could not save grid-snap-enabled');
            }
        });
        gridGroup.add(gridEnabledRow);

        const gridSizeRow = new Adw.SpinRow({
            title: 'Grid size',
            subtitle: 'Cell size in pixels. Only applies while Snap to grid above is on.',
            adjustment: new Gtk.Adjustment({
                lower: 4, upper: 128, step_increment: 1,
                value: ready ? settings.getGlobalValue('grid-size') : 16,
            }),
            sensitive: ready,
        });
        gridSizeRow.connect('notify::value', () => {
            if (!ready) return;
            try {
                settings.setGlobalValue('grid-size', Math.round(gridSizeRow.value));
            } catch (e) {
                logError(e, 'could not save grid-size');
            }
        });
        gridGroup.add(gridSizeRow);

        return page;
    }

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
};
