import Adw from "gi://Adw";

import Gtk from "gi://Gtk";

import Gdk from "gi://Gdk";

import GLib from "gi://GLib";

import { showReportDialog, promptPassword, confirmOverwrite, chooseFile } from "./prefsDialogs.js";

import { saveCurrentSettingsAsWidgetDefaults } from "./devConfigDefaults.js";

import { ThemeService } from "./themeService.js";

import { buildGwctDocumentAsync, writeGwctFile, readGwctFile, importGwctDocument, installGwctAsThemePack } from "./exportService.js";

import { createBackup, restoreBackup } from "./backupService.js";

import { openThemePackExportDialog } from "./themePackExportDialog.js";

import { rgbaToHex } from "./colorUtils.js";

import { SUPPORTED_LOCALES } from "../i18n/index.js";

import { SHADOW_ANGLE_STEPS } from "./globalShadowHelper.js";

function rgbaToHex8(rgba) {
    const toHex = c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0");
    return `#${toHex(rgba.red)}${toHex(rgba.green)}${toHex(rgba.blue)}${toHex(rgba.alpha)}`;
}

function isModifierKeyval(keyval) {
    return [ Gdk.KEY_Control_L, Gdk.KEY_Control_R, Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Super_L, Gdk.KEY_Super_R, Gdk.KEY_Meta_L, Gdk.KEY_Meta_R, Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R, Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_ISO_Level5_Shift, Gdk.KEY_Caps_Lock, Gdk.KEY_Shift_Lock, Gdk.KEY_Num_Lock, Gdk.KEY_Scroll_Lock ].includes(keyval);
}

