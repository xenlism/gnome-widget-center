import GLib from "gi://GLib";

import { readTextFileAsync } from "./fsUtils.js";

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
            // reading metadata.json is async now (EGO.md has the why), so we
            // can't fill this in here anymore. build() calls
            // _ensureMetadataLoaded() before the about page or window title
            // ever look at it.
            this.metadata = {};
            this._metadataLoaded = false;
        } else {
            this._extensionObject = extensionOrPath;
            this.path = extensionOrPath.path;
            this.metadata = extensionOrPath.metadata;
            this._metadataLoaded = true;
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
    async openExportThemeDialogForPack(window, themePackId) {
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
        const entries = await registry.discover();
        const entry = entries.find(e => e.id === themePackId);
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
    // build() calls this before anything reads this.metadata. It's a no-op
    // when we were constructed from the extension object (shell hands us
    // metadata synchronously in that case, nothing to load).
    async _ensureMetadataLoaded() {
        if (this._metadataLoaded) return;
        this.metadata = await this._loadMetadataFromPath(this.path);
        this._metadataLoaded = true;
    }
    async _loadMetadataFromPath(extensionPath) {
        try {
            const contents = await readTextFileAsync(GLib.build_filenamev([ extensionPath, "metadata.json" ]));
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