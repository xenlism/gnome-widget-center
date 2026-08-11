import GLib from "gi://GLib";

import Gio from "gi://Gio";

import { ensureDirectory, readTextFile, writeTextFile } from "./fsUtils.js";

const SETTINGS_SUBDIR = "gnome-widget-center/settings";

function _getSettingsDir() {
    const dataDir = GLib.get_user_data_dir();
    const path = GLib.build_filenamev([ dataDir, SETTINGS_SUBDIR ]);
    return ensureDirectory(path);
}

export class SettingsStore {
    constructor(widgetId, fields = []) {
        this.widgetId = widgetId;
        this._fields = fields;
        this._dir = _getSettingsDir();
        this._file = this._dir.get_child(`${widgetId}.json`);
        this._values = {};
        this._monitor = null;
        this._changedHandlerId = 0;
        this._listeners = new Set;
        this._localListeners = new Set;
        this._loadFromDisk();
    }
    _defaultsMap() {
        const defaults = {};
        for (const field of this._fields) {
            defaults[field.key] = field.default;
        }
        return defaults;
    }
    _loadFromDisk() {
        const defaults = this._defaultsMap();
        try {
            const contents = readTextFile(this._file.get_path());
            if (contents !== null) {
                this._values = {
                    ...defaults,
                    ...JSON.parse(contents)
                };
                return;
            }
        } catch (e) {
            logError(e, `[gwc.settingsStore] Failed to load settings for "${this.widgetId}", falling back to defaults`);
        }
        this._values = defaults;
    }
    get(key) {
        return this._values[key];
    }
    getAll() {
        return {
            ...this._values
        };
    }
    set(key, value) {
        this._values[key] = value;
        this._save();
    }
    setMany(partial) {
        Object.assign(this._values, partial);
        this._save();
    }
    _save() {
        try {
            writeTextFile(this._file.get_path(), JSON.stringify(this._values, null, 2));
        } catch (e) {
            logError(e, `[gwc.settingsStore] Failed to save settings for "${this.widgetId}"`);
        }
        const values = this.getAll();
        for (const listener of this._localListeners) {
            listener(values);
        }
    }
    subscribe(callback) {
        this._localListeners.add(callback);
        callback(this.getAll());
    }
    unsubscribe(callback) {
        this._localListeners.delete(callback);
    }
    watch(callback) {
        this._listeners.add(callback);
        if (this._monitor) {
            return;
        }
        this._monitor = this._file.monitor(Gio.FileMonitorFlags.NONE, null);
        this._changedHandlerId = this._monitor.connect("changed", (_monitor, _file, _otherFile, eventType) => {
            if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT || eventType === Gio.FileMonitorEvent.CREATED) {
                this._loadFromDisk();
                for (const listener of this._listeners) {
                    listener(this.getAll());
                }
            }
        });
    }
    unwatch(callback) {
        if (callback) {
            this._listeners.delete(callback);
        } else {
            this._listeners.clear();
        }
        if (this._listeners.size === 0 && this._monitor) {
            this._monitor.disconnect(this._changedHandlerId);
            this._monitor = null;
            this._changedHandlerId = 0;
        }
    }
    destroy() {
        this.unwatch();
        this._localListeners.clear();
    }
}