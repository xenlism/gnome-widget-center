/**
 * lib/settingsStore.js
 *
 * Persists per-widget settings values as JSON on disk, and broadcasts
 * live-reload notifications via Gio.FileMonitor — same pattern already
 * used by ThemeService for theme.json, so the shell-side widget runtime
 * (HTML/CSS/JS widgets) can pick up changes without an extension restart.
 *
 * On-disk layout:
 *   ~/.local/share/gnome-widget-center/settings/<widgetId>.json
 *
 * File contents:
 *   { "fontFamily": "Cantarell 11", "accentColor": "#3584e4", ... }
 *
 * This module is intended to be usable from BOTH the prefs.js (GTK4)
 * process and the extension.js (GNOME Shell) process — both just need
 * a SettingsStore instance pointed at the same directory. Only the
 * writer needs write access; the shell-side reader only needs the
 * FileMonitor + read.
 *
 * 2026-07-28: converted from the legacy `imports.gi` global style to
 * plain ESM (`import`/`export`) so this can actually be imported by
 * prefs.js — see WIDGET_API.md §6.3.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const SETTINGS_SUBDIR = 'gnome-widget-center/settings';

function _getSettingsDir() {
    const dataDir = GLib.get_user_data_dir();
    const path = GLib.build_filenamev([dataDir, SETTINGS_SUBDIR]);
    const dir = Gio.File.new_for_path(path);
    if (!dir.query_exists(null)) {
        dir.make_directory_with_parents(null);
    }
    return dir;
}

export class SettingsStore {
    /**
     * @param {string} widgetId
     * @param {SettingField[]} fields - schema fields, used to fill in
     *        defaults for any keys missing from the on-disk file.
     */
    constructor(widgetId, fields = []) {
        this.widgetId = widgetId;
        this._fields = fields;
        this._dir = _getSettingsDir();
        this._file = this._dir.get_child(`${widgetId}.json`);
        this._values = {};
        this._monitor = null;
        this._changedHandlerId = 0;
        this._listeners = new Set(); // cross-process, via Gio.FileMonitor (see watch())
        this._localListeners = new Set(); // in-process, synchronous (see subscribe())

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
            if (this._file.query_exists(null)) {
                const [ok, contents] = this._file.load_contents(null);
                if (ok) {
                    const decoder = new TextDecoder('utf-8');
                    const parsed = JSON.parse(decoder.decode(contents));
                    this._values = { ...defaults, ...parsed };
                    return;
                }
            }
        } catch (e) {
            logError(e, `[gwc.settingsStore] Failed to load settings for "${this.widgetId}", falling back to defaults`);
        }
        this._values = defaults;
    }

    /** Get the current value for a key (falls back to schema default). */
    get(key) {
        return this._values[key];
    }

    /** Get a shallow copy of all current values. */
    getAll() {
        return { ...this._values };
    }

    /**
     * Set a single value and persist to disk immediately.
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
        this._values[key] = value;
        this._save();
    }

    /** Batch-set multiple values in one disk write. */
    setMany(partial) {
        Object.assign(this._values, partial);
        this._save();
    }

    _save() {
        try {
            const json = JSON.stringify(this._values, null, 2);
            const bytes = new TextEncoder().encode(json);
            this._file.replace_contents(
                bytes,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (e) {
            logError(e, `[gwc.settingsStore] Failed to save settings for "${this.widgetId}"`);
        }

        // Notify in-process subscribers immediately — used e.g. by the
        // settings renderer to drive showIf() conditional visibility
        // without waiting on the (slower, cross-process) file monitor.
        const values = this.getAll();
        for (const listener of this._localListeners) {
            listener(values);
        }
    }

    /**
     * Subscribe to every value change made through this store instance,
     * synchronously and in-process. Fires once immediately with the
     * current values, then again after every set()/setMany().
     * Unlike watch(), this does NOT pick up changes written by other
     * processes — use watch() for that.
     * @param {(values: Object) => void} callback
     */
    subscribe(callback) {
        this._localListeners.add(callback);
        callback(this.getAll());
    }

    /** Stop receiving in-process change notifications. */
    unsubscribe(callback) {
        this._localListeners.delete(callback);
    }

    /**
     * Start watching the settings file for external changes (e.g. edited
     * by hand, or written by the prefs process while a widget instance is
     * live in the shell) and invoke `callback(values)` on change.
     * @param {(values: Object) => void} callback
     */
    watch(callback) {
        this._listeners.add(callback);

        if (this._monitor) {
            return; // already watching
        }

        this._monitor = this._file.monitor(Gio.FileMonitorFlags.NONE, null);
        this._changedHandlerId = this._monitor.connect('changed', (_monitor, _file, _otherFile, eventType) => {
            if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                eventType === Gio.FileMonitorEvent.CREATED) {
                this._loadFromDisk();
                for (const listener of this._listeners) {
                    listener(this.getAll());
                }
            }
        });
    }

    /** Stop watching and release the file monitor. */
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

    /** Release all resources. Call from prefs window close / extension disable. */
    destroy() {
        this.unwatch();
        this._localListeners.clear();
    }
}
