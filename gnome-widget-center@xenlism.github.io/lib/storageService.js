import Gio from "gi://Gio";

import GLib from "gi://GLib";

import { ensureDirectory, readTextFile, readTextFileAsync, writeTextFile, fileExists } from "./fsUtils.js";

export class StorageService {
    constructor() {
        this._storageDir = null;
        this._layoutFile = null;
        this._widgetsDir = null;
        this._isInitialized = false;
        // In-memory caches so the synchronous getters below (called from
        // widget position getters — a plain `x`/`y` property read, can't
        // become a Promise without breaking every widget that reads
        // api.position.x) don't have to hit disk on every call. `undefined`
        // means "not loaded yet"; `init()` kicks off an async priming read
        // so that, in practice, by the time the first widget actually reads
        // its position the cache is usually already warm. See
        // loadLayout()/getWidgetSettings() for the one-time sync fallback
        // that still runs if something asks before priming finishes.
        this._layoutCache = undefined;
        this._widgetSettingsCache = new Map;
    }
    init() {
        if (this._isInitialized) return;
        const configPath = GLib.get_user_config_dir();
        const baseDirPath = GLib.build_filenamev([ configPath, "gnome-widget-center" ]);
        this._storageDir = ensureDirectory(baseDirPath);
        const layoutPath = GLib.build_filenamev([ baseDirPath, "layout.json" ]);
        this._layoutFile = Gio.File.new_for_path(layoutPath);
        const widgetsDirPath = GLib.build_filenamev([ baseDirPath, "widgets" ]);
        this._widgetsDir = ensureDirectory(widgetsDirPath);
        this._isInitialized = true;
        this._primeLayoutCache();
    }
    async _primeLayoutCache() {
        if (this._layoutCache !== undefined) return;
        try {
            const jsonString = await readTextFileAsync(this._layoutFile.get_path());
            if (this._layoutCache === undefined) this._layoutCache = jsonString === null ? null : JSON.parse(jsonString);
        } catch (error) {
            if (this._layoutCache === undefined) {
                logError(error, "Failed to load layout.json");
                this._layoutCache = null;
            }
        }
    }
    loadLayout() {
        if (!this._isInitialized) this.init();
        if (this._layoutCache !== undefined) return this._layoutCache;
        // Cache isn't warm yet — this only happens for whichever call comes
        // in first, right after enable(), before the background priming
        // read above has resolved. One synchronous read here, same as
        // before this change; every subsequent call (including this same
        // widget's next position read) is a cache hit with no I/O at all.
        try {
            const jsonString = readTextFile(this._layoutFile.get_path());
            this._layoutCache = jsonString === null ? null : JSON.parse(jsonString);
        } catch (error) {
            logError(error, "Failed to load layout.json");
            this._layoutCache = null;
        }
        return this._layoutCache;
    }
    saveLayout(widgetsLayout) {
        if (!this._isInitialized) this.init();
        try {
            const serializedData = widgetsLayout.map(widget => ({
                id: widget.id,
                type: widget.type,
                x: widget.x,
                y: widget.y,
                width: widget.width || 200,
                height: widget.height || 200,
                zIndex: widget.zIndex || 1,
                customProperties: widget.customProperties || {}
            }));
            const layoutData = {
                version: "1.0",
                widgets: serializedData
            };
            writeTextFile(this._layoutFile.get_path(), JSON.stringify(layoutData, null, 4));
            this._layoutCache = layoutData;
        } catch (error) {
            logError(error, "Failed to save layout.json");
            throw error;
        }
    }
    _sanitizeWidgetId(widgetId) {
        const safe = String(widgetId ?? "").replace(/[^a-zA-Z0-9._-]/g, "");
        if (!safe || safe === "." || safe === "..") {
            throw new Error(`Invalid widget id: "${widgetId}"`);
        }
        return safe;
    }
    getWidgetPosition(widgetId) {
        const id = this._sanitizeWidgetId(widgetId);
        const layoutData = this.loadLayout();
        const entry = layoutData?.widgets?.find(w => w.id === id);
        if (!entry) return null;
        return {
            x: entry.x,
            y: entry.y,
            monitorIndex: entry.monitorIndex ?? 0
        };
    }
    updateWidgetPosition(widgetId, x, y, monitorIndex = 0) {
        const id = this._sanitizeWidgetId(widgetId);
        const layoutData = this.loadLayout() ?? {
            version: "1.0",
            widgets: []
        };
        const widgets = layoutData.widgets ?? [];
        const existing = widgets.find(w => w.id === id);
        if (existing) {
            existing.x = x;
            existing.y = y;
            existing.monitorIndex = monitorIndex;
        } else {
            widgets.push({
                id: id,
                type: id,
                x: x,
                y: y,
                monitorIndex: monitorIndex,
                width: 200,
                height: 200,
                zIndex: 1,
                customProperties: {}
            });
        }
        this.saveLayout(widgets);
    }
    getWidgetSettingsPath(instanceId) {
        if (!this._isInitialized) this.init();
        const id = this._sanitizeWidgetId(instanceId);
        return GLib.build_filenamev([ this._widgetsDir.get_path(), `${id}.json` ]);
    }
    getWidgetSettings(instanceId) {
        if (!this._isInitialized) this.init();
        if (this._widgetSettingsCache.has(instanceId)) return this._widgetSettingsCache.get(instanceId);
        const widgetSettingsPath = this.getWidgetSettingsPath(instanceId);
        let result;
        try {
            const jsonString = readTextFile(widgetSettingsPath);
            result = jsonString === null ? {} : JSON.parse(jsonString);
        } catch (error) {
            logError(error, `Failed to load settings for widget instance: ${instanceId}`);
            result = {};
        }
        // No async priming for this one the way loadLayout() has — we don't
        // know instance ids in advance, they only surface as widgets get
        // constructed. But this still turns every read after the first one
        // for a given widget (there are several: widgetSettings.js, the
        // prefs page, export/backup) into a cache hit instead of a fresh
        // disk read each time.
        this._widgetSettingsCache.set(instanceId, result);
        return result;
    }
    saveWidgetSettings(instanceId, settingsData) {
        if (!this._isInitialized) this.init();
        try {
            const widgetSettingsPath = this.getWidgetSettingsPath(instanceId);
            writeTextFile(widgetSettingsPath, JSON.stringify(settingsData, null, 4));
            this._widgetSettingsCache.set(instanceId, settingsData);
        } catch (error) {
            logError(error, `Failed to save settings for widget instance: ${instanceId}`);
            throw error;
        }
    }
    updateWidgetProperty(instanceId, key, value) {
        if (!this._isInitialized) this.init();
        const currentSettings = this.getWidgetSettings(instanceId);
        currentSettings[key] = value;
        this.saveWidgetSettings(instanceId, currentSettings);
    }
    resetWidgetSettings(instanceId) {
        if (!this._isInitialized) this.init();
        const widgetSettingsPath = this.getWidgetSettingsPath(instanceId);
        try {
            if (fileExists(widgetSettingsPath)) Gio.File.new_for_path(widgetSettingsPath).delete(null);
            this._widgetSettingsCache.delete(instanceId);
        } catch (error) {
            logError(error, `Failed to reset settings for widget instance: ${instanceId}`);
            throw error;
        }
    }
    removeWidgetLayoutEntry(widgetId) {
        const id = this._sanitizeWidgetId(widgetId);
        const layoutData = this.loadLayout();
        if (!layoutData?.widgets) return;
        const next = layoutData.widgets.filter(w => w.id !== id);
        if (next.length === layoutData.widgets.length) return;
        this.saveLayout(next);
    }
}