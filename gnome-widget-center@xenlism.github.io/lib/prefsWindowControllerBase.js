import GLib from "gi://GLib";

import { readTextFile } from "./fsUtils.js";

import { pickTranslation } from "./i18nUtils.js";

import { ThemeService } from "./themeService.js";

import { ThemePackRegistry } from "./themePackRegistry.js";

import { openThemePackExportDialog } from "./themePackExportDialog.js";

import { PrefsPageBuildersMixin } from "./prefsPageBuilders.js";

import { PrefsWidgetManagementMixin } from "./prefsWidgetManagement.js";

class PrefsWindowControllerBase {
    constructor(extensionOrPath) {
        if (typeof extensionOrPath === "string") {
            this._extensionObject = null;
            this.path = extensionOrPath;
            this.metadata = this._loadMetadataFromPath(extensionOrPath);
        } else {
            this._extensionObject = extensionOrPath;
            this.path = extensionOrPath.path;
            this.metadata = extensionOrPath.metadata;
        }
        this._i18n = null;
        this._settings = null;
        this._storage = null;
        this._discovered = [];
        this._preferencesPage = null;
    }
    showPreferencesPage(window) {
        if (!this._preferencesPage) return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                window.set_visible_page(this._preferencesPage);
            } catch (e) {
                logError(e, "[widget-center] prefs: showPreferencesPage() failed");
            }
            return GLib.SOURCE_REMOVE;
        });
    }
    openExportThemeDialog(window, prefill = {}) {
        if (!this._settings || !this._storage) return;
        const theme = new ThemeService;
        theme.init();
        openThemePackExportDialog(window, {
            storage: this._storage,
            theme: theme,
            settings: this._settings,
            discoveredWidgets: this._discovered
        }, prefill);
    }
    openExportThemeDialogForPack(window, themePackId) {
        if (!this._settings || !this._storage) return;
        const bundledThemepacksPath = GLib.build_filenamev([ this.path, "themepacks" ]);
        const userThemepacksPath = GLib.build_filenamev([ GLib.get_user_config_dir(), "gnome-widget-center", "themepacks" ]);
        const registry = new ThemePackRegistry([ {
            path: bundledThemepacksPath,
            source: "bundled"
        }, {
            path: userThemepacksPath,
            source: "user"
        } ]);
        const entry = registry.discover().find(e => e.id === themePackId);
        if (!entry) {
            logError(new Error(`theme pack "${themePackId}" not found`), "[widget-center] prefs: openExportThemeDialogForPack");
            return;
        }
        this.openExportThemeDialog(window, {
            id: entry.manifest.id,
            name: entry.manifest.name,
            description: entry.manifest.description ?? "",
            author: entry.manifest.author ?? "",
            email: entry.manifest.email ?? "",
            url: entry.manifest.url ?? "",
            widgetIds: entry.manifest.widgets ?? []
        });
    }
    _loadMetadataFromPath(extensionPath) {
        try {
            const contents = readTextFile(GLib.build_filenamev([ extensionPath, "metadata.json" ]));
            return contents === null ? {} : JSON.parse(contents);
        } catch (e) {
            logError(e, "[widget-center] prefs: could not read metadata.json");
            return {};
        }
    }
    _tr(key, fallback) {
        return pickTranslation(this._i18n, key, fallback);
    }
}

export class PrefsWindowController extends(PrefsWidgetManagementMixin(PrefsPageBuildersMixin(PrefsWindowControllerBase))){}