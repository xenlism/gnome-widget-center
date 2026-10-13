// prefsDataCategories.js - Preferences categories about data: import / export, backup / restore, About.
import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gdk from "gi://Gdk";
import GLib from "gi://GLib";
import { showReportDialog, promptPassword, confirmOverwrite, chooseFile } from "./prefsDialogs.js";
import { ThemeService } from "../themeService.js";
import { buildGwctDocumentAsync, writeGwctFile, readGwctFile, installGwctAsThemePack } from "../exportService.js";
import { createBackup, restoreBackup } from "../backupService.js";
import { openThemePackExportDialog } from "./themePackExportDialog.js";
import { ThemePackRegistry } from "../themePackRegistry.js";
import { isModifierKeyval } from "./prefsKeys.js";

export const PrefsDataCategoriesMixin = Base => class extends Base {
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
            const confirmBody = this._tr("importexport.import.confirm_body", "This installs the chosen file as a theme pack, removes every widget on your desktop and loads the theme's own widgets, layout, colors and shadows.");
            const confirmed = await confirmOverwrite(window, this._tr("importexport.import.confirm_heading", "Import this theme?"), confirmBody, this._tr("importexport.import.confirm_button", "Import"));
            if (!confirmed) return;
            try {
                const document = await readGwctFile(path);
                // Importing is not an in-place rewrite of the widgets that are on screen:
                // the file is installed as a theme pack and the shell is asked to load it,
                // i.e. unload the current widgets and load the pack's own widgets.
                const userThemepacksDir = GLib.build_filenamev([ GLib.get_user_config_dir(), "gnome-widget-center", "themepacks" ]);
                const existing = await new ThemePackRegistry([ { path: userThemepacksDir, source: "user" } ]).discover();
                const wantedId = document.packMeta?.id;
                const sameId = wantedId ? existing.find(e => e.id === wantedId) : null;
                let installedPath;
                if (sameId) {
                    writeGwctFile(sameId.path, document);
                    installedPath = sameId.path;
                } else {
                    installedPath = installGwctAsThemePack(document, userThemepacksDir);
                }
                const packId = wantedId || GLib.path_get_basename(installedPath).replace(/\.gwct$/, "");
                if (!this._settings?.isReady) throw new Error("Widget Center settings are not available.");
                this._settings.setGlobalValue("active-theme-pack", packId);
                this._settings.setGlobalValue("theme-pack-apply-request", `${packId}|${GLib.get_monotonic_time()}`);
                const loadingText = this._tr("importexport.result.loading_theme", "The theme is being loaded: current widgets are removed and the theme's widgets are placed.");
                const installedText = this._tr("importexport.importpack.result_body_short", "Installed to {path}.").replace("{path}", installedPath);
                const lines = [ loadingText, "", installedText ];
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
                discoveredWidgets: discoveredWidgets,
                tr: (key, fallback) => this._tr(key, fallback)
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
                const body = meta ? [ meta.name, meta.description, meta.author ? this._tr("importexport.importpack.by_author", "by {author}").replace("{author}", meta.author) : null, this._tr("importexport.importpack.widget_count", "{count} widget(s)").replace("{count}", (document.widgets ?? []).length) ].filter(Boolean).join("\n") : this._tr("importexport.importpack.confirm_body_nometa", "\"{name}\" doesn't carry a name/description (it wasn't made with Export Theme…), but it can still be installed — it'll show up under its file name.").replace("{name}", GLib.path_get_basename(path));
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

        // ── Pollinations API key (✦ AI) ──────────────────────────────────────
        // Required for the ✦ AI buttons - see generateAiMeta() in
        // themePackExportDialog.js, which calls Pollinations directly.
        const pollinationsKeyRow = new Adw.PasswordEntryRow({
            title: this._tr("importexport.pollinationskey.title", "Pollinations API key (✦ AI)"),
            sensitive: this._settings.isReady
        });
        pollinationsKeyRow.text = this._settings.isReady
            ? this._settings.getGlobalValue("pollinations-api-key") || ""
            : "";
        pollinationsKeyRow.connect("notify::text", () => {
            try {
                this._settings.setGlobalValue("pollinations-api-key", pollinationsKeyRow.text.trim());
            } catch (e) {
                logError(e, "could not save pollinations-api-key");
            }
        });
        const pollinationsKeyUrl = "https://enter.pollinations.ai";
        const pollinationsKeyHint = new Adw.ActionRow({
            title: this._tr("importexport.pollinationskey.subtitle", "Get a free key"),
            subtitle: pollinationsKeyUrl,
            activatable: true
        });
        pollinationsKeyHint.add_suffix(new Gtk.Image({
            icon_name: "adw-external-link-symbolic"
        }));
        pollinationsKeyHint.connect("activated", () => Gtk.show_uri(window, pollinationsKeyUrl, Gdk.CURRENT_TIME));
        packGroup.add(pollinationsKeyRow);
        packGroup.add(pollinationsKeyHint);
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
            title: this._tr("about.version", "Version")
        });
        versionRow.add_suffix(new Gtk.Label({
            label: String(this.metadata["version-name"] ?? "—"),
            css_classes: [ "dim-label" ]
        }));
        group.add(versionRow);
        if (this.metadata.url) {
            const linkRow = new Adw.ActionRow({
                title: this._tr("about.source", "Source code"),
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
};
