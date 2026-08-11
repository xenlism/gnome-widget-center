import Gio from "gi://Gio";

import GLib from "gi://GLib";

import { ensureDirectory, readTextFile, writeTextFile, fileExists } from "./fsUtils.js";

export class StorageService {
    constructor() {
        this._storageDir = null;
        this._layoutFile = null;
        this._widgetsDir = null;
        this._isInitialized = false;
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
    }
    loadLayout() {
        if (!this._isInitialized) this.init();
        try {
            const jsonString = readTextFile(this._layoutFile.get_path());
            return jsonString === null ? null : JSON.parse(jsonString);
        } catch (error) {
            logError(error, "Failed to load layout.json");
            return null;
        }
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
            const jsonString = JSON.stringify({
                version: "1.0",
                widgets: serializedData
            }, null, 4);
            writeTextFile(this._layoutFile.get_path(), jsonString);
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
        const widgetSettingsPath = this.getWidgetSettingsPath(instanceId);
        try {
            const jsonString = readTextFile(widgetSettingsPath);
            return jsonString === null ? {} : JSON.parse(jsonString);
        } catch (error) {
            logError(error, `Failed to load settings for widget instance: ${instanceId}`);
            return {};
        }
    }
    saveWidgetSettings(instanceId, settingsData) {
        if (!this._isInitialized) this.init();
        try {
            const widgetSettingsPath = this.getWidgetSettingsPath(instanceId);
            writeTextFile(widgetSettingsPath, JSON.stringify(settingsData, null, 4));
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