export const PrefsPageBuildersMixin = Base => class extends Base {
    _buildStorePage(window) {
        const page = new Adw.PreferencesPage({
            title: this._tr("tab.store.label", "Store"),
            icon_name: "system-search-symbolic"
        });
        window.add(page);
        const group = new Adw.PreferencesGroup;
        page.add(group);
        group.add(new Adw.StatusPage({
            icon_name: "folder-download-symbolic",
            title: this._tr("store.title", "Coming soon"),
            description: "A widget store is planned but not built yet — for now, install " + "third-party widgets manually into\n~/.local/share/gnome-widget-center/widgets/.",
            vexpand: true
        }));
    }
    _buildPreferencesPage(window, settings, storage, discoveredWidgets, widgetPaths, options = {}) {
        const page = new Adw.PreferencesPage({
            title: this._tr("tab.preferences.label", "Preferences"),
            icon_name: "preferences-system-symbolic"
        });
        window.add(page);
        const group = new Adw.PreferencesGroup;
        page.add(group);
        const categories = [ {
            id: "general",
            title: this._tr("category.general", "General"),
            subtitle: "General settings and behavior",
            icon: "preferences-system-symbolic",
            build: () => this._buildGeneralCategory(settings)
        }, {
            id: "appearance",
            title: this._tr("category.appearance", "Appearance"),
            subtitle: "Theme, colors and layout",
            icon: "applications-graphics-symbolic",
            build: () => this._buildAppearanceCategory(settings)
        }, {
            id: "desktop",
            title: this._tr("category.desktop", "Desktop"),
            subtitle: "Margins, spacing and position",
            icon: "video-display-symbolic",
            build: () => this._buildDesktopCategory(settings)
        }, {
            id: "interactions",
            title: this._tr("category.interactions", "Interactions"),
            subtitle: "Dragging, animations and actions",
            icon: "input-mouse-symbolic",
            build: () => this._buildInteractionsCategory(settings)
        }, {
            id: "backup",
            title: this._tr("category.backup", "Backup and Restore"),
            subtitle: "Backup and restore widgets",
            icon: "drive-multidisk-symbolic",
            build: () => this._buildBackupCategory(window, settings, storage, discoveredWidgets, widgetPaths)
        }, {
            id: "importexport",
            title: this._tr("category.importexport", "Import / Export"),
            subtitle: "Import or export widget data",
            icon: "send-to-symbolic",
            build: () => this._buildImportExportCategory(window, storage, discoveredWidgets)
        }, {
            id: "advanced",
            title: this._tr("category.advanced", "Advanced"),
            subtitle: "Advanced developer options",
            icon: "applications-engineering-symbolic",
            build: () => this._buildAdvancedCategory(window, settings, storage, discoveredWidgets)
        } ];
        if (options.includeAbout !== false) {
            categories.push({
                id: "about",
                title: this._tr("category.about", "About"),
                subtitle: "About GNOME Widget Center",
                icon: "help-about-symbolic",
                build: () => this._buildAboutCategory()
            });
        }
        group.add(this._buildCategoryAccordion(categories));
        return page;
    }
    _buildCategoryAccordion(categories) {
        const clamp = new Adw.Clamp({
            maximum_size: 800,
            tightening_threshold: 800
        });
        const list = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 24,
            margin_start: 12,
            margin_end: 12
        });
        clamp.set_child(list);
        this._accordionCategoriesById = {};
        categories.forEach((category, index) => {
            const {widget: widget, expand: expand} = this._buildAccordionCategory(category);
            list.append(widget);
            this._accordionCategoriesById[category.id] = {
                widget: widget,
                expand: expand
            };
            if (index === 0) expand();
        });
        return clamp;
    }
    _buildAccordionCategory(category) {
        const outer = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: [ "card" ],
            overflow: Gtk.Overflow.HIDDEN
        });
        const headerList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: [ "boxed-list" ]
        });
        const headerRow = new Adw.ActionRow({
            title: category.title,
            subtitle: category.subtitle,
            activatable: true
        });
        headerRow.add_prefix(new Gtk.Image({
            icon_name: category.icon
        }));
        const chevron = new Gtk.Image({
            icon_name: "pan-end-symbolic"
        });
        headerRow.add_suffix(chevron);
        headerList.append(headerRow);
        outer.append(headerList);
        const revealer = new Gtk.Revealer({
            transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN,
            reveal_child: false
        });
        outer.append(revealer);
        let built = false;
        const setExpanded = expanded => {
            revealer.reveal_child = expanded;
            chevron.icon_name = expanded ? "pan-down-symbolic" : "pan-end-symbolic";
            if (expanded && !built) {
                built = true;
                const content = category.build();
                content.vexpand = false;
                revealer.set_child(content);
            }
        };
        headerList.connect("row-activated", () => setExpanded(!revealer.reveal_child));
        return {
            widget: outer,
            expand: () => setExpanded(true)
        };
    }
    _buildComingSoonCategory(title, description) {
        return new Adw.StatusPage({
            icon_name: "view-more-symbolic",
            title: title,
            description: description,
            vexpand: true
        });
    }
    _buildImportExportCategory(window, storage, discoveredWidgets) {
        const page = new Adw.PreferencesPage;
        const group = new Adw.PreferencesGroup({
            title: this._tr("importexport.group.title", "Theme file (.gwct)"),
            description: this._tr("importexport.group.description", "Appearance, host preferences, and settings for your currently-enabled " + "widgets, with any passwords, API keys, usernames or emails left out. " + "Disabled widgets and the widgets themselves are not included — " + "importing on a machine missing one of these widgets will skip it.")
        });
        page.add(group);
        const exportRow = new Adw.ActionRow({
            title: this._tr("importexport.export.title", "Export theme…"),
            subtitle: this._tr("importexport.export.subtitle", "Save the current appearance and widget settings to a .gwct file."),
            activatable: true
        });
        const exportProgress = new Gtk.ProgressBar({
            visible: false,
            show_text: true,
            hexpand: true,
            valign: Gtk.Align.CENTER
        });
        exportRow.add_suffix(exportProgress);
        exportRow.add_suffix(new Gtk.Image({
            icon_name: "document-save-symbolic"
        }));
        exportRow.connect("activated", async () => {
            const path = await chooseFile(window, {
                action: "save",
                title: this._tr("importexport.export.filechooser_title", "Export theme"),
                initialName: "gnome-widget-center.gwct",
                pattern: "*.gwct"
            });
            if (!path) return;
            exportRow.sensitive = false;
            exportProgress.fraction = 0;
            exportProgress.text = this._tr("importexport.export.progress_start", "Collecting widget settings…");
            exportProgress.visible = true;
            await new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            }));
            try {
                const theme = new ThemeService;
                theme.init();
                const {document: document, redactedFields: redactedFields} = await buildGwctDocumentAsync(discoveredWidgets, {
                    storage: storage,
                    theme: theme,
                    settings: this._settings
                }, (done, total) => {
                    exportProgress.fraction = total > 0 ? done / total : 1;
                    exportProgress.text = this._tr("importexport.export.progress_counted", "Collecting widget settings… ({done}/{total})").replace("{done}", done).replace("{total}", total);
                });
                exportProgress.fraction = 1;
                exportProgress.text = this._tr("importexport.export.progress_writing", "Writing file…");
                const finalPath = writeGwctFile(path, document);
                const lines = [ this._tr("importexport.result.saved_to", "Saved to {path}").replace("{path}", finalPath), this._tr("importexport.result.widgets_exported", "Widgets exported: {count}").replace("{count}", document.widgets.length) ];
                if (redactedFields.length > 0) {
                    lines.push("", this._tr("importexport.result.left_out", "Left out (secrets are never exported):"));
                    for (const r of redactedFields) lines.push(`  ${r.widgetId}: ${r.keys.join(", ")}`);
                }
                showReportDialog(window, this._tr("importexport.result.export_heading", "Theme exported"), lines.join("\n"));
            } catch (e) {
                logError(e, "[widget-center] prefs: theme export failed");
                showReportDialog(window, this._tr("importexport.result.export_failed_heading", "Export failed"), e.message);
            } finally {
                exportRow.sensitive = true;
                exportProgress.visible = false;
            }
        });
        group.add(exportRow);
        const importRow = new Adw.ActionRow({
            title: this._tr("importexport.import.title", "Import theme…"),
            subtitle: this._tr("importexport.import.subtitle", "Apply appearance and widget settings from a .gwct file."),
            activatable: true
        });
        importRow.add_suffix(new Gtk.Image({
            icon_name: "document-open-symbolic"
        }));
        importRow.connect("activated", async () => {
            const path = await chooseFile(window, {
                action: "open",
                title: this._tr("importexport.import.filechooser_title", "Import theme"),
                pattern: "*.gwct"
            });
            if (!path) return;
            const confirmed = await confirmOverwrite(window, this._tr("importexport.import.confirm_heading", "Import this theme?"), this._tr("importexport.import.confirm_body", "This applies appearance and widget settings from the chosen file, " + "overwriting any current values for the widgets it covers, and disables " + "every other widget so your desktop matches the theme exactly. This cannot be undone."), this._tr("importexport.import.confirm_button", "Import"));
            if (!confirmed) return;
            try {
                const document = await readGwctFile(path);
                const theme = new ThemeService;
                theme.init();
                const discoveredWidgetsById = new Map(discoveredWidgets.map(w => [ w.id, w ]));
                const {appliedWidgetIds: appliedWidgetIds, missingWidgets: missingWidgets, dependencyWarnings: dependencyWarnings} = importGwctDocument(document, {
                    storage: storage,
                    theme: theme,
                    settings: this._settings,
                    discoveredWidgetsById: discoveredWidgetsById
                });
                const lines = [ this._tr("importexport.result.applied_to", "Applied to {count} widget(s).").replace("{count}", appliedWidgetIds.length) ];
                if (missingWidgets.length > 0) {
                    lines.push("", this._tr("importexport.result.not_installed", "Not installed here — skipped:"));
                    for (const w of missingWidgets) lines.push(`  ${w.name} (${w.id})`);
                }
                if (dependencyWarnings.length > 0) {
                    lines.push("", this._tr("shared.result.missing_dependencies", "Missing system dependencies:"));
                    for (const d of dependencyWarnings) {
                        lines.push(`  ${d.widgetId}: ${d.bin}${d.reason ? ` — ${d.reason}` : ""}`);
                        if (d.suggestedCommand) lines.push(`    ${this._tr("shared.result.install_with", "install with:")} ${d.suggestedCommand}`);
                    }
                }
                showReportDialog(window, this._tr("importexport.result.import_heading", "Theme imported"), lines.join("\n"));
            } catch (e) {
                logError(e, "[widget-center] prefs: theme import failed");
                showReportDialog(window, this._tr("importexport.result.import_failed_heading", "Import failed"), e.message);
            }
        });
        group.add(importRow);
        const packGroup = new Adw.PreferencesGroup({
            title: this._tr("importexport.packgroup.title", "Theme pack (.gwct, shareable)"),
            description: this._tr("importexport.packgroup.description", "Package the current appearance and enabled widgets as a named, described, " + "screenshotted theme pack other people can drop into their own Widget Center.")
        });
        page.add(packGroup);
        const exportPackRow = new Adw.ActionRow({
            title: this._tr("importexport.exportpack.title", "Export Theme…"),
            subtitle: this._tr("importexport.exportpack.subtitle", "Name, description, author, URL and screenshot, saved to a file you choose."),
            activatable: true
        });
        exportPackRow.add_suffix(new Gtk.Image({
            icon_name: "send-to-symbolic"
        }));
        exportPackRow.connect("activated", () => {
            const theme = new ThemeService;
            theme.init();
            openThemePackExportDialog(window, {
                storage: storage,
                theme: theme,
                settings: this._settings,
                discoveredWidgets: discoveredWidgets
            });
        });
        packGroup.add(exportPackRow);
        const importPackRow = new Adw.ActionRow({
            title: this._tr("importexport.importpack.title", "Import Theme Pack…"),
            subtitle: this._tr("importexport.importpack.subtitle", "Install a .gwct theme pack (with its name, description and screenshot) " + "so it shows up as a card in the Themes tab, ready to switch on."),
            activatable: true
        });
        importPackRow.add_suffix(new Gtk.Image({
            icon_name: "list-add-symbolic"
        }));
        importPackRow.connect("activated", async () => {
            const path = await chooseFile(window, {
                action: "open",
                title: this._tr("importexport.importpack.filechooser_title", "Import theme pack"),
                pattern: "*.gwct"
            });
            if (!path) return;
            try {
                const document = await readGwctFile(path);
                const meta = document.packMeta;
                const heading = this._tr("importexport.importpack.confirm_heading", "Install this theme pack?");
                const body = meta ? [ meta.name, meta.description, meta.author ? `by ${meta.author}` : null, `${(document.widgets ?? []).length} widget(s)` ].filter(Boolean).join("\n") : this._tr("importexport.importpack.confirm_body_nometa", `"${GLib.path_get_basename(path)}" doesn't carry a name/description (it wasn't ` + "made with Export Theme…), but it can still be installed — it'll show up " + "under its file name.");
                const confirmed = await confirmOverwrite(window, heading, body, this._tr("importexport.importpack.confirm_button", "Install"));
                if (!confirmed) return;
                const userThemepacksDir = GLib.build_filenamev([ GLib.get_user_config_dir(), "gnome-widget-center", "themepacks" ]);
                const installedPath = installGwctAsThemePack(document, userThemepacksDir);
                showReportDialog(window, this._tr("importexport.importpack.result_heading", "Theme pack installed"), this._tr("importexport.importpack.result_body", "Installed to {path}.\nOpen the Themes tab to switch it on.").replace("{path}", installedPath));
            } catch (e) {
                logError(e, "[widget-center] prefs: theme pack import failed");
                showReportDialog(window, this._tr("importexport.importpack.failed_heading", "Import failed"), e.message);
            }
        });
        packGroup.add(importPackRow);
        const shareShortcutRow = new Adw.ActionRow({
            title: this._tr("importexport.sharekeybind.title", "Desktop share shortcut"),
            subtitle: this._tr("importexport.sharekeybind.subtitle", "Press this any time — including while Export Theme… is open or closed — " + "to capture the desktop and attach it as the pack's screenshot."),
            sensitive: this._settings.isReady
        });
        const currentShareAccel = this._settings.isReady ? this._settings.getGlobalValue("theme-screenshot-keybinding")?.[0] ?? "" : "<Super>Delete";
        const shareRecordButton = new Gtk.Button({
            label: currentShareAccel || "Disabled",
            valign: Gtk.Align.CENTER,
            sensitive: this._settings.isReady
        });
        let recordingShare = false;
        shareRecordButton.connect("clicked", () => {
            recordingShare = true;
            shareRecordButton.label = "Press shortcut…";
            shareRecordButton.grab_focus();
        });
        const shareKeyController = new Gtk.EventControllerKey;
        shareKeyController.connect("key-pressed", (_controller, keyval, _keycode, state) => {
            if (!recordingShare) return false;
            if (keyval === Gdk.KEY_Escape) {
                recordingShare = false;
                shareRecordButton.label = currentShareAccel || "Disabled";
                return true;
            }
            if (isModifierKeyval(keyval)) return true;
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (!Gtk.accelerator_valid(keyval, mask)) return true;
            const accel = Gtk.accelerator_name(keyval, mask);
            recordingShare = false;
            shareRecordButton.label = accel;
            try {
                this._settings.setGlobalValue("theme-screenshot-keybinding", [ accel ]);
            } catch (e) {
                logError(e, "could not save theme-screenshot-keybinding");
            }
            return true;
        });
        shareRecordButton.add_controller(shareKeyController);
        shareShortcutRow.add_suffix(shareRecordButton);
        shareShortcutRow.activatable_widget = shareRecordButton;
        packGroup.add(shareShortcutRow);
        return page;
    }
    _buildBackupCategory(window, settings, storage, discoveredWidgets, widgetPaths) {
        const page = new Adw.PreferencesPage;
        const group = new Adw.PreferencesGroup({
            title: this._tr("backup.group.title", "Full backup (.gwcbak)"),
            description: this._tr("backup.group.description", "Everything — appearance, every widget's settings (including passwords/API " + "keys), host preferences, and the widget files themselves for anything you've " + "installed yourself. Password-protected (AES-256, PBKDF2-derived key) — see the " + "file itself for what that does and doesn't protect against.")
        });
        page.add(group);
        const backupRow = new Adw.ActionRow({
            title: this._tr("backup.create.title", "Create backup…"),
            activatable: true
        });
        backupRow.add_suffix(new Gtk.Image({
            icon_name: "drive-multidisk-symbolic"
        }));
        backupRow.connect("activated", async () => {
            const password = await promptPassword(window, this._tr("backup.password_prompt.heading", "Backup password"), this._tr("backup.password_prompt.create_body", "Choose a password to protect this backup file. You'll need it to restore."));
            if (!password) return;
            const path = await chooseFile(window, {
                action: "save",
                title: this._tr("backup.create.filechooser_title", "Create backup"),
                initialName: "gnome-widget-center.gwcbak",
                pattern: "*.gwcbak"
            });
            if (!path) return;
            try {
                const theme = new ThemeService;
                theme.init();
                const userWidgets = discoveredWidgets.filter(w => w.path.startsWith(widgetPaths.userWidgetsPath));
                const finalPath = await createBackup(path, password, userWidgets, {
                    storage: storage,
                    theme: theme,
                    settings: settings
                });
                showReportDialog(window, this._tr("backup.result.created_heading", "Backup created"), `${this._tr("importexport.result.saved_to", "Saved to {path}").replace("{path}", finalPath)}\n` + `${this._tr("backup.result.widgets_included", "Widgets included: {count}").replace("{count}", userWidgets.length)}`);
            } catch (e) {
                logError(e, "[widget-center] prefs: backup failed");
                showReportDialog(window, this._tr("backup.result.create_failed_heading", "Backup failed"), e.message);
            }
        });
        group.add(backupRow);
        const restoreRow = new Adw.ActionRow({
            title: this._tr("backup.restore.title", "Restore backup…"),
            activatable: true
        });
        restoreRow.add_suffix(new Gtk.Image({
            icon_name: "snapshots-alt-symbolic"
        }));
        restoreRow.connect("activated", async () => {
            const path = await chooseFile(window, {
                action: "open",
                title: this._tr("backup.restore.filechooser_title", "Restore backup"),
                pattern: "*.gwcbak"
            });
            if (!path) return;
            const password = await promptPassword(window, this._tr("backup.password_prompt.heading", "Backup password"), this._tr("backup.password_prompt.restore_body", "Enter this backup's password."));
            if (!password) return;
            const confirmed = await confirmOverwrite(window, this._tr("backup.restore.confirm_heading", "Restore this backup?"), this._tr("backup.restore.confirm_body", "This overwrites appearance, host preferences, and settings for every widget " + "in the backup with the values it contains, and reinstalls the widget files it " + "includes. This cannot be undone."), this._tr("backup.restore.confirm_button", "Restore"));
            if (!confirmed) return;
            try {
                const theme = new ThemeService;
                theme.init();
                const {restoredWidgetIds: restoredWidgetIds, restoredWidgetFileIds: restoredWidgetFileIds, dependencyWarnings: dependencyWarnings} = await restoreBackup(path, password, {
                    storage: storage,
                    theme: theme,
                    settings: settings,
                    userWidgetsDir: widgetPaths.userWidgetsPath
                });
                const lines = [ this._tr("backup.result.settings_restored", "Restored settings for {count} widget(s).").replace("{count}", restoredWidgetIds.length), this._tr("backup.result.files_restored", "Restored files for {count} widget(s).").replace("{count}", restoredWidgetFileIds.length), this._tr("backup.result.reopen_hint", "Reopen this window (or restart the widgets) to see everything.") ];
                if (dependencyWarnings.length > 0) {
                    lines.push("", this._tr("shared.result.missing_dependencies", "Missing system dependencies:"));
                    for (const d of dependencyWarnings) {
                        lines.push(`  ${d.widgetId}: ${d.bin}${d.reason ? ` — ${d.reason}` : ""}`);
                        if (d.suggestedCommand) lines.push(`    ${this._tr("shared.result.install_with", "install with:")} ${d.suggestedCommand}`);
                    }
                }
                showReportDialog(window, this._tr("backup.result.restored_heading", "Backup restored"), lines.join("\n"));
            } catch (e) {
                logError(e, "[widget-center] prefs: restore failed");
                showReportDialog(window, this._tr("backup.result.restore_failed_heading", "Restore failed"), e.message);
            }
        });
        group.add(restoreRow);
        return page;
    }
    _buildAboutCategory() {
        const page = new Adw.PreferencesPage;
        const group = new Adw.PreferencesGroup;
        page.add(group);
        group.add(new Adw.StatusPage({
            icon_name: "preferences-desktop-applications-symbolic",
            title: this.metadata.name ?? "GNOME Widget Center",
            description: this.metadata.description ?? ""
        }));
        const versionRow = new Adw.ActionRow({
            title: "Version"
        });
        versionRow.add_suffix(new Gtk.Label({
            label: String(this.metadata.version ?? "—"),
            css_classes: [ "dim-label" ]
        }));
        group.add(versionRow);
        if (this.metadata.url) {
            const linkRow = new Adw.ActionRow({
                title: "Source code",
                subtitle: this.metadata.url,
                activatable: true
            });
            linkRow.add_suffix(new Gtk.Image({
                icon_name: "adw-external-link-symbolic"
            }));
            linkRow.connect("activated", () => {
                Gtk.show_uri(null, this.metadata.url, Gdk.CURRENT_TIME);
            });
            group.add(linkRow);
        }
        return page;
    }
    _buildAppearanceCategory(settings) {
        const ready = settings?.isReady;
        const page = new Adw.PreferencesPage;

        const shadowGroup = new Adw.PreferencesGroup({
            title: "Global Shadow",
            description: "Distance and angle apply to every widget's drop shadow. Each " + "widget still sets its own shadow color, opacity, and blur in its own " + "Appearance settings."
        });
        page.add(shadowGroup);

        const shadowDistanceRow = new Adw.SpinRow({
            title: "Shadow distance",
            subtitle: "0–30 px.",
            sensitive: ready,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 30,
                step_increment: 1,
                value: ready ? settings.getGlobalValue("shadow-distance") : 4
            })
        });
        shadowGroup.add(shadowDistanceRow);
        shadowDistanceRow.connect("notify::value", () => {
            if (!ready) return;
            settings.setGlobalValue("shadow-distance", Math.round(shadowDistanceRow.value));
        });

        const shadowAngleRow = new Adw.ComboRow({
            title: "Shadow angle",
            subtitle: "Direction the shadow falls, in 45° steps.",
            sensitive: ready,
            model: Gtk.StringList.new(SHADOW_ANGLE_STEPS.map(a => `${a}°`))
        });
        const shadowAngleIndex = SHADOW_ANGLE_STEPS.indexOf(ready ? settings.getGlobalValue("shadow-angle") : 90);
        shadowAngleRow.selected = shadowAngleIndex >= 0 ? shadowAngleIndex : SHADOW_ANGLE_STEPS.indexOf(90);
        shadowGroup.add(shadowAngleRow);
        shadowAngleRow.connect("notify::selected", () => {
            if (!ready) return;
            settings.setGlobalValue("shadow-angle", SHADOW_ANGLE_STEPS[shadowAngleRow.selected] ?? 90);
        });

        return page;
    }
    _buildGeneralCategory(settings) {
        const page = new Adw.PreferencesPage;
        const ready = settings.isReady;
        const group = new Adw.PreferencesGroup({
            title: "Language",
            description: "Overrides the system locale for this extension's own UI text and " + "any widget that ships translations - only where a widget actually has that " + "language available, otherwise it falls back to the system locale as before."
        });
        page.add(group);
        const localeNames = {
            en: "English",
            zh: "中文",
            es: "Español",
            th: "ไทย",
            de: "Deutsch",
            ja: "日本語"
        };
        const codes = [ "", ...SUPPORTED_LOCALES ];
        const labels = [ "System default", ...SUPPORTED_LOCALES.map(c => localeNames[c] ?? c) ];
        const row = new Adw.ComboRow({
            title: "UI language",
            subtitle: "Applies immediately, no restart needed.",
            model: Gtk.StringList.new(labels),
            selected: Math.max(0, codes.indexOf(ready ? settings.getGlobalValue("language") || "" : "")),
            sensitive: ready
        });
        row.connect("notify::selected", () => {
            if (!ready) {
                logError(new Error("SettingsService not ready — could not save language"));
                return;
            }
            try {
                settings.setGlobalValue("language", codes[row.selected] ?? "");
            } catch (e) {
                logError(e, "could not save language");
            }
        });
        group.add(row);
        const widgetsGroup = new Adw.PreferencesGroup({
            title: "Widgets",
            description: "What happens the first time a widget you installed yourself — into " + "~/.local/share/gnome-widget-center/widgets/, or dropped in by a theme " + "pack — is found. Widgets bundled with the extension always start off " + "and wait for you to enable them from Overview, regardless of this " + "setting."
        });
        page.add(widgetsGroup);
        const autoEnableRow = new Adw.SwitchRow({
            title: "Load new widgets automatically",
            subtitle: "For widgets you install yourself. On: enabled the first time it's found " + "(previous behavior). Off: it appears in Overview but stays off the " + "desktop until you turn it on.",
            active: ready ? !!settings.getGlobalValue("auto-enable-new-widgets") : true,
            sensitive: ready
        });
        autoEnableRow.connect("notify::active", () => {
            if (!ready) {
                logError(new Error("SettingsService not ready — could not toggle auto-enable-new-widgets"));
                return;
            }
            try {
                settings.setGlobalValue("auto-enable-new-widgets", autoEnableRow.active);
            } catch (e) {
                logError(e, "could not toggle auto-enable-new-widgets");
            }
        });
        widgetsGroup.add(autoEnableRow);
        const shortcutGroup = new Adw.PreferencesGroup({
            title: "Keyboard shortcut",
            description: "Opens/closes the Widget Center Overlay (lib/shell/widgetCenterOverlay.js). " + "Also editable live from the overlay's own Preferences tab."
        });
        page.add(shortcutGroup);
        const currentAccel = ready ? settings.getGlobalValue("widget-center-overlay-keybinding")?.[0] ?? "" : "<Super>F12";
        const shortcutRow = new Adw.ActionRow({
            title: "Shortcut",
            subtitle: "Click Record shortcut, then press the key combination.",
            sensitive: ready
        });
        const recordButton = new Gtk.Button({
            label: currentAccel || "Disabled",
            valign: Gtk.Align.CENTER,
            sensitive: ready
        });
        let recording = false;
        recordButton.connect("clicked", () => {
            recording = true;
            recordButton.label = "Press shortcut…";
            recordButton.grab_focus();
        });
        const keyController = new Gtk.EventControllerKey;
        keyController.connect("key-pressed", (_controller, keyval, _keycode, state) => {
            if (!recording) return false;
            if (keyval === Gdk.KEY_Escape) {
                recording = false;
                recordButton.label = currentAccel || "Disabled";
                return true;
            }
            if (isModifierKeyval(keyval)) return true;
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (!Gtk.accelerator_valid(keyval, mask)) return true;
            const accel = Gtk.accelerator_name(keyval, mask);
            recording = false;
            recordButton.label = accel;
            try {
                settings.setGlobalValue("widget-center-overlay-keybinding", [ accel ]);
            } catch (e) {
                logError(e, "could not save widget-center-overlay-keybinding");
            }
            return true;
        });
        recordButton.add_controller(keyController);
        shortcutRow.add_suffix(recordButton);
        shortcutRow.activatable_widget = recordButton;
        shortcutGroup.add(shortcutRow);
        return page;
    }
    _buildInteractionsCategory(settings) {
        const page = new Adw.PreferencesPage;
        const ready = settings.isReady;
        const snapGroup = new Adw.PreferencesGroup({
            title: "Magnetic snapping",
            description: "Pulls a dragged widget toward screen edges and other widgets' edges."
        });
        page.add(snapGroup);
        const snapEnabledRow = new Adw.SwitchRow({
            title: "Enable snapping",
            active: ready ? !!settings.getGlobalValue("snap-enabled") : true,
            sensitive: ready
        });
        snapEnabledRow.connect("notify::active", () => {
            if (!ready) return;
            try {
                settings.setGlobalValue("snap-enabled", snapEnabledRow.active);
            } catch (e) {
                logError(e, "could not save snap-enabled");
            }
        });
        snapGroup.add(snapEnabledRow);
        const snapDistanceRow = new Adw.SpinRow({
            title: "Snap distance",
            subtitle: "How close (px) an edge must get before it's pulled the rest of the way.",
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 128,
                step_increment: 1,
                value: ready ? settings.getGlobalValue("snap-distance") : 16
            }),
            sensitive: ready
        });
        snapDistanceRow.connect("notify::value", () => {
            if (!ready) return;
            try {
                settings.setGlobalValue("snap-distance", Math.round(snapDistanceRow.value));
            } catch (e) {
                logError(e, "could not save snap-distance");
            }
        });
        snapGroup.add(snapDistanceRow);
        const guideColorRow = new Adw.ActionRow({
            title: "Guide line color"
        });
        const guideColorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({
                with_alpha: true
            }),
            valign: Gtk.Align.CENTER,
            sensitive: ready
        });
        const initialGuideColor = new Gdk.RGBA;
        initialGuideColor.parse(ready ? settings.getGlobalValue("guide-color") || "#F5A623E6" : "#F5A623E6");
        guideColorButton.set_rgba(initialGuideColor);
        guideColorButton.connect("notify::rgba", () => {
            if (!ready) return;
            try {
                settings.setGlobalValue("guide-color", rgbaToHex(guideColorButton.rgba));
            } catch (e) {
                logError(e, "could not save guide-color");
            }
        });
        guideColorRow.add_suffix(guideColorButton);
        guideColorRow.activatable_widget = guideColorButton;
        snapGroup.add(guideColorRow);
        const gridGroup = new Adw.PreferencesGroup({
            title: "Fixed grid snap",
            description: "Off by default. Rounds a dragged widget's position to the nearest " + "grid cell, applied after magnetic snapping above."
        });
        page.add(gridGroup);
        const gridEnabledRow = new Adw.SwitchRow({
            title: "Snap to grid",
            active: ready ? !!settings.getGlobalValue("grid-snap-enabled") : false,
            sensitive: ready
        });
        gridEnabledRow.connect("notify::active", () => {
            if (!ready) return;
            try {
                settings.setGlobalValue("grid-snap-enabled", gridEnabledRow.active);
            } catch (e) {
                logError(e, "could not save grid-snap-enabled");
            }
        });
        gridGroup.add(gridEnabledRow);
        const gridSizeRow = new Adw.SpinRow({
            title: "Grid size",
            subtitle: "Cell size in pixels. Only applies while Snap to grid above is on.",
            adjustment: new Gtk.Adjustment({
                lower: 4,
                upper: 128,
                step_increment: 1,
                value: ready ? settings.getGlobalValue("grid-size") : 16
            }),
            sensitive: ready
        });
        gridSizeRow.connect("notify::value", () => {
            if (!ready) return;
            try {
                settings.setGlobalValue("grid-size", Math.round(gridSizeRow.value));
            } catch (e) {
                logError(e, "could not save grid-size");
            }
        });
        gridGroup.add(gridSizeRow);
        return page;
    }
    _buildAdvancedCategory(window, settings, storage, discoveredWidgets) {
        const page = new Adw.PreferencesPage;
        const group = new Adw.PreferencesGroup({
            title: "Development",
            description: "For debugging the extension itself — safe to leave off otherwise."
        });
        page.add(group);
        const row = new Adw.SwitchRow({
            title: "Development Mode",
            subtitle: "Hot-reloads widgets on file change, and logs internal debug output " + "(Edit Mode flips, drag start/stop, etc) to the system journal — " + "view with: journalctl -f -o cat | grep widget-center",
            active: settings.isReady ? !!settings.getGlobalValue("dev-mode") : false,
            sensitive: settings.isReady
        });
        row.connect("notify::active", () => {
            if (!settings.isReady) {
                logError(new Error("SettingsService not ready — could not toggle Development Mode"));
                return;
            }
            try {
                settings.setGlobalValue("dev-mode", row.active);
            } catch (e) {
                logError(e, "could not toggle Development Mode");
            }
        });
        group.add(row);
        const defaultsGroup = new Adw.PreferencesGroup({
            title: "Widget defaults",
            description: "For widget authors — bakes the current live appearance/position of " + "every widget into its own config.json/metadata.json, so that becomes " + "the new out-of-the-box default. Writes directly to each widget's own " + "folder on disk."
        });
        page.add(defaultsGroup);
        const saveDefaultsRow = new Adw.ActionRow({
            title: "Save current settings as defaults",
            subtitle: "Applies to every installed widget in one go — see the confirmation " + "dialog before anything is written."
        });
        const saveDefaultsButton = new Gtk.Button({
            label: "Save Defaults",
            valign: Gtk.Align.CENTER,
            css_classes: [ "destructive-action" ]
        });
        saveDefaultsRow.add_suffix(saveDefaultsButton);
        saveDefaultsRow.activatable_widget = saveDefaultsButton;
        defaultsGroup.add(saveDefaultsRow);
        saveDefaultsButton.connect("clicked", async () => {
            const widgets = (discoveredWidgets ?? []).filter(w => w.hasConfigJson);
            if (widgets.length === 0) {
                showReportDialog(window, "Nothing to save", "No installed widget has a config.json with configurable fields.");
                return;
            }
            const confirmed = await confirmOverwrite(window, "Save current settings as defaults?", `This overwrites config.json (and metadata.json's default-position) for ` + `all ${widgets.length} widget(s) with configurable appearance, using ` + `whatever they're currently set to right now on your desktop. This ` + `cannot be undone.`, "Save Defaults");
            if (!confirmed) return;
            let configUpdated = 0;
            let positionUpdated = 0;
            const errors = [];
            for (const widget of widgets) {
                try {
                    const currentValues = storage.getWidgetSettings(widget.id);
                    const rawPosition = storage.getWidgetPosition(widget.id);
                    const position = rawPosition ? {
                        x: rawPosition.x,
                        y: rawPosition.y,
                        monitor: rawPosition.monitorIndex ?? 0
                    } : null;
                    const result = await saveCurrentSettingsAsWidgetDefaults(widget.path, currentValues, position);
                    if (result.configUpdated) configUpdated++;
                    if (result.positionUpdated) positionUpdated++;
                    for (const err of result.errors) errors.push(`${widget.id}: ${err}`);
                } catch (e) {
                    errors.push(`${widget.id}: ${e.message}`);
                }
            }
            const lines = [ `Widgets processed: ${widgets.length}`, `config.json updated: ${configUpdated}`, `metadata.json position updated: ${positionUpdated}` ];
            if (errors.length > 0) {
                lines.push("", "Errors:");
                for (const err of errors) lines.push(`  ${err}`);
            }
            showReportDialog(window, errors.length > 0 ? "Saved with errors" : "Defaults saved", lines.join("\n"));
        });
        return page;
    }
    _buildDesktopCategory(settings) {
        const page = new Adw.PreferencesPage;
        const group = new Adw.PreferencesGroup({
            title: "Widget placement",
            description: "Applies while dragging widgets in Edit Mode."
        });
        page.add(group);
        const overlapRow = new Adw.SwitchRow({
            title: "Prevent widgets from overlapping",
            subtitle: "ห้าม widget ทับกัน — when off, widgets can be dropped on top of each other.",
            active: settings.isReady ? !!settings.getGlobalValue("prevent-widget-overlap") : true,
            sensitive: settings.isReady
        });
        overlapRow.connect("notify::active", () => {
            if (!settings.isReady) {
                logError(new Error("SettingsService not ready — could not toggle widget overlap prevention"));
                return;
            }
            try {
                settings.setGlobalValue("prevent-widget-overlap", overlapRow.active);
            } catch (e) {
                logError(e, "could not toggle prevent-widget-overlap");
            }
        });
        group.add(overlapRow);
        const marginRow = new Adw.SpinRow({
            title: "Screen edge margin",
            subtitle: "พื้นที่จากขอบจอที่ widget วางไม่ได้ — minimum distance (px) a widget " + "must keep from every edge of the screen.",
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 256,
                step_increment: 1,
                value: settings.isReady ? settings.getGlobalValue("edge-margin") : 32
            }),
            sensitive: settings.isReady
        });
        marginRow.connect("notify::value", () => {
            if (!settings.isReady) {
                logError(new Error("SettingsService not ready — could not save edge margin"));
                return;
            }
            try {
                settings.setGlobalValue("edge-margin", Math.round(marginRow.value));
            } catch (e) {
                logError(e, "could not save edge-margin");
            }
        });
        group.add(marginRow);
        const spacingRow = new Adw.SpinRow({
            title: "Spacing between widgets",
            subtitle: "widget ต้องห่างกันเท่าไหร่ — minimum gap (px) kept between widgets " + "while overlap prevention above is on.",
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 256,
                step_increment: 1,
                value: settings.isReady ? settings.getGlobalValue("widget-spacing") : 16
            }),
            sensitive: settings.isReady
        });
        spacingRow.connect("notify::value", () => {
            if (!settings.isReady) {
                logError(new Error("SettingsService not ready — could not save widget spacing"));
                return;
            }
            try {
                settings.setGlobalValue("widget-spacing", Math.round(spacingRow.value));
            } catch (e) {
                logError(e, "could not save widget-spacing");
            }
        });
        group.add(spacingRow);
        return page;
    }
};