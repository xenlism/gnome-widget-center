// products/extension/lib/prefsPageBuilders.js
//
// Split out of prefsWindowController.js (2026-08-01 lib/ cleanup pass) —
// the "build one Adw.PreferencesPage/category" methods (Overview, Store,
// Preferences shell, Import/Export, Backup/Restore, About, Appearance,
// Advanced, Desktop). Applied as a mixin onto PrefsWindowControllerBase
// (see prefsWindowController.js) rather than moved into a standalone
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
import {SHADOW_ANGLE_STEPS} from './widgetVisualKit.js';

export const PrefsPageBuildersMixin = Base => class extends Base {
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
                build: () => this._buildGeneralCategory(settings)},
            {id: 'appearance', title: this._tr('category.appearance', 'Appearance'), subtitle: 'Theme, colors and layout',
                icon: 'applications-graphics-symbolic',
                build: () => this._buildAppearanceCategory()},
            {id: 'desktop', title: this._tr('category.desktop', 'Desktop'), subtitle: 'Margins, spacing and position',
                icon: 'video-display-symbolic',
                build: () => this._buildDesktopCategory(settings)},
            {id: 'interactions', title: this._tr('category.interactions', 'Interactions'), subtitle: 'Dragging, animations and actions',
                icon: 'input-mouse-symbolic',
                build: () => this._buildInteractionsCategory(settings)},
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
        // Stashed on `this` (not just local vars) so a caller outside this
        // method — showBackupPage()'s "jump straight to Backup & Restore"
        // for the Widget Center overlay's new Backup button — can select
        // a specific row after the fact without rebuilding this whole
        // page. Keyed by category id (see showBackupPage()'s doc comment).
        this._categoryListBox = listBox;
        this._categoryRowsById = {};

        for (const category of categories) {
            const row = new Adw.ActionRow({title: category.title, subtitle: category.subtitle});
            row.add_prefix(new Gtk.Image({icon_name: category.icon}));
            row._category = category;
            listBox.append(row);
            this._categoryRowsById[category.id] = row;
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

        // Returned so PrefsWindowController.showPreferencesPage() can jump
        // straight to this page (skipping Overview) — see
        // lib/widgetCenterOverlay.js's Preferences tab / widget-center-
        // prefs-app.js's `--focus=preferences` flag.
        return page;
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
        backupRow.add_suffix(new Gtk.Image({icon_name: 'cloud-upload-symbolic'}));
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
        restoreRow.add_suffix(new Gtk.Image({icon_name: 'cloud-download-symbolic'}));
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
            dialog: new Gtk.ColorDialog({with_alpha: true}),
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
                    color: rgbaToHex(bgColorButton.rgba),
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

        const shadowAngleModel = new Gtk.StringList({strings: SHADOW_ANGLE_STEPS.map(deg => `${deg}\u00b0`)});
        const shadowAngleRow = new Adw.ComboRow({
            title: 'Shadow angle',
            subtitle: 'Direction the shadow is cast in.',
            model: shadowAngleModel,
        });
        const shadowAngleIndex = SHADOW_ANGLE_STEPS.indexOf(current.dropShadow.angle ?? 90);
        shadowAngleRow.selected = shadowAngleIndex >= 0 ? shadowAngleIndex : SHADOW_ANGLE_STEPS.indexOf(90);
        shadowGroup.add(shadowAngleRow);

        const shadowDistanceRow = new Adw.SpinRow({
            title: 'Distance',
            subtitle: 'px',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 64, step_increment: 1,
                value: current.dropShadow.distance ?? 4,
            }),
        });
        shadowGroup.add(shadowDistanceRow);

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

        const shadowForceRow = new Adw.SwitchRow({
            title: 'Force this drop shadow on every widget',
            subtitle: 'Overrides any drop shadow a widget sets for itself ' +
                'in its own Appearance settings.',
            active: !!current.dropShadow.force,
        });
        shadowGroup.add(shadowForceRow);

        const saveShadow = () => {
            theme.setGlobalTheme({
                dropShadow: {
                    enabled: shadowEnabledRow.active,
                    transparent: shadowTransparentRow.active,
                    color: rgbaToHex(shadowColorButton.rgba),
                    opacity: shadowOpacityRow.value,
                    angle: SHADOW_ANGLE_STEPS[shadowAngleRow.selected] ?? 90,
                    distance: shadowDistanceRow.value,
                    blurRadius: shadowBlurRow.value,
                    spread: shadowSpreadRow.value,
                    force: shadowForceRow.active,
                },
            });
        };
        for (const row of [shadowEnabledRow, shadowTransparentRow, shadowOpacityRow,
            shadowDistanceRow, shadowBlurRow, shadowSpreadRow, shadowForceRow]) {
            row.connect(row instanceof Adw.SwitchRow ? 'notify::active' : 'notify::value', saveShadow);
        }
        shadowAngleRow.connect('notify::selected', saveShadow);
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
    /**
     * @private "General" category — the `language` GSettings key
     * (2026-08-04). See WIDGET_API.md §5's api.hostLanguage and this
     * repo's i18n/index.js's pickLocale() for how widgets and this very
     * Preferences window's own chrome both honor it. Same live-sync
     * pattern as _buildAdvancedCategory()'s Development Mode switch.
     * @param {SettingsService} settings
     * @returns {Adw.PreferencesPage}
     */
    _buildGeneralCategory(settings) {
        const page = new Adw.PreferencesPage();

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
            selected: Math.max(0, codes.indexOf(settings.isReady ? (settings.getGlobalValue('language') || '') : '')),
            sensitive: settings.isReady,
        });
        row.connect('notify::selected', () => {
            if (!settings.isReady) {
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

        return page;
    }

    /**
     * @private "Interactions" category (2026-08-04) — drag/snap behavior:
     * the alignment-guide color, magnetic snapping's own on/off + pull
     * distance, the opt-in fixed-grid snap on top of it, and the overlay
     * keyboard shortcut. See lib/snapManager.js/lib/guideRenderer.js for
     * where these are actually consumed, and lib/editModeDragController.js
     * for the live SettingsService.onChanged() wiring that picks up a
     * change made here immediately, no restart.
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

        // --- Shortcut ---
        const shortcutGroup = new Adw.PreferencesGroup({
            title: 'Keyboard shortcut',
            description: 'Opens/closes the Widget Center Overlay (lib/widgetCenterOverlay.js). ' +
                'Also editable live from the overlay\'s own Preferences tab.',
        });
        page.add(shortcutGroup);

        const currentAccel = ready ? (settings.getGlobalValue('widget-center-overlay-keybinding')?.[0] ?? '') : '<Super>F12';
        const shortcutRow = new Adw.EntryRow({
            title: 'Shortcut',
            text: currentAccel,
            sensitive: ready,
        });
        shortcutRow.connect('notify::text', () => {
            if (!ready) return;
            const text = shortcutRow.text.trim();
            if (text.length === 0) {
                try {
                    settings.setGlobalValue('widget-center-overlay-keybinding', []);
                } catch (e) {
                    logError(e, 'could not clear widget-center-overlay-keybinding');
                }
                shortcutRow.remove_css_class('error');
                return;
            }
            const [ok] = Gtk.accelerator_parse(text);
            if (!ok) {
                shortcutRow.add_css_class('error');
                return;
            }
            shortcutRow.remove_css_class('error');
            try {
                settings.setGlobalValue('widget-center-overlay-keybinding', [text]);
            } catch (e) {
                logError(e, 'could not save widget-center-overlay-keybinding');
            }
        });
        shortcutGroup.add(shortcutRow);

        const shortcutHint = new Adw.ActionRow({
            title: 'GTK accelerator syntax, e.g. <Super>F12 , or leave empty to disable.',
        });
        shortcutHint.add_css_class('dim-label');
        shortcutGroup.add(shortcutHint);

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
