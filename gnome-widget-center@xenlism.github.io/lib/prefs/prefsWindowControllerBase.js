import Adw from "gi://Adw";

import GLib from "gi://GLib";

import { readTextFileAsync } from "../fsUtils.js";

import { pickTranslation } from "../i18nUtils.js";

import { ThemeService } from "../themeService.js";

import { ThemePackRegistry } from "../themePackRegistry.js";

import { InstallRegistry } from "../store/installRegistry.js";

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
        this._storePage = null;
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
    showStorePage(window) {
        if (!this._storePage) return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                window.set_visible_page(this._storePage);
            } catch (e) {
                logError(e, "[widget-center] prefs: showStorePage() failed");
            }
            return GLib.SOURCE_REMOVE;
        });
    }
    // Preferences > Store (channel, interval, repositories, rollback)
    showStoreSettings(window) {
        if (!this._preferencesPage || !this._accordionCategoriesById?.store) return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                window.set_visible_page(this._preferencesPage);
                this._accordionCategoriesById.store.expand();
            } catch (e) {
                logError(e, "[widget-center] prefs: showStoreSettings() failed");
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
            discoveredWidgets: this._discovered,
            tr: (key, fallback) => this._tr(key, fallback)
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
    _toast(window, title) {
        try {
            window.add_toast(new Adw.Toast({ title }));
        } catch (e) {
            logError(e, "[widget-center] prefs: toast failed");
        }
    }
    // Share a theme pack. From a store repo -> copies the https link; anything else -> saves the .gwct file.
    // A folder-style pack can't be saved as a single file, so it falls back to the Export dialog.
    async shareThemePackById(window, themePackId) {
        const registry = new ThemePackRegistry([ {
            path: GLib.build_filenamev([ this.path, "themepacks" ]),
            source: "bundled"
        }, {
            path: GLib.build_filenamev([ GLib.get_user_config_dir(), "gnome-widget-center", "themepacks" ]),
            source: "user"
        } ]);
        const entry = (await registry.discover()).find(e => e.id === themePackId);
        if (!entry) {
            this._toast(window, this._tr("share.error.notfound", "Theme pack not found"));
            return;
        }
        if (!entry.path.endsWith(".gwct")) {
            await this.openExportThemeDialogForPack(window, themePackId);
            return;
        }
        try {
            const { shareThemePack } = await import("../store/shareService.js");
            const res = await shareThemePack(window, await InstallRegistry.load(), themePackId, entry.path);
            this._reportShare(window, res);
        } catch (e) {
            logError(e, "[widget-center] prefs: share theme pack failed");
            this._toast(window, e.message);
        }
    }
    // Share a widget. From a store repo -> copies the https link; anything else -> saves a self-contained .gwcw.
    async shareWidgetById(window, widgetId, widgetDir = null) {
        try {
            const { shareWidget } = await import("../store/shareService.js");
            const res = await shareWidget(window, await InstallRegistry.load(), widgetId, widgetDir);
            this._reportShare(window, res);
        } catch (e) {
            logError(e, "[widget-center] prefs: share widget failed");
            this._toast(window, e.message);
        }
    }
    _reportShare(window, res) {
        if (!res) return;   // save dialog cancelled
        if (res.kind === "link") this._toast(window, this._tr("share.link.copied", "Share link copied to the clipboard"));
        else this._toast(window, this._tr("share.file.saved", "Saved to {path}").replace("{path}", res.path));
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