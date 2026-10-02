import GLib from "gi://GLib";

import Gio from "gi://Gio";

import * as BackgroundMenu from "resource:///org/gnome/shell/ui/backgroundMenu.js";

import { InjectionManager } from "resource:///org/gnome/shell/extensions/extension.js";

import { loadTranslations } from "../../i18n/index.js";

import { pickTranslation } from "../i18nUtils.js";

const MENU_LABEL_KEY = "menu.desktop.widgets_settings";

const MENU_LABEL_FALLBACK = "Widgets Settings";

// Adds a "Widgets Settings" entry to GNOME Shell's desktop right-click menu
// (the BackgroundMenu). Selecting it launches the extension's Preferences
// window (widget-center-prefs-app.js), the same app the edit-mode and
// overlay "Settings" buttons use.
//
// Shell creates one BackgroundMenu per monitor and re-creates them whenever
// the monitor layout changes, so instead of patching a particular instance
// the menu class's open() is wrapped: the first time any menu opens, the item
// is added to it (once). That also means nothing here has to track monitor
// hot-plugging.
export class DesktopMenu {
    constructor(extensionObject, gsettings, logger = null) {
        this._extension = extensionObject;
        this._gsettings = gsettings;
        this._logger = logger;
        this._injections = null;
        this._items = new Set();
        this._i18n = {};
        this._languageChangedId = 0;
        this._enabled = false;
    }
    enable() {
        if (this._enabled) return;
        this._enabled = true;
        this._loadI18n();
        try {
            this._languageChangedId = this._gsettings?.connect("changed::language", () => this._loadI18n()) ?? 0;
        } catch (e) {
            this._languageChangedId = 0;
        }
        const menuClass = BackgroundMenu.BackgroundMenu;
        if (!menuClass?.prototype) {
            this._logger?.warn("desktop-menu: BackgroundMenu class not found - menu item not added");
            return;
        }
        const self = this;
        this._injections = new InjectionManager;
        this._injections.overrideMethod(menuClass.prototype, "open", originalOpen => function(...args) {
            try {
                self._ensureItem(this);
            } catch (e) {
                self._logger?.error("desktop-menu: could not add the Widgets Settings item", e);
            }
            return originalOpen.apply(this, args);
        });
    }
    disable() {
        this._enabled = false;
        this._injections?.clear();
        this._injections = null;
        if (this._languageChangedId && this._gsettings) {
            try {
                this._gsettings.disconnect(this._languageChangedId);
            } catch (e) {}
        }
        this._languageChangedId = 0;
        for (const item of this._items) {
            try {
                item.destroy();
            } catch (e) {}
        }
        this._items.clear();
    }
    _label() {
        return pickTranslation(this._i18n, MENU_LABEL_KEY, MENU_LABEL_FALLBACK);
    }
    _loadI18n() {
        let languageOverride;
        try {
            languageOverride = this._gsettings?.get_string("language") || undefined;
        } catch (e) {
            languageOverride = undefined;
        }
        loadTranslations(GLib.build_filenamev([ this._extension.path, "i18n" ]), languageOverride).then(translations => {
            this._i18n = translations ?? {};
            for (const item of this._items) item.label?.set_text(this._label());
        }).catch(() => {
            this._i18n = {};
        });
    }
    _ensureItem(menu) {
        if (menu._widgetCenterItem) return;
        const item = menu.addAction(this._label(), () => this._openPreferences());
        menu._widgetCenterItem = item;
        this._items.add(item);
        item.connect("destroy", () => {
            this._items.delete(item);
            if (menu._widgetCenterItem === item) menu._widgetCenterItem = null;
        });
    }
    _openPreferences() {
        const scriptPath = GLib.build_filenamev([ this._extension.path, "widget-center-prefs-app.js" ]);
        try {
            Gio.Subprocess.new([ "gjs", "-m", scriptPath ], Gio.SubprocessFlags.NONE);
        } catch (e) {
            this._logger?.error("desktop-menu: could not launch the extension Preferences", e);
        }
    }
}
