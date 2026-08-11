import Gio from "gi://Gio";

import GLib from "gi://GLib";

const DEBOUNCE_MS = 500;

export class DevWatcher {
    constructor(onReload, logger = console) {
        this._onReload = onReload;
        this._logger = logger;
        this._watched = new Map;
        this._active = false;
    }
    get isActive() {
        return this._active;
    }
    start(widgets = []) {
        if (this._active) return;
        this._active = true;
        for (const {id: id, path: path} of widgets) this.watchWidget(id, path);
        this._logger.log?.(`[dev-watcher] dev-mode ON — watching ${this._watched.size} widget folder(s)`);
    }
    watchWidget(widgetId, path) {
        if (!this._active || this._watched.has(widgetId)) return;
        const dir = Gio.File.new_for_path(path);
        let monitor;
        try {
            monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        } catch (e) {
            this._logger.warn?.(`[dev-watcher] could not watch "${widgetId}" (${path}): ${e.message}`);
            return;
        }
        const entry = {
            monitor: monitor,
            signalId: 0,
            timeoutId: null
        };
        entry.signalId = monitor.connect("changed", () => {
            if (entry.timeoutId != null) GLib.source_remove(entry.timeoutId);
            entry.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
                entry.timeoutId = null;
                this._onReload?.(widgetId);
                return GLib.SOURCE_REMOVE;
            });
        });
        this._watched.set(widgetId, entry);
    }
    unwatchWidget(widgetId) {
        const entry = this._watched.get(widgetId);
        if (!entry) return;
        if (entry.timeoutId != null) GLib.source_remove(entry.timeoutId);
        entry.monitor.disconnect(entry.signalId);
        entry.monitor.cancel();
        this._watched.delete(widgetId);
    }
    stop() {
        if (!this._active) return;
        for (const widgetId of Array.from(this._watched.keys())) this.unwatchWidget(widgetId);
        this._active = false;
        this._logger.log?.("[dev-watcher] dev-mode OFF — file watchers stopped");
    }
}